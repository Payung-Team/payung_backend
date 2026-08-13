/**
 * PYG-376 — CSV writer for the reconciliation report.
 *
 * NOTE: the card assumed a shared "PYG-333 CSV util" exists to reuse. It does NOT — the
 * PYG-333 transaction report is GraphQL-only with no CSV export in the repo (verified by
 * grep: no BOM / csv writer anywhere). So this is a small self-contained writer. The one
 * thing that matters most is preserved: **UTF-8 with BOM**, or Excel renders Thai as
 * gibberish. Flagged in the PR so a future shared util can absorb this.
 */
import type { ReconRow } from './reconciliation.types';

/** Excel-friendly UTF-8 BOM. Without it Thai text is mojibake in Excel. */
export const UTF8_BOM = '﻿';

const HEADERS = [
  'bookingId',
  'date',
  'amount',
  'capturedAmount',
  'refundedAmount',
  'paymentStatus',
  'omiseStatus',
  'payoutStatus',
  'verdict',
  'reviewReasons',
  'gross',
  'fee',
  'net',
  'flag',
] as const;

/** RFC-4180 escaping: wrap in quotes when the value has comma/quote/newline; double inner quotes. */
function csvCell(value: unknown): string {
  const s =
    value === null || value === undefined
      ? ''
      : Array.isArray(value)
        ? value.join('|')
        : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build the full CSV text (BOM-prefixed) for a set of recon rows. */
export function reconRowsToCsv(rows: ReconRow[]): string {
  const lines: string[] = [HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.bookingId,
        r.date,
        r.amount,
        r.capturedAmount ?? '',
        r.refundedAmount,
        r.paymentStatus,
        r.omiseUnreachable ? 'unreachable' : (r.omiseStatus ?? ''),
        r.payoutStatus ?? '',
        r.verdict,
        r.reviewReasons,
        r.grossAmount ?? '',
        r.platformFee ?? '',
        r.netAmount ?? '',
        r.primaryFlag ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}
