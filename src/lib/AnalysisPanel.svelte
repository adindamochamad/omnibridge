<script lang="ts">
  import type { ProtocolAnalysis, AnalysisField } from '$lib/claude.js';

  let {
    analysis,
    loading,
    error,
    recognized = false,
    sampleCount = 0,
    onFieldEdit,
  }: {
    analysis: ProtocolAnalysis | null;
    loading: boolean;
    error: string | null;
    recognized?: boolean;
    sampleCount?: number;
    /** Called when user manually edits a field's regex. Parent should merge
     *  the new regex into analysisResult so the live dashboard re-parses. */
    onFieldEdit?: (fieldName: string, patch: Partial<AnalysisField>) => void;
  } = $props();

  function confidenceColor(n: number): string {
    if (n >= 80) return '#22c55e';
    if (n >= 55) return '#f59e0b';
    return '#f87171';
  }

  // Inline regex edit state — one field at a time
  let editingField = $state<string | null>(null);
  let draftRegex = $state('');
  let draftError = $state<string | null>(null);

  function startEdit(field: AnalysisField) {
    editingField = field.name;
    draftRegex = field.regex ?? '';
    draftError = null;
  }

  function cancelEdit() {
    editingField = null;
    draftRegex = '';
    draftError = null;
  }

  function saveEdit() {
    if (editingField === null) return;
    // Validate regex compiles
    if (draftRegex.trim()) {
      try {
        new RegExp(draftRegex);
      } catch (e) {
        draftError = `Invalid regex: ${(e as Error).message}`;
        return;
      }
    }
    onFieldEdit?.(editingField, { regex: draftRegex.trim() || undefined });
    cancelEdit();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }
</script>

