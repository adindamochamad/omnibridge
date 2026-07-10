import type { DiscoveredDevice } from './types.js';
import type { DeviceProfile } from './profiles.js';
import type { WebhookConfig } from './webhook.js';
import { URL_WEBHOOK_DEV, URL_WEBHOOK_ONLINE } from './konfigurasi-default-cas.js';

export { URL_WEBHOOK_DEV, URL_WEBHOOK_ONLINE };

/** Baud pertama untuk "membangunkan" timbangan CAS sebelum operasi normal. */
export const BAUD_WARMUP_CAS = 19200;

/** Baud operasional timbangan CAS setelah warmup. */
export const BAUD_OPERASI_CAS = 9600;

/** Durasi tunggu saat port dibuka di 19200 (ms). */
export const DURASI_WARMUP_CAS_MS = 800;

/** Opsi kode timbangan untuk webhook legacy. */
export const OPSI_KODE_TIMBANGAN = ['S100', 'S101', 'S102', 'S200', 'S300'] as const;

/** Opsi company-id untuk webhook legacy. */
export const OPSI_COMPANY_ID = ['1', '2', '3', '4', '5'] as const;

/** Mode endpoint webhook: staging vs production. */
export type ModeWebhook = 'DEV' | 'ONLINE';

export const OPSI_MODE_WEBHOOK: ModeWebhook[] = ['DEV', 'ONLINE'];

/** URL efektif saat kirim: DEV = staging, ONLINE = production. */
export function urlEfektifUntukWebhook(
  config: Pick<WebhookConfig, 'mode_webhook' | 'url'>
): string {
  if (config.mode_webhook === 'ONLINE') {
    return URL_WEBHOOK_ONLINE;
  }
  const urlDev = config.url?.trim();
  return urlDev || URL_WEBHOOK_DEV;
}

/** Port yang sudah di-warmup di sesi ini — hindari ulang tiap stop/start. */
const portSudahWarmup = new Set<string>();

/** VID WCH — adaptor USB-serial yang umum dipakai timbangan CAS (CH340/CH341). */
const VID_CH340 = 0x1a86;

/** Cek apakah port ini adaptor CH340 — timbangan CAS di lapangan biasanya lewat chip ini. */
export function apakahAdaptorCh340(device: DiscoveredDevice): boolean {
  if (device.device_class === 'ch340') return true;
  if (device.vid === VID_CH340) return true;
  const manuf = (device.manufacturer ?? '').toLowerCase();
  const produk = (device.product ?? '').toLowerCase();
  return (
    manuf.includes('wch') ||
    produk.includes('ch340') ||
    produk.includes('ch341') ||
    produk.includes('usb-serial')
  );
}

export function apakahPerangkatCas(
  device: DiscoveredDevice,
  profil?: DeviceProfile | null
): boolean {
  // Demo CAS selalu dikenali
  if (device.port === 'demo://cas-scale') return true;

  const manuf = (device.manufacturer ?? '').toLowerCase();
  const produk = (device.product ?? '').toLowerCase();
  const protokol = (profil?.protocol ?? '').toLowerCase();
  const hint = (profil?.device_hint ?? '').toLowerCase();

  // Manufacturer CAS Corp / CAS ...
  if (/\bcas\b/.test(manuf) || manuf.includes('cas corp')) return true;

  // Produk seri CL (CL5000, CL-5000, dll.) — pola khas timbangan CAS
  if (/\bcl[\s-]?\d/.test(produk)) return true;

  // Adaptor CH340 — hampir semua setup CAS di Indonesia pakai ini
  if (apakahAdaptorCh340(device)) return true;

  // Sudah teridentifikasi sebagai protokol CAS dari profil/learned
  if (protokol.includes('cas scale') || protokol.includes('cas ')) return true;
  if (hint.includes('cas') && hint.includes('scale')) return true;

  // Profil bundled eksplisit minta warmup CAS
  if (profil?.needs_baud_warmup === true && protokol.includes('cas')) return true;

  return false;
}

export function perluWarmupCas(
  port: string,
  device: DiscoveredDevice,
  profil?: DeviceProfile | null
): boolean {
  if (port.startsWith('demo://')) return false;
  if (portSudahWarmup.has(port)) return false;
  if (profil?.needs_baud_warmup === false) return false;
  return apakahPerangkatCas(device, profil);
}

/** Tandai port sudah di-warmup agar tidak diulang di sesi yang sama. */
export function tandaiWarmupSelesai(port: string): void {
  portSudahWarmup.add(port);
}

/** Reset state warmup (berguna untuk testing). */
export function resetWarmupCas(): void {
  portSudahWarmup.clear();
}

export function tidur(ms: number): Promise<void> {
  return new Promise((selesai) => setTimeout(selesai, ms));
}
