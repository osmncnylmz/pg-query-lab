/**
 * The premise of this repository is "same answer, less work". A rewrite that
 * quietly returns different rows is a bug, and a cheap one to ship; the README
 * lists the usual ways it happens. This module is what keeps one of them from
 * being reported as a speedup, so no scenario's timings are believed until its
 * two result sets have been through here.
 *
 * Rows compare as a multiset -- same rows in a different physical order still
 * passes. Scenarios whose queries carry an ORDER BY set `orderedResults`, and
 * then sequence counts too.
 */

export interface ResultSet {
  readonly rows: readonly Record<string, unknown>[];
  readonly fields: readonly string[];
}

export type Comparison =
  | { readonly equal: true; readonly rowCount: number }
  | { readonly equal: false; readonly reason: string };

/** `4.50` becomes `4.5`, `007` becomes `7`, `-0.0` becomes `0`. */
function normaliseDecimal(text: string): string {
  const negative = text.startsWith('-');
  let body = negative ? text.slice(1) : text;
  if (body.includes('.')) {
    body = body.replace(/0+$/, '').replace(/\.$/, '');
  }
  body = body.replace(/^0+(?=\d)/, '');
  if (body === '') body = '0';
  return negative && body !== '0' ? `-${body}` : body;
}

/**
 * PostgreSQL's numeric arrives as a string so precision is not lost, and the
 * same value can legitimately turn up at a different scale from two queries:
 * `4.50` from a stored numeric(12,2) column, `4.5` from an aggregate over it.
 * Compared as text those differ, and the difference is not real, so
 * numeric-looking strings are normalised.
 *
 * Everything else compares exactly, carrying a type tag so the string "5" is
 * never equal to the number 5.
 */
function canonicalValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return `ts:${value.toISOString()}`;
  if (typeof value === 'bigint') return `num:${value.toString()}`;
  if (typeof value === 'number') return `num:${normaliseDecimal(value.toString())}`;
  if (typeof value === 'boolean') return `bool:${value}`;
  if (typeof value === 'string') {
    return /^-?\d+(\.\d+)?$/.test(value) ? `num:${normaliseDecimal(value)}` : `str:${value}`;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, canonicalValue(v)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

function canonicalRow(row: Record<string, unknown>, fields: readonly string[]): string {
  return JSON.stringify(fields.map((f) => canonicalValue(row[f])));
}

export function compareResultSets(
  naive: ResultSet,
  optimized: ResultSet,
  options: { readonly ordered?: boolean } = {},
): Comparison {
  const naiveFields = [...naive.fields].sort();
  const optimizedFields = [...optimized.fields].sort();

  if (naiveFields.join(' ') !== optimizedFields.join(' ')) {
    return {
      equal: false,
      reason:
        `column sets differ\n  naive:     ${naiveFields.join(', ')}\n` +
        `  optimized: ${optimizedFields.join(', ')}`,
    };
  }

  if (naive.rows.length !== optimized.rows.length) {
    return {
      equal: false,
      reason:
        `row counts differ: naive returned ${naive.rows.length}, ` +
        `optimized returned ${optimized.rows.length}`,
    };
  }

  const naiveRows = naive.rows.map((r) => canonicalRow(r, naiveFields));
  const optimizedRows = optimized.rows.map((r) => canonicalRow(r, naiveFields));

  if (options.ordered === true) {
    for (let i = 0; i < naiveRows.length; i += 1) {
      if (naiveRows[i] !== optimizedRows[i]) {
        return {
          equal: false,
          reason:
            `rows differ at position ${i} (this scenario compares in order)\n` +
            `  naive:     ${naiveRows[i] ?? '<missing>'}\n` +
            `  optimized: ${optimizedRows[i] ?? '<missing>'}`,
        };
      }
    }
    return { equal: true, rowCount: naiveRows.length };
  }

  const counts = new Map<string, number>();
  for (const row of naiveRows) counts.set(row, (counts.get(row) ?? 0) + 1);
  for (const row of optimizedRows) {
    const remaining = counts.get(row);
    if (remaining === undefined || remaining === 0) {
      return {
        equal: false,
        reason: `optimized returned a row the naive query did not:\n  ${row}`,
      };
    }
    counts.set(row, remaining - 1);
  }
  for (const [row, remaining] of counts) {
    if (remaining > 0) {
      return {
        equal: false,
        reason: `naive returned a row the optimized query did not (x${remaining}):\n  ${row}`,
      };
    }
  }

  return { equal: true, rowCount: naiveRows.length };
}
