import type { DiscoveredDevice } from './types.js';
import type { DeviceProfile } from './profiles.js';
import type { WebhookConfig } from './webhook.js';

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

/** Endpoint production ENTIS — dipakai otomatis saat mode ONLINE. */
export const URL_WEBHOOK_ONLINE = 'https://bat.entis.app/api/scale';

/** URL efektif saat kirim: DEV = url di pengaturan webhook, ONLINE = bat.entis.app. */
export function urlEfektifUntukWebhook(
  config: Pick<WebhookConfig, 'mode_webhook' | 'url'>
): string {
  if (config.mode_webhook === 'ONLINE') {
    return URL_WEBHOOK_ONLINE;
  }
  return config.url?.trim() ?? '';
}

/** Port yang sudah di-warmup di sesi ini — hindari ulang tiap stop/start. */
const portSudahWarmup = new Set<string>();

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
