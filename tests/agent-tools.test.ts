import { beforeEach, describe, expect, it, vi } from 'vitest';
import agentToolsSource from '../src/lib/agent-tools.ts?raw';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { executeTool, type ToolContext } from '../src/lib/agent-tools.js';
import type { DataLine } from '../src/lib/types.js';

const TOOL_USE_ID = 'toolu_test_01';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'safemode_authorize_tool') {
      return { allowed: true };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function bytesToDataLine(bytes: number[], id = 1, ts = Date.now()): DataLine {
  return {
    id,
    timestamp: ts,
    hex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
    ascii: bytes
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'))
      .join(''),
    bytes: bytes.length,
  };
}

function modbusCrc16(data: number[]): [number, number] {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001;
      else crc >>= 1;
    }
  }
  return [crc & 0xff, (crc >> 8) & 0xff];
}

function buildModbusFrame(registers: number[]): number[] {
  const byteCount = registers.length * 2;
  const frame: number[] = [0x01, 0x03, byteCount];
  for (const r of registers) {
    frame.push((r >> 8) & 0xff);
    frame.push(r & 0xff);
  }
  const [lo, hi] = modbusCrc16(frame);
  frame.push(lo, hi);
  return frame;
}

const emptyCtx: ToolContext = { port: 'test', lines: [], device: null };

// ── analyze_binary_structure ───────────────────────────────────────────────

describe('analyze_binary_structure — Modbus RTU', () => {
  it('detects 25-byte frame length and validates CRC16 on clean Modbus stream', async () => {
    // Emit 10 Modbus frames with 10 registers each (25 bytes per frame)
    const lines: DataLine[] = [];
    for (let i = 0; i < 10; i++) {
      const regs = [254 + i, 1013, 45, 1800, 75, 0, 0, 0, 0, 0];
      lines.push(bytesToDataLine(buildModbusFrame(regs), i + 1));
    }
    const ctx: ToolContext = { port: 'test', lines, device: null };
    const raw = await executeTool('analyze_binary_structure', { hypothesis: 'testing' }, ctx, TOOL_USE_ID);
    const parsed = JSON.parse(raw);

    expect(parsed.frame_analysis).toBeTruthy();
    expect(parsed.frame_analysis.likely_frame_length).toBe(25);
    expect(parsed.frame_analysis.frames_detected).toBe(10);
    expect(parsed.modbus_crc_check.frames_valid).toBe(10);
    expect(parsed.modbus_crc_check.validity_ratio).toBe(1);
    expect(parsed.modbus_crc_check.interpretation).toMatch(/STRONG MATCH/);
    expect(parsed.is_likely_binary).toBe(true);
  });

  it('returns error when buffer too small', async () => {
    const lines = [bytesToDataLine([0x01, 0x02, 0x03])];
    const ctx: ToolContext = { port: 'test', lines, device: null };
    const raw = await executeTool('analyze_binary_structure', { hypothesis: 'x' }, ctx, TOOL_USE_ID);
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/Not enough bytes/);
  });

  it('reports high printable ratio for ASCII streams', async () => {
    const lines: DataLine[] = [];
    for (let i = 0; i < 5; i++) {
      const ascii = `ST,GS,  ${(1.0 + i * 0.1).toFixed(3)} kg\r\n`;
      const bytes = Array.from(ascii).map((c) => c.charCodeAt(0));
      lines.push(bytesToDataLine(bytes, i + 1));
    }
    const ctx: ToolContext = { port: 'test', lines, device: null };
    const raw = await executeTool('analyze_binary_structure', { hypothesis: 'x' }, ctx, TOOL_USE_ID);
    const parsed = JSON.parse(raw);
    expect(parsed.printable_ratio).toBeGreaterThan(0.9);
    expect(parsed.is_likely_binary).toBe(false);
  });
});

// ── search_pattern ─────────────────────────────────────────────────────────

