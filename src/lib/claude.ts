import Anthropic from '@anthropic-ai/sdk';
import { invoke } from '@tauri-apps/api/core';
import { getApiKey } from './settings.js';
import { AGENT_TOOLS, executeTool, type ToolContext } from './agent-tools.js';
import type { DataLine, DiscoveredDevice } from './types.js';

export interface AnalysisField {
  name: string;
  value: string;
  description: string;
  /** Measurement unit, e.g. "kg", "°C", "m/s" */
  unit?: string;
  /** ECMAScript regex. Matches line.ascii by default, or line.hex when match_hex=true. */
  regex?: string;
  /** Which capture group holds the value (default 1) */
  capture_group?: number;
  /** When true, regex runs against the hex representation of each line
   *  (space-separated uppercase bytes, e.g. "01 03 14 00 FE ..."). Used for
   *  binary protocols like Modbus RTU where fields are at fixed byte offsets. */
  match_hex?: boolean;
  /** Value type for downstream parsing. The `hex_*` types decode captured
   *  hex bytes (with optional whitespace) into numbers for live dashboards. */
  data_type?:
    | 'number'
    | 'string'
    | 'boolean'
    | 'hex_u16_be'
    | 'hex_u16_le'
    | 'hex_s16_be'
    | 'hex_u8';
}

export interface CommandPreset {
  /** Short label, shown as chip */
  name: string;
  /** What this command does */
  description: string;
  /** Bytes to send as hex string (e.g. "1B 54 0D 0A") */
  hex?: string;
  /** Or as ASCII with escapes (e.g. "\\x1BT\\r\\n") */
  ascii?: string;
}

export interface ProtocolAnalysis {
  protocol: string;
  confidence: number;
  device_hint: string;
  fields: AnalysisField[];
  notes: string;
  command_presets?: CommandPreset[];
}

const SYSTEM_PROMPT = `You are Protocol Detective, an expert serial communication protocol analyzer embedded in OmniBridge — an intelligent serial gateway for legacy hardware.

Your mission: analyze raw serial byte streams and identify communication protocols, extract structured data fields, and provide actionable device insights.

## Known protocols to detect:
- **CAS/Weighing scales**: look for weight values, stability flags (ST/US), units (kg/lb/g), tare values. Common pattern: STX + data + ETX or simple ASCII lines like "ST,GS,  1.234kg"
- **NMEA 0183**: sentences starting with $GP/$GN/$GL, checksum after *, comma-delimited fields
- **Modbus RTU**: binary, device address + function code (01-06,15,16) + data + CRC16
- **Arduino/custom ASCII**: often human-readable key:value or CSV format
- **Industrial sensors**: may use STX/ETX framing, LRC/CRC checksums
- **Raw binary**: structured binary with repeated patterns

## Output format — respond ONLY with valid JSON, no markdown, no prose:
{
  "protocol": "Protocol name",
  "confidence": 85,
  "device_hint": "Specific device type guess",
  "fields": [
    {
      "name": "field_key",
      "value": "sample_value",
      "description": "what this represents",
      "unit": "kg",
      "regex": "GS,\\\\s*([\\\\d.]+)\\\\s*kg",
      "capture_group": 1,
      "data_type": "number"
    }
  ],
  "notes": "Brief analysis: what you observed, any anomalies, recommendations"
}

## Parsing rules (critical for real-time dashboard):
For each field, generate an ECMAScript regex pattern that captures the value from a SINGLE line. Use capture groups.
- "regex" matches one line; don't include \\n
- "capture_group" index (default 1) picks which group holds the value
- "unit" is display suffix (empty string if none)
- Double-escape backslashes in JSON: \\\\s not \\s
- Test mentally: does your regex match at least one of the lines provided?

### For ASCII protocols (CAS, NMEA, key=value):
- regex runs against line.ascii (the visible text)
- data_type: "number" | "string" | "boolean"
- Example (CAS weight): { "regex": "GS,\\\\s*([\\\\d.]+)\\\\s*kg", "capture_group": 1, "data_type": "number", "unit": "kg" }

### For BINARY protocols (Modbus RTU, DNP3, industrial sensors):
Rather than omitting regex, set "match_hex": true and write the regex against the HEX REPRESENTATION of the line. The hex representation is space-separated uppercase bytes like "01 03 14 00 FE 03 F5 ...".
- Capture the bytes you want, then use a hex_* data_type so the app decodes them:
  - "hex_u16_be" → big-endian unsigned 16-bit (most Modbus registers)
  - "hex_u16_le" → little-endian unsigned 16-bit
  - "hex_s16_be" → signed 16-bit (two's complement)
  - "hex_u8"    → single byte
- Example (Modbus register 0 = temp×10, big-endian): {
    "name": "temp",
    "regex": "^01 03 14 ([0-9A-F]{2} [0-9A-F]{2})",
    "match_hex": true,
    "capture_group": 1,
    "data_type": "hex_u16_be",
    "unit": "°C·10",
    "description": "Temperature ×10 (scale by /10 for °C)"
  }
- Anchor with the frame header so the regex only matches at frame starts (use "^" + known prefix bytes)
- For a 25-byte Modbus frame "01 03 14 HH LL HH LL ...":
  - register 0 = bytes 3-4 → regex: "^01 03 14 ([0-9A-F]{2} [0-9A-F]{2})"
  - register 1 = bytes 5-6 → regex: "^01 03 14 [0-9A-F]{2} [0-9A-F]{2} ([0-9A-F]{2} [0-9A-F]{2})"
  - register 2 = bytes 7-8 → regex with TWO more "[0-9A-F]{2} [0-9A-F]{2}" before the capture, etc.
- ALWAYS emit these fields for binary — a working dashboard requires them. Do NOT omit regex for binary protocols.

## Command presets (optional but encouraged for known protocols):
If you recognize the protocol, ALSO output a "command_presets" array with 2-5 common commands the user can send to the device:
{
  "command_presets": [
    { "name": "Tare", "description": "Zero the scale reading", "hex": "1B 54 0D 0A" },
    { "name": "Query weight", "description": "Request current weight", "ascii": "W\\r\\n" }
  ]
}
Examples by protocol:
- CAS Scale: Tare (ESC T CR LF), Zero (ESC Z), Unit toggle
- NMEA GPS: Set 1Hz rate ($PMTK220,1000), Enable GGA only ($PMTK314,...)
- Modbus RTU: Read holding register (01 03 ...), Write single register (01 06 ...)
- Arduino/custom: Include "help" or known query if observable in stream
Omit command_presets if protocol is unknown or you're not confident about the commands.

Rules:
- confidence is an integer 0–100
- fields can be empty array if data is too sparse or corrupted
- Never output anything outside the JSON object
- If data looks like multiple packet types, analyze the dominant pattern`;

