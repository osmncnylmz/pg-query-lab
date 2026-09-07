import { describe, expect, it } from 'vitest';

import {
  renderSqlVariables,
  splitStatements,
  toSqlLiteral,
  UnboundSqlVariableError,
} from '../src/sql-text.js';

describe('toSqlLiteral', () => {
  it('renders scalars', () => {
    expect(toSqlLiteral(null)).toBe('NULL');
    expect(toSqlLiteral(true)).toBe('true');
    expect(toSqlLiteral(42)).toBe('42');
    expect(toSqlLiteral(-1.5)).toBe('-1.5');
  });

  it('escapes embedded quotes', () => {
    expect(toSqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it('renders dates as an explicitly typed timestamptz', () => {
    expect(toSqlLiteral(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      "TIMESTAMPTZ '2026-01-02T03:04:05.000Z'",
    );
  });

  it('refuses values it cannot render unambiguously', () => {
    expect(() => toSqlLiteral(Number.NaN)).toThrow(/non-finite/);
  });
});

describe('renderSqlVariables', () => {
  it('substitutes a bare variable', () => {
    expect(renderSqlVariables('SELECT :n', { n: 7 })).toBe('SELECT 7');
  });

  it("supports psql's quoted form", () => {
    expect(renderSqlVariables("SELECT :'name'", { name: 'ada' })).toBe("SELECT 'ada'");
  });

  it('leaves the cast operator alone', () => {
    // The reason a regex will not do: ":text" here is the tail of a cast, and
    // "text" is not a variable.
    expect(renderSqlVariables('SELECT x::text, :n::int', { n: 1 })).toBe(
      'SELECT x::text, 1::int',
    );
  });

  it('does not substitute inside string literals', () => {
    const sql = "SELECT md5(g::text || ':session'), :n";
    expect(renderSqlVariables(sql, { n: 3 })).toBe("SELECT md5(g::text || ':session'), 3");
  });

  it('handles doubled quotes inside a string literal', () => {
    const sql = "SELECT 'it''s :notavariable', :n";
    expect(renderSqlVariables(sql, { n: 3 })).toBe("SELECT 'it''s :notavariable', 3");
  });

  it('does not substitute inside dollar-quoted bodies', () => {
    const sql = 'CREATE FUNCTION f() RETURNS int AS $$ SELECT :n $$ LANGUAGE sql';
    expect(renderSqlVariables(sql, { n: 9 })).toBe(sql);
  });

  it('does not substitute inside tagged dollar quotes', () => {
    const sql = 'DO $body$ BEGIN RAISE NOTICE :msg; END $body$';
    expect(renderSqlVariables(sql, { msg: 'x' })).toBe(sql);
  });

  it('does not substitute inside quoted identifiers', () => {
    expect(renderSqlVariables('SELECT ":n" FROM t', { n: 1 })).toBe('SELECT ":n" FROM t');
  });

  it('does not substitute inside line or block comments', () => {
    expect(renderSqlVariables('-- :n\nSELECT :n', { n: 5 })).toBe('-- :n\nSELECT 5');
    expect(renderSqlVariables('/* :n /* :n */ */ SELECT :n', { n: 5 })).toBe(
      '/* :n /* :n */ */ SELECT 5',
    );
  });

  it('reports an unbound variable by name, with what was available', () => {
    expect(() => renderSqlVariables('SELECT :missing', { present: 1 })).toThrow(
      UnboundSqlVariableError,
    );
    expect(() => renderSqlVariables('SELECT :missing', { present: 1 })).toThrow(
      /:missing.*:present/s,
    );
  });

  it('leaves a lone colon alone', () => {
    expect(renderSqlVariables('SELECT a[1:2]', {})).toBe('SELECT a[1:2]');
  });
});

describe('splitStatements', () => {
  it('splits on top-level semicolons and drops empties', () => {
    expect(splitStatements('SELECT 1; SELECT 2;;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores semicolons inside string literals', () => {
    expect(splitStatements("SELECT ';'; SELECT 2")).toEqual(["SELECT ';'", 'SELECT 2']);
  });

  it('ignores semicolons inside dollar-quoted function bodies', () => {
    const script = [
      'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$',
      'BEGIN',
      "  RAISE EXCEPTION 'no';",
      'END;',
      '$$;',
      'SELECT 1;',
    ].join('\n');
    const statements = splitStatements(script);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('RAISE EXCEPTION');
    expect(statements[1]).toBe('SELECT 1');
  });

  it('strips comment-only statements', () => {
    expect(splitStatements('-- just a comment\n\n/* and another */')).toEqual([]);
  });
});
