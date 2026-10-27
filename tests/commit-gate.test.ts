import { describe, expect, it } from 'vitest';
import { applyCommitGate, verifyFieldRegexes } from '../src/lib/commit-gate.js';
import {
  breakTrailingCrc,
  bufferModbusCrcRatio,
  buildDemoBufferLines,
  faceplateValuesVisible,
  readModbusMachine,
  shouldProveGateOpens,
} from '../src/lib/commit-gate-demo.js';
import type { DataLine } from '../src/lib/types.js';

function line(ascii: string, id = 1): DataLine {
  return {
    id,
    timestamp: Date.now(),
    hex: '',
    ascii,
    bytes: ascii.length,
  };
}

describe('commit gate', () => {
  it('naive lane always commits', () => {
    const analysis = {
      protocol: 'CAS Scale',
      confidence: 90,
      device_hint: 'scale',
      fields: [{ name: 'w', regex: 'no-match' }],
      notes: '',
    };
    const out = applyCommitGate(analysis, [line('ST,GS, 1.0 kg')], null, 'naive');
    expect(out.committed).toBe(true);
    expect(out.analysis.gate_mode).toBe('naive');
  });

  it('verified lane holds when ASCII regexes do not match', () => {
    const analysis = {
      protocol: 'CAS Scale',
      confidence: 90,
      device_hint: 'scale',
      fields: [{ name: 'w', regex: 'GS,\\s*([\\d.]+)\\s*kg', capture_group: 1 }],
      notes: '',
    };
    const out = applyCommitGate(
      analysis,
      [line('garbage line')],
      [{ type: 'tool_result', tool_name: 'search_pattern', tool_output: '{"total_matches":0}' }],
      'verified'
    );
    expect(out.committed).toBe(false);
    expect(out.analysis.fields).toHaveLength(0);
  });

  it('verified lane commits when regex matches buffer', () => {
    const analysis = {
      protocol: 'CAS Scale',
      confidence: 90,
      device_hint: 'scale',
      fields: [{ name: 'w', regex: 'GS,\\s*([\\d.]+)\\s*kg', capture_group: 1 }],
      notes: '',
    };
    const out = applyCommitGate(
      analysis,
      [line('ST,GS,  1.234 kg')],
      null,
      'verified'
    );
    expect(out.committed).toBe(true);
  });

  it('verified lane holds Modbus when CRC validity is low', () => {
    const analysis = {
      protocol: 'Modbus RTU',
      confidence: 99,
      device_hint: 'PLC',
      fields: [
        {
          name: 'reg0',
          regex: '^01 03',
          match_hex: true,
          capture_group: 0,
        },
      ],
      notes: '',
      command_presets: [{ name: 'Force coil', hex: '01 05 00 00 FF 00' }],
    };
    const hexLine = {
      id: 1,
      timestamp: Date.now(),
      hex: '01 03 14 00 FE 03 F5 00 2D 07 08 00 4B 00 00 00 00 00 00 00 00 00 00 AA BB',
      ascii: '·························',
      bytes: 25,
    };
    const out = applyCommitGate(
      analysis,
      [hexLine],
      [
        {
          type: 'tool_result',
          tool_name: 'analyze_binary_structure',
          tool_output: JSON.stringify({
            modbus_crc_check: { validity_ratio: 0.1, frames_tested: 10 },
          }),
        },
      ],
      'verified'
    );
    expect(out.committed).toBe(false);
    expect(out.analysis.fields).toHaveLength(0);
    expect(out.analysis.command_presets).toEqual([]);
    expect(out.analysis.withheld_presets).toEqual([
      { name: 'Force coil', hex: '01 05 00 00 FF 00' },
    ]);
  });

  it('verified lane holds a Modbus-shaped parser when the title omits the word Modbus', () => {
    const hexLine = {
      id: 1,
      timestamp: Date.now(),
      hex: '01 03 14 00 FE 03 F5 00 2D 07 08 00 4B 00 00 00 00 00 00 00 00 00 00 AA BB',
      ascii: '·························',
      bytes: 25,
    };
    const out = applyCommitGate(
      {
        protocol: 'Industrial frame',
        confidence: 96,
        device_hint: 'RTU PLC',
        fields: [{ name: 'reg0', regex: '^01 03', match_hex: true, capture_group: 0 }],
        notes: '',
        command_presets: [{ name: 'Write register', hex: '01 06 00 00 00 01' }],
      },
      [hexLine],
      [
        {
          type: 'tool_result',
          tool_name: 'analyze_binary_structure',
          tool_output: JSON.stringify({
            modbus_crc_check: { validity_ratio: 0.1, frames_tested: 10 },
          }),
        },
      ],
      'verified'
    );
    expect(out.committed).toBe(false);
    expect(out.analysis.fields).toHaveLength(0);
    expect(out.analysis.command_presets).toEqual([]);
    expect(out.analysis.withheld_presets).toEqual([
      { name: 'Write register', hex: '01 06 00 00 00 01' },
    ]);
  });

  it('verified lane holds a binary parser when CRC validity is below 0.9 even if the title is not Modbus', () => {
    const hexLine = {
      id: 1,
      timestamp: Date.now(),
      hex: '05 64 AA BB CC',
      ascii: '·····',
      bytes: 5,
    };
    const out = applyCommitGate(
      {
        protocol: 'Vendor frame',
        confidence: 91,
        device_hint: 'controller',
        fields: [{ name: 'byte0', regex: '^([0-9A-F]{2})', match_hex: true, capture_group: 1 }],
        notes: '',
        command_presets: [{ name: 'Force coil', hex: '01 05 00 00 FF 00' }],
      },
      [hexLine],
      [
        {
          type: 'tool_result',
          tool_name: 'analyze_binary_structure',
          tool_output: JSON.stringify({
            modbus_crc_check: { validity_ratio: 0, frames_tested: 8 },
          }),
        },
      ],
      'verified'
    );
    expect(out.committed).toBe(false);
    expect(out.analysis.fields).toHaveLength(0);
    expect(out.analysis.command_presets).toEqual([]);
    expect(out.analysis.withheld_presets).toEqual([
      { name: 'Force coil', hex: '01 05 00 00 FF 00' },
    ]);
    expect(out.commit_reason).toContain('need ≥ 0.9');
  });

  it('verified lane commits a non-Modbus binary parser when CRC was not measured and the regex matches', () => {
    const hexLine = {
      id: 1,
      timestamp: Date.now(),
      hex: '05 64 AA BB CC',
      ascii: '·····',
      bytes: 5,
    };
    const out = applyCommitGate(
      {
        protocol: 'DNP3',
        confidence: 90,
        device_hint: 'relay',
        fields: [
          {
            name: 'start',
            regex: '^05 64 ([0-9A-F]{2})',
            match_hex: true,
            capture_group: 1,
          },
        ],
        notes: '',
      },
      [hexLine],
      [
        {
          type: 'tool_result',
          tool_name: 'analyze_binary_structure',
          tool_output: JSON.stringify({ frame_analysis: { likely_frame_length: 5 } }),
        },
      ],
      'verified'
    );
    expect(out.committed).toBe(true);
    expect(out.analysis.fields).toHaveLength(1);
  });

  it('verified lane commits Modbus when CRC validity is high', () => {
    const analysis = {
      protocol: 'Modbus RTU',
      confidence: 98,
      device_hint: 'PLC',
      fields: [{ name: 'reg0', regex: '^01 03 14 ([0-9A-F]{2} [0-9A-F]{2})', match_hex: true, capture_group: 1 }],
      notes: '',
    };
    const hexLine = {
      id: 1,
      timestamp: Date.now(),
      hex: '01 03 14 00 FE 03 F5 00 2D 07 08 00 4B 00 00 00 00 00 00 00 00 00 00 AA BB',
      ascii: '·························',
      bytes: 25,
    };
    const out = applyCommitGate(
      analysis,
      [hexLine],
      [
        {
          type: 'tool_result',
          tool_name: 'analyze_binary_structure',
          tool_output: JSON.stringify({
            modbus_crc_check: { validity_ratio: 0.95, frames_tested: 10 },
          }),
        },
      ],
      'verified'
    );
    expect(out.committed).toBe(true);
    expect(out.analysis.fields.length).toBeGreaterThan(0);
  });

  it('verifyFieldRegexes reports match rate', () => {
    const r = verifyFieldRegexes(
      {
        protocol: 'x',
        confidence: 1,
        device_hint: '',
        fields: [{ name: 'w', regex: 'GS,\\s*([\\d.]+)\\s*kg', capture_group: 1 }],
        notes: '',
      },
      [line('ST,GS,  2.000 kg')]
    );
    expect(r.pass).toBe(true);
    expect(r.matchRate).toBe(1);
  });

  it('breakTrailingCrc changes the last two hex bytes', () => {
    const hex = '01 03 14 00 FE AA BB';
    const broken = breakTrailingCrc(hex);
    expect(broken).not.toBe(hex);
    expect(broken.startsWith('01 03 14')).toBe(true);
  });

  it('demo Modbus buffer CRC is 1.00 intact and below 0.90 when flipped', () => {
    const intact = buildDemoBufferLines('modbus-plc', 12, { breakCrc: false });
    const broken = buildDemoBufferLines('modbus-plc', 12, { breakCrc: true });
    expect(bufferModbusCrcRatio(intact).ratio).toBe(1);
    expect(bufferModbusCrcRatio(broken).ratio).toBeLessThan(0.9);
    const flipped = broken[0];
    const fromHex = flipped.hex
      .split(/\s+/)
      .map((part) => (Number.parseInt(part, 16) >= 0x20 && Number.parseInt(part, 16) <= 0x7e
        ? String.fromCharCode(Number.parseInt(part, 16))
        : '·'))
      .join('');
    expect(flipped.ascii).toBe(fromHex);
  });

  it('shows PLC values only after the verified lane commits on a strong CRC', () => {
    expect(faceplateValuesVisible({ verifiedCommitted: false, crcRatio: 0 })).toBe(false);
    expect(faceplateValuesVisible({ verifiedCommitted: null, crcRatio: 1 })).toBe(false);
    expect(faceplateValuesVisible({ verifiedCommitted: true, crcRatio: 0 })).toBe(false);
    expect(faceplateValuesVisible({ verifiedCommitted: true, crcRatio: 1 })).toBe(true);
  });

  it('re-runs the compare only when Break CRC is cleared after a hold', () => {
    expect(
      shouldProveGateOpens({
        previousBreakCrc: true,
        nextBreakCrc: false,
        scenario: 'modbus-plc',
        verifiedCommitted: false,
        running: false,
      })
    ).toBe(true);
    expect(
      shouldProveGateOpens({
        previousBreakCrc: true,
        nextBreakCrc: false,
        scenario: 'modbus-plc',
        verifiedCommitted: true,
        running: false,
      })
    ).toBe(false);
    expect(
      shouldProveGateOpens({
        previousBreakCrc: false,
        nextBreakCrc: true,
        scenario: 'modbus-plc',
        verifiedCommitted: false,
        running: false,
      })
    ).toBe(false);
  });

  it('reads the same machine values when only the CRC bytes are flipped', () => {
    const intact = buildDemoBufferLines('modbus-plc', 1, { breakCrc: false });
    const reading = readModbusMachine(intact[0].hex);
    expect(reading).not.toBeNull();
    expect(reading!.temperatureC).toBeGreaterThan(0);
    expect(reading!.motorRpm).toBeGreaterThan(0);
    expect(readModbusMachine(breakTrailingCrc(intact[0].hex))).toEqual(reading);
  });
});
