<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type { AuditEventRow } from './safemode.js';

  let events = $state<AuditEventRow[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let filterEvent = $state('');
  let filterPort = $state('');

  const filtered = $derived(
    events.filter((e) => {
      if (filterEvent && e.event !== filterEvent) return false;
      if (filterPort.trim() && !(e.port ?? '').includes(filterPort.trim())) return false;
      return true;
    })
  );

  const eventTypes = $derived(
    [...new Set(events.map((e) => e.event))].sort()
  );

  async function refresh() {
    loading = true;
    error = null;
    try {
      const res = await invoke<{ events: AuditEventRow[]; total: number }>('safemode_read_audit', {
        limit: 300,
        offset: 0,
      });
      events = res.events;
      total = res.total;
    } catch (e) {
      error = String(e);
      events = [];
      total = 0;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void refresh();
  });

  function formatTs(tsMs: number): string {
    return new Date(tsMs).toLocaleString();
  }
</script>

<div class="audit-panel">
  <div class="toolbar">
    <span class="meta">{filtered.length} shown · {total} total</span>
    <button type="button" class="btn-mini" onclick={() => refresh()} disabled={loading}>
      {loading ? '…' : 'Refresh'}
    </button>
  </div>

  <div class="filters">
    <label>
      Event
      <select bind:value={filterEvent}>
        <option value="">All</option>
        {#each eventTypes as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </label>
    <label>
      Port contains
      <input type="text" placeholder="/dev/cu…" bind:value={filterPort} />
    </label>
  </div>

  {#if error}
    <p class="error">{error}</p>
  {:else if filtered.length === 0}
    <p class="empty">No audit events yet.</p>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Event</th>
            <th>Port</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as row (row.seq)}
            <tr>
              <td>{row.seq}</td>
              <td class="ts">{formatTs(row.ts_ms)}</td>
              <td><code>{row.event}</code></td>
              <td class="port">{row.port ?? '—'}</td>
              <td class="detail">
                {#if row.decision}
                  <span>{row.decision}</span>
                {/if}
                {#if row.reason}
                  <span class="reason">{row.reason}</span>
                {/if}
                {#if row.hex}
                  <code class="hex">{row.hex}</code>
                {/if}
                {#if row.detail}
                  <span class="detail-text">{row.detail}</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .audit-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .meta {
    font-size: 0.75rem;
    color: #7a8aaa;
  }

  .btn-mini {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    border: 1px solid #2a3450;
    background: #151a2e;
    color: #b0c0e8;
    cursor: pointer;
  }

  .filters {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .filters label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.7rem;
    color: #8a9aba;
  }

  .filters select,
  .filters input {
    font-size: 0.78rem;
    padding: 0.3rem 0.45rem;
    border-radius: 6px;
    border: 1px solid #2a3450;
    background: #0a0e1a;
    color: #d0dafa;
    min-width: 8rem;
  }

  .error {
    color: #f87171;
    font-size: 0.8rem;
    margin: 0;
  }

  .empty {
    font-size: 0.8rem;
    color: #6a7a9a;
    margin: 0;
  }

  .table-wrap {
    max-height: 220px;
    overflow: auto;
    border: 1px solid #1e2a40;
    border-radius: 8px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.72rem;
  }

  th,
  td {
    padding: 0.35rem 0.45rem;
    border-bottom: 1px solid #1e2a40;
    text-align: left;
    vertical-align: top;
  }

  th {
    position: sticky;
    top: 0;
    background: #11172d;
    color: #8a9aba;
    font-weight: 600;
  }

  .ts {
    white-space: nowrap;
    color: #8a9aba;
  }

  .port {
    font-family: ui-monospace, monospace;
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .hex {
    font-size: 0.68rem;
    word-break: break-all;
  }

  .reason {
    color: #f0a060;
  }

  .detail-text {
    color: #9aa8c8;
  }
</style>
