import { describe, expect, it } from 'vitest';
import {
  formatCountdownSeconds,
  formatHexAsciiRows,
  remainingApprovalMs,
} from '../src/lib/safemode.js';

describe('safemode helpers', () => {
  it('formats hex rows in 16-byte chunks', () => {
    const hex = '01 02 03 04';
    const ascii = '····';
    const rows = formatHexAsciiRows(hex, ascii);
    expect(rows).toHaveLength(1);
    expect(rows[0].hex).toBe('01 02 03 04');
    expect(rows[0].ascii).toBe('····');
    expect(rows[0].offset).toBe(0);
  });

  it('computes remaining approval time', () => {
    expect(remainingApprovalMs(10_000, 9_000)).toBe(1_000);
    expect(remainingApprovalMs(5_000, 6_000)).toBe(0);
  });

  it('formats countdown seconds rounded up', () => {
    expect(formatCountdownSeconds(4_500)).toBe('5');
    expect(formatCountdownSeconds(0)).toBe('0');
  });
});
