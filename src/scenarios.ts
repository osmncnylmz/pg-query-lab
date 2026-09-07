import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { NodeMatcher } from './explain.js';
import { SQL_DIR } from './lab.js';

export const SCENARIOS_DIR = join(SQL_DIR, 'scenarios');

/**
 * When the scenario's DDL is applied.
 *
 * `before-optimized`  the fix *is* the DDL, so the naive query must be measured
 *                     without it. This is the honest ordering for "add an index".
 * `before-both`       the fix is a query rewrite, so both queries must see the
 *                     same indexes or the comparison is rigged. Used where the
 *                     scenario needs an index to exist for either query to be
 *                     interesting.
 * `none`              a pure rewrite against the schema as shipped.
 */
export type SetupMode = 'before-optimized' | 'before-both' | 'none';

export interface PlanExpectation {
  /** Every matcher here must match at least one node in the plan. */
  readonly nodes?: readonly (string | NodeMatcher)[];
  /** No matcher here may match any node in the plan. */
  readonly forbidden?: readonly (string | NodeMatcher)[];
}

export interface ScenarioMeta {
  readonly title: string;
  /** The technique on trial, as it appears in the README index. */
  readonly technique: string;
  /** One sentence: what is slow and why. */
  readonly summary: string;
  readonly setup: SetupMode;
  readonly iterations: number;
  readonly warmups: number;
  /** True when both queries carry an ORDER BY and row order is part of the answer. */
  readonly orderedResults: boolean;
  readonly expect: {
    readonly naive?: PlanExpectation;
    readonly optimized?: PlanExpectation;
  };
}

export interface Scenario extends ScenarioMeta {
  /** Directory name, e.g. `01-unindexed-foreign-key`. Also the scenario id. */
  readonly id: string;
  readonly dir: string;
  readonly naiveSql: string;
  readonly optimizedSql: string;
  /** DDL applied per `setup`, and undone by `teardownSql`. */
  readonly setupSql: string | undefined;
  readonly teardownSql: string | undefined;
  /**
   * Optional query returning exactly one row. Its columns become psql-style
   * variables available to naive.sql and optimized.sql. Used where a query
   * needs a value that a real application would already have -- a pagination
   * cursor, for instance.
   */
  readonly paramsSql: string | undefined;
  /**
   * Optional script whose final statement returns rows to be shown alongside
   * the benchmark, for scenarios where something other than time is the point
   * (index size, for example). Anything it creates it must also drop.
   */
  readonly notesSql: string | undefined;
  readonly readme: string;
}

class ScenarioMetaError extends Error {
  constructor(id: string, message: string) {
    super(`sql/scenarios/${id}/meta.json: ${message}`);
    this.name = 'ScenarioMetaError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMatchers(id: string, where: string, value: unknown): (string | NodeMatcher)[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ScenarioMetaError(id, `${where} must be an array`);
  return value.map((entry, i) => {
    if (typeof entry === 'string') return entry;
    if (!isRecord(entry)) throw new ScenarioMetaError(id, `${where}[${i}] must be a string or object`);
    for (const key of Object.keys(entry)) {
      if (!['node', 'relation', 'index', 'joinType', 'parentRelationship'].includes(key)) {
        throw new ScenarioMetaError(id, `${where}[${i}] has unknown key "${key}"`);
      }
      if (typeof entry[key] !== 'string') {
        throw new ScenarioMetaError(id, `${where}[${i}].${key} must be a string`);
      }
    }
    if (Object.keys(entry).length === 0) {
      throw new ScenarioMetaError(id, `${where}[${i}] is empty and would match every node`);
    }
    return entry;
  });
}

function parseExpectation(id: string, where: string, value: unknown): PlanExpectation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ScenarioMetaError(id, `${where} must be an object`);
  return {
    nodes: parseMatchers(id, `${where}.nodes`, value.nodes),
    forbidden: parseMatchers(id, `${where}.forbidden`, value.forbidden),
  };
}

