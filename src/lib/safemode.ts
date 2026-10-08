export interface ApprovalRequestedPayload {
  id: string;
  port: string;
  hex: string;
  ascii: string;
  reason: string;
  toolUseId: string;
  expiresAt: number;
}

export interface HexAsciiRow {
  offset: number;
  hex: string;
  ascii: string;
}

/** Build 16-byte rows for hex + ASCII display (non-printables shown as ·). */
export function formatHexAsciiRows(hexSpaced: string, ascii: string): HexAsciiRow[] {
  const bytes = hexSpaced
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => parseInt(part, 16));

  const rows: HexAsciiRow[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hex = chunk.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const asciiSlice = ascii.slice(i, i + chunk.length);
    rows.push({ offset: i, hex, ascii: asciiSlice });
  }
  return rows;
}

export function remainingApprovalMs(expiresAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, expiresAtMs - nowMs);
}

export function formatCountdownSeconds(remainingMs: number): string {
  const totalSec = Math.ceil(remainingMs / 1000);
  return String(Math.max(0, totalSec));
}
