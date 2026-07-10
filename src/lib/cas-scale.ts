import type { DiscoveredDevice } from './types.js';
import type { DeviceProfile } from './profiles.js';

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

/** Port yang sudah di-warmup di sesi ini — hindari ulang tiap stop/start. */
const portSudahWarmup = new Set<string>();

export function apakahPerangkatCas(
  device: DiscoveredDevice,
  profil?: DeviceProfile | null
): boolean {
  const teksGabungan = [
    device.manufacturer,
    device.product,
    device.label,
    profil?.protocol,
    profil?.device_hint,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    teksGabungan.includes('cas') ||
    teksGabungan.includes('timbang') ||
    teksGabungan.includes('scale') ||
    teksGabungan.includes('cl5000')
  );
}

export function perluWarmupCas(
  port: string,
  device: DiscoveredDevice,
  profil?: DeviceProfile | null
): boolean {
  if (port.startsWith('demo://')) return false;
  if (portSudahWarmup.has(port)) return false;
  if (profil?.needs_baud_warmup === false) return false;
  return apakahPerangkatCas(device, profil) || profil?.needs_baud_warmup === true;
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