let _client: Anthropic | null = null;
let _clientKey = '';

function getClient(apiKey: string): Anthropic {
  if (!_client || _clientKey !== apiKey) {
    _client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    _clientKey = apiKey;
  }
  return _client;
}

export function resetClient() {
  _client = null;
  _clientKey = '';
}

// ═══════════════════════════════════════════════════════════════════════════
//  ASK MODE — free-form Q&A over the live buffer
// ═══════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT_ASK = `You are an assistant answering questions about a live serial device data stream in OmniBridge.

You are given:
- Recent raw bytes from a serial port (as hex + ASCII)
- The current protocol identification (if any) with fields and notes
- The user's question

Be concise — 1-3 short paragraphs. Cite actual values, timestamps, hex bytes, or field names from the data when helpful. Think of this as giving a quick technical answer to a colleague who is already looking at the same dashboard.

If the data is insufficient to answer, say so honestly — do not invent patterns.

Do NOT repeat the raw hex back at the user; they see it already. Synthesize.

Respond in plain text. No markdown headers, no code fences unless showing an actual byte sequence. Keep output under ~150 words.`;

export interface AskContext {
  question: string;
  lines: DataLine[];
  analysis: ProtocolAnalysis | null;
  /** Prior Q&A turns for continuity (oldest first) */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export async function askAboutBuffer(
  ctx: AskContext,
  onChunk?: (chunk: string) => void
): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured. Open Settings to add one.');

  const client = getClient(apiKey);

  // Take last 80 lines as context — enough to answer most questions, small
  // enough to keep latency low and cost reasonable.
  const recent = ctx.lines.slice(-80);
  const bufferText = recent
    .map((l) => {
      const ts = new Date(l.timestamp).toISOString().slice(11, 23);
      return `[${ts}] HEX: ${l.hex.slice(0, 120)}${l.hex.length > 120 ? '…' : ''}  ASCII: ${l.ascii.slice(0, 60)}`;
    })
    .join('\n');

  const analysisContext = ctx.analysis
    ? `PROTOCOL: ${ctx.analysis.protocol} (${ctx.analysis.confidence}% confidence)
