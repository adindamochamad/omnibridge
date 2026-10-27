import type { DataLine } from './types.js';

/** Minimal trace shape — avoids circular import with claude.ts */
export interface GateAgentStep {
  type: string;
  tool_name?: string;
  tool_output?: string;
}

export interface GateProtocolAnalysis {
  protocol: string;
  confidence: number;
  device_hint: string;
  fields: Array<{
    name: string;
    regex?: string;
    capture_group?: number;
    match_hex?: boolean;
  }>;
  notes: string;
  command_presets?: unknown[];
  /** Proposed commands the gate refused to install. */
  withheld_presets?: unknown[];
  committed?: boolean;
  commit_reason?: string;
  gate_mode?: 'naive' | 'verified';
  evidence_summary?: string;
}

export type CommitMode = 'naive' | 'verified';

export interface CommitGateOutcome {
  committed: boolean;
  commit_reason: string;
  evidence_summary: string;
}

export interface ToolEvidence {
  modbusValidityRatio: number | null;
  modbusFramesTested: number;
  binaryStructureCalls: number;
  searchPatternTotalMatches: number | null;
}

export function collectToolEvidence(trace: GateAgentStep[] | null): ToolEvidence {
  const out: ToolEvidence = {
    modbusValidityRatio: null,
    modbusFramesTested: 0,
    binaryStructureCalls: 0,
    searchPatternTotalMatches: null,
  };
  if (!trace) return out;

  for (const step of trace) {
    if (step.type !== 'tool_result' || !step.tool_output) continue;
    try {
      const parsed = JSON.parse(step.tool_output) as Record<string, unknown>;
      if (step.tool_name === 'analyze_binary_structure') {
        out.binaryStructureCalls++;
        const crc = parsed.modbus_crc_check as Record<string, unknown> | undefined;
        if (crc && typeof crc.validity_ratio === 'number') {
          out.modbusValidityRatio = crc.validity_ratio;
          out.modbusFramesTested =
            typeof crc.frames_tested === 'number' ? crc.frames_tested : out.modbusFramesTested;
        }
      }
      if (step.tool_name === 'search_pattern' && typeof parsed.total_matches === 'number') {
        out.searchPatternTotalMatches = parsed.total_matches;
      }
    } catch {
      // ignore non-JSON tool output
    }
  }
  return out;
}

function sampleLines(lines: DataLine[], max = 80): DataLine[] {
  if (lines.length <= max) return lines;
  return lines.slice(-max);
}

/** Verify each field regex matches at least one buffered line. */
export function verifyFieldRegexes(
  analysis: GateProtocolAnalysis,
  lines: DataLine[]
): { pass: boolean; reason: string; matchRate: number } {
  const fields = analysis.fields.filter((f) => f.regex);
  if (fields.length === 0) {
    return { pass: false, reason: 'No field regexes to verify against the buffer.', matchRate: 0 };
  }

  const sample = sampleLines(lines);
  if (sample.length === 0) {
    return { pass: false, reason: 'Buffer is empty.', matchRate: 0 };
  }

  let matchedFields = 0;
  for (const field of fields) {
    if (!field.regex) continue;
    let re: RegExp;
    try {
      re = new RegExp(field.regex);
    } catch {
      return {
        pass: false,
        reason: `Invalid regex for field "${field.name}".`,
        matchRate: 0,
      };
    }
    const group = field.capture_group ?? 1;
    const useHex = field.match_hex === true;
    let any = false;
    for (const line of sample) {
      const target = useHex ? line.hex : line.ascii;
      const m = re.exec(target);
      if (m && m[group] !== undefined) {
        any = true;
        break;
      }
    }
    if (any) matchedFields++;
  }

  const matchRate = matchedFields / fields.length;
  const pass = matchRate >= 0.5;
  return {
    pass,
    reason: pass
      ? `${matchedFields}/${fields.length} field regexes matched the buffer.`
      : `Only ${matchedFields}/${fields.length} field regexes matched — hypothesis not verified.`,
    matchRate,
  };
}

/** Model claimed Modbus even when the protocol title omitted that word. */
function claimsModbusHypothesis(analysis: GateProtocolAnalysis): boolean {
  const blob = `${analysis.protocol} ${analysis.device_hint}`.toLowerCase();
  if (/modbus|\brtu\b/.test(blob)) return true;
  return analysis.fields.some(
    (field) => field.match_hex === true && typeof field.regex === 'string' && /01\s*03/i.test(field.regex)
  );
}