/**
 * Hand-written validation rather than a schema library. It is thirty lines, it
 * keeps the dependency list at one runtime package, and it produces messages
 * that name the file.
 */
export function parseScenarioMeta(id: string, raw: unknown): ScenarioMeta {
  if (!isRecord(raw)) throw new ScenarioMetaError(id, 'must contain a JSON object');

  const requireString = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ScenarioMetaError(id, `"${key}" must be a non-empty string`);
    }
    return value;
  };

  const setup = raw.setup;
  if (setup !== 'before-optimized' && setup !== 'before-both' && setup !== 'none') {
    throw new ScenarioMetaError(
      id,
      '"setup" must be one of "before-optimized", "before-both", "none"',
    );
  }

  const optionalPositiveInt = (key: string, fallback: number): number => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new ScenarioMetaError(id, `"${key}" must be a non-negative integer`);
    }
    return value;
  };

  const expect = isRecord(raw.expect) ? raw.expect : {};
  if (raw.expect !== undefined && !isRecord(raw.expect)) {
    throw new ScenarioMetaError(id, '"expect" must be an object');
  }

  const orderedResults = raw.orderedResults;
  if (orderedResults !== undefined && typeof orderedResults !== 'boolean') {
    throw new ScenarioMetaError(id, '"orderedResults" must be a boolean');
  }

  const naiveExpectation = parseExpectation(id, 'expect.naive', expect.naive);
  const optimizedExpectation = parseExpectation(id, 'expect.optimized', expect.optimized);

  return {
    title: requireString('title'),
    technique: requireString('technique'),
    summary: requireString('summary'),
    setup,
    iterations: optionalPositiveInt('iterations', 5),
    warmups: optionalPositiveInt('warmups', 1),
    orderedResults: orderedResults ?? false,
    expect: {
      ...(naiveExpectation !== undefined ? { naive: naiveExpectation } : {}),
      ...(optimizedExpectation !== undefined ? { optimized: optimizedExpectation } : {}),
    },
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function loadScenario(id: string, dir: string): Promise<Scenario> {
  const metaRaw = await readFile(join(dir, 'meta.json'), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaRaw);
  } catch (error) {
    throw new ScenarioMetaError(id, `invalid JSON (${(error as Error).message})`);
  }
  const meta = parseScenarioMeta(id, parsed);

  const [naiveSql, optimizedSql, setupSql, teardownSql, paramsSql, notesSql, readme] =
    await Promise.all([
      readFile(join(dir, 'naive.sql'), 'utf8'),
      readFile(join(dir, 'optimized.sql'), 'utf8'),
      readOptional(join(dir, 'setup.sql')),
      readOptional(join(dir, 'teardown.sql')),
      readOptional(join(dir, 'params.sql')),
      readOptional(join(dir, 'notes.sql')),
      readFile(join(dir, 'README.md'), 'utf8'),
    ]);

  if (meta.setup !== 'none' && setupSql === undefined) {
    throw new ScenarioMetaError(id, `"setup" is "${meta.setup}" but there is no setup.sql`);
  }
  if (setupSql !== undefined && teardownSql === undefined) {
    throw new ScenarioMetaError(
      id,
      'has a setup.sql but no teardown.sql; scenarios must leave the database as they found it',
    );
  }

  return {
    ...meta,
    id,
    dir,
    naiveSql,
    optimizedSql,
    setupSql,
    teardownSql,
    paramsSql,
    notesSql,
    readme,
  };
}

/** Every scenario directory, in numeric filename order. */
export async function loadScenarios(root: string = SCENARIOS_DIR): Promise<Scenario[]> {
  const entries = await readdir(root);
  const dirs: string[] = [];
  for (const entry of entries.sort()) {
    const path = join(root, entry);
    if ((await stat(path)).isDirectory()) dirs.push(entry);
  }
  return Promise.all(dirs.map((id) => loadScenario(id, join(root, id))));
}
