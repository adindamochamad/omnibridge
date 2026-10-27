<script lang="ts">
  import { tick } from 'svelte';
  import { formatTimestamp, type DataLine } from '$lib/types.js';
  import AnalysisPanel from '$lib/AnalysisPanel.svelte';
  import StructuredDashboard from '$lib/StructuredDashboard.svelte';
  import ScalePushPanel from '$lib/ScalePushPanel.svelte';
  import WebhookConfigModal from '$lib/WebhookConfigModal.svelte';
  import {
    analyzeStream,
    analyzeWithAgent,
    friendlyError,
    type ProtocolAnalysis,
    type AnalysisField,
    type AgentStep,
    type AgentResult,
    type UsageStats,
  } from '$lib/claude.js';
  import type { DiscoveredDevice } from '$lib/types.js';
  import AgentTracePanel from '$lib/AgentTracePanel.svelte';
  import ChatPanel, { type ChatMessage } from '$lib/ChatPanel.svelte';
  import CommandSender from '$lib/CommandSender.svelte';
  import { profileToAnalysis, type DeviceProfile } from '$lib/profiles.js';
  import { compileFields, parseStream, latest } from '$lib/parser.js';
  import {
    defaultStats,
    saveConfig as saveWebhookConfig,
    sendWebhook,
    shouldSendWebhook,
    type WebhookConfig,
    type WebhookPayload,
    type WebhookStats,
  } from '$lib/webhook.js';
  import {
    buildExport,
    downloadFile,
    type ExportFormat,
    type ExportScope,
  } from '$lib/export.js';

  let {
    port,
    lines,
    deviceClass,
    deviceFingerprint,
    device = null,
    learnedProfile = null,
    webhookConfig: webhookConfigProp,
    onWebhookConfigChange,
    onClose,
    onAnalysisComplete,
  }: {
    port: string;
    lines: DataLine[];
    deviceClass?: string;
    deviceFingerprint?: string | null;
    device?: DiscoveredDevice | null;
    learnedProfile?: DeviceProfile | null;
    webhookConfig: WebhookConfig;
    onWebhookConfigChange?: (cfg: WebhookConfig) => void | Promise<void>;
    onClose: () => void;
    onAnalysisComplete?: (analysis: ProtocolAnalysis) => void;
  } = $props();

  let showHex = $state(false);
  let autoScroll = $state(true);
  let bufferEl = $state<HTMLDivElement | null>(null);
  let showSender = $state(false);

  let analysisLoading = $state(false);
  let analysisResult = $state<ProtocolAnalysis | null>(null);
  let analysisError = $state<string | null>(null);
  let showAnalysis = $state(false);
  let isRecognized = $state(false);
  let recognizedSampleCount = $state(0);

  // Bottom panel tabs: detective (analysis) · dashboard (live values) · investigation (agent trace) · ask (Q&A chat)
  let bottomTab = $state<'detective' | 'dashboard' | 'investigation' | 'ask'>('detective');

  // Chat Q&A history per-port (persists while DataBuffer is mounted)
  let chatHistory = $state<ChatMessage[]>([]);

  // ── Agent investigation state ────────────────────────────────────────────
  let investigating = $state(false);
  let agentTrace = $state<AgentStep[]>([]);
  let agentError = $state<string | null>(null);
  let agentApiCalls = $state(0);
  let agentStoppedAt = $state<'end_turn' | 'max_steps' | 'error' | null>(null);
  let agentUsage = $state<UsageStats | null>(null);

  // ── Resizable split ──────────────────────────────────────────────────────
  /** Percent of vertical space given to the top buffer; the analysis panel
   *  fills the rest. User can drag the handle between them to resize. */
  let bufferPercent = $state(55);
  let isResizing = $state(false);
  let contentEl = $state<HTMLDivElement | null>(null);

  function startResize(e: MouseEvent) {
    e.preventDefault();
    isResizing = true;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onResize);
    window.addEventListener('mouseup', stopResize);
  }

  function onResize(e: MouseEvent) {
    if (!contentEl) return;
    const rect = contentEl.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const pct = (y / rect.height) * 100;
    bufferPercent = Math.max(15, Math.min(85, pct));
  }

  function stopResize() {
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onResize);
    window.removeEventListener('mouseup', stopResize);
  }

  function handleResizeKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      bufferPercent = Math.max(15, bufferPercent - 3);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      bufferPercent = Math.min(85, bufferPercent + 3);
    } else if (e.key === 'Home') {
      e.preventDefault();
      bufferPercent = 55; // reset to default
    }
  }

  // ── Webhook output ───────────────────────────────────────────────────────
  let showWebhookModal = $state(false);
  let webhookStats = $state<WebhookStats>(defaultStats());

  const webhookKey = $derived(deviceFingerprint ?? `port:${port}`);
  const webhookConfig = $derived(webhookConfigProp);

  // Throttle timer — fires periodically; sends latest snapshot when there's
  // valid data to forward. Earlier dirty-flag pattern relied on Svelte
  // tracking `lines.length` inside an effect with an early return, which did
  // not always re-subscribe across config changes — webhook only fired on
  // manual Test. Simpler model: every interval, check conditions, send.
  $effect(() => {
    if (!webhookConfig?.enabled) return;
    const ms = Math.max(200, webhookConfig.throttle_ms);
    const id = setInterval(flushWebhook, ms);
    return () => clearInterval(id);
  });

  function buildPayload(): WebhookPayload | null {
    if (!analysisResult) return null;
    const parsed = parseStream(lines, analysisResult.fields);
    const fields: WebhookPayload['fields'] = {};
    for (const f of analysisResult.fields) {
      const lv = latest(parsed.history[f.name] ?? []);
      if (!lv) continue;
      fields[f.name] = { value: lv.value, updated_at: lv.timestamp };
      if (f.unit) fields[f.name].unit = f.unit;
    }
    const payload: WebhookPayload = {
      timestamp: Date.now(),
      port,
      device_class: deviceClass,
      protocol: analysisResult.protocol,
      confidence: analysisResult.confidence,
      fields,
    };
    if (webhookConfig?.include_raw && lines.length > 0) {
      const last = lines[lines.length - 1];
      payload.raw_line = { ascii: last.ascii, hex: last.hex, timestamp: last.timestamp };
    }
    return payload;
  }

  async function flushWebhook() {
    if (!webhookConfig?.enabled || !analysisResult) return;
    const payload = buildPayload();
    if (!payload || Object.keys(payload.fields).length === 0) return;

    if (!shouldSendWebhook(webhookConfig, payload)) {
      webhookStats = { ...webhookStats, skipped: webhookStats.skipped + 1 };
      return;
    }

    const result = await sendWebhook(webhookConfig, payload);
    webhookStats = {
      sent: webhookStats.sent + (result.ok ? 1 : 0),
      failed: webhookStats.failed + (result.ok ? 0 : 1),
      skipped: webhookStats.skipped,
      last_status: result.ok ? `${result.status} OK` : (result.error ?? 'Error'),
      last_sent_at: Date.now(),
      last_error: result.ok ? null : (result.error ?? null),
    };
  }

  async function handleWebhookSave(cfg: WebhookConfig) {
    await saveWebhookConfig(webhookKey, cfg);
    await onWebhookConfigChange?.(cfg);
  }

  const punyaFieldBerat = $derived(
    analysisResult?.fields.some((f) => f.name === 'weight') ?? false
  );

  // ── Export menu ──────────────────────────────────────────────────────────
  let exportMenuOpen = $state(false);

  function doExport(format: ExportFormat, scope: ExportScope) {
    const { content, filename, mime } = buildExport(
      { port, device_class: deviceClass, analysis: analysisResult, lines },
      format,
      scope
    );
    downloadFile(content, filename, mime);
    exportMenuOpen = false;
  }

  function closeMenuOnClickOutside(node: HTMLElement) {
    const handler = (e: MouseEvent) => {
      if (!node.contains(e.target as Node)) exportMenuOpen = false;
    };
    document.addEventListener('click', handler);
    return {
      destroy: () => document.removeEventListener('click', handler),
    };
  }

  const hasParsableFields = $derived.by(() => {
    if (!analysisResult) return false;
    if (analysisResult.committed === false) return false;
    const compiled = compileFields(analysisResult.fields);
    return Object.values(compiled).some((r) => r !== null);
  });

  // Pre-populate from learned profile on mount (only once)
  let profileApplied = false;
  $effect(() => {
    if (learnedProfile && !profileApplied) {
      profileApplied = true;
      analysisResult = profileToAnalysis(learnedProfile);
      isRecognized = true;
      recognizedSampleCount = learnedProfile.sample_count;
      showAnalysis = true;
    }
  });

  // Auto-switch to dashboard when parsable fields become available
  let autoSwitched = false;
  $effect(() => {
    if (hasParsableFields && !autoSwitched) {
      autoSwitched = true;
      bottomTab = 'dashboard';
    }
  });

  // ── Live analysis (auto-trigger with debounce) ───────────────────────────
  let liveAnalysis = $state(false);
  let lastAnalyzedCount = $state(0);
  const FIRST_TRIGGER_THRESHOLD = 10;
  const RETRY_TRIGGER_THRESHOLD = 15;
  const FORCE_TRIGGER_THRESHOLD = 25;
  const DEBOUNCE_MS = 400;

  const newLinesSinceAnalysis = $derived(lines.length - lastAnalyzedCount);
  const triggerThreshold = $derived(
    lastAnalyzedCount === 0 ? FIRST_TRIGGER_THRESHOLD : RETRY_TRIGGER_THRESHOLD
  );

  $effect(() => {
    lines.length;
    if (autoScroll) {
      tick().then(() => {
        if (bufferEl) bufferEl.scrollTop = bufferEl.scrollHeight;
      });
    }
  });

  // Auto-trigger analysis when live mode is on and threshold met.
  // Re-runs on every new line → debounces until stream idles 2s.
  // Force-fires if buffer accumulates faster than Claude can keep up.
  $effect(() => {
    if (!liveAnalysis) return;
    if (analysisLoading) return;
    const newLines = lines.length - lastAnalyzedCount;
    const threshold = lastAnalyzedCount === 0 ? FIRST_TRIGGER_THRESHOLD : RETRY_TRIGGER_THRESHOLD;
    if (newLines < threshold) return;

    // Continuous stream — don't wait forever for idle
    if (newLines >= FORCE_TRIGGER_THRESHOLD) {
      runAnalysis();
      return;
    }

    const timer = setTimeout(() => {
      if (!analysisLoading && liveAnalysis) runAnalysis();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  function toggleLiveAnalysis() {
    liveAnalysis = !liveAnalysis;
    if (liveAnalysis) {
      showAnalysis = true;
      lastAnalyzedCount = 0; // allow immediate first trigger
    }
  }

  function handleScroll() {
    if (!bufferEl) return;
    const atBottom = bufferEl.scrollHeight - bufferEl.scrollTop - bufferEl.clientHeight < 32;
    autoScroll = atBottom;
  }

  function shortPort(p: string): string {
    return p.split('/').at(-1) ?? p;
  }

  function clearBuffer() {
    lines.splice(0, lines.length);
    analysisResult = null;
    analysisError = null;
    lastAnalyzedCount = 0;
    if (!liveAnalysis) showAnalysis = false;
  }

  async function runAnalysis() {
    if (lines.length === 0 || analysisLoading) return;
    showAnalysis = true;
    analysisLoading = true;
    analysisError = null;
    // Keep previous analysisResult visible during refresh (no flicker)
    lastAnalyzedCount = lines.length;

    const hexSamples = lines.map((l) => l.hex);
    const asciiSamples = lines.map((l) => l.ascii);

    try {
      const result = await analyzeStream(hexSamples, asciiSamples, deviceClass, lines);
      analysisResult = result;
      isRecognized = false;
      onAnalysisComplete?.(result);
    } catch (e) {
      analysisError = friendlyError(e);
    } finally {
      analysisLoading = false;
    }
  }

  function closeAnalysis() {
    showAnalysis = false;
    analysisResult = null;
    analysisError = null;
    liveAnalysis = false; // closing panel also disables live
  }

  /** Merge a manual field override from the AnalysisPanel. Triggers the live
   *  dashboard to re-parse with the user's regex instead of Claude's. We also
   *  re-persist the profile so the edit sticks across reconnects. */
  function handleFieldEdit(fieldName: string, patch: Partial<AnalysisField>) {
    if (!analysisResult) return;
    const updatedFields = analysisResult.fields.map((f) =>
      f.name === fieldName ? { ...f, ...patch } : f
    );
    analysisResult = { ...analysisResult, fields: updatedFields };
    // Propagate to parent so the device profile is updated and persisted
    onAnalysisComplete?.(analysisResult);
  }

  async function runInvestigation() {
    if (lines.length === 0 || investigating) return;
    showAnalysis = true;
    bottomTab = 'investigation';
    investigating = true;
    agentTrace = [];
    agentError = null;
    agentApiCalls = 0;
    agentStoppedAt = null;
    agentUsage = null;
    analysisError = null;

    const result: AgentResult = await analyzeWithAgent(
      { port, lines, device, deviceClass },
      (step) => {
        agentTrace = [...agentTrace, step];
      }
    );

    agentApiCalls = result.total_api_calls;
    agentStoppedAt = result.stopped_at;
    agentUsage = result.usage;

    if (result.analysis) {
      analysisResult = result.analysis;
      isRecognized = false;
      lastAnalyzedCount = lines.length;
      if (result.analysis.committed !== false) {
        onAnalysisComplete?.(result.analysis);
      } else {
        agentError = result.error ?? result.analysis.commit_reason ?? 'Commit gate held parser.';
      }
    } else if (result.error) {
      agentError = result.error;
    }
    investigating = false;
  }
</script>

<div class="buffer-panel">
  <div class="buffer-header">
    <div class="title-area">
      <span class="live-dot"></span>
      <span class="port-label">{shortPort(port)}</span>
      <span class="full-path">{port}</span>
      <span class="line-count">{lines.length} lines</span>
      {#if analysisResult?.committed === false}
        <span class="gate-chip held">gate held</span>
      {:else if analysisResult?.gate_mode === 'naive'}
        <span class="gate-chip naive">naive commit</span>
      {:else if analysisResult?.committed === true}
        <span class="gate-chip ok">gate passed</span>
      {/if}
    </div>
    <div class="controls">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={showHex} />
        HEX
      </label>
      <label class="toggle-label">
        <input type="checkbox" bind:checked={autoScroll} />
        Auto-scroll
      </label>
      <button
        class="ctrl-btn live"
        class:active={liveAnalysis}
        onclick={toggleLiveAnalysis}
        title="Auto-analyze stream as data arrives"
      >
        <span class="live-icon">⚡</span>
        Live
        {#if liveAnalysis && !analysisLoading && newLinesSinceAnalysis < triggerThreshold}
          <span class="live-progress">{newLinesSinceAnalysis}/{triggerThreshold}</span>
        {/if}
      </button>
      <button
        class="ctrl-btn analyze"
        onclick={runAnalysis}
        disabled={analysisLoading || lines.length === 0}
        title="⬡ Analyze — Naive one-shot on muse-spark-1.3. Installs a parser without the evidence gate (contrast lane)."
      >
        {#if analysisLoading}
          <span class="spin-sm">◌</span> Analyzing…
        {:else}
          ⬡ Analyze
        {/if}
      </button>
      <button
        class="ctrl-btn investigate"
        onclick={runInvestigation}
        disabled={investigating || lines.length === 0}
        title="🔬 Investigate — Muse Spark tool loop. Parser and dashboard install only if the commit gate sees matching framing evidence."
      >
        {#if investigating}
          <span class="spin-sm">◌</span> Investigating…
        {:else}
          🔬 Investigate
        {/if}
      </button>
      <button
        class="ctrl-btn ask"
        onclick={() => { showAnalysis = true; bottomTab = 'ask'; }}
        disabled={lines.length === 0}
        title="🤖 Ask — Free-form Q&A over the live buffer via Muse Spark."
      >
        🤖 Ask
      </button>
      <button
        class="ctrl-btn send"
        class:active={showSender}
        onclick={() => (showSender = !showSender)}
        title="Send data to device (bidirectional)"
      >
        → Send
      </button>
      <div class="export-wrap" use:closeMenuOnClickOutside>
        <button
          class="ctrl-btn export"
          onclick={(e) => { e.stopPropagation(); exportMenuOpen = !exportMenuOpen; }}
          disabled={lines.length === 0}
          title="Export buffer data"
        >
          ⤓ Export
          <span class="chevron" class:open={exportMenuOpen}>▾</span>
        </button>
        {#if exportMenuOpen}
          <div class="export-menu">
            <div class="menu-section-label">Structured (parsed)</div>
            <button
              class="menu-item"
              onclick={() => doExport('csv', 'structured')}
              disabled={!analysisResult}
            >
              <span class="menu-icon">📊</span>
              <span class="menu-label">CSV · Fields</span>
              <span class="menu-hint">spreadsheet-ready</span>
            </button>
            <button
              class="menu-item"
              onclick={() => doExport('json', 'structured')}
              disabled={!analysisResult}
            >
              <span class="menu-icon">📊</span>
              <span class="menu-label">JSON · Fields</span>
              <span class="menu-hint">with schema</span>
            </button>

            <div class="menu-divider"></div>
            <div class="menu-section-label">Raw stream</div>
            <button class="menu-item" onclick={() => doExport('csv', 'raw')}>
              <span class="menu-icon">📝</span>
              <span class="menu-label">CSV · Raw</span>
              <span class="menu-hint">ascii + hex</span>
            </button>
            <button class="menu-item" onclick={() => doExport('json', 'raw')}>
              <span class="menu-icon">📝</span>
              <span class="menu-label">JSON · Raw</span>
              <span class="menu-hint">full capture</span>
            </button>
          </div>
        {/if}
      </div>
      <button
        class="ctrl-btn webhook"
        class:active={webhookConfig?.enabled}
        onclick={() => (showWebhookModal = true)}
        title="Configure webhook output"
      >
        🔗 Webhook
        {#if webhookConfig?.enabled && webhookStats.sent > 0}
          <span class="wh-count ok">{webhookStats.sent}</span>
        {/if}
        {#if webhookStats.failed > 0}
          <span class="wh-count fail">{webhookStats.failed}</span>
        {/if}
      </button>
      <button class="ctrl-btn" onclick={clearBuffer} title="Clear buffer">Clear</button>
      <button class="ctrl-btn close" onclick={onClose} title="Stop monitoring">✕</button>
    </div>
  </div>

  <!-- Buffer + Analysis split -->
  <div
  class="buffer-content"
  class:split={showAnalysis}
  class:resizing={isResizing}
  style="--buffer-pct: {bufferPercent}%"
  bind:this={contentEl}
>
    {#if showSender}
      <CommandSender
        {port}
        presets={analysisResult?.command_presets ?? []}
        onClose={() => (showSender = false)}
      />
    {/if}
    <div
      class="buffer-body"
      bind:this={bufferEl}
      onscroll={handleScroll}
    >
      {#if lines.length === 0}
        <div class="empty">
          <span class="cursor">█</span>
          <span>Waiting for data…</span>
        </div>
      {:else}
        {#each lines as line (line.id)}
          <div class="line" class:tx={line.direction === 'tx'}>
            <span class="dir-marker" class:tx={line.direction === 'tx'}>
              {line.direction === 'tx' ? '→' : '←'}
            </span>
            <span class="ts">{formatTimestamp(line.timestamp)}</span>
            <span class="sep">│</span>
            {#if showHex}
              <span class="hex">{line.hex}</span>
              <span class="sep">│</span>
              <span class="ascii">{line.ascii}</span>
            {:else}
              <span class="ascii">{line.ascii}</span>
            {/if}
            <span class="bytecount">{line.bytes}B</span>
          </div>
        {/each}
      {/if}
    </div>

    {#if showAnalysis}
      <!-- Drag handle to resize buffer vs analysis panel.
           Focusable separator per ARIA spec — with aria-valuenow + keyboard
           arrows, this IS an interactive separator. Svelte's a11y lint
           doesn't recognize "separator" as interactive, so we suppress here. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(bufferPercent)}
        aria-valuemin="15"
        aria-valuemax="85"
        aria-label="Resize panel split — ArrowUp/Down to adjust, Home to reset"
        tabindex="0"
        onmousedown={startResize}
        ondblclick={() => (bufferPercent = 55)}
        onkeydown={handleResizeKeydown}
        title="Drag to resize · double-click or Home key to reset"
      >
        <span class="resize-grip"></span>
      </div>
      <div class="analysis-slot">
        <div class="bottom-tabs">
          <button
            class="bt-tab"
            class:active={bottomTab === 'detective'}
            onclick={() => (bottomTab = 'detective')}
          >
            🧠 Detective
          </button>
          <button
            class="bt-tab"
            class:active={bottomTab === 'dashboard'}
            disabled={!hasParsableFields}
            onclick={() => (bottomTab = 'dashboard')}
            title={hasParsableFields ? 'Live structured values' : 'Needs fresh analysis with parsing rules'}
          >
            📊 Dashboard
            {#if hasParsableFields}
              <span class="tab-live-dot"></span>
            {/if}
          </button>
          <button
            class="bt-tab"
            class:active={bottomTab === 'investigation'}
            disabled={agentTrace.length === 0 && !investigating}
            onclick={() => (bottomTab = 'investigation')}
            title={agentTrace.length > 0 || investigating ? 'Agent investigation trace' : 'Run 🔬 Investigate first'}
          >
            🔍 Investigation
            {#if investigating}
              <span class="tab-live-dot investigating"></span>
            {:else if agentTrace.length > 0}
              <span class="tab-count">{agentTrace.length}</span>
            {/if}
          </button>
          <button
            class="bt-tab"
            class:active={bottomTab === 'ask'}
            onclick={() => (bottomTab = 'ask')}
            title="Ask Muse Spark natural-language questions about the live data"
          >
            🤖 Ask
            {#if chatHistory.length > 0}
              <span class="tab-count">{Math.floor(chatHistory.length / 2)}</span>
            {/if}
          </button>
          <div class="bt-spacer"></div>
          <button class="bt-close" onclick={closeAnalysis} title="Hide panel">✕</button>
        </div>
        <div class="bt-content">
          {#if bottomTab === 'detective'}
            <AnalysisPanel
              analysis={analysisResult}
              loading={analysisLoading}
              error={analysisError}
              recognized={isRecognized}
              sampleCount={recognizedSampleCount}
              onFieldEdit={handleFieldEdit}
            />
          {:else if bottomTab === 'dashboard'}
            <StructuredDashboard
              fields={analysisResult?.fields ?? []}
              {lines}
            />
            {#if punyaFieldBerat}
              <ScalePushPanel
                config={webhookConfig}
                payload={buildPayload()}
                stats={webhookStats}
                onStatsChange={(s) => (webhookStats = s)}
              />
            {/if}
          {:else if bottomTab === 'investigation'}
            <AgentTracePanel
              trace={agentTrace}
              loading={investigating}
              error={agentError}
              apiCalls={agentApiCalls}
              stoppedAt={agentStoppedAt}
              usage={agentUsage}
            />
          {:else if bottomTab === 'ask'}
            <ChatPanel
              bind:history={chatHistory}
              {lines}
              analysis={analysisResult}
            />
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

{#if showWebhookModal}
  <WebhookConfigModal
    config={webhookConfig}
    stats={webhookStats}
    samplePayload={buildPayload()}
    onSave={handleWebhookSave}
    onClose={() => (showWebhookModal = false)}
  />
{/if}

<style>
  .buffer-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #0d0d14;
    border-left: 1px solid #1e1e30;
  }

  .buffer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.8rem;
    border-bottom: 1px solid #1e1e30;
    background: #111120;
    flex-shrink: 0;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .title-area {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22c55e;
    flex-shrink: 0;
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 #22c55e44; }
    50% { opacity: 0.7; box-shadow: 0 0 0 4px #22c55e00; }
  }

  .port-label {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    font-size: 0.85rem;
    color: #e0e0f0;
  }

  .full-path {
    font-size: 0.7rem;
    color: #4a4a6a;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .line-count {
    font-size: 0.68rem;
    color: #3a3a5a;
    margin-left: 0.25rem;
  }

  .gate-chip {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    margin-left: 0.4rem;
  }
  .gate-chip.held {
    background: #3a1515;
    color: #fca5a5;
  }
  .gate-chip.naive {
    background: #3a3215;
    color: #fcd34d;
  }
  .gate-chip.ok {
    background: #14301f;
    color: #86efac;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
    color: #7a7a9a;
    cursor: pointer;
    white-space: nowrap;
  }

  .toggle-label input[type='checkbox'] {
    accent-color: #4f6ef7;
    width: 12px;
    height: 12px;
  }

  .ctrl-btn {
    font-size: 0.7rem;
    padding: 0.2rem 0.55rem;
    border-radius: 4px;
    border: 1px solid #2a2a42;
    background: #1a1a28;
    color: #7a7a9a;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
  }

  .ctrl-btn:hover:not(:disabled) {
    color: #c0c0e0;
    border-color: #3a3a56;
  }

  .ctrl-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .ctrl-btn.analyze {
    border-color: #2a3050;
    color: #6080c0;
    background: #111830;
  }

  .ctrl-btn.analyze:hover:not(:disabled) {
    background: #182040;
    border-color: #3a50a0;
    color: #90b0ff;
  }

  .ctrl-btn.investigate {
    border-color: #3a2a50;
    color: #a090e0;
    background: #1a1230;
  }

  .ctrl-btn.investigate:hover:not(:disabled) {
    background: #22183a;
    border-color: #5a3a80;
    color: #c8a8ff;
  }

  .ctrl-btn.send {
    border-color: #3a2e14;
    color: #d4a548;
    background: #1a1408;
  }

  .ctrl-btn.send:hover {
    background: #22180a;
    border-color: #6a4e20;
    color: #fbbf24;
  }

  .ctrl-btn.send.active {
    background: #261a08;
    border-color: #8a6828;
    color: #fcd34d;
    box-shadow: 0 0 0 1px #8a6828 inset;
  }

  /* Export dropdown */
  .export-wrap {
    position: relative;
    display: inline-flex;
  }

  .ctrl-btn.export {
    border-color: #2a3042;
    color: #7a8aa8;
    background: #141822;
  }

  .ctrl-btn.export:hover:not(:disabled) {
    background: #1a2030;
    color: #a0b0d8;
  }

  .chevron {
    font-size: 0.55rem;
    opacity: 0.7;
    transition: transform 0.15s;
    display: inline-block;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .export-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 230px;
    background: #0f1428;
    border: 1px solid #2a3450;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    padding: 0.35rem 0;
    z-index: 100;
    animation: menuFadeIn 0.15s ease-out;
  }

  @keyframes menuFadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .menu-section-label {
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #4a5a7a;
    padding: 0.3rem 0.8rem 0.2rem;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.8rem;
    background: none;
    border: none;
    color: #c0c8e0;
    font-size: 0.78rem;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    transition: background 0.12s;
  }

  .menu-item:hover:not(:disabled) {
    background: #1a2038;
    color: #e0e8ff;
  }

  .menu-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .menu-icon {
    font-size: 0.85rem;
    width: 1.1rem;
    text-align: center;
  }

  .menu-label {
    flex: 1;
    font-weight: 500;
  }

  .menu-hint {
    font-size: 0.66rem;
    color: #5a6a8a;
    font-family: "JetBrains Mono", monospace;
  }

  .menu-divider {
    height: 1px;
    background: #1e2a40;
    margin: 0.3rem 0.5rem;
  }

  .ctrl-btn.webhook {
    border-color: #2a3042;
    color: #7a8aa8;
    background: #141822;
  }

  .ctrl-btn.webhook:hover {
    background: #1a2030;
    color: #a0b0d8;
  }

  .ctrl-btn.webhook.active {
    background: #0e2018;
    border-color: #1e4028;
    color: #22c55e;
    box-shadow: 0 0 0 1px #1e4028 inset;
  }

  .wh-count {
    font-size: 0.6rem;
    padding: 0.05rem 0.3rem;
    border-radius: 8px;
    font-family: "JetBrains Mono", monospace;
    font-weight: 600;
    margin-left: 0.1rem;
  }

  .wh-count.ok {
    background: #1e4028;
    color: #4ade80;
  }

  .wh-count.fail {
    background: #401e1e;
    color: #f87171;
  }

  .ctrl-btn.live {
    border-color: #2a3a2a;
    color: #6a8a6a;
    background: #101810;
  }

  .ctrl-btn.live:hover {
    color: #80c080;
    border-color: #3a5a3a;
  }

  .ctrl-btn.live.active {
    background: #1a3018;
    border-color: #3a7030;
    color: #90e090;
    box-shadow: 0 0 0 1px #3a7030 inset, 0 0 10px #22c55e22;
  }

  .ctrl-btn.live.active .live-icon {
    animation: zap 1.5s ease-in-out infinite;
  }

  @keyframes zap {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(1.15); }
  }

  .live-progress {
    font-size: 0.6rem;
    background: #22401e;
    color: #b0e8a0;
    padding: 0.05rem 0.3rem;
    border-radius: 8px;
    font-family: "JetBrains Mono", monospace;
    margin-left: 0.1rem;
  }

  .ctrl-btn.close {
    color: #5a3a3a;
    border-color: #3a2a2a;
  }

  .ctrl-btn.close:hover {
    color: #f87171;
    border-color: #5a2a2a;
    background: #1e1414;
  }

  .spin-sm {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* Buffer + Analysis layout */
  .buffer-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .buffer-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.4rem 0;
    font-family: "JetBrains Mono", "Fira Code", "Consolas", monospace;
    font-size: 0.78rem;
    scrollbar-width: thin;
    scrollbar-color: #2a2a42 transparent;
    min-height: 0;
  }

  .buffer-content.split .buffer-body {
    flex: 0 0 var(--buffer-pct, 55%);
    min-height: 0;
  }

  .buffer-content.split .analysis-slot {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* Drag handle between top buffer and bottom analysis panel.
     Subtle by default; visible grip on hover; cursor changes to ns-resize. */
  .resize-handle {
    flex: 0 0 6px;
    background: #1e2a40;
    cursor: ns-resize;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
  }

  .resize-handle:hover,
  .resize-handle:focus-visible {
    background: #4f6ef7;
    outline: none;
  }

  .resize-grip {
    width: 36px;
    height: 2px;
    background: #3a4a6a;
    border-radius: 2px;
    transition: background 0.15s;
  }

  .resize-handle:hover .resize-grip,
  .resize-handle:focus-visible .resize-grip {
    background: #c0d0ff;
  }

  /* During active drag: disable text selection on the whole panel so
     the cursor can sweep freely without highlighting trace contents. */
  .buffer-content.resizing {
    user-select: none;
  }
  .buffer-content.resizing .resize-handle {
    background: #4f6ef7;
  }
  .buffer-content.resizing .resize-grip {
    background: #c0d0ff;
  }

  /* Bottom tab bar */
  .bottom-tabs {
    display: flex;
    align-items: center;
    background: #0a0e1a;
    border-bottom: 1px solid #1a2038;
    padding: 0 0.3rem;
    flex-shrink: 0;
  }

  .bt-tab {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.4rem 0.7rem;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #4a5a7a;
    font-size: 0.72rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .bt-tab:hover:not(:disabled) {
    color: #8090c0;
  }

  .bt-tab.active {
    color: #b0c0f0;
    border-bottom-color: #4f6ef7;
  }

  .bt-tab:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .tab-live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    animation: pulse 1.2s ease-in-out infinite;
    margin-left: 0.1rem;
  }

  .tab-live-dot.investigating {
    background: #a090e0;
  }

  .tab-count {
    background: #2a1e42;
    color: #c8a8ff;
    font-size: 0.6rem;
    font-family: "JetBrains Mono", monospace;
    font-weight: 600;
    padding: 0.05rem 0.35rem;
    border-radius: 9px;
    margin-left: 0.1rem;
  }

  .bt-spacer { flex: 1; }

  .bt-close {
    background: none;
    border: none;
    color: #3a3a5a;
    cursor: pointer;
    font-size: 0.7rem;
    padding: 0.2rem 0.4rem;
    transition: color 0.15s;
  }

  .bt-close:hover { color: #f87171; }

  .bt-content {
    flex: 1;
    overflow: hidden;
  }

  .buffer-body::-webkit-scrollbar { width: 6px; }
  .buffer-body::-webkit-scrollbar-thumb { background: #2a2a42; border-radius: 3px; }

  .empty {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 1.5rem 1rem;
    color: #3a3a5a;
    font-size: 0.8rem;
  }

  .cursor {
    animation: blink 1s step-start infinite;
    color: #4f6ef7;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.1rem 0.8rem;
    border-bottom: 1px solid #111120;
    line-height: 1.6;
    transition: background 0.1s;
  }

  .line:hover { background: #141424; }

  .line.tx {
    background: linear-gradient(90deg, #1a1408 0%, #111120 20%);
  }

  .line.tx:hover { background: linear-gradient(90deg, #241a0c 0%, #141424 20%); }

  .dir-marker {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.75rem;
    color: #4a5a6a;
    flex-shrink: 0;
    width: 10px;
    font-weight: 700;
  }

  .dir-marker.tx {
    color: #f59e0b;
  }

  .ts {
    color: #3a3a5a;
    flex-shrink: 0;
    font-size: 0.72rem;
    letter-spacing: 0.02em;
  }

  .sep {
    color: #2a2a42;
    flex-shrink: 0;
  }

  .hex {
    color: #4f6ef7;
    letter-spacing: 0.06em;
    word-break: break-all;
    flex: 1;
  }

  .ascii {
    color: #c8c8e8;
    white-space: pre-wrap;
    word-break: break-all;
    flex: 1;
  }

  .bytecount {
    color: #2a2a42;
    font-size: 0.65rem;
    flex-shrink: 0;
    margin-left: auto;
  }
</style>
