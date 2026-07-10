import { Store } from '@tauri-apps/plugin-store';
import { deviceFingerprint, type DiscoveredDevice } from './types.js';
import type { AnalysisField, CommandPreset, ProtocolAnalysis } from './claude.js';

const STORE_FILE = 'omnibridge.profiles.json';
const KEY_PROFILES = 'profiles';
const MIN_CONFIDENCE_TO_SAVE = 55;

export interface DeviceProfile {
  fingerprint: string;
  vid: number | null;
  pid: number | null;
  serial_number: string | null;
  manufacturer: string | null;
  product: string | null;
  device_class: string;
  suggested_baud: number;
  protocol: string;
  confidence: number;
  device_hint: string;
  expected_fields: AnalysisField[];
  /** Preset perintah yang dikirim ke device (Tare, Zero, dll). */
  command_presets?: CommandPreset[];
  notes: string;
  /** Timbangan CAS butuh warmup baud 19200 → 9600 saat sesi pertama. */
  needs_baud_warmup?: boolean;
  /** Asal profil: 'bundled' dari repo, 'learned' dari analisis AI. */
  sumber?: 'bundled' | 'learned';
  first_learned_at: number;
  last_seen_at: number;
  sample_count: number;
  high_water_confidence: number;
}

let _store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!_store) _store = await Store.load(STORE_FILE);
  return _store;
}

export async function getAllProfiles(): Promise<Record<string, DeviceProfile>> {
  try {
    const store = await getStore();
    return (await store.get<Record<string, DeviceProfile>>(KEY_PROFILES)) ?? {};
  } catch {
    return {};
  }
}

export async function getProfile(fingerprint: string): Promise<DeviceProfile | null> {
  const all = await getAllProfiles();
  return all[fingerprint] ?? null;
}

export async function saveProfile(
  device: DiscoveredDevice,
  analysis: ProtocolAnalysis
): Promise<DeviceProfile | null> {
  if (analysis.confidence < MIN_CONFIDENCE_TO_SAVE) return null;

  const store = await getStore();
  const fp = deviceFingerprint(device);
  const existing = (await getAllProfiles())[fp];
  const now = Date.now();

  const profile: DeviceProfile = {
    fingerprint: fp,
    vid: device.vid,
    pid: device.pid,
    serial_number: device.serial_number,
    manufacturer: device.manufacturer,
    product: device.product,
    device_class: device.device_class,
    suggested_baud: device.suggested_baud,
    protocol: analysis.protocol,
    confidence: analysis.confidence,
    device_hint: analysis.device_hint,
    expected_fields: analysis.fields,
    command_presets: analysis.command_presets ?? existing?.command_presets ?? [],
    notes: analysis.notes,
    needs_baud_warmup: existing?.needs_baud_warmup,
    sumber: 'learned',
    first_learned_at: existing?.first_learned_at ?? now,
    last_seen_at: now,
    sample_count: (existing?.sample_count ?? 0) + 1,
    high_water_confidence: Math.max(
      existing?.high_water_confidence ?? 0,
      analysis.confidence
    ),
  };

  const all = await getAllProfiles();
  all[fp] = profile;
  await store.set(KEY_PROFILES, all);
  await store.save();
  return profile;
}

export async function deleteProfile(fingerprint: string): Promise<void> {
  const store = await getStore();
  const all = await getAllProfiles();
  delete all[fingerprint];
  await store.set(KEY_PROFILES, all);
  await store.save();
}

/** Remove every learned device profile. Used by Settings → "Clear learned
 *  data" and by demo recording to guarantee a fresh first-run experience. */
export async function clearAllProfiles(): Promise<void> {
  const store = await getStore();
  await store.set(KEY_PROFILES, {});
  await store.save();
}

/** Convert a stored profile back to a ProtocolAnalysis shape for UI display. */
export function profileToAnalysis(p: DeviceProfile): ProtocolAnalysis {
  return {
    protocol: p.protocol,
    confidence: p.confidence,
    device_hint: p.device_hint,
    fields: p.expected_fields,
    notes: p.notes,
    command_presets: p.command_presets,
  };
}
