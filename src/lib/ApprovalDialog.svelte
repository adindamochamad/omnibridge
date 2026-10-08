<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import {
    formatCountdownSeconds,
    formatHexAsciiRows,
    remainingApprovalMs,
    type ApprovalRequestedPayload,
  } from './safemode.js';

  let queue = $state<ApprovalRequestedPayload[]>([]);
  let countdownMs = $state(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  const current = $derived(queue[0] ?? null);
  const rows = $derived(
    current ? formatHexAsciiRows(current.hex, current.ascii) : []
  );

  function clearTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startCountdown() {
    clearTimer();
    if (!current) return;
    const tick = () => {
      const left = remainingApprovalMs(current.expiresAt);
      countdownMs = left;
      if (left <= 0) {
        clearTimer();
        void resolveCurrent(false);
      }
    };
    tick();
    timer = setInterval(tick, 200);
  }

  $effect(() => {
    if (current) {
      startCountdown();
    } else {
      clearTimer();
    }
    return () => clearTimer();
  });

  async function resolveCurrent(approve: boolean) {
    const item = queue[0];
    if (!item) return;
    clearTimer();
    try {
      await invoke('safemode_resolve_approval', { id: item.id, approve });
    } catch {
      // ignore — Rust ignores unknown/expired ids as well
    }
    queue = queue.slice(1);
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;
    listen<ApprovalRequestedPayload>('safemode:approval_requested', (ev) => {
      queue = [...queue, ev.payload];
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      clearTimer();
    };
  });
</script>

{#if current}
  <div class="backdrop" role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <header>
        <h2 id="approval-title">Safe Mode — approve write?</h2>
        <p class="port">Port: <code>{current.port}</code></p>
      </header>

      <div class="body">
        <p class="untrusted-label">Reason <span class="untrusted-tag">untrusted, written by AI</span></p>
        <p class="reason">{current.reason}</p>

        <table class="hex-table">
          <thead>
            <tr>
              <th>Offset</th>
              <th>Hex</th>
              <th>ASCII</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.offset)}
              <tr>
                <td class="offset">{row.offset.toString(16).toUpperCase().padStart(4, '0')}</td>
                <td class="hex">{row.hex}</td>
                <td class="ascii">{row.ascii}</td>
              </tr>
            {/each}
          </tbody>
        </table>

        <p class="countdown">
          Auto-deny in <strong>{formatCountdownSeconds(countdownMs)}</strong>s
        </p>
      </div>

      <footer>
        <button type="button" class="btn-deny" onclick={() => resolveCurrent(false)}>Deny</button>
        <button type="button" class="btn-approve" onclick={() => resolveCurrent(true)}>Approve</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    padding: 1rem;
  }

  .modal {
    background: var(--surface-elevated, #1e1e2e);
    color: var(--text-primary, #e8e8f0);
    border: 1px solid var(--border-subtle, #3a3a4a);
    border-radius: 12px;
    max-width: 640px;
    width: 100%;
    max-height: 90vh;
    overflow: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
  }

  header {
    padding: 1rem 1.25rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle, #3a3a4a);
  }

  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
  }

  .port {
    margin: 0;
    font-size: 0.9rem;
    opacity: 0.9;
  }

  .body {
    padding: 1rem 1.25rem;
  }

  .untrusted-label {
    margin: 0 0 0.25rem;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .untrusted-tag {
    font-weight: 400;
    font-size: 0.75rem;
    color: #f0a060;
  }

  .reason {
    margin: 0 0 1rem;
    font-size: 0.95rem;
    line-height: 1.4;
    word-break: break-word;
  }

  .hex-table {
    width: 100%;
    border-collapse: collapse;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    margin-bottom: 1rem;
  }

  .hex-table th,
  .hex-table td {
    border: 1px solid var(--border-subtle, #3a3a4a);
    padding: 0.35rem 0.5rem;
    text-align: left;
  }

  .offset {
    width: 4rem;
    color: #888;
  }

  .hex {
    word-break: break-all;
  }

  .ascii {
    white-space: pre;
  }

  .countdown {
    margin: 0;
    font-size: 0.9rem;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem 1rem;
    border-top: 1px solid var(--border-subtle, #3a3a4a);
  }

  .btn-deny,
  .btn-approve {
    border: none;
    border-radius: 8px;
    padding: 0.5rem 1rem;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-deny {
    background: #3a3a4a;
    color: #e8e8f0;
  }

  .btn-approve {
    background: #2d6a4f;
    color: #fff;
  }
</style>