DEVICE: ${ctx.analysis.device_hint || 'unknown'}
FIELDS: ${ctx.analysis.fields.map((f) => `${f.name}${f.unit ? ` [${f.unit}]` : ''}`).join(', ') || '(none extracted)'}
NOTES: ${ctx.analysis.notes || '(none)'}`
    : 'No protocol identification yet — user has not yet run Analyze or Investigate.';

  const userContent = `${analysisContext}

RECENT BUFFER (${recent.length} lines, most recent last):
${bufferText}

USER QUESTION: ${ctx.question}`;

  // Build message list with prior Q&A history for conversational continuity
  const messages: Anthropic.Messages.MessageParam[] = [];
  if (ctx.history) {
    for (const turn of ctx.history) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: 'user', content: userContent });

  const stream = client.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT_ASK,
        // @ts-ignore — cache_control not in older type defs
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages,
  });

  let fullText = '';
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      'delta' in event &&
      event.delta &&
      (event.delta as { type?: string }).type === 'text_delta'
    ) {
      const chunk = (event.delta as { text: string }).text;
      fullText += chunk;
      onChunk?.(chunk);
    }
  }

  return fullText.trim();
}

/** Turn SDK / network errors into short, user-readable strings.
 *  Anthropic SDK throws structured errors with `.status`; generic failures
 *  come through as strings or Error instances. Judges/users shouldn't have
 *  to parse a 400-char stack trace to understand "wrong API key". */
export function friendlyError(e: unknown): string {
  const anyE = e as { status?: number; error?: { message?: string }; message?: string };
  const status = anyE?.status;
  const msg = anyE?.error?.message ?? anyE?.message ?? String(e);

  if (status === 401 || /invalid.*api.*key|authentication|unauthorized/i.test(msg)) {
    return 'API key rejected. Open Settings and paste a valid Anthropic key.';
  }
  if (status === 429 || /rate.?limit/i.test(msg)) {
    return 'Anthropic rate limit hit. Wait ~30 seconds and retry.';
  }
  if (status === 529 || /overloaded/i.test(msg)) {
    return 'Anthropic API is overloaded right now. Retry in a moment.';
  }
  if (status && status >= 500) {
    return `Anthropic server error (${status}). Retry in a moment.`;
  }
  if (/network|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
    return 'Network issue — check your connection, then retry.';
  }
  if (/max_tokens/i.test(msg)) {
    return 'Response exceeded token budget. Try a smaller buffer or a simpler stream.';
  }
  // Fallback: truncate very long errors so the UI stays readable
  return msg.length > 240 ? msg.slice(0, 240) + '…' : msg;
}

export async function analyzeStream(
  hexSamples: string[],
  asciiSamples: string[],
  deviceClass?: string
): Promise<ProtocolAnalysis> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured. Set it in Settings.');

  const client = getClient(apiKey);

  const hexPreview = hexSamples.slice(-30).join('\n');
  const asciiPreview = asciiSamples.slice(-30).join('\n');
  const deviceContext = deviceClass ? `\nDevice classification hint: ${deviceClass}` : '';

  const userContent = `Analyze this serial port capture (${hexSamples.length} packets):${deviceContext}

HEX representation:
${hexPreview}

ASCII representation:
${asciiPreview}

