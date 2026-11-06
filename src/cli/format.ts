export const fmtTime = (ms: number | null | undefined): string => (ms ? new Date(ms).toISOString() : '-');

export function table(rows: Record<string, string | number | null | undefined>[], cols: string[]): string {
  if (rows.length === 0) return '(none)';
  const cell = (v: unknown) => String(v ?? '-').replace(/\s+/g, ' ');
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [
    line(cols.map((c) => c.toUpperCase())),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(cols.map((c) => cell(r[c])))),
  ].join('\n');
}

export function relative(ms: number | null, now = Date.now()): string {
  if (ms === null) return '-';
  const d = ms - now;
  const abs = Math.abs(d);
  const s =
    abs < 90_000
      ? `${Math.round(abs / 1000)}s`
      : abs < 5_400_000
        ? `${Math.round(abs / 60_000)}m`
        : `${(abs / 3_600_000).toFixed(1)}h`;
  return d >= 0 ? `in ${s} (${fmtTime(ms)})` : `${s} ago (${fmtTime(ms)})`;
}
