<script lang="ts">
  import { fly } from 'svelte/transition';
  import { tick } from 'svelte';
  import type { AgentStep, UsageStats } from '$lib/claude.js';

  let {
    trace,
    loading,
    error,
    apiCalls,
    stoppedAt,
    usage = null,
  }: {
    trace: AgentStep[];
    loading: boolean;
    error: string | null;
    apiCalls: number;
    stoppedAt: 'end_turn' | 'max_steps' | 'error' | null;
    usage?: UsageStats | null;
  } = $props();

  function formatCost(c: number): string {
    if (c < 0.001) return '< $0.001';
    if (c < 0.01) return `$${c.toFixed(4)}`;
    return `$${c.toFixed(3)}`;
  }

  function formatTokens(n: number): string {
    if (n < 1000) return `${n}`;
    return `${(n / 1000).toFixed(1)}K`;
  }

  let copyStatus = $state<'idle' | 'copied' | 'failed'>('idle');
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyTraceJson() {
    const payload = {
      exported_at: new Date().toISOString(),
      stopped_at: stoppedAt,
      api_calls: apiCalls,
      usage,
      trace,
    };
    const json = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      copyStatus = 'copied';
    } catch {
      copyStatus = 'failed';
    }
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copyStatus = 'idle'), 2000);
  }

  let expanded = $state<Record<string, boolean>>({});
  let bodyEl = $state<HTMLDivElement | null>(null);
  let seenIds = new Set<string>();

  // Auto-scroll to bottom when new step arrives, and auto-expand
  // reasoning-heavy blocks (thinking/text/final) so judges see the
  // model's prose without having to click each step.
  $effect(() => {
    for (const step of trace) {
      if (!seenIds.has(step.id)) {
        seenIds.add(step.id);
        if (step.type === 'thinking' || step.type === 'text' || step.type === 'final') {
          expanded[step.id] = true;
        }
      }
    }
    tick().then(() => {
      if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
    });
  });

  function toggle(id: string) {
    expanded[id] = !expanded[id];
  }

  function iconFor(type: AgentStep['type']): string {
    switch (type) {
      case 'thinking': return '🧠';
      case 'text': return '💬';
      case 'tool_call': return '🔧';
      case 'tool_result': return '📥';
      case 'final': return '✨';
      case 'error': return '⚠';
    }
  }

  function colorFor(type: AgentStep['type']): string {
    switch (type) {
      case 'thinking': return '#8b5cf6';
      case 'text': return '#60a5fa';
      case 'tool_call': return '#f59e0b';
      case 'tool_result': return '#10b981';
      case 'final': return '#22c55e';
      case 'error': return '#f87171';
    }
  }

  function typeLabel(type: AgentStep['type']): string {
    switch (type) {
      case 'thinking': return 'Thinking';
      case 'text': return 'Agent';
      case 'tool_call': return 'Tool call';
      case 'tool_result': return 'Tool result';
      case 'final': return 'Final';
      case 'error': return 'Error';
    }
  }

  function summary(step: AgentStep): string {
    if (step.type === 'tool_call') {
      const input = step.tool_input ?? {};
      const previewKeys = ['purpose', 'hypothesis', 'count', 'regex', 'baud', 'hex'];
      for (const k of previewKeys) {
        if (k in input && input[k]) {
          const v = String(input[k]);
          return `${step.tool_name}(${k}: ${v.length > 40 ? v.slice(0, 40) + '…' : v})`;
        }
      }
      return `${step.tool_name}()`;
    }
    if (step.type === 'tool_result') {
      const out = step.tool_output ?? '';
      try {
        const parsed = JSON.parse(out);
        if (parsed.error) return `error: ${parsed.error}`;
        // analyze_binary_structure — signature: total_bytes_analyzed + frame_analysis
        if (parsed.total_bytes_analyzed !== undefined) {
          const bits: string[] = [];
          bits.push(`${Math.round(parsed.printable_ratio * 100)}% ASCII`);
          if (parsed.frame_analysis)
            bits.push(`frame=${parsed.frame_analysis.likely_frame_length}B ×${parsed.frame_analysis.frames_detected}`);
          if (parsed.modbus_crc_check && parsed.modbus_crc_check.validity_ratio >= 0.9)
            bits.push('✓ Modbus CRC');
          return bits.join(' · ');
        }
        if (parsed.total_matches !== undefined) return `${parsed.total_matches} matches`;
        if (parsed.returned !== undefined) return `${parsed.returned} lines returned`;
        if (parsed.manufacturer) return `${parsed.manufacturer} · ${parsed.product ?? ''}`;
        // probe_baud_rate — signature: baud + printable_ratio
        if (parsed.printable_ratio !== undefined && parsed.baud !== undefined)
          return `${Math.round(parsed.printable_ratio * 100)}% printable @ ${parsed.baud}`;
        if (parsed.ok !== undefined && parsed.bytes_sent !== undefined)
          return `sent ${parsed.bytes_sent}B · ${parsed.response_lines_captured ?? 0} response lines`;
      } catch {
        // fall through
      }
      return out.length > 60 ? out.slice(0, 60) + '…' : out;
    }
    if (step.type === 'thinking') {
      // First sentence or ~120 chars, whichever is shorter — gives headline
      // while full reasoning is visible in the auto-expanded detail pane.
      const text = step.text ?? '';
      const firstSentence = text.match(/^[^.!?\n]+[.!?]/)?.[0] ?? text;
      const head = firstSentence.length > 120 ? firstSentence.slice(0, 120) + '…' : firstSentence;
      return head;
    }
    if (step.type === 'text') {
      const text = step.text ?? '';
      return text.length > 100 ? text.slice(0, 100) + '…' : text;
    }
    if (step.type === 'final') return step.text ?? 'Completed';
    if (step.type === 'error') return step.error ?? 'Unknown error';
    return '';
  }

  function formatDetail(step: AgentStep): string {
    if (step.type === 'thinking' || step.type === 'text') return step.text ?? '';
    if (step.type === 'tool_call') {
      return JSON.stringify(step.tool_input ?? {}, null, 2);
    }
    if (step.type === 'tool_result') {
      try {
        return JSON.stringify(JSON.parse(step.tool_output ?? ''), null, 2);
      } catch {
        return step.tool_output ?? '';
      }
    }
    if (step.type === 'error') return step.error ?? '';
    return '';
  }

  const toolCallCount = $derived(trace.filter((s) => s.type === 'tool_call').length);