Identify the protocol and extract all structured data fields.`;

  const stream = client.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // @ts-ignore — cache_control is valid but may not be in older type defs
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userContent }],
  });

  const response = await stream.finalMessage();

  // Check if response was truncated (hit max_tokens)
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      'Response exceeded token budget. Try reducing the buffer size or analyzing a simpler stream.'
    );
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude (possibly thinking-only output)');
  }

  // Robust JSON extraction — handles markdown fences, prose wrapping, or plain JSON
  const text = textBlock.text.trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error(`No JSON object in response: ${text.slice(0, 150)}`);
  }
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(jsonSlice) as ProtocolAnalysis;
  } catch (e) {
    throw new Error(`Claude returned malformed JSON: ${(e as Error).message}. First 200 chars: ${jsonSlice.slice(0, 200)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  AGENT MODE — multi-step investigation with tool use
// ═══════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT_AGENT = `You are Protocol Detective, operating in AGENT mode inside OmniBridge — an intelligent serial gateway.

Your job: investigate unknown serial devices by iteratively using your tools to build confidence in a protocol identification. Unlike one-shot analysis, you can explore, verify hypotheses, and cross-reference metadata before committing to an answer.

## Available tools:
- **read_more_lines** — fetch more recent ASCII+HEX lines from the buffer beyond the initial 20 shown
- **search_pattern** — test an ECMAScript regex hypothesis across all buffered ASCII lines (great for ASCII protocol verification)
- **analyze_binary_structure** — structural analysis of raw bytes: printable ratio, framing byte counts, frame-length autocorrelation, Modbus CRC16 validation. USE THIS FIRST for binary streams
- **get_device_metadata** — USB VID/PID/manufacturer to cross-reference hardware
- **probe_baud_rate** — reopen port at different baud (only if data looks like unprintable garbage; fails if monitor is active)
- **send_bytes** — transmit bytes to the device to elicit a response (use sparingly)

## Investigation strategy — adapt depth to the protocol:

### Path A: Obvious ASCII protocols (NMEA sentences, CAS scale, key=value CSV)
These announce themselves in the initial sample. 1-2 tool calls is enough:
1. Recognize the pattern from the initial 20 lines
2. Optionally call search_pattern or get_device_metadata for a single confirmation
3. Emit final JSON

### Path B: Binary / unknown / low-ASCII streams
These require real investigation — spend 3-5 tool calls to be confident:
1. **Start with analyze_binary_structure** — it immediately reveals frame length, CRC match, framing bytes
2. If analyze_binary_structure returns a Modbus CRC match, you're done — identify as Modbus RTU and describe register layout from sample_frames_hex
3. If no CRC match, use read_more_lines with a large count (60-100) to see more frames, then re-analyze
4. Call get_device_metadata to strengthen the hardware hypothesis
5. Only probe_baud_rate if printable_ratio is extremely low (<0.2) AND no repeating structure found
6. Emit final JSON with confidence proportional to evidence gathered

## Decision heuristic:
- **printable_ratio ≥ 0.85 AND structured pattern visible** → ASCII path, finish fast
- **printable_ratio < 0.7 OR framing bytes > 10** → BINARY path, use analyze_binary_structure
- **Ambiguous (0.7-0.85)** → call analyze_binary_structure to disambiguate

## Budget guidance:
- ASCII obvious: 1-2 tool calls
- Binary / mystery: 3-5 tool calls (you have up to 8 steps)
- Budget for final analysis: ~1500 output tokens
- Concise field descriptions (<50 chars each)

## Interleaved reasoning:
You are Claude Opus 4.7 with adaptive thinking. Think between tool calls — let your thinking block capture the hypothesis you're testing and what outcome would falsify it. The user sees your thinking; make it worth reading.

## Final output (after investigation is complete):
Output a JSON object as plain text (NO markdown fences, NO prose before/after JSON, NO tool calls):

{
  "protocol": "Protocol name (e.g. 'NMEA 0183', 'CAS Scale', 'Modbus RTU')",
  "confidence": 85,
  "device_hint": "Specific device type guess",
  "fields": [
    {
      "name": "field_key",
      "value": "sample_value",
      "description": "what this represents (short)",
      "unit": "kg",
      "regex": "GS,\\\\s*([\\\\d.]+)\\\\s*kg",
      "capture_group": 1,
      "data_type": "number"
    }
  ],
  "notes": "Brief summary: what you investigated, key findings, any caveats (mention tools you used)"
}

## Regex rules — same schema as one-shot analysis:

### ASCII protocols:
- regex runs on line.ascii
- data_type: "number" | "string" | "boolean"
- Double-escape backslashes in JSON: \\\\s not \\s

### Binary protocols (Modbus RTU etc.):
- Set "match_hex": true — regex runs against the space-separated hex representation (e.g. "01 03 14 00 FE ...")
- Anchor with the frame header bytes so you only match at frame starts
- Use a hex_* data_type for automatic decoding:
  - "hex_u16_be" / "hex_u16_le" — 16-bit uint (most Modbus registers)
  - "hex_s16_be" — signed 16-bit
  - "hex_u8" — single byte (e.g. for alarm bit flags)
- Example Modbus register-0 extraction:
  { "regex": "^01 03 14 ([0-9A-F]{2} [0-9A-F]{2})", "match_hex": true, "capture_group": 1, "data_type": "hex_u16_be", "unit": "°C·10" }
- You MUST emit these fields for binary protocols — a live dashboard depends on it. Use analyze_binary_structure's sample_frames_hex output to figure out byte offsets.

## Command presets (optional, encouraged for known protocols):
Include a "command_presets" array with 2-5 useful commands user can send:
  "command_presets": [
    { "name": "Tare", "description": "Zero the scale", "hex": "1B 54 0D 0A" },
    { "name": "Query", "description": "Request weight", "ascii": "W\\\\r\\\\n" }
  ]
Omit if protocol unknown or commands unclear.

## Confidence calibration:
- 90-100: Verified via search_pattern + metadata
- 70-89: Strong pattern match, one confirmation
- 50-69: Plausible guess, not verified
- <50: Likely wrong, flag in notes`;

export type AgentStepType =
  | 'thinking'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'final'
  | 'error';

export interface AgentStep {
  id: string;
  type: AgentStepType;
  timestamp: number;
  text?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  error?: string;
}

/** Aggregate token usage + estimated cost across the full agent loop.
 *  Pricing is approximate — consult anthropic.com/pricing for authoritative rates.
 *  These constants match public Opus-tier pricing as of early 2026 and are used
 *  only for the cost indicator shown to the user, not for billing. */
const PRICING_USD_PER_MTOK = {
  input: 15.0,
  output: 75.0,
  cache_write: 18.75,
  cache_read: 1.5,
};

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  estimated_cost_usd: number;
  /** 0-1 — fraction of input tokens served from prompt cache (higher = cheaper) */
  cache_hit_ratio: number;
}

function emptyUsage(): UsageStats {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    estimated_cost_usd: 0,
    cache_hit_ratio: 0,
  };
}

function addUsageFromResponse(acc: UsageStats, u: Anthropic.Messages.Usage | undefined): void {
  if (!u) return;
  acc.input_tokens += u.input_tokens ?? 0;
  acc.output_tokens += u.output_tokens ?? 0;
  // @ts-ignore — cache_* fields may not be in older SDK types
  acc.cache_read_tokens += (u.cache_read_input_tokens as number | undefined) ?? 0;
  // @ts-ignore
  acc.cache_write_tokens += (u.cache_creation_input_tokens as number | undefined) ?? 0;

  acc.estimated_cost_usd =
    (acc.input_tokens * PRICING_USD_PER_MTOK.input) / 1_000_000 +
    (acc.output_tokens * PRICING_USD_PER_MTOK.output) / 1_000_000 +
    (acc.cache_write_tokens * PRICING_USD_PER_MTOK.cache_write) / 1_000_000 +
    (acc.cache_read_tokens * PRICING_USD_PER_MTOK.cache_read) / 1_000_000;

  const totalInput = acc.input_tokens + acc.cache_read_tokens + acc.cache_write_tokens;
  acc.cache_hit_ratio = totalInput > 0 ? acc.cache_read_tokens / totalInput : 0;
}

export interface AgentResult {
  trace: AgentStep[];
  analysis: ProtocolAnalysis | null;
  error: string | null;
  stopped_at: 'end_turn' | 'max_steps' | 'error';
  total_api_calls: number;
  usage: UsageStats;
}

export interface AgentContext {
  port: string;
  lines: DataLine[];
  device: DiscoveredDevice | null;
  deviceClass?: string;
}

const MAX_AGENT_STEPS = 8;

export async function analyzeWithAgent(
  ctx: AgentContext,
  onStep?: (step: AgentStep) => void
): Promise<AgentResult> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return {
      trace: [],
      analysis: null,
      error: 'API key not configured. Open Settings to add one.',
      stopped_at: 'error',
      total_api_calls: 0,
      usage: emptyUsage(),
    };
  }

  const client = getClient(apiKey);
  const trace: AgentStep[] = [];
  let apiCalls = 0;
  const usage = emptyUsage();

  try {
    await invoke('safemode_begin_session');
  } catch {
    // Safe Mode not available outside the desktop shell (e.g. vitest).
  }

  function emit(step: Omit<AgentStep, 'id' | 'timestamp'>): AgentStep {
    const full: AgentStep = {
      id: `step-${trace.length}`,
      timestamp: Date.now(),
      ...step,
    };
    trace.push(full);
    onStep?.(full);
    return full;
  }

  const hexSample = ctx.lines.slice(-20).map((l) => l.hex).join('\n');
  const asciiSample = ctx.lines.slice(-20).map((l) => l.ascii).join('\n');
  const deviceContext = ctx.deviceClass ? `Device classification hint: ${ctx.deviceClass}\n` : '';

  const initialUserContent = `${deviceContext}Investigate this serial stream (${ctx.lines.length} total lines buffered, showing 20 most recent).

HEX:
${hexSample}

ASCII:
${asciiSample}

Use your tools to investigate as needed. Begin investigation now.`;

  // Use looser typing for message accumulator — SDK uses ContentBlock vs ContentBlockParam
  // which are structurally compatible but TS strict mode complains on round-tripping.
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: initialUserContent },
  ];

  const toolCtx: ToolContext = {
    port: ctx.port,
    lines: ctx.lines,
    device: ctx.device,
  };

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    apiCalls++;

    let response: Anthropic.Messages.Message;
    try {
      const stream = client.messages.stream({
        model: 'claude-opus-4-7',
        max_tokens: 8192,
        thinking: { type: 'adaptive' },
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT_AGENT,
            // @ts-ignore — cache_control may not be in older type defs
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: AGENT_TOOLS,
        messages,
      });
      response = await stream.finalMessage();
    } catch (e) {
      const friendly = friendlyError(e);
      emit({ type: 'error', error: friendly });
      return {
        trace,
        analysis: null,
        error: friendly,
        stopped_at: 'error',
        total_api_calls: apiCalls,
        usage,
      };
    }

    addUsageFromResponse(usage, response.usage);

    if (response.stop_reason === 'max_tokens') {
      emit({ type: 'error', error: 'Response exceeded max_tokens budget' });
      return {
        trace,
        analysis: null,
        error: 'Response exceeded max_tokens budget',
        stopped_at: 'error',
        total_api_calls: apiCalls,
        usage,
      };
    }

    // Record observable blocks in trace
    for (const block of response.content) {
      if (block.type === 'thinking') {
        const thinkText = (block as { thinking?: string }).thinking;
        if (thinkText) emit({ type: 'thinking', text: thinkText });
      } else if (block.type === 'text') {
        if (block.text.trim()) emit({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        emit({
          type: 'tool_call',
          tool_name: block.name,
          tool_input: block.input as Record<string, unknown>,
        });
      }
    }

    if (response.stop_reason === 'tool_use') {
      // Preserve full assistant response (including thinking) for tool-use continuation
      messages.push({
        role: 'assistant',
        content: response.content as unknown as Anthropic.Messages.ContentBlockParam[],
      });

      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
      );

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const output = await executeTool(
          tu.name,
          tu.input as Record<string, unknown>,
          toolCtx,
          tu.id
        );
        emit({ type: 'tool_result', tool_name: tu.name, tool_output: output });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: output,
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // end_turn — extract final JSON analysis
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === 'text'
      );
      if (!textBlock) {
        emit({ type: 'error', error: 'Agent ended without text output' });
        return {
          trace,
          analysis: null,
          error: 'Agent ended without text output',
          stopped_at: 'end_turn',
          total_api_calls: apiCalls,
          usage,
        };
      }

      const text = textBlock.text.trim();
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace < 0 || lastBrace <= firstBrace) {
        emit({ type: 'error', error: 'No JSON object in final response' });
        return {
          trace,
          analysis: null,
          error: `No JSON in final response: ${text.slice(0, 150)}`,
          stopped_at: 'end_turn',
          total_api_calls: apiCalls,
          usage,
        };
      }

      try {
        const analysis = JSON.parse(
          text.slice(firstBrace, lastBrace + 1)
        ) as ProtocolAnalysis;
        emit({
          type: 'final',
          text: `${analysis.protocol} · ${analysis.confidence}%`,
        });
        return {
          trace,
          analysis,
          error: null,
          stopped_at: 'end_turn',
          total_api_calls: apiCalls,
          usage,
        };
      } catch (e) {
        emit({ type: 'error', error: `Malformed final JSON: ${(e as Error).message}` });
        return {
          trace,
          analysis: null,
          error: `Malformed final JSON: ${(e as Error).message}`,
          stopped_at: 'end_turn',
          total_api_calls: apiCalls,
          usage,
        };
      }
    }

    // Any other stop reason (pause_turn, refusal, etc.)
    emit({ type: 'error', error: `Unexpected stop_reason: ${response.stop_reason}` });
    return {
      trace,
      analysis: null,
      error: `Unexpected stop_reason: ${response.stop_reason}`,
      stopped_at: 'error',
      total_api_calls: apiCalls,
      usage,
    };
  }

  emit({ type: 'error', error: `Safety limit reached (${MAX_AGENT_STEPS} steps)` });
  return {
    trace,
    analysis: null,
    error: `Exceeded max agent steps (${MAX_AGENT_STEPS})`,
    stopped_at: 'max_steps',
    total_api_calls: apiCalls,
    usage,
  };
}
