<script lang="ts">
  import { untrack } from 'svelte';
  import { invoke } from "@tauri-apps/api/core";
  import { BAUD_RATES, BAUDS_TO_PROBE, CLASS_COLORS, type BaudProbeResult, type DiscoveredDevice } from "$lib/types.js";
  import type { DeviceProfile } from "$lib/profiles.js";
  import {
    OPSI_KODE_TIMBANGAN,
    OPSI_COMPANY_ID,
    OPSI_MODE_WEBHOOK,
    apakahPerangkatCas,
    type ModeWebhook,
  } from "$lib/cas-scale.js";
  import type { WebhookConfig } from "$lib/webhook.js";

  let {
    device,
    monitoring = false,
    starting = false,
    selectedBaud = device.suggested_baud,
    learnedProfile = null,
    webhookConfig = null,
    onToggle,
    onBaudChange,
    onWebhookConfigChange,
  }: {
    device: DiscoveredDevice;
    monitoring: boolean;
    starting?: boolean;
    selectedBaud?: number;
    learnedProfile?: DeviceProfile | null;
    webhookConfig?: WebhookConfig | null;
    onToggle: () => void;
    onBaudChange: (baud: number) => void;
    onWebhookConfigChange?: (patch: Partial<WebhookConfig>) => void;
  } = $props();

  // Sinkronkan dropdown saat parent mengubah baud (mis. setelah warmup CAS)
  $effect(() => {
    selectedBaudLocal = selectedBaud;
  });

  let selectedBaudLocal = $state(untrack(() => selectedBaud));

  const color = $derived(CLASS_COLORS[device.device_class] ?? "#4b5563");

  const tampilkanDropdownTimbangan = $derived(
    apakahPerangkatCas(device, learnedProfile) && webhookConfig !== null
  );

  function handleKodeTimbangan(e: Event) {
    onWebhookConfigChange?.({
      scales_code: (e.target as HTMLSelectElement).value,
    });
  }

  function handleCompanyId(e: Event) {
    onWebhookConfigChange?.({
      company_id: (e.target as HTMLSelectElement).value,
    });
  }

  function handleModeWebhook(e: Event) {
    onWebhookConfigChange?.({
      mode_webhook: (e.target as HTMLSelectElement).value as ModeWebhook,
    });
  }

  function handleEntis(e: Event) {
    const dicentang = (e.target as HTMLInputElement).checked;
    onWebhookConfigChange?.({
      entis: dicentang,
      enabled: dicentang,
    });
  }

  // Auto baud probe state
  let probing = $state(false);
  let probeIndex = $state(0);
  let probeCurrent = $state<number | null>(null);
  let probeResults = $state<BaudProbeResult[]>([]);
  let probeError = $state<string | null>(null);
  let probeWinner = $state<BaudProbeResult | null>(null);
  let winnerTimer: ReturnType<typeof setTimeout> | null = null;

  function handleBaudChange(e: Event) {
    const val = parseInt((e.target as HTMLSelectElement).value, 10);
    selectedBaudLocal = val;
    onBaudChange(val);
  }

  function shortPort(p: string): string {
    const parts = p.split("/");
    return parts[parts.length - 1];
  }

  async function autoProbe() {
    if (probing || monitoring) return;
    probing = true;
    probeResults = [];
    probeError = null;
    probeWinner = null;
    if (winnerTimer) { clearTimeout(winnerTimer); winnerTimer = null; }

    try {
      for (let i = 0; i < BAUDS_TO_PROBE.length; i++) {
        probeIndex = i + 1;
        probeCurrent = BAUDS_TO_PROBE[i];
        const r = await invoke<BaudProbeResult>("probe_single_baud", {
          port: device.port,
          baud: BAUDS_TO_PROBE[i],
        });
        probeResults = [...probeResults, r];
      }

      // Pick winner: highest score AND at least some bytes read
      const valid = probeResults.filter((r) => r.bytes_read > 0 && !r.error);
      if (valid.length === 0) {
        probeError = "No device response detected — make sure it's transmitting";
        return;
      }
      const best = valid.reduce((a, b) => (b.score > a.score ? b : a));
      probeWinner = best;
      selectedBaudLocal = best.baud;
      onBaudChange(best.baud);

      // Auto-dismiss winner strip after 8 seconds
      winnerTimer = setTimeout(() => { probeWinner = null; }, 8000);
    } catch (e) {
      probeError = String(e);
    } finally {
      probing = false;
      probeCurrent = null;
    }
  }
</script>

