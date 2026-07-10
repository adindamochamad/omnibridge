<script lang="ts">
  import {
    sendWebhook,
    renderFormBody,
    templateFormTimbangan,
    type WebhookConfig,
    type WebhookPayload,
    type WebhookStats,
  } from '$lib/webhook.js';
  import { urlEfektifUntukWebhook } from '$lib/cas-scale.js';

  let {
    config,
    payload,
    stats,
    onStatsChange,
  }: {
    config: WebhookConfig;
    payload: WebhookPayload | null;
    stats: WebhookStats;
    onStatsChange: (stats: WebhookStats) => void;
  } = $props();

  let mengirim = $state(false);
  let pesanHasil = $state<{ ok: boolean; teks: string } | null>(null);

  const beratSaatIni = $derived(
    payload?.fields.weight ? String(payload.fields.weight.value) : null
  );

  const urlAktif = $derived(urlEfektifUntukWebhook(config));

  const previewBody = $derived.by(() => {
    if (!payload) return '';
    const template = config.form_template?.trim() || templateFormTimbangan();
    return renderFormBody(template, payload, config);
  });

  async function kirimSekarang() {
    if (!payload || !urlAktif) {
      pesanHasil = {
        ok: false,
        teks:
          config.mode_webhook === 'ONLINE'
            ? 'URL production tidak tersedia'
            : 'Isi URL webhook dulu di pengaturan 🔗',
      };
      return;
    }
    if (!beratSaatIni) {
      pesanHasil = { ok: false, teks: 'Belum ada pembacaan berat — tunggu data dari timbangan' };
      return;
    }

    mengirim = true;
    pesanHasil = null;
    const cfgKirim: WebhookConfig = {
      ...config,
      enabled: true,
      body_format: 'form',
      form_template: config.form_template?.trim() || templateFormTimbangan(),
    };
    const hasil = await sendWebhook(cfgKirim, payload);
    onStatsChange({
      sent: stats.sent + (hasil.ok ? 1 : 0),
      failed: stats.failed + (hasil.ok ? 0 : 1),
      last_status: hasil.ok ? `${hasil.status} OK` : (hasil.error ?? 'Error'),
      last_sent_at: Date.now(),
      last_error: hasil.ok ? null : (hasil.error ?? null),
    });
    pesanHasil = {
      ok: hasil.ok,
      teks: hasil.ok
        ? `✓ Terkirim — ${beratSaatIni} kg → ${config.scales_code} (company ${config.company_id})`
        : `✗ Gagal — ${hasil.error ?? 'Unknown error'}`,
    };
    mengirim = false;
  }
</script>

<div class="panel">
  <div class="panel-header">
    <span class="ikon">⚖️</span>
    <span class="judul">Kirim Berat ke Server</span>
    <span class="badge-konfig">
      {config.mode_webhook ?? 'DEV'} · {config.scales_code} · co.{config.company_id}{config.entis ? ' · ENTIS' : ''}
    </span>
    {#if config.entis}
      <span class="badge-auto">Auto-kirim {config.throttle_ms}ms</span>
    {/if}
  </div>

  <div class="baris-aksi">
    <button
      class="btn-kirim"
      onclick={kirimSekarang}
      disabled={mengirim || !beratSaatIni}
      title="Kirim berat saat ini ke endpoint webhook"
    >
      {#if mengirim}
        ◌ Mengirim…
      {:else}
        📤 Kirim Berat
      {/if}
    </button>
    <span class="petunjuk-sidebar">Kode &amp; Company ID diatur di card port sidebar</span>
  </div>

  {#if beratSaatIni}
    <div class="berat-saat-ini">
      Berat terakhir: <strong>{beratSaatIni} kg</strong>
    </div>
  {/if}

  {#if pesanHasil}
    <div class="hasil" class:gagal={!pesanHasil.ok}>{pesanHasil.teks}</div>
  {/if}

  {#if payload && urlAktif}
    <details class="preview">
      <summary>Preview body → {urlAktif}</summary>
      <code>{previewBody}</code>
    </details>
  {:else if !urlAktif}
    <div class="petunjuk">
      Mode <strong>DEV</strong>: atur URL di tombol <strong>🔗 Webhook</strong>.
      Mode <strong>ONLINE</strong> otomatis ke bat.entis.app.
    </div>
  {/if}
</div>

<style>
  .panel {
    margin-top: 0.75rem;
    padding: 0.75rem 0.9rem;
    background: #111828;
    border: 1px solid #2a3450;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .ikon { font-size: 1rem; }

  .judul {
    font-size: 0.82rem;
    font-weight: 600;
    color: #c0d0ff;
  }

  .badge-konfig {
    font-size: 0.62rem;
    background: #1a2038;
    color: #8aa0d0;
    border: 1px solid #2a3450;
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    font-family: "JetBrains Mono", monospace;
  }

  .badge-auto {
    font-size: 0.62rem;
    background: #1a2e1a;
    color: #86efac;
    border: 1px solid #1e4028;
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    font-family: "JetBrains Mono", monospace;
    margin-left: auto;
  }

  .baris-aksi {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }

  .btn-kirim {
    background: #4f6ef7;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 0.4rem 0.85rem;
    font-size: 0.76rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  }

  .btn-kirim:hover:not(:disabled) { background: #3a56e0; }
  .btn-kirim:disabled { opacity: 0.45; cursor: default; }

  .petunjuk-sidebar {
    font-size: 0.68rem;
    color: #5a6a8a;
  }

  .berat-saat-ini {
    font-size: 0.75rem;
    color: #7a8ab0;
  }

  .berat-saat-ini strong {
    color: #86efac;
    font-family: "JetBrains Mono", monospace;
  }

  .hasil {
    font-size: 0.72rem;
    padding: 0.35rem 0.55rem;
    border-radius: 5px;
    background: #0e2018;
    border: 1px solid #1e4028;
    color: #86efac;
  }

  .hasil.gagal {
    background: #1e0e0e;
    border-color: #4a1e1e;
    color: #f87171;
  }

  .preview {
    font-size: 0.7rem;
    color: #6a7a9a;
  }

  .preview summary {
    cursor: pointer;
    user-select: none;
  }

  .preview code {
    display: block;
    margin-top: 0.35rem;
    padding: 0.4rem 0.5rem;
    background: #0a0e1a;
    border-radius: 4px;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.68rem;
    color: #a0b0d8;
    word-break: break-all;
  }

  .petunjuk {
    font-size: 0.72rem;
    color: #5a6a8a;
  }

  .petunjuk strong { color: #90a8e0; }
</style>
