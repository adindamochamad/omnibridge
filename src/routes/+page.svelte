<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import {
    CLASS_COLORS,
    deviceFingerprint,
    toHex,
    toVisibleAscii,
    type DataLine,
    type DiscoveredDevice,
    type PortDataEvent,
  } from "$lib/types.js";
  import PortCard from "$lib/PortCard.svelte";
  import DataBuffer from "$lib/DataBuffer.svelte";
  import SettingsModal from "$lib/SettingsModal.svelte";
  import { getAllProfiles, saveProfile, type DeviceProfile } from "$lib/profiles.js";
  import { getApiKey } from "$lib/settings.js";
  import type { ProtocolAnalysis } from "$lib/claude.js";
  import {
    allDemoDevices,
    demoScenarioFromPort,
    isDemoPort,
  } from "$lib/demo.js";
  import { terapkanSemuaPresetBundled } from "$lib/bundled-presets.js";
  import versiPkg from "../../package.json";
  import {
    BAUD_OPERASI_CAS,
    BAUD_WARMUP_CAS,
    DURASI_WARMUP_CAS_MS,
    perluWarmupCas,
    tandaiWarmupSelesai,
    tidur,
  } from "$lib/cas-scale.js";
  import {
    getConfig as getWebhookConfig,
    saveConfig as saveWebhookConfig,
    defaultConfig,
    templateFormTimbangan,
    type WebhookConfig,
  } from "$lib/webhook.js";

  // ── State ──────────────────────────────────────────────────────────────────

  let devices = $state<DiscoveredDevice[]>([]);
  let scanning = $state(false);
  let scanError = $state<string | null>(null);

  /** fingerprint → learned profile */
  let profiles = $state<Record<string, DeviceProfile>>({});

  /** fingerprint → konfigurasi webhook (kode timbangan, company-id, dll.) */
  let konfigurasiWebhook = $state<Record<string, WebhookConfig>>({});

  function profileFor(d: DiscoveredDevice): DeviceProfile | null {
    return profiles[deviceFingerprint(d)] ?? null;
  }

  /** port → active boolean */
  let monitoring = $state<Record<string, boolean>>({});
  /** port → sedang proses start/warmup (cegah double-click) */
  let sedangMemulai = $state<Record<string, boolean>>({});
  /** port → selected baud rate */
  let baudRates = $state<Record<string, number>>({});
  /** port → data lines */
  let buffers = $state<Record<string, DataLine[]>>({});
  /** port → unlisten function */
  let unlisteners: Record<string, (() => void)[]> = {};

  let lineSeq = 0;
  let activeTab = $state<string | null>(null);

  let showSettings = $state(false);
  let demoActive = $state(false);
  /** true when no API key is configured — hints first-time users toward Settings */
  let needsApiKey = $state(false);

  async function refreshApiKeyStatus() {
    const key = await getApiKey();
    needsApiKey = !key;
  }
  /** port → interval id for demo generators */
  let demoIntervals: Record<string, ReturnType<typeof setInterval>> = {};

  /** transient notifications (top-right toast) */
  let toasts = $state<Array<{ id: number; kind: 'info' | 'warn' | 'error'; msg: string }>>([]);
  let toastSeq = 0;
  function toast(kind: 'info' | 'warn' | 'error', msg: string, durationMs = 4000) {
    const id = ++toastSeq;
    toasts = [...toasts, { id, kind, msg }];
    setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); }, durationMs);
  }

  const monitoredPorts = $derived(
    Object.entries(monitoring)
      .filter(([, v]) => v)
      .map(([k]) => k)
  );

  // ── Commands ───────────────────────────────────────────────────────────────

  async function muatKonfigurasiWebhook(devs: DiscoveredDevice[]) {
    const baru = { ...konfigurasiWebhook };
    await Promise.all(
      devs.map(async (d) => {
        const fp = deviceFingerprint(d);
        const cfg = await getWebhookConfig(fp);
        baru[fp] = cfg ?? defaultConfig();
      })
    );
    konfigurasiWebhook = baru;
  }

  async function ubahKonfigurasiWebhookPort(
    fp: string,
    patch: Partial<WebhookConfig> | WebhookConfig
  ) {
    const lama = konfigurasiWebhook[fp] ?? defaultConfig();
    const baru: WebhookConfig = { ...lama, ...patch };

    // ENTIS = saklar auto-forward: centang → kirim terus, uncheck → stop
    if ("entis" in patch) {
      baru.enabled = Boolean(patch.entis);
      baru.form_template = templateFormTimbangan();
      baru.body_format = "form";
    } else if ("enabled" in patch) {
      baru.entis = Boolean(patch.enabled);
    }

    if ("scales_code" in patch || "company_id" in patch || "mode_webhook" in patch) {
      baru.form_template = templateFormTimbangan();
      baru.body_format = "form";
    }
    konfigurasiWebhook = { ...konfigurasiWebhook, [fp]: baru };
    await saveWebhookConfig(fp, baru);
  }

  async function discoverDevices() {
    scanning = true;
    scanError = null;
    try {
      const [discovered, loadedProfiles] = await Promise.all([
        invoke<DiscoveredDevice[]>("discover_devices"),
        getAllProfiles(),
      ]);
      devices = discovered;
      profiles = loadedProfiles;

      // Terapkan preset bawaan dari repo (mis. CAS Scale) untuk device baru
      const hasilPreset = await terapkanSemuaPresetBundled(discovered);
      if (hasilPreset.profilBaru > 0) {
        profiles = await getAllProfiles();
        toast('info', `Preset bawaan dimuat: ${hasilPreset.profilBaru} device`);
      }

      await muatKonfigurasiWebhook(devices);

      for (const d of devices) {
        if (baudRates[d.port] === undefined) {
          // Use learned baud if available, else device suggestion
          const learned = profiles[deviceFingerprint(d)];
          baudRates[d.port] = learned?.suggested_baud ?? d.suggested_baud;
        }
      }
    } catch (e) {
      scanError = String(e);
    } finally {
      scanning = false;
    }
  }

  async function handleAnalysisComplete(port: string, analysis: ProtocolAnalysis) {
    const device = devices.find((d) => d.port === port);
    if (!device) return;
    const saved = await saveProfile(device, analysis);
    if (saved) {
      profiles = { ...profiles, [saved.fingerprint]: saved };
    }
  }

  async function toggleDemoMode() {
    if (demoActive) {
      // Remove demo devices (stop their monitors first)
      for (const d of allDemoDevices()) {
        if (monitoring[d.port]) stopMonitor(d.port);
      }
      devices = devices.filter((d) => !isDemoPort(d.port));
      demoActive = false;
    } else {
      const demos = allDemoDevices();
      devices = [...devices, ...demos];
      for (const d of demos) {
        if (baudRates[d.port] === undefined) baudRates[d.port] = d.suggested_baud;
      }
      await terapkanSemuaPresetBundled(demos);
      profiles = await getAllProfiles();
      await muatKonfigurasiWebhook(demos);
      demoActive = true;
    }
  }

  function startDemoMonitor(port: string) {
    const scenario = demoScenarioFromPort(port);
    if (!scenario) return;
    monitoring[port] = true;
    buffers[port] = [];
    activeTab = port;

    demoIntervals[port] = setInterval(() => {
      const bytes = scenario.generate();
      const data = Array.from(bytes);
      const line: DataLine = {
        id: ++lineSeq,
        timestamp: Date.now(),
        hex: toHex(data),
        ascii: toVisibleAscii(data),
        bytes: data.length,
      };
      buffers[port].push(line);
      if (buffers[port].length > 1000) buffers[port].splice(0, 1);
    }, scenario.interval_ms);
  }

  async function startMonitor(port: string) {
    if (isDemoPort(port)) {
      startDemoMonitor(port);
      return;
    }

    // Cegah double-click / start bersamaan saat warmup masih berjalan
    if (sedangMemulai[port] || monitoring[port]) return;
    sedangMemulai[port] = true;

    const device = devices.find((d) => d.port === port);
    const profil = device ? profileFor(device) : null;
    const butuhWarmup = !!(device && perluWarmupCas(port, device, profil));

    try {
      // Inisialisasi baud CAS: 19200 → stop → 9600 (wajib agar kg terbaca)
      if (butuhWarmup) {
        try {
          toast('info', `${port}: inisialisasi CAS 19200→9600…`, 3000);
          await invoke("start_port_monitor", { port, baudRate: BAUD_WARMUP_CAS });
          await tidur(DURASI_WARMUP_CAS_MS);
          await invoke("stop_port_monitor", { port }).catch(() => {});
          await tidur(150); // beri waktu port dilepas (Windows)
          baudRates[port] = BAUD_OPERASI_CAS;
        } catch (e) {
          toast('warn', `Warmup CAS gagal: ${String(e).slice(0, 80)}`, 5000);
          return;
        }
      }

      const baud = baudRates[port] ?? 9600;
      await invoke("start_port_monitor", { port, baudRate: baud });
      monitoring[port] = true;
      buffers[port] = [];
      activeTab = port;

      if (butuhWarmup) tandaiWarmupSelesai(port);

      const unData = await listen<PortDataEvent>("port:data", (ev) => {
        if (ev.payload.port !== port) return;
        const line: DataLine = {
          id: ++lineSeq,
          timestamp: ev.payload.timestamp,
          hex: toHex(ev.payload.data),
          ascii: toVisibleAscii(ev.payload.data),
          bytes: ev.payload.data.length,
          direction: ev.payload.direction ?? "rx",
        };
        buffers[port].push(line);
        if (buffers[port].length > 1000) buffers[port].splice(0, 1);
      });

      const unClosed = await listen<string>("port:closed", (ev) => {
        if (ev.payload === port) {
          const wasActive = monitoring[port];
          monitoring[port] = false;
          if (wasActive) {
            toast('warn', `${port.split('/').at(-1)} disconnected`);
          }
        }
      });

      const unError = await listen<{ port: string; error: string }>("port:error", (ev) => {
        if (ev.payload.port === port) {
          monitoring[port] = false;
          toast('error', `${port.split('/').at(-1)}: ${ev.payload.error}`, 6000);
        }
      });

      unlisteners[port] = [unData, unClosed, unError];
    } catch (e) {
      monitoring[port] = false;
      scanError = String(e);
    } finally {
      sedangMemulai[port] = false;
    }
  }

  async function stopMonitor(port: string) {
    if (isDemoPort(port)) {
      if (demoIntervals[port]) clearInterval(demoIntervals[port]);
      delete demoIntervals[port];
      monitoring[port] = false;
      if (activeTab === port) {
        activeTab = monitoredPorts.find((p) => p !== port) ?? null;
      }
      return;
    }
    await invoke("stop_port_monitor", { port }).catch(() => {});
    monitoring[port] = false;
    for (const fn of unlisteners[port] ?? []) fn();
    delete unlisteners[port];
    if (activeTab === port) {
      activeTab = monitoredPorts.find((p) => p !== port) ?? null;
    }
  }

  function toggleMonitor(port: string) {
    if (monitoring[port]) stopMonitor(port);
    else startMonitor(port);
  }

  function closeBuffer(port: string) {
    stopMonitor(port);
  }

  function classColor(cls: string) {
    return CLASS_COLORS[cls] ?? "#4b5563";
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  function handleKeydown(e: KeyboardEvent) {
    const cmdKey = e.metaKey || e.ctrlKey;
    if (cmdKey && e.key === ",") {
      e.preventDefault();
      showSettings = true;
    } else if (cmdKey && e.key.toLowerCase() === "d" && !e.shiftKey) {
      // Avoid conflict with browser bookmark shortcut in dev preview
      e.preventDefault();
      if (!scanning) discoverDevices();
    }
  }

  // ── Lifecycle: auto-discover on launch + bind shortcuts ──────────────────
  onMount(() => {
    discoverDevices();
    refreshApiKeyStatus();
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  });
</script>

<div class="layout">
  <!-- ── Sidebar ─────────────────────────────────────────────────────────── -->
  <aside class="sidebar">
    <header class="app-header">
      <div class="logo-area">
        <div class="logo-icon">⬡</div>
        <div class="logo-text">
          <div class="app-name">OmniBridge</div>
          <div class="app-sub">CAS Scale Bridge · v{versiPkg.version}</div>
        </div>
        <button class="header-icon-btn" onclick={() => (showSettings = true)} title="Settings">
          ⚙
        </button>
      </div>
    </header>

    <div class="sidebar-actions">
      <button class="discover-btn" onclick={discoverDevices} disabled={scanning}>
        {#if scanning}
          <span class="spin">◌</span> Scanning…
        {:else}
          ⊕ Discover Devices
        {/if}
      </button>
      <button class="demo-btn" class:active={demoActive} onclick={toggleDemoMode}>
        {#if demoActive}
          ✓ Demo Mode
        {:else}
          ▶ Try Demo Mode
        {/if}
      </button>
    </div>

    {#if scanError}
      <div class="scan-error">{scanError}</div>
    {/if}

    <div class="port-list-header">
      PORTS
      {#if devices.length > 0}
        <span class="port-count">{devices.length}</span>
      {/if}
    </div>

    <div class="port-list">
      {#if devices.length === 0}
        <div class="no-ports">
          {#if scanning}
            <span class="spin">◌</span>
            <span>Scanning for devices…</span>
          {:else}
            <div class="no-ports-icon">🔌</div>
            <div class="no-ports-title">No devices found</div>
            <div class="no-ports-sub">
              Connect a serial device and click Discover,<br />
              or try <strong>Demo Mode</strong> above.
            </div>
          {/if}
        </div>
      {:else}
        {#each devices as device (device.port)}
          {@const fp = deviceFingerprint(device)}
          <PortCard
            {device}
            monitoring={monitoring[device.port] ?? false}
            starting={sedangMemulai[device.port] ?? false}
            selectedBaud={baudRates[device.port] ?? device.suggested_baud}
            learnedProfile={profileFor(device)}
            webhookConfig={konfigurasiWebhook[fp] ?? null}
            onToggle={() => toggleMonitor(device.port)}
            onBaudChange={(baud) => (baudRates[device.port] = baud)}
            onWebhookConfigChange={(patch) => ubahKonfigurasiWebhookPort(fp, patch)}
          />
        {/each}
      {/if}
    </div>

    <!-- Mini status legend -->
    {#if devices.length > 0}
      <div class="legend">
        {#each [...new Set(devices.map((d) => d.device_class))] as cls}
          <span class="legend-item">
            <span class="legend-dot" style="background:{classColor(cls)}"></span>
            {devices.find((d) => d.device_class === cls)?.label}
          </span>
        {/each}
      </div>
    {/if}
  </aside>

  <!-- ── Main content ───────────────────────────────────────────────────── -->
  <main class="content">
    {#if monitoredPorts.length === 0}
      <!-- Empty state -->
      <div class="empty-state">
        <div class="empty-icon">⬡</div>
        <h2>Welcome to OmniBridge</h2>
        <p class="tagline">Intelligent Serial Gateway · AI-powered protocol detection</p>

        {#if devices.length === 0}
          <p class="intro">
            Bridge legacy RS-232 hardware to modern cloud ecosystems.<br />
            Claude automatically identifies your device's protocol, parses<br />
            the data, and forwards structured values to any webhook endpoint.
          </p>
          {#if needsApiKey}
            <button class="api-key-hint" onclick={() => (showSettings = true)} type="button">
              <span class="hint-icon">🔑</span>
              <span class="hint-text">
                <strong>First time here?</strong>
                Add your Anthropic API key to unlock AI protocol detection →
              </span>
              <span class="hint-arrow">⚙</span>
            </button>
          {/if}
          <div class="cta-row">
            <button class="cta-btn primary" onclick={discoverDevices} disabled={scanning}>
              {scanning ? "Scanning…" : "⊕ Discover Devices"}
            </button>
            <button class="cta-btn secondary" onclick={toggleDemoMode}>
              ▶ Try Demo Mode
            </button>
          </div>
          <div class="feature-grid">
            <div class="feature">
              <div class="feature-icon">🧠</div>
              <div class="feature-title">Protocol Detective</div>
              <div class="feature-desc">Claude analyzes raw bytes → identifies CAS scale, NMEA GPS, Modbus, or custom formats</div>
            </div>
            <div class="feature">
              <div class="feature-icon">📊</div>
              <div class="feature-title">Live Dashboard</div>
              <div class="feature-desc">Structured values in real-time with sparkline charts and live gauges</div>
            </div>
            <div class="feature">
              <div class="feature-icon">⭐</div>
              <div class="feature-title">Learns Devices</div>
              <div class="feature-desc">Remembers each device by VID/PID — instant recognition on reconnect</div>
            </div>
            <div class="feature">
              <div class="feature-icon">🔗</div>
              <div class="feature-title">Cloud Bridge</div>
              <div class="feature-desc">Forward to Zapier, n8n, Home Assistant, or any HTTP webhook</div>
            </div>
          </div>
        {:else}
          <p>
            Select a device on the left and click<br />
            <strong>▶ Monitor</strong> to start streaming data.
          </p>
        {/if}
      </div>
    {:else}
      <!-- Tab bar -->
      <div class="tab-bar">
        {#each monitoredPorts as port (port)}
          {@const cls = devices.find((d) => d.port === port)?.device_class ?? "unknown"}
          <div
            class="tab"
            class:active={activeTab === port}
            role="tab"
            tabindex="0"
            onclick={() => (activeTab = port)}
            onkeydown={(e) => e.key === "Enter" && (activeTab = port)}
            style="--tab-color: {classColor(cls)}"
          >
            <span class="tab-dot" style="background:{classColor(cls)}"></span>
            {port.split("/").at(-1)}
            <button
              class="tab-close"
              onclick={(e) => { e.stopPropagation(); closeBuffer(port); }}
              title="Stop monitoring"
            >✕</button>
          </div>
        {/each}
      </div>

      <!-- Active buffer -->
      <div class="buffer-area">
        {#each monitoredPorts as port (port)}
          {@const device = devices.find((d) => d.port === port)}
          {@const fp = device ? deviceFingerprint(device) : null}
          <div class="buffer-slot" class:visible={activeTab === port}>
            <DataBuffer
              {port}
              lines={buffers[port] ?? []}
              deviceClass={device?.device_class}
              deviceFingerprint={fp}
              device={device ?? null}
              learnedProfile={device ? profileFor(device) : null}
              webhookConfig={fp ? (konfigurasiWebhook[fp] ?? defaultConfig()) : defaultConfig()}
              onWebhookConfigChange={async (cfg) => {
                if (fp) await ubahKonfigurasiWebhookPort(fp, cfg);
              }}
              onClose={() => closeBuffer(port)}
              onAnalysisComplete={(a) => handleAnalysisComplete(port, a)}
            />
          </div>
        {/each}
      </div>
    {/if}
  </main>
</div>

{#if showSettings}
  <SettingsModal
    onClose={() => { showSettings = false; refreshApiKeyStatus(); }}
    onProfilesChanged={async () => {
      profiles = await getAllProfiles();
    }}
  />
{/if}

<!-- Toast stack -->
{#if toasts.length > 0}
  <div class="toast-stack">
    {#each toasts as t (t.id)}
      <div class="toast toast-{t.kind}">
        <span class="toast-icon">
          {#if t.kind === 'info'}ℹ{:else if t.kind === 'warn'}⚠{:else}✕{/if}
        </span>
        <span class="toast-msg">{t.msg}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    background: #0d0d14;
    color: #d0d0e8;
    font-family: Inter, system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    overflow: hidden;
    height: 100vh;
  }

  .layout {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Sidebar ──────────────────────────────────────────────────────────── */
  .sidebar {
    width: 260px;
    min-width: 260px;
    display: flex;
    flex-direction: column;
    background: #111120;
    border-right: 1px solid #1e1e30;
    overflow: hidden;
  }

  .app-header {
    padding: 0.9rem 0.8rem 0.7rem;
    border-bottom: 1px solid #1e1e30;
    flex-shrink: 0;
  }

  .logo-area {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .logo-text { flex: 1; }

  .header-icon-btn {
    background: transparent;
    border: 1px solid #2a2a42;
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
    color: #7a7a9a;
    cursor: pointer;
    font-size: 0.95rem;
    transition: all 0.15s;
  }

  .header-icon-btn:hover {
    background: #1e1e30;
    color: #c0c0e0;
    border-color: #3a3a56;
  }

  .logo-icon {
    font-size: 1.6rem;
    color: #4f6ef7;
    line-height: 1;
  }

  .app-name {
    font-size: 1rem;
    font-weight: 700;
    color: #e0e0f8;
    letter-spacing: 0.02em;
  }

  .app-sub {
    font-size: 0.65rem;
    color: #4a4a6a;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .sidebar-actions {
    padding: 0.7rem 0.8rem;
    flex-shrink: 0;
  }

  .discover-btn {
    width: 100%;
    padding: 0.55rem 0.8rem;
    background: #4f6ef7;
    border: none;
    border-radius: 7px;
    color: #fff;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    transition: background 0.2s;
  }

  .discover-btn:hover:not(:disabled) {
    background: #3a56e0;
  }

  .discover-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .demo-btn {
    width: 100%;
    padding: 0.45rem 0.8rem;
    background: transparent;
    border: 1px dashed #3a2e5a;
    border-radius: 7px;
    color: #a78bfa;
    font-size: 0.76rem;
    font-weight: 500;
    cursor: pointer;
    margin-top: 0.4rem;
    transition: all 0.15s;
  }

  .demo-btn:hover {
    background: #1a0e2a;
    border-color: #6a4eaf;
    color: #c8a8ff;
  }

  .demo-btn.active {
    background: #1a0e2a;
    border-style: solid;
    border-color: #a855f7;
    color: #e0c8ff;
  }

  .spin {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .scan-error {
    margin: 0 0.8rem 0.5rem;
    padding: 0.4rem 0.6rem;
    background: #2a1414;
    border: 1px solid #5a2a2a;
    border-radius: 5px;
    font-size: 0.72rem;
    color: #f87171;
    word-break: break-word;
  }

  .port-list-header {
    padding: 0 0.9rem 0.4rem;
    font-size: 0.65rem;
    font-weight: 600;
    color: #3a3a5a;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .port-count {
    background: #2a2a42;
    color: #7a7aaa;
    font-size: 0.62rem;
    padding: 0.05rem 0.35rem;
    border-radius: 8px;
  }

  .port-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 0.6rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    scrollbar-width: thin;
    scrollbar-color: #2a2a42 transparent;
  }

  .port-list::-webkit-scrollbar { width: 4px; }
  .port-list::-webkit-scrollbar-thumb { background: #2a2a42; border-radius: 2px; }

  .no-ports {
    padding: 1.5rem 0.5rem;
    text-align: center;
    color: #3a3a5a;
    font-size: 0.78rem;
    line-height: 1.7;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
  }

  .no-ports-icon {
    font-size: 1.8rem;
    opacity: 0.5;
    margin-bottom: 0.2rem;
  }

  .no-ports-title {
    color: #5a5a7a;
    font-weight: 600;
    font-size: 0.82rem;
  }

  .no-ports-sub {
    color: #4a4a6a;
    font-size: 0.72rem;
  }

  .no-ports-sub strong { color: #a78bfa; }

  .legend {
    padding: 0.5rem 0.8rem;
    border-top: 1px solid #1e1e30;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.7rem;
    flex-shrink: 0;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.65rem;
    color: #4a4a6a;
  }

  .legend-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ── Main content ─────────────────────────────────────────────────────── */
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #0d0d14;
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 2.5rem 2rem;
    gap: 0.6rem;
    color: #3a3a5a;
    overflow-y: auto;
  }

  .empty-icon {
    font-size: 3.5rem;
    color: #4f6ef7;
    margin-bottom: 0.5rem;
    opacity: 0.8;
    animation: pulseLogo 3s ease-in-out infinite;
  }

  @keyframes pulseLogo {
    0%, 100% { opacity: 0.8; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.05); }
  }

  .empty-state h2 {
    font-size: 1.4rem;
    font-weight: 700;
    color: #d0d8ff;
    letter-spacing: -0.01em;
  }

  .empty-state .tagline {
    font-size: 0.82rem;
    color: #7a8aa8;
    font-style: italic;
    margin-bottom: 0.5rem;
  }

  .empty-state .intro {
    font-size: 0.82rem;
    line-height: 1.7;
    color: #5a6a8a;
    max-width: 440px;
    margin-bottom: 0.6rem;
  }

  .empty-state p {
    font-size: 0.82rem;
    line-height: 1.7;
    color: #3a3a5a;
  }

  .empty-state strong { color: #a78bfa; }

  /* Proactive onboarding banner — shown only when API key is missing.
     Sits between the intro paragraph and CTA buttons so new users see it
     before clicking anything that requires the key. */
  .api-key-hint {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    margin: 0.4rem 0 0.8rem;
    padding: 0.55rem 0.9rem;
    background: linear-gradient(90deg, #2a1e42 0%, #1f1d3a 100%);
    border: 1px solid #4a3870;
    border-radius: 8px;
    color: #d8b4fe;
    font-size: 0.78rem;
    line-height: 1.4;
    cursor: pointer;
    text-align: left;
    transition: transform 0.15s, border-color 0.15s, box-shadow 0.2s;
    animation: hintPulse 2.4s ease-in-out infinite;
    max-width: 460px;
  }

  .api-key-hint:hover {
    transform: translateY(-1px);
    border-color: #7854b8;
    box-shadow: 0 4px 18px -6px rgba(168, 85, 247, 0.4);
  }

  .api-key-hint .hint-icon { font-size: 1.1rem; flex-shrink: 0; }
  .api-key-hint .hint-text { flex: 1; }
  .api-key-hint .hint-text strong { color: #fff; margin-right: 0.3rem; }
  .api-key-hint .hint-arrow {
    font-size: 1rem;
    opacity: 0.7;
    flex-shrink: 0;
  }

  @keyframes hintPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.0); }
    50%      { box-shadow: 0 0 0 4px rgba(168, 85, 247, 0.08); }
  }

  .cta-row {
    display: flex;
    gap: 0.6rem;
    margin-top: 0.3rem;
  }

  .cta-btn {
    padding: 0.55rem 1.2rem;
    border-radius: 7px;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
  }

  .cta-btn.primary {
    background: #4f6ef7;
    color: #fff;
  }

  .cta-btn.primary:hover:not(:disabled) {
    background: #3a56e0;
  }

  .cta-btn.secondary {
    background: transparent;
    border-color: #3a2e5a;
    color: #a78bfa;
    border-style: dashed;
  }

  .cta-btn.secondary:hover {
    background: #1a0e2a;
    border-color: #6a4eaf;
    color: #c8a8ff;
    border-style: solid;
  }

  /* Feature grid */
  .feature-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(200px, 240px));
    gap: 0.7rem;
    margin-top: 1.5rem;
    max-width: 520px;
  }

  .feature {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.7rem 0.85rem;
    background: #111828;
    border: 1px solid #1e2a40;
    border-radius: 8px;
    text-align: left;
    transition: border-color 0.2s;
  }

  .feature:hover {
    border-color: #3a4a70;
  }

  .feature-icon {
    font-size: 1.2rem;
    margin-bottom: 0.15rem;
  }

  .feature-title {
    font-size: 0.8rem;
    font-weight: 700;
    color: #b0c0f0;
  }

  .feature-desc {
    font-size: 0.7rem;
    color: #6a7a9a;
    line-height: 1.5;
  }

  /* ── Tabs ─────────────────────────────────────────────────────────────── */
  .tab-bar {
    display: flex;
    align-items: center;
    background: #111120;
    border-bottom: 1px solid #1e1e30;
    padding: 0 0.5rem;
    gap: 0.2rem;
    flex-shrink: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab-bar::-webkit-scrollbar { display: none; }

  .tab {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem 0.7rem;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: #5a5a7a;
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
    font-family: "JetBrains Mono", monospace;
  }

  .tab:hover {
    color: #a0a0c8;
  }

  .tab.active {
    color: #e0e0f8;
    border-bottom-color: var(--tab-color, #4f6ef7);
  }

  .tab-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .tab-close {
    font-size: 0.65rem;
    color: inherit;
    opacity: 0.4;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 0.1rem;
    line-height: 1;
    transition: opacity 0.15s;
  }

  .tab-close:hover {
    opacity: 1;
  }

  /* ── Buffer area ──────────────────────────────────────────────────────── */
  .buffer-area {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  .buffer-slot {
    position: absolute;
    inset: 0;
    display: none;
  }

  .buffer-slot.visible {
    display: flex;
    flex-direction: column;
  }

  /* ── Toast stack ────────────────────────────────────────────────────── */
  .toast-stack {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.85rem;
    border-radius: 6px;
    font-size: 0.78rem;
    max-width: 360px;
    min-width: 240px;
    animation: toastSlide 0.25s ease-out;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    pointer-events: auto;
    backdrop-filter: blur(6px);
  }

  @keyframes toastSlide {
    from { opacity: 0; transform: translateX(20px); }
    to { opacity: 1; transform: translateX(0); }
  }

  .toast-icon {
    font-size: 0.95rem;
    flex-shrink: 0;
  }

  .toast-msg {
    flex: 1;
    font-family: "JetBrains Mono", monospace;
  }

  .toast-info {
    background: rgba(30, 58, 138, 0.9);
    border: 1px solid #3b5288;
    color: #c8d8ff;
  }

  .toast-warn {
    background: rgba(146, 64, 14, 0.9);
    border: 1px solid #b45309;
    color: #fed7aa;
  }

  .toast-error {
    background: rgba(127, 29, 29, 0.9);
    border: 1px solid #b91c1c;
    color: #fecaca;
  }
</style>
