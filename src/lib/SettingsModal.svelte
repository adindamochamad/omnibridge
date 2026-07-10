<script lang="ts">
  import { getApiKey, setApiKey, clearApiKey } from '$lib/settings.js';
  import { getAllProfiles, clearAllProfiles } from '$lib/profiles.js';
  import versiPkg from '../../package.json';
  import Anthropic from '@anthropic-ai/sdk';

  let { onClose }: { onClose: () => void } = $props();

  let apiKey = $state('');
  let showKey = $state(false);
  let saving = $state(false);
  let testing = $state(false);
  let testResult = $state<{ ok: boolean; message: string } | null>(null);
  let profileCount = $state(0);
  let keySource = $state<'store' | 'env' | 'none'>('none');

  $effect(() => {
    load();
  });

  async function load() {
    try {
      const envKey = import.meta.env.DEV
        ? ((import.meta.env.VITE_ANTHROPIC_API_KEY as string) || '')
        : '';
      const stored = await getApiKey();
      if (stored) {
        apiKey = stored;
        keySource = stored === envKey && envKey ? 'env' : 'store';
      } else if (envKey) {
        apiKey = envKey;
        keySource = 'env';
      }
    } catch {
      // fall through
    }
    try {
      const profiles = await getAllProfiles();
      profileCount = Object.keys(profiles).length;
    } catch {
      profileCount = 0;
    }
  }

  async function handleSave() {
    if (!apiKey.trim()) return;
    saving = true;
    try {
      await setApiKey(apiKey.trim());
      keySource = 'store';
      testResult = { ok: true, message: 'Saved to app data store' };
    } catch (e) {
      testResult = { ok: false, message: String(e) };
    } finally {
      saving = false;
    }
  }

  async function handleTest() {
    if (!apiKey.trim()) return;
    testing = true;
    testResult = null;
    try {
      const client = new Anthropic({
        apiKey: apiKey.trim(),
        dangerouslyAllowBrowser: true,
      });
      const res = await client.models.list();
      const count = res.data?.length ?? 0;
      testResult = { ok: true, message: `✓ Connected — ${count} models available` };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      testResult = { ok: false, message: `✗ ${msg.slice(0, 140)}` };
    } finally {
      testing = false;
    }
  }

  // Inline 2-step confirmation — Tauri v2's webview does not reliably show
  // the browser `confirm()` dialog, so we use "click again within 4s" instead.
  let keyConfirmPending = $state(false);
  let keyConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  async function handleClearKey() {
    if (!keyConfirmPending) {
      keyConfirmPending = true;
      if (keyConfirmTimer) clearTimeout(keyConfirmTimer);
      keyConfirmTimer = setTimeout(() => (keyConfirmPending = false), 4000);
      return;
    }
    if (keyConfirmTimer) clearTimeout(keyConfirmTimer);
    keyConfirmPending = false;
    await clearApiKey();
    apiKey = '';
    keySource = 'none';
    testResult = null;
  }

  let clearingProfiles = $state(false);
  let profilesCleared = $state(false);
  let profilesConfirmPending = $state(false);
  let profilesConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  async function handleClearProfiles() {
    if (profileCount === 0) return;
    if (!profilesConfirmPending) {
      profilesConfirmPending = true;
      if (profilesConfirmTimer) clearTimeout(profilesConfirmTimer);
      profilesConfirmTimer = setTimeout(
        () => (profilesConfirmPending = false),
        4000
      );
      return;
    }
    if (profilesConfirmTimer) clearTimeout(profilesConfirmTimer);
    profilesConfirmPending = false;
    clearingProfiles = true;
    try {
      await clearAllProfiles();
      profileCount = 0;
      profilesCleared = true;
      setTimeout(() => (profilesCleared = false), 2500);
    } finally {
      clearingProfiles = false;
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function mask(s: string): string {
    if (s.length < 20) return s;
    return `${s.slice(0, 12)}…${s.slice(-6)}`;
  }
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={handleBackdrop}
  onkeydown={(e) => e.key === 'Escape' && onClose()}
  tabindex="-1"
>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header>
      <div class="title">
        <span class="icon">⚙</span>
        <h2 id="settings-title">Settings</h2>
      </div>
      <button class="close-x" onclick={onClose} aria-label="Close">✕</button>
    </header>

    <div class="body">
      <!-- API key section -->
      <section class="section">
        <div class="section-title">
          <span class="section-icon">🔑</span>
          <span>Anthropic API Key</span>
          {#if keySource === 'store'}
            <span class="source-tag store">stored</span>
          {:else if keySource === 'env'}
            <span class="source-tag env">from .env</span>
          {:else}
            <span class="source-tag none">not set</span>
          {/if}
        </div>

        <div class="input-row">
          {#if showKey}
            <input
              type="text"
              placeholder="Tempel API key Anthropic di sini"
              bind:value={apiKey}
              autocomplete="off"
              spellcheck="false"
            />
          {:else}
            <input
              type="password"
              placeholder="Tempel API key Anthropic di sini"
              bind:value={apiKey}
              autocomplete="off"
              spellcheck="false"
            />
          {/if}
          <button class="btn-mini" onclick={() => (showKey = !showKey)} title={showKey ? 'Hide' : 'Show'}>
            {showKey ? '🙈' : '👁'}
          </button>
        </div>

        <div class="help-text">
          Get your API key at <span class="link">console.anthropic.com</span>.
          Keys are stored in your app data directory, never synced or sent to us.
        </div>

        {#if testResult}
          <div class="test-msg" class:fail={!testResult.ok}>{testResult.message}</div>
        {/if}

        <div class="button-row">
          <button class="btn secondary" onclick={handleTest} disabled={testing || !apiKey.trim()}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button class="btn primary" onclick={handleSave} disabled={saving || !apiKey.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {#if keySource === 'store'}
            <button
            class="btn ghost-danger"
            class:pending-confirm={keyConfirmPending}
            onclick={handleClearKey}
          >
            {keyConfirmPending ? 'Click again' : 'Clear'}
          </button>
          {/if}
        </div>
      </section>

      <div class="divider"></div>

      <!-- Data section -->
      <section class="section">
        <div class="section-title">
          <span class="section-icon">💾</span>
          <span>Learned Data</span>
        </div>
        <div class="stat-row">
          <div class="stat-big">
            <span class="stat-number">{profileCount}</span>
            <span class="stat-unit">device profile{profileCount !== 1 ? 's' : ''}</span>
          </div>
          <div class="stat-help">
            Profiles are stored automatically after each successful protocol analysis (≥55% confidence).
          </div>
        </div>
        <div class="actions-row">
          <button
            class="btn ghost-danger"
            class:pending-confirm={profilesConfirmPending}
            onclick={handleClearProfiles}
            disabled={profileCount === 0 || clearingProfiles}
            title="Remove all learned device profiles — useful before demo recording or stress testing"
          >
            {#if clearingProfiles}
              Clearing…
            {:else if profilesCleared}
              ✓ Cleared
            {:else if profilesConfirmPending}
              Click again to confirm
            {:else}
              Clear learned data
            {/if}
          </button>
        </div>
      </section>

      <div class="divider"></div>

      <!-- About -->
      <section class="section">
        <div class="section-title">
          <span class="section-icon">⬡</span>
          <span>About</span>
        </div>
        <div class="about">
          <div class="about-name">OmniBridge</div>
          <div class="about-tagline">Intelligent Serial Gateway · AI-powered protocol detection</div>
          <div class="about-meta">
            <span>v{versiPkg.version}</span>
            <span>·</span>
            <span>Tauri 2 + Svelte 5</span>
            <span>·</span>
            <span>Claude Opus 4.7</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(5, 8, 15, 0.78);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(6px);
  }

  .modal {
    width: 520px;
    max-width: 90vw;
    max-height: 85vh;
    background: #0f1428;
    border: 1px solid #2a3450;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 80px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.9rem 1.1rem;
    border-bottom: 1px solid #1e2a40;
    background: linear-gradient(to bottom, #11172d, #0a0e1a);
    flex-shrink: 0;
  }

  .title { display: flex; align-items: center; gap: 0.55rem; }
  .icon { font-size: 1.1rem; color: #7090f0; }
  h2 { font-size: 0.95rem; font-weight: 700; color: #d0dafa; margin: 0; letter-spacing: 0.02em; }

  .close-x {
    background: none;
    border: none;
    color: #5a6a8a;
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.2rem 0.5rem;
    transition: color 0.15s;
  }
  .close-x:hover { color: #f87171; }

  .body {
    padding: 1rem 1.1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
    scrollbar-width: thin;
    scrollbar-color: #2a3450 transparent;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .section-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: #b0c0e8;
  }

  .section-icon { font-size: 0.9rem; }

  .source-tag {
    font-size: 0.6rem;
    padding: 0.05rem 0.45rem;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    margin-left: auto;
  }

  .source-tag.store { background: #0e2018; color: #4ade80; border: 1px solid #1e4028; }
  .source-tag.env { background: #1e1e3a; color: #a78bfa; border: 1px solid #3a2e5a; }
  .source-tag.none { background: #2a1e1e; color: #f87171; border: 1px solid #4a2e2e; }

  .input-row {
    display: flex;
    gap: 0.3rem;
    align-items: center;
  }

  .input-row input {
    flex: 1;
    background: #0a0e1a;
    border: 1px solid #2a3450;
    border-radius: 6px;
    color: #d0d8f0;
    font-size: 0.8rem;
    padding: 0.5rem 0.6rem;
    font-family: "JetBrains Mono", monospace;
    outline: none;
    transition: border-color 0.15s;
  }
  .input-row input:focus { border-color: #4f6ef7; }

  .btn-mini {
    background: #1a2038;
    border: 1px solid #2a3450;
    border-radius: 6px;
    padding: 0.4rem 0.55rem;
    cursor: pointer;
    font-size: 0.85rem;
    color: #c0c8e0;
    transition: background 0.15s;
  }
  .btn-mini:hover { background: #22284a; }

  .help-text {
    font-size: 0.7rem;
    color: #5a6a8a;
    line-height: 1.6;
  }

  .link { color: #7090f0; }

  .test-msg {
    padding: 0.4rem 0.6rem;
    background: #0e2018;
    border: 1px solid #1e4028;
    color: #22c55e;
    border-radius: 5px;
    font-size: 0.72rem;
    word-break: break-all;
    font-family: "JetBrains Mono", monospace;
  }

  .test-msg.fail {
    background: #1e0e0e;
    border-color: #4a1e1e;
    color: #f87171;
  }

  .button-row {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
  }

  .btn {
    padding: 0.45rem 1rem;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
    font-family: inherit;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.primary { background: #4f6ef7; color: #fff; }
  .btn.primary:hover:not(:disabled) { background: #3a56e0; }
  .btn.secondary { background: #1a2038; color: #90a8e0; border-color: #2a3450; }
  .btn.secondary:hover:not(:disabled) { background: #202848; }
  .btn.ghost-danger { background: transparent; color: #f87171; }
  .btn.ghost-danger:hover { background: #2a1414; }

  .btn.pending-confirm {
    background: #2a1414 !important;
    color: #fca5a5 !important;
    border-color: #7a2424 !important;
    animation: confirmPulse 1s ease-in-out infinite;
  }

  @keyframes confirmPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0); }
    50%      { box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.15); }
  }

  .divider {
    height: 1px;
    background: #1a2038;
    margin: 1rem 0;
  }

  /* Stats */
  .stat-row {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    background: #0a0e1a;
    border: 1px solid #1e2a40;
    padding: 0.7rem 0.9rem;
    border-radius: 8px;
  }

  .actions-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.5rem;
  }

  .stat-big {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    flex-shrink: 0;
  }

  .stat-number {
    font-family: "JetBrains Mono", monospace;
    font-weight: 700;
    font-size: 1.6rem;
    color: #7090f0;
    line-height: 1;
  }

  .stat-unit {
    font-size: 0.66rem;
    color: #5a6a8a;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .stat-help {
    font-size: 0.7rem;
    color: #7a8aa8;
    line-height: 1.6;
    flex: 1;
  }

  /* About */
  .about {
    background: #0a0e1a;
    border: 1px solid #1e2a40;
    padding: 0.8rem;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .about-name {
    font-weight: 700;
    font-size: 0.9rem;
    color: #b0c0f0;
  }

  .about-tagline {
    font-size: 0.74rem;
    color: #7a8aa8;
    font-style: italic;
  }

  .about-meta {
    display: flex;
    gap: 0.35rem;
    font-size: 0.66rem;
    color: #4a5a7a;
    font-family: "JetBrains Mono", monospace;
    margin-top: 0.3rem;
  }
</style>
