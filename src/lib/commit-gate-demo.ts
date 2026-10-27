import { DEMO_SCENARIOS } from './demo.js';
import type { DataLine } from './types.js';

function modbusCrc16(data: number[]): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001;
      else crc >>= 1;
    }
  }
  return crc & 0xffff;
}

/** Per-line Modbus CRC16. Each demo line is one frame. */
export function bufferModbusCrcRatio(lines: Array<{ hex: string }>): {
  frames: number;
  valid: number;
  ratio: number;
} {
  let frames = 0;
  let valid = 0;
  for (const line of lines) {
    const bytes = line.hex
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 16));
    if (bytes.length < 4 || bytes.some((byte) => Number.isNaN(byte) || byte > 0xff)) continue;
    frames++;
    const crcLo = bytes[bytes.length - 2];
    const crcHi = bytes[bytes.length - 1];
    const expected = (crcHi << 8) | crcLo;
    if (modbusCrc16(bytes.slice(0, -2)) === expected) valid++;
  }
  const ratio = frames > 0 ? Math.round((valid / frames) * 100) / 100 : 0;
  return { frames, valid, ratio };
}

/** Flip CRC bytes so analyze_binary_structure reports a Modbus miss. */
export function breakTrailingCrc(hex: string): string {
  const parts = hex.split(/\s+/).filter(Boolean);
  if (parts.length < 4) return hex;
  const last = parts.length - 1;
  parts[last] = parts[last] === '00' ? 'FF' : '00';
  parts[last - 1] = parts[last - 1] === '00' ? 'FF' : '00';
  return parts.join(' ');
}

export interface ModbusMachineReading {
  temperatureC: number;
  pressureHpa: number;
  flowLMin: number;
  motorRpm: number;
  valvePercent: number;
  alarm: number;
}

/** Engineering units from one Modbus read-holding-registers frame. */
export function readModbusMachine(hex: string): ModbusMachineReading | null {
  const bytes = hex
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 16));
  if (bytes.length < 15 || bytes[0] !== 0x01 || bytes[1] !== 0x03) return null;
  const count = bytes[2];
  if (!Number.isInteger(count) || count < 12 || bytes.length < 3 + 12) return null;
  const register = (index: number) => (bytes[3 + index * 2] << 8) | bytes[3 + index * 2 + 1];
  return {
    temperatureC: register(0) / 10,
    pressureHpa: register(1),
    flowLMin: register(2),
    motorRpm: register(3),
    valvePercent: register(4),
    alarm: register(5),
  };
}

/** Build buffer lines from a built-in device scenario. */
export function buildDemoBufferLines(
  scenarioId: 'cas-scale' | 'modbus-plc',
  lineCount = 24,
  options?: { breakCrc?: boolean }
): DataLine[] {
  const scenario = DEMO_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return [];

  const lines: DataLine[] = [];
  let seq = 0;
  for (let i = 0; i < lineCount; i++) {
    const bytes = scenario.generate();
    let hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    if (options?.breakCrc && scenarioId === 'modbus-plc') {
      hex = breakTrailingCrc(hex);
    }
    const shown = hex.split(/\s+/).filter(Boolean).map((part) => Number.parseInt(part, 16));
    const ascii = shown
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'))
      .join('');
    lines.push({
      id: ++seq,
      timestamp: Date.now() + i,
      hex,
      ascii,
      bytes: shown.length,
    });
  }
  return lines;
}
