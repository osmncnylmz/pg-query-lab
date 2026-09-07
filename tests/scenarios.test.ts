import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeMatcher, findNodes, formatPlan, type ExplainOutput } from '../src/explain.js';
import { Lab, TEST_CONFIG } from '../src/lab.js';
import { runScenario, type ScenarioRun } from '../src/runner.js';
import { loadScenarios, type PlanExpectation, type Scenario } from '../src/scenarios.js';

/**
 * Loaded at module scope so vitest can name one describe block per scenario.
 * The database work happens once in beforeAll: building the lab costs several
 * seconds and every scenario shares it, which is safe because runScenario
 * verifies that each one leaves the database exactly as it found it.
 */
const scenarios: Scenario[] = await loadScenarios();

let lab: Lab;
const runs = new Map<string, ScenarioRun>();

beforeAll(async () => {
  lab = await Lab.create(TEST_CONFIG);
  for (const scenario of scenarios) {
    runs.set(scenario.id, await runScenario(lab, scenario));
  }
});

afterAll(async () => {
  await lab.close();
});

function runFor(id: string): ScenarioRun {
  const run = runs.get(id);
  if (run === undefined) throw new Error(`scenario ${id} was not run`);
  return run;
}

function checkExpectation(
  explain: ExplainOutput,
  expectation: PlanExpectation | undefined,
  label: string,
): void {
  if (expectation === undefined) return;

  for (const matcher of expectation.nodes ?? []) {
    const found = findNodes(explain.Plan, matcher);
    expect(
      found.length,
      `${label} plan should contain "${describeMatcher(matcher)}" but does not:\n\n${formatPlan(explain)}\n`,
    ).toBeGreaterThan(0);
  }

  for (const matcher of expectation.forbidden ?? []) {
    const found = findNodes(explain.Plan, matcher);
    expect(
      found.length,
      `${label} plan should NOT contain "${describeMatcher(matcher)}" but does:\n\n${formatPlan(explain)}\n`,
    ).toBe(0);
  }
}

describe('scenario catalogue', () => {
  it('has at least ten scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
  });

  it('gives every scenario a unique numeric prefix', () => {
    const prefixes = scenarios.map((s) => s.id.slice(0, 2));
    expect(new Set(prefixes).size).toBe(scenarios.length);
    for (const prefix of prefixes) expect(prefix).toMatch(/^\d\d$/);
  });

  it('gives every scenario a README that names its technique', () => {
    for (const scenario of scenarios) {
      expect(scenario.readme.length, `${scenario.id} README is too short`).toBeGreaterThan(400);
      expect(scenario.readme, `${scenario.id} README should state the technique`).toContain(
        '**Technique:**',
      );
    }
  });

  it('asserts something about both plans of every scenario', () => {
    for (const scenario of scenarios) {
      const optimized = scenario.expect.optimized;
      expect(optimized, `${scenario.id} has no expect.optimized`).toBeDefined();
      expect(
        (optimized?.nodes?.length ?? 0) + (optimized?.forbidden?.length ?? 0),
        `${scenario.id} expect.optimized asserts nothing`,
      ).toBeGreaterThan(0);
    }
  });
});

describe.each(scenarios.map((s) => [s.id, s] as const))('%s', (id, scenario) => {
  it('returns the same rows from the naive and optimized queries', () => {
    const run = runFor(id);
    if (!run.comparison.equal) {
      throw new Error(
        `the optimized query does not answer the same question:\n${run.comparison.reason}`,
      );
    }
    expect(run.comparison.rowCount).toBeGreaterThan(0);
  });

  it('produces the plan the naive query is supposed to have', () => {
    const run = runFor(id);
    checkExpectation(run.naive.explain, scenario.expect.naive, `${id} naive`);
  });

  it('produces the plan the optimization is supposed to produce', () => {
    const run = runFor(id);
    checkExpectation(run.optimized.explain, scenario.expect.optimized, `${id} optimized`);
  });

  it('is actually faster', () => {
    const run = runFor(id);
    // The published speedups range from roughly 4x to several hundred. The
    // threshold here is deliberately far below any of them: this test exists to
    // catch a scenario that has stopped working, not to police timing noise on
    // a shared CI runner.
    expect(
      run.speedup,
      `naive ${run.naive.timing.medianMs.toFixed(2)}ms vs ` +
        `optimized ${run.optimized.timing.medianMs.toFixed(2)}ms`,
    ).toBeGreaterThan(1.2);
  });
});

describe('materialized view refresh', () => {
  it('supports REFRESH ... CONCURRENTLY, which is why scenario 08 creates a unique index', async () => {
    const scenario = scenarios.find((s) => s.id.startsWith('08'));
    expect(scenario).toBeDefined();
    if (scenario?.setupSql === undefined || scenario.teardownSql === undefined) {
      throw new Error('scenario 08 should have both setup.sql and teardown.sql');
    }

    await lab.db.exec(scenario.setupSql);
    try {
      const before = await lab.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM daily_revenue',
      );
      // Without the unique index this statement raises
      // "cannot refresh materialized view concurrently".
      await lab.db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY daily_revenue');
      const after = await lab.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM daily_revenue',
      );
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      expect(after.rows[0]?.n).toBeGreaterThan(0);
    } finally {
      await lab.db.exec(scenario.teardownSql);
    }
  });
});
