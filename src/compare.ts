/**
 * Order-insensitive result set comparison.
 *
 * The premise of this repository is "same answer, less work". An optimization
 * that quietly returns different rows is not an optimization, it is a bug, and
 * it is an easy one to ship: rewrite a LEFT JOIN as an inner join, forget the
 * tiebreaker in an ORDER BY ... LIMIT, lose a NULL to a NOT IN. Every scenario
 * is therefore checked here before any of its timings are believed.
 *
 * Rows are compared as a multiset, so a plan that returns the same rows in a
 * different physical order still passes. Scenarios whose queries specify an
 * ORDER BY set `orderedResults`, and then sequence matters too.
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
 * Canonical form of one value.
 *
 * PostgreSQL's numeric arrives as a string so precision is not lost, and the
 * same value can legitimately arrive with a different scale from two different
 * queries (`4.50` from a stored numeric(12,2) column, `4.5` from an aggregate).
 * Comparing those as text would report a difference that does not exist, so
 * numeric-looking strings are normalised. Everything else is compared exactly,
 * with a type tag so that the string "5" is never equal to the number 5.
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
