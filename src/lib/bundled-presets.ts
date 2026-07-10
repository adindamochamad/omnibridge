import casScalePreset from '../../presets/cas-scale.json';
import { getAllProfiles, type DeviceProfile } from './profiles.js';
import { saveConfig, getConfig, defaultConfig, type WebhookConfig } from './webhook.js';
import { deviceFingerprint, type DiscoveredDevice } from './types.js';
import { apakahPerangkatCas } from './cas-scale.js';
import type { CommandPreset } from './claude.js';

interface PresetBundled {
  id: string;
  name: string;
  description: string;
  match: {
    manufacturer_contains?: string[];
    product_contains?: string[];
    protocol_contains?: string[];
  };
  profile: {
    protocol: string;
    confidence: number;
    device_hint: string;
    suggested_baud: number;
    needs_baud_warmup?: boolean;
    notes: string;
    expected_fields: DeviceProfile['expected_fields'];
    command_presets?: CommandPreset[];
  };
  webhook?: Partial<WebhookConfig>;
}

const DAFTAR_PRESET: PresetBundled[] = [casScalePreset as PresetBundled];

function cocokPreset(device: DiscoveredDevice, preset: PresetBundled): boolean {
  const manuf = (device.manufacturer ?? '').toLowerCase();
  const produk = (device.product ?? '').toLowerCase();

  const cocokManuf = preset.match.manufacturer_contains?.some((k) =>
    manuf.includes(k.toLowerCase())
  );
  const cocokProduk = preset.match.product_contains?.some((k) =>
    produk.includes(k.toLowerCase())
  );

  return !!(cocokManuf || cocokProduk || apakahPerangkatCas(device));
}

/** Terapkan preset bawaan ke store lokal jika belum ada profil untuk device ini. */
export async function terapkanPresetBundled(
  device: DiscoveredDevice
): Promise<{
  profil: DeviceProfile | null;
  webhook: WebhookConfig | null;
  profilBaruDibuat: boolean;
  webhookBaruDibuat: boolean;
}> {
  const preset = DAFTAR_PRESET.find((p) => cocokPreset(device, p));
  if (!preset) {
    return { profil: null, webhook: null, profilBaruDibuat: false, webhookBaruDibuat: false };
  }

  const fp = deviceFingerprint(device);
  const profilAda = (await getAllProfiles())[fp];
  const webhookAda = await getConfig(fp);

  let profilHasil: DeviceProfile | null = profilAda ?? null;
  let webhookHasil: WebhookConfig | null = webhookAda ?? null;
  let profilBaruDibuat = false;
  let webhookBaruDibuat = false;

  if (!profilAda) {
    profilBaruDibuat = true;
    const sekarang = Date.now();
    const dataProfil = preset.profile;
    profilHasil = {
      fingerprint: fp,
      vid: device.vid,
      pid: device.pid,
      serial_number: device.serial_number,
      manufacturer: device.manufacturer,
      product: device.product,
      device_class: device.device_class,
      suggested_baud: dataProfil.suggested_baud,
      needs_baud_warmup: dataProfil.needs_baud_warmup ?? true,
      protocol: dataProfil.protocol,
      confidence: dataProfil.confidence,
      device_hint: dataProfil.device_hint,
      expected_fields: dataProfil.expected_fields,
      command_presets: dataProfil.command_presets ?? [],
      notes: dataProfil.notes,
      first_learned_at: sekarang,
      last_seen_at: sekarang,
      sample_count: 1,
      high_water_confidence: dataProfil.confidence,
      sumber: 'bundled',
    };
    const semua = await getAllProfiles();
    const { Store } = await import('@tauri-apps/plugin-store');
    const store = await Store.load('omnibridge.profiles.json');
    semua[fp] = profilHasil;
    await store.set('profiles', semua);
    await store.save();
  }

  if (!webhookAda && preset.webhook) {
    webhookBaruDibuat = true;
    webhookHasil = { ...defaultConfig(), ...preset.webhook };
    await saveConfig(fp, webhookHasil);
  }

  return { profil: profilHasil, webhook: webhookHasil, profilBaruDibuat, webhookBaruDibuat };
}

/** Terapkan semua preset yang cocok untuk daftar device yang ditemukan. */
export async function terapkanSemuaPresetBundled(
  devices: DiscoveredDevice[]
): Promise<{ profilBaru: number; webhookBaru: number }> {
  let profilBaru = 0;
  let webhookBaru = 0;
  for (const d of devices) {
    const hasil = await terapkanPresetBundled(d);
    if (hasil.profilBaruDibuat) profilBaru++;
    if (hasil.webhookBaruDibuat) webhookBaru++;
  }
  return { profilBaru, webhookBaru };
}

/** Daftar preset yang tersedia di repo (untuk dokumentasi UI). */
export function daftarPresetBundled(): Array<{ id: string; name: string; description: string }> {
  return DAFTAR_PRESET.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
  }));
}