function looksBinary(analysis: GateProtocolAnalysis, lines: DataLine[]): boolean {
  if (analysis.fields.some((f) => f.match_hex)) return true;
  const proto = analysis.protocol.toLowerCase();
  if (/modbus|rtu|binary|dnp3|plc/i.test(proto)) return true;
  const sample = sampleLines(lines, 40);
  let printable = 0;
  let total = 0;
  for (const line of sample) {
    for (const ch of line.ascii) {
      total++;
      if (ch !== '·' && ch !== '.') printable++;
    }
  }
  if (total === 0) return false;
  return printable / total < 0.65;
}

export function applyCommitGate<T extends GateProtocolAnalysis>(
  analysis: T,
  lines: DataLine[],
  trace: GateAgentStep[] | null,
  mode: CommitMode
): CommitGateOutcome & {
  analysis: T & {
    committed: boolean;
    commit_reason: string;
    gate_mode: CommitMode;
    evidence_summary: string;
    withheld_presets?: unknown[];
  };
} {
  const evidence = collectToolEvidence(trace);
  const regexCheck = verifyFieldRegexes(analysis, lines);
  const binary = looksBinary(analysis, lines);

  if (mode === 'naive') {
    const enriched = {
      ...analysis,
      committed: true,
      commit_reason:
        'One-shot lane: parser installed without an evidence gate. Not for a live machine.',
      gate_mode: 'naive' as const,
      evidence_summary: 'No tool evidence required on naive lane.',
      withheld_presets: [],
    };
    return {
      committed: true,
      commit_reason: enriched.commit_reason!,
      evidence_summary: 'No tool evidence required on naive lane.',
      analysis: enriched,
    };
  }

  const reasons: string[] = [];
  let committed = true;

  if (binary) {
    const crcOk =
      evidence.modbusValidityRatio !== null && evidence.modbusValidityRatio >= 0.9;
    const structureRan = evidence.binaryStructureCalls > 0;
    if (!structureRan) {
      committed = false;
      reasons.push('Binary stream: analyze_binary_structure was not run before commit.');
    } else if (claimsModbusHypothesis(analysis) && !crcOk) {
      committed = false;
      reasons.push(
        `Modbus hypothesis: CRC validity ${evidence.modbusValidityRatio ?? 0} (need ≥ 0.9).`
      );
    } else if (!crcOk && !regexCheck.pass) {
      committed = false;
      reasons.push('Binary stream: neither Modbus CRC nor field regex checks passed.');
    }
  } else {
    if (!regexCheck.pass) {
      committed = false;
      reasons.push(regexCheck.reason);
    }
    if (
      evidence.searchPatternTotalMatches !== null &&
      evidence.searchPatternTotalMatches === 0 &&
      analysis.confidence < 80
    ) {
      committed = false;
      reasons.push('search_pattern returned zero matches and confidence is below 80%.');
    }
  }

  if (committed && analysis.confidence < 55) {
    committed = false;
    reasons.push('Confidence below minimum threshold (55%).');
  }

  const commit_reason = committed
    ? `Committed: ${regexCheck.reason}${
        evidence.modbusValidityRatio !== null
          ? ` Modbus CRC ratio ${evidence.modbusValidityRatio}.`
          : ''
      }`
    : reasons.join(' ');

  const evidence_summary = [
    `binary=${binary}`,
    `binary_structure_calls=${evidence.binaryStructureCalls}`,
    evidence.modbusValidityRatio !== null ? `modbus_crc=${evidence.modbusValidityRatio}` : null,
    `regex=${regexCheck.reason}`,
  ]
    .filter(Boolean)
    .join('; ');

  const proposed = Array.isArray(analysis.command_presets) ? analysis.command_presets : [];
  const enriched = {
    ...analysis,
    committed,
    commit_reason,
    gate_mode: 'verified' as const,
    evidence_summary,
    fields: committed ? analysis.fields : [],
    command_presets: committed ? analysis.command_presets : [],
    withheld_presets: committed ? [] : proposed,
  };

  return { committed, commit_reason, evidence_summary, analysis: enriched };
}
