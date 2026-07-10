import { describe, it, expect, beforeEach } from 'vitest';
import {
  apakahAdaptorCh340,
  apakahPerangkatCas,
  resetWarmupCas,
} from '../src/lib/cas-scale.js';
import type { DiscoveredDevice } from '../src/lib/types.js';

function deviceContoh(patch: Partial<DiscoveredDevice> = {}): DiscoveredDevice {
  return {
    port: 'COM3',
    device_class: 'unknown',
    label: 'Unknown',
    manufacturer: null,
    product: null,
    vid: null,
    pid: null,
    serial_number: null,
    suggested_baud: 9600,
    ...patch,
  };
}

describe('apakahAdaptorCh340', () => {
  it('mengenali device_class ch340', () => {
    expect(apakahAdaptorCh340(deviceContoh({ device_class: 'ch340' }))).toBe(true);
  });

  it('mengenali VID WCH 0x1A86', () => {
    expect(apakahAdaptorCh340(deviceContoh({ vid: 0x1a86 }))).toBe(true);
  });
});

describe('apakahPerangkatCas', () => {
  beforeEach(() => resetWarmupCas());

  it('mengenali COM3 CH340 sebagai timbangan CAS', () => {
    expect(
      apakahPerangkatCas(
        deviceContoh({
          port: 'COM3',
          device_class: 'ch340',
          label: 'CH340/CH341',
          vid: 0x1a86,
        })
      )
    ).toBe(true);
  });

  it('tidak mengenali port generik tanpa CAS/CH340', () => {
    expect(
      apakahPerangkatCas(
        deviceContoh({
          device_class: 'ftdi_adapter',
          manufacturer: 'FTDI',
          product: 'FT232R',
        })
      )
    ).toBe(false);
  });
});