describe('search_pattern', () => {
  it('finds ASCII pattern matches in buffered lines', async () => {
    const lines = [
      bytesToDataLine(Array.from('temp=24.5').map((c) => c.charCodeAt(0))),
      bytesToDataLine(Array.from('temp=25.1').map((c) => c.charCodeAt(0))),
      bytesToDataLine(Array.from('humid=62').map((c) => c.charCodeAt(0))),
    ];
    const ctx: ToolContext = { port: 'test', lines, device: null };
    const raw = await executeTool(
      'search_pattern',
      { regex: 'temp=[\\d.]+', purpose: 'verify' },
      ctx,
      TOOL_USE_ID
    );
    const parsed = JSON.parse(raw);
    expect(parsed.total_matches).toBe(2);
    expect(parsed.sample_matches).toHaveLength(2);
  });

  it('rejects ReDoS-prone nested quantifier', async () => {
    const raw = await executeTool(
      'search_pattern',
      { regex: '(a+)+b', purpose: 'attack' },
      emptyCtx,
      TOOL_USE_ID
    );
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/ReDoS|nested/i);
  });

  it('rejects overly long pattern', async () => {
    const raw = await executeTool(
      'search_pattern',
      { regex: 'a'.repeat(400), purpose: 'overflow' },
      emptyCtx,
      TOOL_USE_ID
    );
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/too long/);
  });
});

// ── read_more_lines ────────────────────────────────────────────────────────

describe('read_more_lines', () => {
  it('returns requested count capped at buffer size', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      bytesToDataLine([0x41 + i, 0x42, 0x43], i + 1)
    );
    const ctx: ToolContext = { port: 'test', lines, device: null };
    const raw = await executeTool('read_more_lines', { count: 10 }, ctx, TOOL_USE_ID);
    const parsed = JSON.parse(raw);
    expect(parsed.returned).toBe(5);
    expect(parsed.total_buffer_size).toBe(5);
    expect(parsed.lines).toHaveLength(5);
  });

  it('clamps count to 100 max', async () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      bytesToDataLine([0x41], i + 1)
    );
    const ctx: ToolContext = { port: 'test', lines, device: null };
    const raw = await executeTool('read_more_lines', { count: 999 }, ctx, TOOL_USE_ID);
    const parsed = JSON.parse(raw);
    expect(parsed.returned).toBe(100);
  });
});

// ── Safe Mode gate (send_bytes) ────────────────────────────────────────────

describe('send_bytes — Safe Mode gate', () => {
  it('does not reference send_bytes_to_port in agent-tools source', () => {
    expect(agentToolsSource.includes('send_bytes_to_port')).toBe(false);
  });

  it('returns do_not_retry when the gate blocks the write', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'safemode_authorize_tool') {
        return { allowed: true };
      }
      if (cmd === 'safemode_agent_send_bytes') {
        return {
          ok: false,
          blocked: true,
          reason: 'needs_approval',
          retry: 'do_not_retry',
        };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const raw = await executeTool(
      'send_bytes',
      { hex: '1B 54', purpose: 'test write' },
      emptyCtx,
      TOOL_USE_ID
    );
    const parsed = JSON.parse(raw);
    expect(parsed.blocked).toBe(true);
    expect(parsed.retry).toBe('do_not_retry');
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'send_bytes_to_port')).toBe(
      false
    );
  });

  it('propagates authorize denial without calling send gate', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'safemode_authorize_tool') {
        return {
          allowed: false,
          blocked: true,
          reason: 'policy_denied:unknown_tool',
          retry: 'do_not_retry',
        };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const raw = await executeTool(
      'send_bytes',
      { hex: '1B 54', purpose: 'test' },
      emptyCtx,
      TOOL_USE_ID
    );
    const parsed = JSON.parse(raw);
    expect(parsed.retry).toBe('do_not_retry');
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === 'safemode_agent_send_bytes')).toBe(
      false
    );
  });
});
