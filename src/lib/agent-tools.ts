import Anthropic from '@anthropic-ai/sdk';
import { invoke } from '@tauri-apps/api/core';
import type { DataLine, DiscoveredDevice, BaudProbeResult } from './types.js';

// ── Tool definitions exposed to Claude ─────────────────────────────────────

export const AGENT_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'read_more_lines',
    description:
      'Retrieve more recent ASCII+HEX lines from the serial buffer. The initial sample shows only 20 lines; use this to see up to 100 more. Useful when you need to see the full packet structure or verify consistency across more samples.',
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          description: 'Number of most-recent lines to retrieve (1-100).',
        },
      },
      required: ['count'],
    },
  },
  {
    name: 'search_pattern',
    description:
      'Search all buffered ASCII lines for an ECMAScript regex. Returns total match count and up to 5 sample matching lines. Double-escape backslashes in JSON (\\\\s, not \\s). Useful to verify protocol hypotheses like NMEA checksums (\\\\*[0-9A-F]{2}$), specific framing bytes, or key:value patterns.',
    input_schema: {
      type: 'object',
      properties: {
        regex: {
          type: 'string',
          description: 'ECMAScript regex pattern to search for.',
        },
        purpose: {
          type: 'string',
          description: 'Short reason why you are searching (shown to the user in the trace).',
        },
      },
      required: ['regex', 'purpose'],
    },
  },
  {
    name: 'get_device_metadata',
    description:
      'Return the USB descriptor fields (VID, PID, manufacturer, product strings, device class) for the connected device. Useful for cross-referencing known hardware (e.g. FTDI adapters, Arduino boards, CP210x, CH340 clones) to strengthen protocol hypothesis.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'probe_baud_rate',
    description:
      'Test a different baud rate by briefly opening the port at that rate and measuring printable ASCII ratio. Use ONLY when the current data looks like garbage (low printable chars suggest wrong baud). Will fail if the port is currently being monitored — recommend to user in that case. Common rates: 4800, 9600, 19200, 38400, 57600, 115200.',
    input_schema: {
      type: 'object',
      properties: {
        baud: {
          type: 'integer',
          description: 'Baud rate to test.',
        },
      },
      required: ['baud'],
    },
  },
  {
    name: 'send_bytes',
    description:
      'Send bytes TO the device (bidirectional communication). Use ONLY when you need to trigger a response to verify protocol (e.g. sending a Modbus query, requesting NMEA rate config, issuing scale tare). Requires explicit human approval in the app before any bytes are transmitted. If the operator denies or the request times out, do NOT call send_bytes again in this investigation — continue with read-only tools. REQUIRES active monitor on the port. Use sparingly.',
    input_schema: {
      type: 'object',
      properties: {
        hex: {
          type: 'string',
          description: 'Bytes to send as hex string (e.g. "1B 54 0D 0A" or "1B540D0A"). Whitespace ignored.',
        },
        purpose: {
          type: 'string',
          description: 'Why this command is being sent (e.g. "query scale tare", "request GPS rate config").',
        },
      },
      required: ['hex', 'purpose'],
    },
  },
  {
    name: 'analyze_binary_structure',
    description:
      'Structural analysis of the raw byte stream for binary protocols. Returns: printable ASCII ratio, framing byte counts (STX/ETX/DLE/SOH), detected frame length via repeating-prefix autocorrelation, Modbus CRC16 validation across detected frames, and sample frames in hex. USE THIS FIRST when printable_ratio looks low or data has no visible ASCII structure. Essential for Modbus RTU, DNP3, proprietary industrial protocols, and any STX/ETX-framed binary data.',
    input_schema: {
      type: 'object',
      properties: {
        hypothesis: {
          type: 'string',
          description: 'Short note of what you are testing (shown in the trace, e.g. "testing Modbus RTU framing" or "looking for repeating structure").',
        },
      },
      required: ['hypothesis'],
    },
  },
];

// ── Tool execution context ─────────────────────────────────────────────────

