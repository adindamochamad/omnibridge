<script lang="ts">
  import { untrack } from 'svelte';
  import {
    defaultConfig,
    sendWebhook,
    renderFormBody,
    templateFormTimbangan,
    type WebhookConfig,
    type WebhookPayload,
    type WebhookStats,
  } from '$lib/webhook.js';
  import { formatTimestamp } from '$lib/types.js';
  import { urlEfektifUntukWebhook, URL_WEBHOOK_ONLINE } from '$lib/cas-scale.js';

  let {
    config,
    stats,
    samplePayload,
    onSave,
    onClose,
  }: {
    config: WebhookConfig | null;
    stats: WebhookStats;
    samplePayload: WebhookPayload | null;
    onSave: (cfg: WebhookConfig) => Promise<void>;
    onClose: () => void;
  } = $props();

  // Draft is an editable copy of the initial config — user edits should persist,
  // so untrack() captures the starting value without triggering the warning.
  let draft = $state<WebhookConfig>(untrack(() => config ?? defaultConfig()));
  let testing = $state(false);
  let testResult = $state<{ ok: boolean; message: string } | null>(null);
  let saving = $state(false);
  let showPayload = $state(false);
  const urlAktif = $derived(urlEfektifUntukWebhook(draft));

  async function handleSave() {
    saving = true;
    try {
      // Sinkronkan ENTIS dengan toggle enable agar konsisten dengan port card
      draft = { ...draft, entis: draft.enabled };
      await onSave(draft);
      onClose();
    } finally {
      saving = false;
    }
  }

  async function handleTest() {
    if (!samplePayload) {
      testResult = { ok: false, message: 'No sample data yet — wait for stream' };
      return;
    }
    testing = true;
    testResult = null;
    const r = await sendWebhook(draft, samplePayload);
    testResult = {
      ok: r.ok,
      message: r.ok
        ? `✓ ${r.status} OK${r.bodyPreview ? ` — ${r.bodyPreview.slice(0, 60)}` : ''}`
        : `✗ ${r.error ?? 'Unknown error'}`,
    };
    testing = false;
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  // Tokens the user can drop into the form template — top-level metadata plus
  // every parsed field name from the current sample.
  const availableTokens = $derived([
    'port',
    'protocol',
    'confidence',
    'timestamp',
    'device_class',
    ...(samplePayload ? Object.keys(samplePayload.fields) : []),
  ]);

  // Live preview of the exact body that will be sent.
  const bodyPreview = $derived.by(() => {
    if (!samplePayload) return '';
    return draft.body_format === 'form'
      ? renderFormBody(
          draft.form_template?.trim() || templateFormTimbangan(),
          samplePayload,
          draft
        )
      : JSON.stringify(samplePayload, null, 2);
  });

</script>

<div
  class="backdrop"
  role="presentation"
  onclick={handleBackdrop}
  onkeydown={(e) => e.key === 'Escape' && onClose()}
  tabindex="-1"
>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="webhook-title">
    <header class="modal-header">
      <div class="title-area">
        <span class="icon">🔗</span>
        <h2 id="webhook-title">Webhook Output</h2>
      </div>
      <button class="close-x" onclick={onClose} aria-label="Close">✕</button>
    </header>

    <div class="modal-body">
      <!-- Enable toggle -->
      <label class="toggle-row">
        <input type="checkbox" bind:checked={draft.enabled} />
        <span class="toggle-label">Enable webhook forwarding</span>
      </label>

      <!-- URL -->
      <div class="field">
        <label for="wh-url">
          Webhook URL
          {#if (draft.mode_webhook ?? 'DEV') === 'ONLINE'}
            <span class="hint">(mode ONLINE — kirim ke {URL_WEBHOOK_ONLINE})</span>
          {:else}
            <span class="hint">(mode DEV — URL di bawah dipakai saat kirim)</span>
          {/if}
        </label>
        <input
          id="wh-url"
          type="url"
          placeholder="https://dev.bat.entis.app/api/scale"
          bind:value={draft.url}
          disabled={(draft.mode_webhook ?? 'DEV') === 'ONLINE'}
        />
        {#if (draft.mode_webhook ?? 'DEV') === 'ONLINE'}
          <span class="hint">Ganti ke mode DEV di card port untuk mengubah URL staging.</span>
        {/if}
      </div>

      <!-- Method + Throttle -->
      <div class="field-row">
        <div class="field">
          <label for="wh-method">Method</label>
          <select id="wh-method" bind:value={draft.method}>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
          </select>
        </div>
        <div class="field">
          <label for="wh-throttle">Throttle (ms)</label>
          <input
            id="wh-throttle"
            type="number"
            min="200"
            max="60000"
            step="100"
            bind:value={draft.throttle_ms}
          />
        </div>
      </div>

      <!-- Body format -->
      <div class="field">
        <label for="wh-format">Body Format</label>
        <select id="wh-format" bind:value={draft.body_format}>
          <option value="json">JSON (structured payload)</option>
          <option value="form">Form URL-encoded (legacy $_POST)</option>
        </select>
      </div>

      <!-- Form template (only when form-encoded) -->
      {#if draft.body_format === 'form'}
        <div class="field hint-box">
          <span class="hint">
            Kode Timbangan, Company ID, dan <strong>ENTIS</strong> diatur di card port sidebar.
            Centang ENTIS = auto-forward aktif.
            Saat ini: mode <code>{draft.mode_webhook ?? 'DEV'}</code>
            · <code>{draft.scales_code}</code> · company <code>{draft.company_id}</code>
            · ENTIS <code>{draft.entis ? '1 (auto-kirim)' : '0'}</code>
          </span>
        </div>

        <div class="field">
          <label for="wh-template">
            Form Body Template
            <span class="hint">gunakan <code>{'{{scales_code}}'}</code>, <code>{'{{weight}}'}</code>, <code>{'{{company_id}}'}</code></span>
          </label>
          <textarea
            id="wh-template"
            rows="2"
            placeholder="scales-code={'{{scales_code}}'}&amp;scales-weight={'{{weight}}'}&amp;company-id={'{{company_id}}'}"
            bind:value={draft.form_template}
          ></textarea>
          {#if availableTokens.length > 0}
            <div class="tokens">
              <span class="tokens-label">Available:</span>
              {#each availableTokens as tok}
                <button
                  type="button"
                  class="token-chip"
                  title="Insert {`{{${tok}}}`}"
                  onclick={() => (draft.form_template = (draft.form_template ?? '') + `{{${tok}}}`)}
                >
                  {tok}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Custom headers -->
      <div class="field">
        <label for="wh-headers">Custom Headers <span class="hint">(one per line: <code>Key: Value</code>)</span></label>
        <textarea
          id="wh-headers"
          rows="3"
          placeholder="gs-key: your-api-key&#10;Authorization: Bearer xxx"
          bind:value={draft.custom_headers}
        ></textarea>
      </div>

      <!-- Include raw -->
      <label class="toggle-row compact">
        <input type="checkbox" bind:checked={draft.include_raw} />
        <span class="toggle-label">Include latest raw ASCII/HEX line in payload</span>
      </label>

      <!-- Stats -->
      {#if stats.sent > 0 || stats.failed > 0}
        <div class="stats">
          <div class="stat">
            <span class="stat-value ok">{stats.sent}</span>
            <span class="stat-label">sent</span>
          </div>
          <div class="stat">
            <span class="stat-value fail">{stats.failed}</span>
            <span class="stat-label">failed</span>
          </div>
          {#if stats.last_sent_at}
            <div class="stat-last">
              Last: {stats.last_status} · {formatTimestamp(stats.last_sent_at)}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Test + Payload preview -->
      {#if testResult}
        <div class="test-result" class:fail={!testResult.ok}>{testResult.message}</div>
      {/if}

      {#if samplePayload}
        <button class="payload-toggle" onclick={() => (showPayload = !showPayload)}>
          {showPayload ? '▼' : '▶'} Preview body
          <span class="format-tag">{draft.body_format === 'form' ? 'form-urlencoded' : 'json'}</span>
        </button>
        {#if showPayload}
          <pre class="payload">{bodyPreview}</pre>
        {/if}
      {/if}
    </div>

    <footer class="modal-footer">
      <button class="btn secondary" onclick={handleTest} disabled={testing || !urlAktif}>
        {testing ? 'Testing…' : 'Test'}
      </button>
      <div class="spacer"></div>
      <button class="btn ghost" onclick={onClose}>Cancel</button>
      <button class="btn primary" onclick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(5, 8, 15, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(4px);
  }

  .modal {
    width: 480px;
    max-width: 90vw;
    max-height: 85vh;
    background: #0f1428;
    border: 1px solid #2a3450;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.8rem 1rem;
    border-bottom: 1px solid #1e2a40;
    background: #0a0e1a;
    flex-shrink: 0;
  }

  .title-area {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .icon { font-size: 1.1rem; }

  h2 {
    font-size: 0.95rem;
    font-weight: 600;
    color: #c0d0ff;
    margin: 0;
  }

  .close-x {
    background: none;
    border: none;
    color: #5a6a8a;
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0.2rem 0.5rem;
    transition: color 0.15s;
  }

  .close-x:hover { color: #f87171; }

  .modal-body {
    padding: 1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    scrollbar-width: thin;
    scrollbar-color: #2a3450 transparent;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    padding: 0.5rem 0.6rem;
    background: #141c30;
    border-radius: 6px;
    border: 1px solid #1e2a40;
  }

  .toggle-row.compact {
    padding: 0.4rem 0.6rem;
    background: transparent;
    border: none;
  }

  .toggle-row input[type='checkbox'] {
    accent-color: #4f6ef7;
    width: 15px;
    height: 15px;
  }

  .toggle-label {
    font-size: 0.8rem;
    color: #c0d0ff;
    font-weight: 500;
  }

  .toggle-row.compact .toggle-label {
    color: #7a8ab0;
    font-weight: 400;
    font-size: 0.75rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .field label {
    font-size: 0.72rem;
    color: #7a8ab0;
    font-weight: 500;
    letter-spacing: 0.02em;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .hint {
    color: #4a5a7a;
    font-weight: 400;
    font-size: 0.68rem;
  }

  .hint code {
    background: #1a2038;
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.7rem;
  }

  .field input,
  .field select,
  .field textarea {
    background: #0a0e1a;
    border: 1px solid #2a3450;
    border-radius: 5px;
    color: #d0d8f0;
    font-size: 0.8rem;
    padding: 0.4rem 0.55rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }

  .field textarea {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    resize: vertical;
  }

  .field input:focus,
  .field select:focus,
  .field textarea:focus {
    border-color: #4f6ef7;
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }

  .hint-box {
    padding: 0.45rem 0.6rem;
    background: #141c30;
    border-radius: 6px;
    border: 1px solid #1e2a40;
  }

  .hint-box .hint {
    font-size: 0.72rem;
    line-height: 1.5;
  }

  .hint-box code {
    background: #1a2038;
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
    font-family: "JetBrains Mono", monospace;
    color: #8aa0d0;
  }

  /* Stats */
  .stats {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 0.7rem;
    background: #0a0e1a;
    border-radius: 6px;
    border: 1px solid #1e2a40;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
  }

  .stat-value {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    font-size: 1rem;
  }

  .stat-value.ok { color: #22c55e; }
  .stat-value.fail { color: #f87171; }

  .stat-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #4a5a7a;
  }

  .stat-last {
    flex: 1;
    text-align: right;
    font-size: 0.68rem;
    color: #7a8ab0;
    font-family: "JetBrains Mono", monospace;
  }

  /* Test result */
  .test-result {
    padding: 0.4rem 0.6rem;
    background: #0e2018;
    border: 1px solid #1e4028;
    color: #22c55e;
    border-radius: 5px;
    font-size: 0.72rem;
    word-break: break-all;
  }

  .test-result.fail {
    background: #1e0e0e;
    border-color: #4a1e1e;
    color: #f87171;
  }

  /* Payload preview */
  .payload-toggle {
    background: none;
    border: none;
    color: #6a80b0;
    font-size: 0.72rem;
    cursor: pointer;
    padding: 0.2rem 0;
    text-align: left;
    font-family: inherit;
  }

  .payload-toggle:hover { color: #90a8e0; }

  .format-tag {
    font-size: 0.6rem;
    background: #1a2038;
    color: #6a80b0;
    padding: 0.05rem 0.35rem;
    border-radius: 8px;
    font-family: "JetBrains Mono", monospace;
    margin-left: 0.3rem;
  }

  .tokens {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.4rem;
  }

  .tokens-label {
    font-size: 0.66rem;
    color: #4a5a7a;
  }

  .token-chip {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.66rem;
    background: #141c30;
    color: #8aa0d0;
    border: 1px solid #2a3450;
    border-radius: 4px;
    padding: 0.1rem 0.35rem;
    cursor: pointer;
    transition: all 0.12s;
  }

  .token-chip:hover {
    background: #1c2640;
    color: #b0c4f0;
    border-color: #3a4a70;
  }

  .payload {
    background: #0a0e1a;
    border: 1px solid #1e2a40;
    border-radius: 5px;
    padding: 0.5rem 0.6rem;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.7rem;
    color: #a0b0d8;
    max-height: 200px;
    overflow: auto;
    white-space: pre;
  }

  /* Footer */
  .modal-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.7rem 1rem;
    border-top: 1px solid #1e2a40;
    background: #0a0e1a;
    flex-shrink: 0;
  }

  .spacer { flex: 1; }

  .btn {
    padding: 0.4rem 0.9rem;
    border-radius: 5px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
    font-family: inherit;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .btn.primary {
    background: #4f6ef7;
    color: #fff;
  }

  .btn.primary:hover:not(:disabled) { background: #3a56e0; }

  .btn.secondary {
    background: #1a2038;
    color: #90a8e0;
    border-color: #2a3450;
  }

  .btn.secondary:hover:not(:disabled) { background: #202848; }

  .btn.ghost {
    background: transparent;
    color: #7a8ab0;
  }

  .btn.ghost:hover { color: #a0b0d8; }
</style>
