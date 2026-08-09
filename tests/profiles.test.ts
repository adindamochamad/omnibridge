import { describe, it, expect } from 'vitest';
import {
  buildProfileExportBundle,
  mergeProfileMaps,
  parseProfileExport,
  PROFILE_EXPORT_VERSION,
  type DeviceProfile,
} from '../src/lib/profiles.js';

const profilContoh: DeviceProfile = {
  fingerprint: '1234:5678:ABC',
  vid: 0x1234,
  pid: 0x5678,
  serial_number: 'ABC',
  manufacturer: 'FTDI',
  product: 'USB Serial',
  device_class: 'scale',
  suggested_baud: 9600,
  protocol: 'CAS Scale',
  confidence: 92,
  device_hint: 'Weighing scale',
  expected_fields: [],
  notes: '',
  first_learned_at: 1000,
  last_seen_at: 2000,
  sample_count: 3,
  high_water_confidence: 92,
};

describe('buildProfileExportBundle', () => {
  it('wraps profiles in a versioned bundle', () => {
    const bundle = buildProfileExportBundle({ [profilContoh.fingerprint]: profilContoh });
    expect(bundle.version).toBe(PROFILE_EXPORT_VERSION);
    expect(bundle.app).toBe('omnibridge');
    expect(bundle.profiles).toHaveLength(1);
    expect(bundle.profiles[0].fingerprint).toBe('1234:5678:ABC');
  });
});

describe('parseProfileExport', () => {
  it('parses official bundle format', () => {
    const bundle = buildProfileExportBundle({ [profilContoh.fingerprint]: profilContoh });
    const hasil = parseProfileExport(JSON.stringify(bundle));
    expect(hasil).toHaveLength(1);
    expect(hasil[0].protocol).toBe('CAS Scale');
  });

  it('parses raw array format', () => {
    const hasil = parseProfileExport(JSON.stringify([profilContoh]));
    expect(hasil).toHaveLength(1);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseProfileExport('not json')).toThrow(/JSON/i);
  });

  it('rejects empty profile list', () => {
    expect(() => parseProfileExport(JSON.stringify({ profiles: [{}] }))).toThrow(/valid/i);
  });

  it('rejects unknown app bundle', () => {
    const bundle = { ...buildProfileExportBundle({}), app: 'other-app' };
    expect(() => parseProfileExport(JSON.stringify(bundle))).toThrow(/OmniBridge/i);
  });
});

describe('mergeProfileMaps', () => {
  it('merges incoming profiles into existing map', () => {
    const existing = { [profilContoh.fingerprint]: profilContoh };
    const baru: DeviceProfile = { ...profilContoh, fingerprint: '9999:1111:XYZ', protocol: 'NMEA' };
    const hasil = mergeProfileMaps(existing, [baru], 'merge');
    expect(Object.keys(hasil)).toHaveLength(2);
    expect(hasil['9999:1111:XYZ'].protocol).toBe('NMEA');
  });

  it('replaces entire map in replace mode', () => {
    const existing = { [profilContoh.fingerprint]: profilContoh };
    const baru: DeviceProfile = { ...profilContoh, fingerprint: '9999:1111:XYZ' };
    const hasil = mergeProfileMaps(existing, [baru], 'replace');
    expect(Object.keys(hasil)).toHaveLength(1);
    expect(hasil['9999:1111:XYZ']).toBeDefined();
  });
});