export interface ToolContext {
  port: string;
  lines: DataLine[];
  device: DiscoveredDevice | null;
  /** Compare runs identify the buffer only. Never open a write approval. */
  denyTransmit?: boolean;
}

// ── Tool executor ──────────────────────────────────────────────────────────

type ToolInput = Record<string, unknown>;

interface SafemodeAuthorizeResult {
  allowed: boolean;
  blocked?: boolean;
  reason?: string;
  retry?: string;
  message?: string;
}

interface SafemodeAgentSendResult {
  ok: boolean;
  blocked?: boolean;
  simulated?: boolean;
  bytes_sent?: number;
  reason?: string;
  retry?: string;
  message?: string;
}

function summarizeToolInput(input: ToolInput): string {
  return JSON.stringify(input).slice(0, 500);
}

export async function executeTool(
  name: string,
  input: ToolInput,
  ctx: ToolContext,
  toolUseId: string
): Promise<string> {
  if (ctx.denyTransmit && (name === 'send_bytes' || name === 'probe_baud_rate')) {
    return JSON.stringify({
      ok: false,
      blocked: true,
      retry: 'do_not_retry',
      reason: 'transmit_disabled',
      message:
        'This run identifies the buffer only. Do not transmit. Call analyze_binary_structure before the final JSON.',
    });
  }

  try {
    const auth = await invoke<SafemodeAuthorizeResult>('safemode_authorize_tool', {
      toolName: name,
      inputSummary: summarizeToolInput(input),
    });
    if (!auth.allowed) {
      return JSON.stringify({
        ok: false,
        blocked: auth.blocked ?? true,
        reason: auth.reason ?? 'denied',
        retry: auth.retry ?? 'do_not_retry',
        message: auth.message,
      });
    }

    switch (name) {
      case 'read_more_lines': {
        const rawCount = typeof input.count === 'number' ? input.count : 20;
        const n = Math.min(100, Math.max(1, Math.floor(rawCount)));
        const tail = ctx.lines.slice(-n);
        return JSON.stringify({
          total_buffer_size: ctx.lines.length,
          returned: tail.length,
          lines: tail.map((l) => ({ ascii: l.ascii, hex: l.hex, bytes: l.bytes })),
        });
      }

      case 'search_pattern': {
        const regex = String(input.regex ?? '');
        if (!regex) return JSON.stringify({ error: 'empty regex' });
        if (regex.length > 300) {
          return JSON.stringify({ error: 'regex too long (max 300 chars)' });
        }
        // ReDoS guard — reject nested quantifiers like (x+)+ / (x*)*
        if (/\([^)]*[+*][^)]*\)\s*[+*]/.test(regex)) {
          return JSON.stringify({
            error: 'regex rejected: nested quantifier pattern is ReDoS-prone. Simplify the expression.',
          });
        }
        let re: RegExp;
        try {
          re = new RegExp(regex);
        } catch (e) {
          return JSON.stringify({ error: `Invalid regex: ${(e as Error).message}` });
        }
        let matchCount = 0;
        const samples: { line: string; match: string }[] = [];
        for (const l of ctx.lines) {
          const m = l.ascii.match(re);
          if (m) {
            matchCount++;
            if (samples.length < 5) samples.push({ line: l.ascii, match: m[0] });
          }
        }
        return JSON.stringify({
          total_matches: matchCount,
          total_lines_scanned: ctx.lines.length,
          sample_matches: samples,
        });
      }

      case 'get_device_metadata': {
        if (!ctx.device) {
          return JSON.stringify({ error: 'No device metadata available' });
        }
        return JSON.stringify({
          vid: ctx.device.vid !== null ? `0x${ctx.device.vid.toString(16).padStart(4, '0').toUpperCase()}` : null,
          pid: ctx.device.pid !== null ? `0x${ctx.device.pid.toString(16).padStart(4, '0').toUpperCase()}` : null,
          manufacturer: ctx.device.manufacturer,
          product: ctx.device.product,
          device_class: ctx.device.device_class,
          serial_number: ctx.device.serial_number,
          suggested_baud: ctx.device.suggested_baud,
        });
      }

      case 'probe_baud_rate': {
        const baud = typeof input.baud === 'number' ? input.baud : 0;
        if (baud < 300 || baud > 921600) {
          return JSON.stringify({ error: `Baud ${baud} out of sensible range` });
        }
        try {
          const result = await invoke<BaudProbeResult>('probe_single_baud', {
            port: ctx.port,
            baud,
          });
          return JSON.stringify({
            baud: result.baud,
            printable_ratio: result.score,
            bytes_read: result.bytes_read,
            sample_ascii: result.sample_ascii,
            error: result.error,
          });
        } catch (e) {
          return JSON.stringify({ error: String(e) });
        }
      }

      case 'send_bytes': {
        const hexStr = String(input.hex ?? '').replace(/[\s,_-]/g, '').replace(/0x/gi, '');
        if (!hexStr) return JSON.stringify({ error: 'empty hex' });
        if (hexStr.length % 2 !== 0) return JSON.stringify({ error: 'hex must have even length' });
        if (!/^[0-9a-fA-F]+$/.test(hexStr)) return JSON.stringify({ error: 'invalid hex characters' });
        const data: number[] = [];
        for (let i = 0; i < hexStr.length; i += 2) {
          data.push(parseInt(hexStr.slice(i, i + 2), 16));
        }
        if (data.length > 256) {
          return JSON.stringify({ error: 'payload too large (max 256 bytes for agent sends)' });
        }
        try {
          const gate = await invoke<SafemodeAgentSendResult>('safemode_agent_send_bytes', {
            port: ctx.port,
            data,
            reason: String(input.purpose ?? ''),
            toolUseId,
          });
          if (!gate.ok) {
            return JSON.stringify(gate);
          }
          const before = ctx.lines.length;
          await new Promise((r) => setTimeout(r, 600));
          const newLines = ctx.lines.slice(before);
          return JSON.stringify({
            ok: true,
            bytes_sent: gate.bytes_sent ?? data.length,
            response_lines_captured: newLines.length,
            response_preview: newLines.slice(0, 5).map((l) => ({ ascii: l.ascii, hex: l.hex })),
          });
        } catch (e) {
          return JSON.stringify({ error: String(e) });
        }
      }

      case 'analyze_binary_structure': {
        // Reconstruct raw byte stream by parsing each line's hex representation.
        // We intentionally concatenate across lines — binary frames don't always
        // align to the renderer's line boundaries.
        const allBytes: number[] = [];
        for (const line of ctx.lines) {
          const parts = line.hex.split(/\s+/).filter(Boolean);
          for (const p of parts) {
            const n = parseInt(p, 16);
            if (!Number.isNaN(n) && n >= 0 && n <= 0xff) allBytes.push(n);
          }
        }
        if (allBytes.length < 10) {
          return JSON.stringify({ error: 'Not enough bytes to analyze (need ≥10)' });
        }
        // Cap at 2000 bytes for responsive tool execution
        const bytes = allBytes.slice(-2000);

        // Printable ratio (CR, LF, TAB count as printable for text protocols)
        let printable = 0;
        for (const b of bytes) {
          if ((b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09) printable++;
        }
        const printableRatio = Math.round((printable / bytes.length) * 1000) / 1000;

        // Framing byte counts (common industrial delimiters)
        const framingCounts = {
          soh_0x01: 0,
          stx_0x02: 0,
          etx_0x03: 0,
          eot_0x04: 0,
          ack_0x06: 0,
          nak_0x15: 0,
          dle_0x10: 0,
        };
        for (const b of bytes) {
          if (b === 0x01) framingCounts.soh_0x01++;
          else if (b === 0x02) framingCounts.stx_0x02++;
          else if (b === 0x03) framingCounts.etx_0x03++;
          else if (b === 0x04) framingCounts.eot_0x04++;
          else if (b === 0x06) framingCounts.ack_0x06++;
          else if (b === 0x15) framingCounts.nak_0x15++;
          else if (b === 0x10) framingCounts.dle_0x10++;
        }

        // Detect frame length via repeating 2-byte prefix autocorrelation.
        // Many binary protocols have a constant header (slave_addr + function,
        // or STX + length) that repeats at the start of every frame.
        type FrameGuess = { length: number; count: number; score: number };
        let bestGuess: FrameGuess | null = null;
        const maxLen = Math.min(128, Math.floor(bytes.length / 3));
        for (let len = 4; len <= maxLen; len++) {
          const framesPossible = Math.floor(bytes.length / len);
          if (framesPossible < 3) continue;
          const p0 = bytes[0];
          const p1 = bytes[1];
          let matches = 1; // count the first occurrence
          for (let f = 1; f < framesPossible; f++) {
            if (bytes[f * len] === p0 && bytes[f * len + 1] === p1) matches++;
          }
          const score = matches / framesPossible;
          if (score >= 0.7 && (!bestGuess || score > bestGuess.score)) {
            bestGuess = { length: len, count: framesPossible, score };
          }
        }

        const frameAnalysis = bestGuess
          ? {
              likely_frame_length: bestGuess.length,
              frames_detected: bestGuess.count,
              confidence:
                bestGuess.score >= 0.95 ? 'high' : bestGuess.score >= 0.85 ? 'medium' : 'low',
              score: Math.round(bestGuess.score * 100) / 100,
            }
          : null;

        // Modbus CRC16 (polynomial 0xA001, init 0xFFFF) — try last 2 bytes of each frame
        function modbusCrc16(data: number[], start: number, end: number): number {
          let crc = 0xffff;
          for (let i = start; i < end; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
              if (crc & 1) crc = (crc >> 1) ^ 0xa001;
              else crc >>= 1;
            }
          }
          return crc & 0xffff;
        }
        let crcResult: Record<string, unknown> | null = null;
        if (bestGuess && bestGuess.length >= 4) {
          const frames = bestGuess.count;
          const len = bestGuess.length;
          let valid = 0;
          for (let f = 0; f < frames; f++) {
            const start = f * len;
            const end = start + len;
            const crcLo = bytes[end - 2];
            const crcHi = bytes[end - 1];
            const expected = (crcHi << 8) | crcLo;
            const computed = modbusCrc16(bytes, start, end - 2);
            if (computed === expected) valid++;
          }
          crcResult = {
            algorithm: 'modbus_crc16 (poly 0xA001, init 0xFFFF, LSB-first append)',
            frames_valid: valid,
            frames_tested: frames,
            validity_ratio: frames > 0 ? Math.round((valid / frames) * 100) / 100 : 0,
            interpretation:
              frames > 0 && valid / frames >= 0.9
                ? 'STRONG MATCH — this is almost certainly a Modbus RTU stream'
                : valid / frames >= 0.5
                  ? 'partial match — could be Modbus with occasional corruption or different CRC algorithm'
                  : 'no match — not Modbus RTU (try other checksum algorithms if binary)',
          };
        }

        // Sample up to 3 frames as hex + byte-level structure hint
        const sampleFramesHex: string[] = [];
        if (bestGuess) {
          const samples = Math.min(3, bestGuess.count);
          for (let i = 0; i < samples; i++) {
            const start = i * bestGuess.length;
            const end = start + bestGuess.length;
            sampleFramesHex.push(
              bytes
                .slice(start, end)
                .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
                .join(' ')
            );
          }
        }

        return JSON.stringify({
          total_bytes_analyzed: bytes.length,
          printable_ratio: printableRatio,
          is_likely_binary: printableRatio < 0.7,
          framing_bytes_detected: framingCounts,
          frame_analysis: frameAnalysis,
          modbus_crc_check: crcResult,
          sample_frames_hex: sampleFramesHex,
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: `Tool execution failed: ${(e as Error).message}` });
  }
}