</script>

<div class="trace-panel">
  <div class="trace-header">
    <div class="header-left">
      <span class="title-icon">🔍</span>
      <span class="title">Investigation</span>
      {#if loading}
        <span class="live-badge">
          <span class="pulse-dot"></span>
          Running
        </span>
      {:else if stoppedAt === 'end_turn' && !error}
        <span class="done-badge">✓ Complete</span>
      {:else if error}
        <span class="fail-badge">✗ Failed</span>
      {/if}
    </div>
    <div class="stats">
      {apiCalls} API {apiCalls === 1 ? 'call' : 'calls'} ·
      {toolCallCount} {toolCallCount === 1 ? 'tool' : 'tools'} ·
      {trace.length} {trace.length === 1 ? 'step' : 'steps'}
      {#if usage && (usage.input_tokens > 0 || usage.output_tokens > 0)}
        <span
          class="cost-chip"
          title={`Tokens · in: ${usage.input_tokens} · out: ${usage.output_tokens} · cached: ${usage.cache_read_tokens} · cache-write: ${usage.cache_write_tokens}\nEstimated cost at Muse Spark Standard rates (dev.meta.ai pricing).`}
        >
          💰 {formatCost(usage.estimated_cost_usd)}
          {#if usage.cache_hit_ratio > 0.1}
            <span class="cache-ratio">· {Math.round(usage.cache_hit_ratio * 100)}% cache</span>
          {/if}
        </span>
      {/if}
      {#if trace.length > 0}
        <button
          class="copy-btn"
          onclick={copyTraceJson}
          title="Copy full trace as JSON — useful for bug reports or sharing"
          class:success={copyStatus === 'copied'}
          class:failed={copyStatus === 'failed'}
        >
          {#if copyStatus === 'copied'}
            ✓ Copied
          {:else if copyStatus === 'failed'}
            ✗ Failed
          {:else}
            📋 Copy JSON
          {/if}
        </button>
      {/if}
    </div>
  </div>

  <div class="trace-body" bind:this={bodyEl}>
    {#if trace.length === 0 && !loading}
      <div class="empty">
        <div class="empty-icon">🔬</div>
        <div class="empty-title">Ready to investigate</div>
        <div class="empty-sub">
          Click <strong>🔬 Investigate</strong> — Muse Spark will use tools to
          iteratively identify this device's protocol.
        </div>
      </div>
    {:else}
      {#each trace as step, i (step.id)}
        <div
          class="step"
          class:expanded={expanded[step.id]}
          class:is-error={step.type === 'error'}
          class:is-final={step.type === 'final'}
          class:is-thinking={step.type === 'thinking'}
          class:is-tool-call={step.type === 'tool_call'}
          class:is-tool-result={step.type === 'tool_result'}
          style="--step-color: {colorFor(step.type)}"
          in:fly={{ y: 8, duration: 250 }}
        >
          <div class="step-main" role="button" tabindex="0" onclick={() => toggle(step.id)}
               onkeydown={(e) => e.key === 'Enter' && toggle(step.id)}>
            <div class="step-icon">{iconFor(step.type)}</div>
            <div class="step-body">
              <div class="step-meta">
                <span class="step-type">{typeLabel(step.type)}</span>
                <span class="step-number">#{i + 1}</span>
              </div>
              <div class="step-summary">{summary(step)}</div>
            </div>
            <span class="step-chevron" class:rotated={expanded[step.id]}>▸</span>
          </div>

          {#if expanded[step.id]}
            <div class="step-detail" in:fly={{ y: -4, duration: 150 }}>
              <pre>{formatDetail(step)}</pre>
            </div>
          {/if}
        </div>
      {/each}

      {#if loading}
        <div class="thinking-row" in:fly={{ y: 8, duration: 200 }}>
          <div class="thinking-dots">
            <span></span><span></span><span></span>
          </div>
          <span class="thinking-text">Muse Spark is thinking…</span>
        </div>
      {/if}

      {#if !loading && stoppedAt === 'end_turn' && usage && usage.estimated_cost_usd > 0}
        <div class="cost-summary" in:fly={{ y: 8, duration: 300 }}>
          <div class="cost-summary-header">
            <span class="cost-summary-icon">💰</span>
            <span class="cost-summary-title">Investigation cost</span>
            <span class="cost-summary-total">{formatCost(usage.estimated_cost_usd)}</span>
          </div>
          <div class="cost-summary-grid">
            <div class="cost-row">
              <span class="cost-label">Input tokens (fresh)</span>
              <span class="cost-value">{formatTokens(usage.input_tokens)}</span>
            </div>
            <div class="cost-row">
              <span class="cost-label">Input tokens (cached, ~10× cheaper)</span>
              <span class="cost-value cached">{formatTokens(usage.cache_read_tokens)}</span>
            </div>
            <div class="cost-row">
              <span class="cost-label">Output tokens</span>
              <span class="cost-value">{formatTokens(usage.output_tokens)}</span>
            </div>
            <div class="cost-row">
              <span class="cost-label">Prompt cache hit ratio</span>
              <span class="cost-value cached">{Math.round(usage.cache_hit_ratio * 100)}%</span>
            </div>
          </div>
          <div class="cost-summary-note">
            Token counts for this investigation. Cached input is cheaper than a fresh prompt.
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .trace-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #0a0e1a;
    overflow: hidden;
  }

  .trace-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.8rem;
    background: #0f1428;
    border-bottom: 1px solid #1e2a40;
    flex-shrink: 0;
    gap: 0.5rem;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .title-icon { font-size: 0.9rem; }

  .title {
    font-size: 0.72rem;
    font-weight: 600;
    color: #9090e0;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .live-badge,
  .done-badge,
  .fail-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.62rem;
    padding: 0.05rem 0.45rem;
    border-radius: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .live-badge {
    background: #1a2a50;
    color: #6080d0;
    border: 1px solid #2a3a60;
  }

  .done-badge {
    background: #0e2018;
    color: #22c55e;
    border: 1px solid #1e4028;
  }

  .fail-badge {
    background: #1e0e0e;
    color: #f87171;
    border: 1px solid #4a1e1e;
  }

  .pulse-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #6080d0;
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .stats {
    font-size: 0.64rem;
    color: #4a5a7a;
    font-family: "JetBrains Mono", monospace;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .cost-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.62rem;
    padding: 0.1rem 0.4rem;
    background: #1f2a14;
    color: #86efac;
    border: 1px solid #2d4020;
    border-radius: 10px;
    cursor: help;
    font-weight: 600;
  }

  .cost-chip .cache-ratio {
    color: #f59e0b;
    opacity: 0.9;
    font-weight: 500;
  }

  .copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.62rem;
    padding: 0.1rem 0.45rem;
    background: #1a2438;
    color: #8a9ab8;
    border: 1px solid #2a3450;
    border-radius: 10px;
    cursor: pointer;
    font-family: inherit;
    font-weight: 500;
    transition: all 0.15s;
  }

  .copy-btn:hover {
    background: #24304a;
    color: #a0b0d0;
    border-color: #3a4a70;
  }

  .copy-btn.success {
    background: #0e2018;
    color: #22c55e;
    border-color: #1e4028;
  }

  .copy-btn.failed {
    background: #1a0e0e;
    color: #f87171;
    border-color: #3a1a1a;
  }

  /* Prominent summary card shown at the end of a successful investigation.
     Visible in the video Shot 3 payoff — explicitly demonstrates cost
     consciousness and prompt-caching benefit to judges. */
  .cost-summary {
    background: linear-gradient(135deg, #0d1a0f 0%, #0f1828 100%);
    border: 1px solid #1e3a1e;
    border-left: 3px solid #22c55e;
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    margin-top: 0.4rem;
  }

  .cost-summary-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.45rem;
  }

  .cost-summary-icon { font-size: 0.95rem; }

  .cost-summary-title {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #86efac;
    flex: 1;
  }

  .cost-summary-total {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.92rem;
    font-weight: 700;
    color: #4ade80;
  }

  .cost-summary-grid {
    display: grid;
    grid-template-columns: 1fr auto;
    row-gap: 0.25rem;
    column-gap: 0.8rem;
    margin-bottom: 0.4rem;
  }

  .cost-row {
    display: contents;
  }

  .cost-label {
    font-size: 0.68rem;
    color: #7a9088;
  }

  .cost-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.7rem;
    font-weight: 600;
    color: #b0d0b8;
    text-align: right;
  }

  .cost-value.cached {
    color: #f59e0b;
  }

  .cost-summary-note {
    font-size: 0.62rem;
    color: #4a6a5a;
    line-height: 1.5;
    padding-top: 0.35rem;
    border-top: 1px solid #1a2a1a;
    font-style: italic;
  }

  /* Body */
  .trace-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    scrollbar-width: thin;
    scrollbar-color: #2a3450 transparent;
  }

  /* Empty state */
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 1.5rem;
    gap: 0.3rem;
    color: #3a4a6a;
  }

  .empty-icon { font-size: 2rem; opacity: 0.5; }

  .empty-title {
    font-size: 0.82rem;
    font-weight: 600;
    color: #5a6a8a;
  }

  .empty-sub {
    font-size: 0.72rem;
    color: #4a5a7a;
    line-height: 1.6;
    max-width: 280px;
  }

  .empty-sub strong { color: #9090e0; }

  /* Step card */
  .step {
    background: #0f1828;
    border: 1px solid #1a2340;
    border-left: 3px solid var(--step-color, #4f6ef7);
    border-radius: 5px;
    overflow: hidden;
    transition: border-color 0.15s;
    position: relative;
  }

  .step:hover {
    border-color: #2a3a5a;
  }

  .step.is-final {
    background: linear-gradient(90deg, #0f1a14 0%, #0f1828 60%);
  }

  .step.is-error {
    background: #1a0e0e;
  }

  /* Thinking blocks get subtle purple gradient + thicker accent —
     visually signals "this is Claude's internal reasoning" and
     draws the eye even in a busy trace. */
  .step.is-thinking {
    background: linear-gradient(90deg, #150f28 0%, #0f1428 65%);
    border-left-width: 4px;
    box-shadow: inset 0 0 0 1px rgba(139, 92, 246, 0.08);
  }

  .step.is-thinking .step-detail {
    background: rgba(139, 92, 246, 0.04);
    border-top-color: rgba(139, 92, 246, 0.18);
  }

  .step.is-thinking .step-detail pre {
    color: #c4b5fd;
    font-family: Inter, system-ui, sans-serif;
    font-size: 0.72rem;
    line-height: 1.65;
    font-style: italic;
    max-height: 320px;
  }

  /* Tool calls — amber accent, monospace detail */
  .step.is-tool-call {
    background: linear-gradient(90deg, #1a1408 0%, #0f1828 60%);
  }

  /* Tool results — green accent, slightly brighter text for scanning */
  .step.is-tool-result .step-detail pre {
    color: #b0e0c8;
  }

  .step-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.55rem;
    cursor: pointer;
    user-select: none;
  }

  .step-icon {
    font-size: 0.9rem;
    flex-shrink: 0;
    width: 20px;
    text-align: center;
  }

  .step-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .step-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.62rem;
    color: #5a6a8a;
  }

  .step-type {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--step-color);
  }

  .step-number {
    font-family: "JetBrains Mono", monospace;
    color: #3a4a6a;
  }

  .step-summary {
    font-size: 0.74rem;
    color: #b0c0d8;
    font-family: "JetBrains Mono", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.4;
  }

  .step-chevron {
    font-size: 0.6rem;
    color: #4a5a7a;
    flex-shrink: 0;
    transition: transform 0.15s;
  }

  .step-chevron.rotated {
    transform: rotate(90deg);
  }

  .step-detail {
    padding: 0.3rem 0.6rem 0.5rem 2rem;
    border-top: 1px solid #1a2340;
    background: #080c18;
  }

  .step-detail pre {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.68rem;
    line-height: 1.5;
    color: #9aaad0;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 220px;
    overflow-y: auto;
    margin: 0;
  }

  /* Thinking indicator (while loading) */
  .thinking-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    background: #0f1428;
    border: 1px dashed #2a3a5a;
    border-radius: 5px;
    font-size: 0.72rem;
    color: #7090f0;
  }

  .thinking-dots {
    display: flex;
    gap: 0.2rem;
  }

  .thinking-dots span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #7090f0;
    animation: dotBounce 1.2s ease-in-out infinite;
  }

  .thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.3s; }

  @keyframes dotBounce {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-3px); }
  }

  .thinking-text {
    font-style: italic;
  }
</style>
