<script lang="ts">
  import type { AnalysisField } from '$lib/claude.js';
  import type { DataLine } from '$lib/types.js';
  import { parseStream, latest, numericHistory } from '$lib/parser.js';
  import Sparkline from './Sparkline.svelte';

  let {
    fields,
    lines,
  }: {
    fields: AnalysisField[];
    lines: DataLine[];
  } = $props();

  const parsed = $derived(parseStream(lines, fields));
  const parsableFields = $derived(fields.filter((f) => parsed.compiledRegex[f.name]));

  // Tick every second so "last updated N ago" updates
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  function ago(ts: number, currentNow: number): string {
    const d = currentNow - ts;
    if (d < 1000) return 'just now';
    if (d < 60000) return `${(d / 1000).toFixed(0)}s ago`;
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    return `${Math.floor(d / 3600000)}h ago`;
  }

  function formatValue(v: string | number | boolean, unit?: string): string {
    if (typeof v === 'number') {
      const formatted = Number.isInteger(v) ? v.toString() : v.toFixed(3);
      return unit ? `${formatted} ${unit}` : formatted;
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return unit ? `${v} ${unit}` : v;
  }

  function typeColor(type?: string): string {
    if (type === 'number') return '#4f6ef7';
    if (type === 'boolean') return '#22c55e';
    if (type?.startsWith('hex_')) return '#f97316'; // orange for binary-decoded
    return '#a855f7';
  }

  function isNumericType(t?: string): boolean {
    return t === 'number' || t === 'hex_u16_be' || t === 'hex_u16_le'
      || t === 'hex_s16_be' || t === 'hex_u8';
  }

  function isStale(ts: number, currentNow: number): boolean {
    return currentNow - ts > 5000;
  }
</script>

<div class="dashboard">
  {#if parsableFields.length === 0}
    <div class="no-rules">
      <div class="no-rules-icon">📡</div>
      <div class="no-rules-title">No parsing rules yet</div>
      <div class="no-rules-sub">
        Run <strong>⬡ Analyze</strong> — Muse Spark will generate regex patterns
        to extract live field values from your stream.
      </div>
    </div>
  {:else}
    <div class="cards-grid">
      {#each parsableFields as field (field.name)}
        {@const hist = parsed.history[field.name] ?? []}
        {@const lv = latest(hist)}
        {@const nums = numericHistory(hist)}
        {@const color = typeColor(field.data_type)}
        <div class="card" class:stale={lv && isStale(lv.timestamp, now)} class:empty={!lv}>
          <div class="card-header">
            <span class="field-name">{field.name}</span>
            {#if field.data_type}
              <span class="type-tag" style="color: {color}; border-color: {color}44">
                {field.data_type}
              </span>
            {/if}
          </div>

          <div class="value-row">
            {#if lv}
              <div class="value" style="color: {color}">{formatValue(lv.value, field.unit)}</div>
            {:else}
              <div class="value placeholder">—</div>
            {/if}
          </div>

          {#if isNumericType(field.data_type) && nums.length >= 2}
            <div class="sparkline-wrap">
              <Sparkline values={nums} {color} height={28} />
            </div>
          {/if}

          <div class="footer">
            <span class="desc">{field.description}</span>
            {#if lv}
              <span class="timestamp">{ago(lv.timestamp, now)}</span>
            {/if}
          </div>

          <div class="sample-count">
            {hist.length} sample{hist.length !== 1 ? 's' : ''}
          </div>
        </div>
      {/each}
    </div>

    <div class="dashboard-footer">
      <span class="foot-label">Live parsing active</span>
      <span class="foot-dot"></span>
      <span class="foot-stat">
        {parsableFields.length} field{parsableFields.length !== 1 ? 's' : ''} tracked
        · {lines.length} lines processed
      </span>
    </div>
  {/if}
</div>

<style>
  .dashboard {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #0a0e1a;
    overflow: hidden;
  }

  /* Empty state */
  .no-rules {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 0.4rem;
    padding: 1.5rem;
    color: #3a4a6a;
  }

  .no-rules-icon { font-size: 2rem; opacity: 0.5; }

  .no-rules-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: #5a6a8a;
  }

  .no-rules-sub {
    font-size: 0.72rem;
    line-height: 1.6;
    max-width: 320px;
    color: #4a5a7a;
  }

  .no-rules-sub strong { color: #7090f0; }

  /* Cards grid */
  .cards-grid {
    flex: 1;
    overflow-y: auto;
    padding: 0.6rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 0.5rem;
    scrollbar-width: thin;
    scrollbar-color: #1e2a40 transparent;
  }

  .card {
    background: #0f1628;
    border: 1px solid #1e2a40;
    border-radius: 6px;
    padding: 0.55rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    transition: border-color 0.2s, opacity 0.3s;
    position: relative;
  }

  .card.stale {
    opacity: 0.5;
  }

  .card.empty .value { color: #3a3a5a; }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .field-name {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.7rem;
    color: #6a8aff;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .type-tag {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border: 1px solid;
    border-radius: 3px;
    padding: 0.05rem 0.3rem;
    font-weight: 600;
  }

  .value-row {
    min-height: 1.8rem;
    display: flex;
    align-items: baseline;
  }

  .value {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    animation: valueFlash 0.4s ease-out;
  }

  @keyframes valueFlash {
    0% { transform: scale(1.08); filter: brightness(1.4); }
    100% { transform: scale(1); filter: brightness(1); }
  }

  .value.placeholder {
    animation: none;
    font-weight: 400;
  }

  .sparkline-wrap {
    margin: 0.1rem 0;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.4rem;
    min-height: 0.9rem;
  }

  .desc {
    font-size: 0.65rem;
    color: #4a5a7a;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .timestamp {
    font-size: 0.6rem;
    color: #3a4a6a;
    font-family: "JetBrains Mono", monospace;
    white-space: nowrap;
  }

  .sample-count {
    position: absolute;
    top: 0.3rem;
    right: 0.5rem;
    font-size: 0.55rem;
    color: #2a3a5a;
    font-family: "JetBrains Mono", monospace;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .card:hover .sample-count { opacity: 1; }

  /* Footer bar */
  .dashboard-footer {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.8rem;
    background: #0f1428;
    border-top: 1px solid #1e2a40;
    font-size: 0.65rem;
    color: #4a5a7a;
    flex-shrink: 0;
  }

  .foot-label {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    color: #22c55e;
  }

  .foot-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #22c55e;
    animation: livePulse 1.2s ease-in-out infinite;
  }

  @keyframes livePulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 #22c55e44; }
    50% { opacity: 0.5; box-shadow: 0 0 0 3px #22c55e00; }
  }

  .foot-stat {
    color: #5a6a8a;
  }
</style>