<div class="panel">
  {#if loading || (recognized && analysis)}
    <div class="status-strip">
      {#if loading}
        <span class="thinking-badge">Thinking…</span>
      {:else if recognized && analysis}
        <span class="recognized-badge" title="Loaded from learned profile — click Analyze to refresh">
          ⭐ Auto-recognized
          {#if sampleCount > 1}
            <span class="sample-count-label">· {sampleCount} sessions</span>
          {/if}
        </span>
      {/if}
    </div>
  {/if}

  <div class="panel-body">
    <!-- Existing result stays visible during re-analysis to avoid flicker -->
    {#if analysis}
      {#if error}
        <div class="inline-error">
          <span class="error-icon">⚠</span>
          Re-analysis failed: {error}
        </div>
      {/if}
      <div class="results" class:refreshing={loading}>
        <!-- Protocol + confidence -->
        <div class="proto-row">
          <div class="proto-name">{analysis.protocol}</div>
          <div class="confidence-bar-wrap">
            <div
              class="confidence-bar"
              style="width: {analysis.confidence}%; background: {confidenceColor(analysis.confidence)}"
            ></div>
          </div>
          <div class="confidence-pct" style="color: {confidenceColor(analysis.confidence)}">
            {analysis.confidence}%
          </div>
        </div>

        {#if analysis.device_hint}
          <div class="device-hint">
            <span class="hint-label">Device:</span>
            <span class="hint-value">{analysis.device_hint}</span>
          </div>
        {/if}

        {#if analysis.committed === false}
          <div class="gate-banner held">
            Commit gate held — no parser, no dashboard. {analysis.commit_reason}
          </div>
        {:else if analysis.gate_mode === 'naive'}
          <div class="gate-banner naive">
            Naive lane — parser installed without evidence. Contrast only.
          </div>
        {:else if analysis.committed === true}
          <div class="gate-banner ok">
            Commit gate passed. {analysis.commit_reason}
          </div>
        {/if}

        <!-- Fields table -->
        {#if analysis.fields.length > 0}
          <div class="section-label">Extracted Fields <span class="edit-hint">· click ✎ to edit regex</span></div>
          <div class="fields-table">
            {#each analysis.fields as field}
              <div class="field-row">
                <span class="field-name">{field.name}</span>
                <span class="field-value">{field.value}</span>
                <span class="field-desc">{field.description}</span>
                {#if onFieldEdit}
                  <button
                    class="field-edit-btn"
                    onclick={() => startEdit(field)}
                    title="Edit this field's regex"
                    disabled={editingField !== null && editingField !== field.name}
                  >✎</button>
                {/if}
              </div>
              {#if editingField === field.name}
                <div class="field-edit-panel">
                  <label class="edit-label">
                    <span class="edit-label-text">
                      Regex {field.match_hex ? '(matches hex representation)' : '(matches ASCII)'}
                    </span>
                    <input
                      type="text"
                      class="edit-input"
                      class:invalid={draftError !== null}
                      bind:value={draftRegex}
                      onkeydown={handleKeydown}
                      placeholder="Empty regex disables parsing for this field"
                      spellcheck="false"
                      autocomplete="off"
                    />
                  </label>
                  {#if draftError}
                    <div class="edit-error">{draftError}</div>
                  {/if}
                  <div class="edit-actions">
                    <button class="edit-cancel" onclick={cancelEdit}>Cancel (Esc)</button>
                    <button class="edit-save" onclick={saveEdit}>Save (Enter)</button>
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}

        <!-- Notes -->
        {#if analysis.notes}
          <div class="section-label">Analysis Notes</div>
          <div class="notes">{analysis.notes}</div>
        {/if}
      </div>

    {:else if loading}
      <div class="loading-state">
        <div class="spinner"></div>
        <div class="loading-text">
          <div class="loading-main">Muse Spark is analyzing the stream…</div>
          <div class="loading-sub">Reading the frame before a parser is installed</div>
        </div>
      </div>

    {:else if error}
      <div class="error-state">
        <span class="error-icon">⚠</span>
        <div>
          <div class="error-title">Analysis failed</div>
          <div class="error-msg">{error}</div>
        </div>
      </div>

    {:else}
      <div class="idle-state">Click <strong>Analyze</strong> or toggle <strong>⚡ Live</strong> to run Protocol Detective.</div>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    background: #0d1120;
    border-top: 1px solid #1e1e30;
    height: 100%;
    overflow: hidden;
  }

  .status-strip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.8rem;
    background: #0a0e1a;
    border-bottom: 1px solid #1a2038;
    flex-shrink: 0;
  }

  .thinking-badge {
    font-size: 0.62rem;
    background: #1a2a50;
    color: #6080d0;
    border: 1px solid #2a3a60;
    border-radius: 10px;
    padding: 0.05rem 0.4rem;
    animation: throb 1.5s ease-in-out infinite;
  }

  .recognized-badge {
    font-size: 0.62rem;
    background: #2a1e42;
    color: #d8b4fe;
    border: 1px solid #4a3870;
    border-radius: 10px;
    padding: 0.05rem 0.4rem;
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }

  @keyframes throb {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .sample-count-label {
    color: #a78bfa;
    opacity: 0.8;
  }

  .gate-banner {
    font-size: 0.75rem;
    line-height: 1.4;
    padding: 0.45rem 0.55rem;
    border-radius: 6px;
    margin: 0.5rem 0 0.35rem;
  }
  .gate-banner.held {
    background: #2a1212;
    color: #fca5a5;
    border: 1px solid #7f1d1d;
  }
  .gate-banner.naive {
    background: #2a2412;
    color: #fcd34d;
    border: 1px solid #854d0e;
  }
  .gate-banner.ok {
    background: #10241a;
    color: #86efac;
    border: 1px solid #166534;
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.6rem 0.8rem;
    scrollbar-width: thin;
    scrollbar-color: #1e2a40 transparent;
  }

  /* Loading */
  .loading-state {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    padding: 0.4rem 0;
    color: #6080d0;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #1e2a40;
    border-top-color: #4f6ef7;
    border-radius: 50%;
    flex-shrink: 0;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-main {
    font-size: 0.8rem;
    color: #8090c0;
  }

  .loading-sub {
    font-size: 0.68rem;
    color: #3a4a70;
    margin-top: 0.15rem;
  }

  /* Error */
  .error-state {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.5rem 0.6rem;
    background: #1a0e0e;
    border: 1px solid #3a1a1a;
    border-radius: 6px;
  }

  .error-icon {
    color: #f87171;
    font-size: 0.9rem;
    flex-shrink: 0;
  }

  .error-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: #f87171;
  }

  .error-msg {
    font-size: 0.7rem;
    color: #a05050;
    margin-top: 0.15rem;
    word-break: break-word;
  }

  /* Inline error (shown above stale result during re-analysis) */
  .inline-error {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.7rem;
    color: #f87171;
    background: #1a0e0e;
    border: 1px solid #3a1a1a;
    border-radius: 4px;
    padding: 0.3rem 0.5rem;
    margin-bottom: 0.5rem;
  }

  /* Results */
  .results {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    transition: opacity 0.2s;
  }

  .results.refreshing {
    opacity: 0.55;
  }

  .proto-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .proto-name {
    font-size: 0.85rem;
    font-weight: 700;
    color: #c0d0ff;
    white-space: nowrap;
  }

  .confidence-bar-wrap {
    flex: 1;
    height: 5px;
    background: #1e1e30;
    border-radius: 3px;
    overflow: hidden;
  }

  .confidence-bar {
    height: 100%;
    border-radius: 3px;
    transition: width 0.5s ease;
  }

  .confidence-pct {
    font-size: 0.72rem;
    font-weight: 700;
    white-space: nowrap;
    min-width: 2.8rem;
    text-align: right;
  }

  .device-hint {
    font-size: 0.72rem;
    color: #5a6a8a;
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }

  .hint-label {
    color: #3a4a6a;
    font-weight: 600;
    text-transform: uppercase;
    font-size: 0.62rem;
    letter-spacing: 0.07em;
  }

  .hint-value {
    color: #8090b0;
  }

  .section-label {
    font-size: 0.62rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #3a4a6a;
    margin-top: 0.2rem;
  }

  .fields-table {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
  }

  .field-row {
    display: grid;
    grid-template-columns: 120px minmax(60px, 1fr) 2fr auto;
    gap: 0.4rem;
    padding: 0.2rem 0.4rem;
    background: #111828;
    border-radius: 4px;
    align-items: baseline;
  }

  .field-edit-btn {
    background: transparent;
    border: 1px solid transparent;
    color: #4a5a7a;
    cursor: pointer;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    font-size: 0.75rem;
    transition: all 0.15s;
    line-height: 1;
  }

  .field-edit-btn:hover:not(:disabled) {
    color: #a78bfa;
    border-color: #4a3870;
    background: #1a1428;
  }

  .field-edit-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .field-edit-panel {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.55rem 0.6rem;
    background: #0e1424;
    border: 1px solid #2a3450;
    border-left: 2px solid #a78bfa;
    border-radius: 0 4px 4px 0;
    margin-top: 2px;
  }

  .edit-label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .edit-label-text {
    font-size: 0.62rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #a78bfa;
  }

  .edit-input {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    padding: 0.35rem 0.5rem;
    background: #050810;
    color: #e0e8ff;
    border: 1px solid #2a3450;
    border-radius: 3px;
    outline: none;
    transition: border-color 0.15s;
  }

  .edit-input:focus {
    border-color: #a78bfa;
  }

  .edit-input.invalid {
    border-color: #f87171;
    background: #180808;
  }

  .edit-error {
    font-size: 0.68rem;
    color: #f87171;
    font-family: "JetBrains Mono", monospace;
  }

  .edit-actions {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
    margin-top: 0.15rem;
  }

  .edit-cancel,
  .edit-save {
    font-size: 0.68rem;
    padding: 0.25rem 0.7rem;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
    transition: all 0.15s;
  }

  .edit-cancel {
    background: #1a1f30;
    color: #8090b0;
    border: 1px solid #2a3450;
  }

  .edit-cancel:hover {
    background: #24304a;
  }

  .edit-save {
    background: #3a1e78;
    color: #fff;
    border: 1px solid #5a3ab0;
  }

  .edit-save:hover {
    background: #4a2e92;
    border-color: #7050d0;
  }

  .edit-hint {
    color: #4a5a7a;
    font-weight: 400;
    text-transform: none;
    font-style: italic;
  }

  .field-row:nth-child(odd) {
    background: #0e1620;
  }

  .field-name {
    color: #4f6ef7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .field-value {
    color: #e0e8ff;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .field-desc {
    color: #4a5a7a;
    font-size: 0.68rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: Inter, system-ui, sans-serif;
  }

  .notes {
    font-size: 0.72rem;
    color: #6070a0;
    line-height: 1.6;
    background: #0e1624;
    border-left: 2px solid #1e2a42;
    padding: 0.4rem 0.6rem;
    border-radius: 0 4px 4px 0;
  }

  .idle-state {
    font-size: 0.75rem;
    color: #3a3a5a;
    padding: 0.4rem 0;
  }

  .idle-state strong {
    color: #5a5a8a;
  }
</style>
