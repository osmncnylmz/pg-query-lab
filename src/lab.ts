import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

import { renderSqlVariables, splitStatements, type SqlValue } from './sql-text.js';

/** Repository root, resolved from this module rather than from process.cwd(). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SQL_DIR = join(REPO_ROOT, 'sql');

export interface LabConfig {
  /** Row-count multiplier. 1 is the documented default dataset. */
  readonly scale: number;
  /** Salts the pseudo-random stream in sql/02_seed.sql. */
  readonly seed: number;
}

export const DEFAULT_CONFIG: LabConfig = { scale: 1, seed: 20260101 };

/**
 * The scale used by the test suite. Smaller than the benchmark default so the
 * suite stays quick, but deliberately not tiny: plan assertions are only
 * meaningful on a dataset large enough that the planner would genuinely choose
 * a sequential scan without the index under test.
 */
export const TEST_CONFIG: LabConfig = { scale: 0.35, seed: 20260101 };

export interface TableCount {
  readonly table: string;
  readonly rows: number;
}

/** A relation as seen by the drift check: name plus kind. */
export interface DatabaseObject {
  readonly name: string;
  readonly kind: string;
}

export interface DatabaseSnapshot {
  readonly relations: readonly DatabaseObject[];
  readonly extensions: readonly string[];
}

const SEEDED_TABLES = [
  'customers',
  'addresses',
  'categories',
  'products',
  'product_variants',
  'inventory_movements',
  'orders',
  'order_items',
  'payments',
  'reviews',
  'events',
] as const;

/**
 * A PGlite database with the lab schema applied and seeded.
 *
 * PGlite is a real PostgreSQL compiled to WebAssembly, so the planner, the
 * executor, the statistics and EXPLAIN output are the genuine article. What it
 * is not is a server: one connection, no background workers, no parallel query.
 * Those limits are documented in the README, and they are the reason the
 * numbers here are ratios first and absolute milliseconds second.
 */
export class Lab {
  private constructor(
    readonly db: PGlite,
    readonly config: LabConfig,
  ) {}

  static async create(config: LabConfig = DEFAULT_CONFIG): Promise<Lab> {
    if (!(config.scale > 0)) throw new Error(`scale must be > 0, got ${config.scale}`);
    if (!Number.isInteger(config.seed)) throw new Error(`seed must be an integer, got ${config.seed}`);

    const db = await PGlite.create({ extensions: { pg_trgm } });
    const lab = new Lab(db, config);

    await lab.applyScript('01_schema.sql');
    await lab.applyScript('02_seed.sql', { scale: config.scale, seed: config.seed });
    await lab.applyStatementByStatement('03_statistics.sql');

    return lab;
  }

  /** Apply a file from sql/ as a single multi-statement script. */
  private async applyScript(file: string, vars: Readonly<Record<string, SqlValue>> = {}): Promise<void> {
    const raw = await readFile(join(SQL_DIR, file), 'utf8');
    await this.db.exec(renderSqlVariables(raw, vars));
  }

  /**
   * Apply a file one statement at a time. Needed for VACUUM, which refuses to
   * run inside the implicit transaction block that a multi-statement simple
   * query creates.
   */
  private async applyStatementByStatement(file: string): Promise<void> {
    const raw = await readFile(join(SQL_DIR, file), 'utf8');
    for (const statement of splitStatements(raw)) {
      await this.db.query(statement);
    }
  }

  async rowCounts(): Promise<TableCount[]> {
    const counts: TableCount[] = [];
    for (const table of SEEDED_TABLES) {
      const res = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      counts.push({ table, rows: res.rows[0]?.n ?? 0 });
    }
    return counts;
  }

  /**
   * Everything a scenario could create and forget to drop. Compared before and
   * after each scenario so that one scenario's index can never silently make
   * the next scenario's "before" number look good.
   */
  async snapshot(): Promise<DatabaseSnapshot> {
    const relations = await this.db.query<DatabaseObject>(`
      SELECT c.relname AS name, c.relkind::text AS kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'i', 'm', 'v', 'p', 'S')
      ORDER BY c.relname
    `);
    const extensions = await this.db.query<{ name: string }>(
      `SELECT extname AS name FROM pg_extension ORDER BY extname`,
    );
    return {
      relations: relations.rows,
      extensions: extensions.rows.map((r) => r.name),
    };
  }

  /** Sizes on disk of the named relations, in bytes. */
  async relationSizes(names: readonly string[]): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for (const name of names) {
      const res = await this.db.query<{ bytes: number }>(
        `SELECT pg_relation_size($1::regclass)::int AS bytes`,
        [name],
      );
      sizes.set(name, res.rows[0]?.bytes ?? 0);
    }
    return sizes;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export interface SnapshotDiff {
  readonly added: DatabaseObject[];
  readonly removed: DatabaseObject[];
  readonly addedExtensions: string[];
  readonly removedExtensions: string[];
}

export function diffSnapshots(before: DatabaseSnapshot, after: DatabaseSnapshot): SnapshotDiff {
  const key = (o: DatabaseObject): string => `${o.kind}:${o.name}`;
  const beforeKeys = new Set(before.relations.map(key));
  const afterKeys = new Set(after.relations.map(key));
  const beforeExt = new Set(before.extensions);
  const afterExt = new Set(after.extensions);

  return {
    added: after.relations.filter((o) => !beforeKeys.has(key(o))),
    removed: before.relations.filter((o) => !afterKeys.has(key(o))),
    addedExtensions: after.extensions.filter((e) => !beforeExt.has(e)),
    removedExtensions: before.extensions.filter((e) => !afterExt.has(e)),
  };
}
