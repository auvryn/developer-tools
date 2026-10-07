/*
 * Plain, stable text output: aligned tables and "label: value" blocks. No
 * colors, spinners or terminal control codes, so piping and logs stay clean.
 */

export type Cell = string | number | boolean | null | undefined;

const text = (value: unknown): string =>
  value === null || value === undefined
    ? '-'
    : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : JSON.stringify(value);

/** An aligned table with upper-case headers; "No …" when empty. */
export function table<T extends object>(
  rows: readonly T[],
  columns: readonly (readonly [header: string, key: keyof T & string])[],
  empty: string,
): string {
  if (rows.length === 0) {
    return empty;
  }
  const cells = rows.map((row) => columns.map(([, key]) => text(row[key])));
  const widths = columns.map(([header], index) =>
    Math.max(header.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );
  const line = (values: readonly string[]) =>
    values
      .map((value, index) =>
        index === values.length - 1 ? value : value.padEnd(widths[index] ?? 0),
      )
      .join('  ');
  return [line(columns.map(([header]) => header.toUpperCase())), ...cells.map(line)].join('\n');
}

/** "Label: value" lines, aligned. */
export function details(entries: readonly (readonly [label: string, value: Cell])[]): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries
    .map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${text(value)}`)
    .join('\n');
}

/** A "more results" hint after a page. */
export function moreHint(nextCursor: string | null): string {
  return nextCursor === null ? '' : `\n\nMore results: --cursor ${nextCursor} (or --all)`;
}

export function bytes(size: number): string {
  if (size < 1024) {
    return `${String(size)} B`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? ''}`;
}

/** Minor units as a decimal amount, with the currency's own decimals: ("4250", "EUR") → "42.50 EUR". */
export function money(amountMinor: string, currency: string): string {
  let decimals = 2;
  try {
    decimals =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    // Unknown currency code: keep two decimals.
  }
  const sign = amountMinor.startsWith('-') ? '-' : '';
  const digits = amountMinor.replace(/^-/, '').padStart(decimals + 1, '0');
  const whole =
    decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return `${sign}${whole} ${currency}`;
}
