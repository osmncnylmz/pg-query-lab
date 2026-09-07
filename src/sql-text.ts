/**
 * Two jobs, one scanner.
 *
 * `renderSqlVariables` substitutes psql-style `:name` and `:'name'` variables,
 * so the .sql files in this repository can be fed to psql and to the PGlite
 * runner without maintaining two dialects. `splitStatements` cuts a script into
 * statements, which VACUUM needs: it will not run inside the implicit
 * transaction block a multi-statement simple query creates.
 *
 * Both have to know where they are in the text, so both sit on one scanner that
 * understands what a regex gets wrong -- single-quoted strings with their `''`
 * and `E'\''` escapes, quoted identifiers, dollar-quoted bodies, `--` lines and
 * nestable block comments. Substitute with a regex and `':session'` inside a
 * string literal gets rewritten, or `::text` is read as a cast of a variable
 * called `text`.
 */

export type SqlValue = string | number | boolean | Date | null;

interface Span {
  /** Index just past the structure that started at the offset scanned from. */
  end: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/**
 * If a non-code structure starts at `i`, return where it ends; otherwise null.
 *
 * Malformed input never throws. An unterminated structure just runs to the end
 * of the text, which keeps the caller from substituting inside what is plainly
 * not code.
 */
function scanNonCode(sql: string, i: number): Span | null {
  const two = sql.slice(i, i + 2);

  if (two === '--') {
    const nl = sql.indexOf('\n', i);
    return { end: nl === -1 ? sql.length : nl };
  }

  if (two === '/*') {
    // PostgreSQL block comments nest.
    let depth = 0;
    let j = i;
    while (j < sql.length) {
      if (sql.startsWith('/*', j)) {
        depth += 1;
        j += 2;
      } else if (sql.startsWith('*/', j)) {
        depth -= 1;
        j += 2;
        if (depth === 0) return { end: j };
      } else {
        j += 1;
      }
    }
    return { end: sql.length };
  }

  if (sql[i] === "'") {
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === '\\') {
        // Only meaningful in E'' strings, but treating it as an escape
        // everywhere is the conservative choice: it can only ever make the
        // scanner skip more text, never less.
        j += 2;
        continue;
      }
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        return { end: j + 1 };
      }
      j += 1;
    }
    return { end: sql.length };
  }

  if (sql[i] === '"') {
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === '"') {
        if (sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        return { end: j + 1 };
      }
      j += 1;
    }
    return { end: sql.length };
  }

  if (sql[i] === '$') {
    const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
    if (tag) {
      const marker = tag[0];
      const close = sql.indexOf(marker, i + marker.length);
      return { end: close === -1 ? sql.length : close + marker.length };
    }
  }

  return null;
}

/** Deliberately narrow: what cannot be rendered unambiguously is an error,
 * not a coercion. */
export function toSqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot render non-finite number as a SQL literal: ${String(value)}`);
    }
    return String(value);
  }
  if (value instanceof Date) {
    return `TIMESTAMPTZ '${value.toISOString()}'`;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export class UnboundSqlVariableError extends Error {
  constructor(
    readonly variable: string,
    readonly available: readonly string[],
  ) {
    super(
      `unbound SQL variable ":${variable}" (bound variables: ${
        available.length > 0 ? available.map((v) => `:${v}`).join(', ') : 'none'
      })`,
    );
    this.name = 'UnboundSqlVariableError';
  }
}

/**
 * Substitute psql-style variables.
 *
 * `:name`    -> the value rendered as a SQL literal
 * `:'name'`  -> the value rendered as a single-quoted string literal
 * `::`       -> left alone; it is a cast, not a variable
 *
 * Substitution never happens inside strings, identifiers, dollar-quoted bodies
 * or comments -- the same rule psql follows.
 */
export function renderSqlVariables(sql: string, vars: Readonly<Record<string, SqlValue>>): string {
  const names = Object.keys(vars);
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const span = scanNonCode(sql, i);
    if (span) {
      out += sql.slice(i, span.end);
      i = span.end;
      continue;
    }

    if (sql[i] === ':') {
      if (sql[i + 1] === ':') {
        out += '::';
        i += 2;
        continue;
      }

      // :'name' -- psql's "interpolate as a quoted literal" form.
      if (sql[i + 1] === "'") {
        const close = sql.indexOf("'", i + 2);
        const name = close === -1 ? '' : sql.slice(i + 2, close);
        if (close !== -1 && name.length > 0 && IDENT_START.test(name.charAt(0))) {
          if (!Object.hasOwn(vars, name)) throw new UnboundSqlVariableError(name, names);
          const value = vars[name] ?? null;
          out += value === null ? 'NULL' : toSqlLiteral(String(value));
          i = close + 1;
          continue;
        }
      }

      const first = sql[i + 1];
      if (first !== undefined && IDENT_START.test(first)) {
        let j = i + 1;
        while (j < sql.length && IDENT_PART.test(sql.charAt(j))) j += 1;
        const name = sql.slice(i + 1, j);
        if (!Object.hasOwn(vars, name)) throw new UnboundSqlVariableError(name, names);
        out += toSqlLiteral(vars[name] ?? null);
        i = j;
        continue;
      }
    }

    out += sql.charAt(i);
    i += 1;
  }

  return out;
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;

  while (i < sql.length) {
    const span = scanNonCode(sql, i);
    if (span) {
      i = span.end;
      continue;
    }
    if (sql[i] === ';') {
      statements.push(sql.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  statements.push(sql.slice(start));

  return statements.map(stripComments).filter((s) => s.length > 0);
}

/** Strip comments and surrounding whitespace, for emptiness checks. */
function stripComments(statement: string): string {
  let out = '';
  let i = 0;
  while (i < statement.length) {
    const span = scanNonCode(statement, i);
    if (span) {
      const text = statement.slice(i, span.end);
      // Strings and dollar-quoted bodies survive; a comment becomes a space, so
      // that `a/**/b` does not collapse into `ab`.
      if (!text.startsWith('--') && !text.startsWith('/*')) out += text;
      else out += ' ';
      i = span.end;
      continue;
    }
    out += statement.charAt(i);
    i += 1;
  }
  return out.trim();
}