<div class="card" class:active={monitoring} style="--accent: {color}">
  <div class="card-header">
    <span class="badge" style="background: {color}22; color: {color}; border-color: {color}44">
      {device.label}
    </span>
    <button
      class="monitor-btn"
      class:running={monitoring}
      class:starting
      onclick={onToggle}
      disabled={starting}
      title={
        starting
          ? "Menyiapkan port…"
          : monitoring
          ? "Stop monitoring"
          : "Start monitoring"
      }
    >
      {#if starting}
        <span class="spin-s">◌</span> Starting…
      {:else if monitoring}
        <span class="dot pulsing"></span> Live
      {:else}
        ▶ Monitor
      {/if}
    </button>
  </div>

  <div class="port-name">{shortPort(device.port)}</div>
  <div class="port-full">{device.port}</div>

  {#if device.manufacturer || device.product}
    <div class="meta">
      {device.manufacturer ?? ""}{device.product ? ` · ${device.product}` : ""}
    </div>
  {/if}

  {#if device.vid !== null && device.pid !== null}
    <div class="ids">
      VID:{device.vid.toString(16).padStart(4, "0").toUpperCase()}
      PID:{device.pid.toString(16).padStart(4, "0").toUpperCase()}
    </div>
  {/if}

  {#if learnedProfile}
    <div class="learned-badge" title="Learned from {learnedProfile.sample_count} prior session{learnedProfile.sample_count > 1 ? 's' : ''}">
      <span class="learned-star">⭐</span>
      <span class="learned-protocol">{learnedProfile.protocol}</span>
      <span class="learned-conf">{learnedProfile.high_water_confidence}%</span>
    </div>
  {/if}

  <div class="baud-row">
    <span class="baud-label">Baud</span>
    <select
      class="baud-select"
      value={selectedBaudLocal}
      onchange={handleBaudChange}
      disabled={monitoring || probing || starting}
    >
      {#each BAUD_RATES as rate}
        <option value={rate}>{rate}</option>
      {/each}
    </select>
    <button
      class="auto-btn"
      class:probing
      onclick={autoProbe}
      disabled={monitoring || probing || device.port.startsWith('demo://')}
      title={
        starting
          ? 'Tunggu monitor selesai dimulai'
          : device.port.startsWith('demo://')
          ? 'Demo device uses fixed baud'
          : monitoring
          ? 'Stop monitoring first'
          : 'Auto-detect baud rate (~6s)'
      }
    >
      {#if probing}
        <span class="spin-s">◌</span>
      {:else}
        🎯
      {/if}
    </button>
  </div>

  {#if tampilkanDropdownTimbangan && webhookConfig}
    <div class="scale-row">
      <div class="scale-field">
        <span class="scale-label">Kode</span>
        <select
          class="scale-select"
          value={webhookConfig.scales_code}
          onchange={handleKodeTimbangan}
        >
          {#each OPSI_KODE_TIMBANGAN as kode}
            <option value={kode}>{kode}</option>
          {/each}
        </select>
      </div>
      <div class="scale-field">
        <span class="scale-label">Co.ID</span>
        <select
          class="scale-select"
          value={webhookConfig.company_id}
          onchange={handleCompanyId}
        >
          {#each OPSI_COMPANY_ID as id}
            <option value={id}>{id}</option>
          {/each}
        </select>
      </div>
      <div class="scale-field">
        <span class="scale-label">Mode</span>
        <select
          class="scale-select"
          class:mode-dev={webhookConfig.mode_webhook === 'DEV'}
          class:mode-online={webhookConfig.mode_webhook === 'ONLINE'}
          value={webhookConfig.mode_webhook ?? 'DEV'}
          onchange={handleModeWebhook}
        >
          {#each OPSI_MODE_WEBHOOK as mode}
            <option value={mode}>{mode}</option>
          {/each}
        </select>
      </div>
    </div>
    <label class="entis-row" title="Centang untuk auto-kirim berat ke webhook terus-menerus">
      <input
        type="checkbox"
        checked={webhookConfig.entis}
        onchange={handleEntis}
      />
      <span class="entis-label">ENTIS</span>
      {#if webhookConfig.entis}
        <span class="entis-auto">auto-kirim</span>
      {/if}
    </label>
  {/if}

  {#if probing}
    <div class="probe-strip probing">
      <span class="probe-spin">◌</span>
      <span class="probe-text">Probing {probeIndex}/{BAUDS_TO_PROBE.length} · {probeCurrent}</span>
    </div>
  {:else if probeError}
    <div class="probe-strip error">
      <span>⚠ {probeError}</span>
    </div>
  {:else if probeWinner}
    <div class="probe-strip success">
      <span class="trophy">✓</span>
      <span class="probe-text">
        <strong>{probeWinner.baud}</strong>
        · {Math.round(probeWinner.score * 100)}% printable
        · {probeWinner.bytes_read}B
      </span>
    </div>
  {/if}
</div>

<style>
  .card {
    background: #1a1a28;
    border: 1px solid #252538;
    border-left: 3px solid var(--accent, #4b5563);
    border-radius: 8px;
    padding: 0.85rem;
    cursor: default;
    transition: border-color 0.2s, background 0.2s;
  }

  .card.active {
    background: #1e1e30;
    border-color: var(--accent, #4b5563);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    gap: 0.5rem;
  }

  .badge {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    border: 1px solid;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }

  .monitor-btn {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 5px;
    border: 1px solid #3a3a56;
    background: #252538;
    color: #a0a0c0;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .monitor-btn:hover:not(:disabled) {
    background: #2e2e48;
    color: #e0e0f0;
  }

  .monitor-btn.running {
    background: #1a2e1a;
    border-color: #22c55e44;
    color: #22c55e;
  }

  .monitor-btn.starting {
    background: #1e1a30;
    border-color: #4f6ef744;
    color: #90b0ff;
    opacity: 0.85;
    cursor: wait;
  }

  .monitor-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    display: inline-block;
  }

  .pulsing {
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .port-name {
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 0.9rem;
    font-weight: 600;
    color: #c8c8e8;
    margin-bottom: 0.1rem;
  }

  .port-full {
    font-family: monospace;
    font-size: 0.68rem;
    color: #5a5a7a;
    margin-bottom: 0.4rem;
    word-break: break-all;
  }

  .meta {
    font-size: 0.72rem;
    color: #7a7a9a;
    margin-bottom: 0.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ids {
    font-family: monospace;
    font-size: 0.68rem;
    color: #4a4a6a;
    margin-bottom: 0.5rem;
    letter-spacing: 0.04em;
  }

  .learned-badge {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.5rem;
    padding: 0.2rem 0.45rem;
    background: linear-gradient(90deg, #1a1428 0%, #1e1a30 100%);
    border: 1px solid #4a3870;
    border-radius: 4px;
    font-size: 0.7rem;
  }

  .learned-star {
    color: #fbbf24;
    font-size: 0.7rem;
  }

  .learned-protocol {
    color: #d8b4fe;
    font-weight: 600;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .learned-conf {
    color: #a78bfa;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.65rem;
    background: #2a1e42;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }

  .baud-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .baud-label {
    font-size: 0.7rem;
    color: #5a5a7a;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .baud-select {
    flex: 1;
    background: #111120;
    border: 1px solid #2a2a42;
    border-radius: 5px;
    color: #a0a0c0;
    font-size: 0.75rem;
    padding: 0.2rem 0.4rem;
    cursor: pointer;
  }

  .baud-select:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .scale-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 0.4rem;
    margin-top: 0.45rem;
  }

  .scale-select.mode-dev {
    color: #fbbf24;
    border-color: #854d0e44;
  }

  .scale-select.mode-online {
    color: #86efac;
    border-color: #1e402844;
  }

  .scale-field {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .scale-label {
    font-size: 0.62rem;
    color: #5a5a7a;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .scale-select {
    background: #111120;
    border: 1px solid #2a2a42;
    border-radius: 5px;
    color: #a0a0c0;
    font-size: 0.72rem;
    padding: 0.2rem 0.35rem;
    cursor: pointer;
    font-family: "JetBrains Mono", monospace;
  }

  .entis-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.35rem;
    padding: 0.25rem 0.45rem;
    background: #141828;
    border: 1px solid #2a2a42;
    border-radius: 5px;
    cursor: pointer;
    user-select: none;
  }

  .entis-row input[type='checkbox'] {
    accent-color: #4f6ef7;
    width: 14px;
    height: 14px;
    cursor: pointer;
  }

  .entis-label {
    font-size: 0.72rem;
    font-weight: 600;
    color: #90a8e0;
    letter-spacing: 0.06em;
  }

  .entis-auto {
    margin-left: auto;
    font-size: 0.6rem;
    color: #86efac;
    background: #1a2e1a;
    border: 1px solid #1e4028;
    padding: 0.05rem 0.35rem;
    border-radius: 6px;
    font-family: "JetBrains Mono", monospace;
  }

  .auto-btn {
    background: #1a1a28;
    border: 1px solid #2a2a42;
    border-radius: 5px;
    color: #a0a0c0;
    cursor: pointer;
    padding: 0.2rem 0.5rem;
    font-size: 0.78rem;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
  }

  .auto-btn:hover:not(:disabled) {
    background: #2a2a42;
    border-color: #4f6ef7;
    color: #90b0ff;
  }

  .auto-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .auto-btn.probing {
    background: #1e1a30;
    border-color: #4f6ef7;
    color: #90b0ff;
  }

  .spin-s {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .probe-strip {
    margin-top: 0.35rem;
    padding: 0.3rem 0.5rem;
    border-radius: 5px;
    font-size: 0.7rem;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-family: "JetBrains Mono", monospace;
  }

  .probe-strip.probing {
    background: #141830;
    border: 1px solid #2a3450;
    color: #7090f0;
  }

  .probe-strip.success {
    background: #0e2018;
    border: 1px solid #1e4028;
    color: #86efac;
    animation: fadeIn 0.3s ease-out;
  }

  .probe-strip.error {
    background: #1e0e0e;
    border: 1px solid #4a1e1e;
    color: #f87171;
    font-family: inherit;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .probe-spin {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  .probe-text strong {
    color: #d0ffd0;
    font-weight: 700;
  }

  .trophy {
    font-size: 0.8rem;
  }
</style>
