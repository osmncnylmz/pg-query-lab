import { compareResultSets, type Comparison, type ResultSet } from './compare.js';
import { explainAnalyze, type ExplainOutput } from './explain.js';
import { diffSnapshots, type DatabaseSnapshot, type Lab } from './lab.js';
import type { Scenario } from './scenarios.js';
import { renderSqlVariables, splitStatements, type SqlValue } from './sql-text.js';

export interface Timing {
  /** Every measured sample, warmups excluded, in milliseconds. */
  readonly samples: readonly number[];
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

export interface SideResult {
  readonly sql: string;
  readonly timing: Timing;
  readonly explain: ExplainOutput;
  readonly result: ResultSet;
}

export interface CreatedObject {
  readonly name: string;
  readonly kind: string;
  readonly bytes: number;
}

export interface ScenarioRun {
  readonly scenario: Scenario;
  readonly params: Readonly<Record<string, SqlValue>>;
  readonly naive: SideResult;
  readonly optimized: SideResult;
  readonly comparison: Comparison;
  readonly speedup: number;
  /** Relations the scenario's setup.sql created, with their size on disk. */
  readonly createdObjects: readonly CreatedObject[];
  readonly notes: ResultSet | undefined;
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of an empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 !== 0) return upper;
  return ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/** Anything that cannot be re-rendered as a literal is a scenario authoring bug. */
function asSqlValue(column: string, value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value;
  throw new Error(
    `params.sql column "${column}" has type ${typeof value}, which cannot be rendered as a SQL literal`,
  );
}

async function measure(
  lab: Lab,
  sql: string,
  warmups: number,
  iterations: number,
): Promise<{ timing: Timing; result: ResultSet }> {
  for (let i = 0; i < warmups; i += 1) {
    await lab.db.query(sql);
  }

  const samples: number[] = [];
  let rows: Record<string, unknown>[] = [];
  let fields: string[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const res = await lab.db.query<Record<string, unknown>>(sql);
    samples.push(performance.now() - started);
    if (i === 0) {
      rows = res.rows;
      fields = res.fields.map((f) => f.name);
    }
  }

  return {
    timing: {
      samples,
      medianMs: median(samples),
      minMs: Math.min(...samples),
      maxMs: Math.max(...samples),
    },
    result: { rows, fields },
  };
}

/**
 * Run a script and return the last result that actually had columns.
 *
 * "Last statement" would not do: a notes script typically creates something to
 * measure, measures it, and drops it again, so the final statement is a DROP
 * that returns nothing.
 */
async function runScript(lab: Lab, sql: string): Promise<ResultSet> {
  let last: ResultSet = { rows: [], fields: [] };
  for (const statement of splitStatements(sql)) {
    const res = await lab.db.query<Record<string, unknown>>(statement);
    if (res.fields.length > 0) {
      last = { rows: res.rows, fields: res.fields.map((f) => f.name) };
    }
  }
  return last;
}

export class ScenarioError extends Error {
  constructor(scenarioId: string, message: string) {
    super(`scenario ${scenarioId}: ${message}`);
    this.name = 'ScenarioError';
  }
}

/** Run one scenario end to end and leave the database exactly as it was found. */
export async function runScenario(lab: Lab, scenario: Scenario): Promise<ScenarioRun> {
  const before = await lab.snapshot();

  let run: ScenarioRun;
  try {
    run = await executeScenario(lab, scenario, before);
  } catch (error) {
    // Still put the database back, but never let a teardown failure hide the
    // error that actually broke the run.
    try {
      await teardown(lab, scenario);
    } catch {
      // the original error is the useful one
    }
    throw error;
  }

  await teardown(lab, scenario);
  await assertNoDrift(lab, scenario, before);
  return run;
}

async function teardown(lab: Lab, scenario: Scenario): Promise<void> {
  if (scenario.teardownSql !== undefined) {
    await lab.db.exec(scenario.teardownSql);
  }
}

/**
 * One scenario's leftover index silently improving the next scenario's "before"
 * number is exactly the sort of quiet dishonesty this repository exists to
 * argue against. So the snapshot taken before the run is compared against the
 * one taken after teardown, and a mismatch fails the scenario.
 */
async function assertNoDrift(
  lab: Lab,
  scenario: Scenario,
  before: DatabaseSnapshot,
): Promise<void> {
  const drift = diffSnapshots(before, await lab.snapshot());
  const problems: string[] = [];

  if (drift.added.length > 0) {
    problems.push(`left behind ${drift.added.map((o) => `${o.name} (${o.kind})`).join(', ')}`);
  }
  if (drift.removed.length > 0) {
    problems.push(`removed ${drift.removed.map((o) => `${o.name} (${o.kind})`).join(', ')}`);
  }
  if (drift.addedExtensions.length > 0) {
    problems.push(`left behind extension ${drift.addedExtensions.join(', ')}`);
  }
  if (drift.removedExtensions.length > 0) {
    problems.push(`dropped extension ${drift.removedExtensions.join(', ')}`);
  }

  if (problems.length > 0) {
    throw new ScenarioError(
      scenario.id,
      `teardown.sql did not restore the database: ${problems.join('; ')}`,
    );
  }
}

async function executeScenario(
  lab: Lab,
  scenario: Scenario,
  before: DatabaseSnapshot,
): Promise<ScenarioRun> {
  let createdObjects: readonly CreatedObject[] = [];

  if (scenario.setup === 'before-both' && scenario.setupSql !== undefined) {
    await lab.db.exec(scenario.setupSql);
    createdObjects = await describeCreatedObjects(lab, before);
  }

  const params = await resolveParams(lab, scenario);

  const naiveSql = render(scenario, 'naive.sql', scenario.naiveSql, params);
  const optimizedSql = render(scenario, 'optimized.sql', scenario.optimizedSql, params);

  const naiveMeasured = await measure(lab, naiveSql, scenario.warmups, scenario.iterations);
  const naiveExplain = await explainAnalyze(lab.db, naiveSql);

  if (scenario.setup === 'before-optimized' && scenario.setupSql !== undefined) {
    await lab.db.exec(scenario.setupSql);
    createdObjects = await describeCreatedObjects(lab, before);
  }

  const optimizedMeasured = await measure(
    lab,
    optimizedSql,
    scenario.warmups,
    scenario.iterations,
  );
  const optimizedExplain = await explainAnalyze(lab.db, optimizedSql);

  const comparison = compareResultSets(naiveMeasured.result, optimizedMeasured.result, {
    ordered: scenario.orderedResults,
  });

  const notes =
    scenario.notesSql !== undefined ? await runScript(lab, scenario.notesSql) : undefined;

  return {
    scenario,
    params,
    naive: {
      sql: naiveSql,
      timing: naiveMeasured.timing,
      explain: naiveExplain,
      result: naiveMeasured.result,
    },
    optimized: {
      sql: optimizedSql,
      timing: optimizedMeasured.timing,
      explain: optimizedExplain,
      result: optimizedMeasured.result,
    },
    comparison,
    speedup: naiveMeasured.timing.medianMs / optimizedMeasured.timing.medianMs,
    createdObjects,
    notes,
  };
}

function render(
  scenario: Scenario,
  file: string,
  sql: string,
  params: Readonly<Record<string, SqlValue>>,
): string {
  try {
    return renderSqlVariables(sql, params).trim().replace(/;\s*$/, '');
  } catch (error) {
    throw new ScenarioError(scenario.id, `${file}: ${(error as Error).message}`);
  }
}

async function resolveParams(
  lab: Lab,
  scenario: Scenario,
): Promise<Readonly<Record<string, SqlValue>>> {
  if (scenario.paramsSql === undefined) return {};
  const res = await lab.db.query<Record<string, unknown>>(
    scenario.paramsSql.trim().replace(/;\s*$/, ''),
  );
  if (res.rows.length !== 1) {
    throw new ScenarioError(
      scenario.id,
      `params.sql must return exactly one row, got ${res.rows.length}`,
    );
  }
  const row = res.rows[0] ?? {};
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, asSqlValue(key, value)]),
  );
}

async function describeCreatedObjects(
  lab: Lab,
  before: DatabaseSnapshot,
): Promise<CreatedObject[]> {
  const after = await lab.snapshot();
  const added = diffSnapshots(before, after).added;
  const sizes = await lab.relationSizes(added.map((o) => o.name));
  return added.map((o) => ({ name: o.name, kind: o.kind, bytes: sizes.get(o.name) ?? 0 }));
}
