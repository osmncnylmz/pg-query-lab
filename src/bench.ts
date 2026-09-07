/**
 * The benchmark runner.
 *
 *   npm run bench                        default scale, writes BENCHMARK.md
 *   npm run bench -- --scale 0.25        a quarter of the rows
 *   npm run bench -- --only 05           just one scenario, no file written
 *   npm run bench -- --check             fail if any scenario stops paying off
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatPlan } from './explain.js';
import { DEFAULT_CONFIG, Lab, REPO_ROOT, type LabConfig } from './lab.js';
import { renderBenchmarkMarkdown } from './report.js';
import { runScenario, type ScenarioRun } from './runner.js';
import { loadScenarios } from './scenarios.js';

/**
 * The version of PGlite that is actually installed, for the report header.
 * Its package.json is not in the package's `exports` map, so it cannot be
 * `require`d; read it off disk, and fall back to the declared range.
 */
async function installedPgliteVersion(): Promise<string> {
  const candidates = [
    join(REPO_ROOT, 'node_modules/@electric-sql/pglite/package.json'),
    join(REPO_ROOT, 'package.json'),
  ];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        version?: string;
        dependencies?: Record<string, string>;
      };
      const version = parsed.dependencies?.['@electric-sql/pglite'] ?? parsed.version;
      if (typeof version === 'string') return version;
    } catch {
      // try the next candidate
    }
  }
  return 'unknown';
}

interface Options extends LabConfig {
  readonly only: string | undefined;
  readonly out: string;
  readonly check: boolean;
  readonly minSpeedup: number;
  readonly plans: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Options {
  let scale = DEFAULT_CONFIG.scale;
  let seed = DEFAULT_CONFIG.seed;
  let only: string | undefined;
  let out = join(REPO_ROOT, 'BENCHMARK.md');
  let check = false;
  let minSpeedup = 1.5;
  let plans = false;

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '--scale':
        scale = Number(requireValue(arg, argv[++i]));
        if (!(scale > 0)) throw new UsageError('--scale must be a positive number');
        break;
      case '--seed':
        seed = Number(requireValue(arg, argv[++i]));
        if (!Number.isInteger(seed)) throw new UsageError('--seed must be an integer');
        break;
      case '--only':
        only = requireValue(arg, argv[++i]);
        break;
      case '--out':
        out = requireValue(arg, argv[++i]);
        break;
      case '--check':
        check = true;
        break;
      case '--plans':
        plans = true;
        break;
      case '--min-speedup':
        minSpeedup = Number(requireValue(arg, argv[++i]));
        if (!(minSpeedup > 0)) throw new UsageError('--min-speedup must be a positive number');
        break;
      case '--help':
      case '-h':
        throw new UsageError('help');
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  return { scale, seed, only, out, check, minSpeedup, plans };
}

const USAGE = `pg-query-lab benchmark runner

  --scale <n>         row-count multiplier (default ${DEFAULT_CONFIG.scale})
  --seed <int>        pseudo-random seed (default ${DEFAULT_CONFIG.seed})
  --only <substring>  run only scenarios whose id contains this
  --out <path>        where to write the report (default BENCHMARK.md)
  --check             exit non-zero if a scenario is not meaningfully faster
  --min-speedup <n>   threshold for --check (default 1.5)
  --plans             print both EXPLAIN plans for every scenario it runs
`;

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stdout.write(USAGE);
      return error.message === 'help' ? 0 : 2;
    }
    throw error;
  }

  const all = await loadScenarios();
  const only = options.only;
  const scenarios = only === undefined ? all : all.filter((s) => s.id.includes(only));

  if (scenarios.length === 0) {
    process.stderr.write(`no scenarios matched --only ${only}\n`);
    return 1;
  }

  process.stdout.write(`Building the lab (scale ${options.scale}, seed ${options.seed})...\n`);
  const buildStarted = performance.now();
  const lab = await Lab.create({ scale: options.scale, seed: options.seed });
  const buildMs = performance.now() - buildStarted;

  try {
    const rowCounts = await lab.rowCounts();
    const total = rowCounts.reduce((sum, c) => sum + c.rows, 0);
    process.stdout.write(
      `Ready in ${(buildMs / 1000).toFixed(1)}s: ${total.toLocaleString('en-US')} rows across ` +
        `${rowCounts.length} tables\n\n`,
    );

    const runs: ScenarioRun[] = [];
    const failures: string[] = [];

    const idWidth = Math.max(...scenarios.map((s) => s.id.length));
    for (const scenario of scenarios) {
      process.stdout.write(`${pad(scenario.id, idWidth)}  `);
      const run = await runScenario(lab, scenario);
      runs.push(run);

      const line =
        `${padStart(run.naive.timing.medianMs.toFixed(2), 9)} ms -> ` +
        `${padStart(run.optimized.timing.medianMs.toFixed(2), 8)} ms  ` +
        padStart(`${run.speedup.toFixed(1)}x`, 8);
      process.stdout.write(line);

      if (!run.comparison.equal) {
        process.stdout.write('  RESULTS DIFFER\n');
        failures.push(`${scenario.id}: naive and optimized returned different rows\n  ${run.comparison.reason}`);
      } else if (options.check && run.speedup < options.minSpeedup) {
        process.stdout.write('  BELOW THRESHOLD\n');
        failures.push(
          `${scenario.id}: speedup ${run.speedup.toFixed(2)}x is below --min-speedup ${options.minSpeedup}`,
        );
      } else {
        process.stdout.write('\n');
      }

      if (options.plans) {
        process.stdout.write(`\n--- ${scenario.id} :: naive\n`);
        process.stdout.write(`${formatPlan(run.naive.explain)}\n`);
        process.stdout.write(`\n--- ${scenario.id} :: optimized\n`);
        process.stdout.write(`${formatPlan(run.optimized.explain)}\n\n`);
      }
    }

    process.stdout.write('\n');

    if (only === undefined) {
      const serverVersion = (
        await lab.db.query<{ v: string }>('SELECT current_setting($1) AS v', ['server_version'])
      ).rows[0]?.v;
      const pgliteVersion = await installedPgliteVersion();

      const markdown = renderBenchmarkMarkdown(runs, {
        config: lab.config,
        rowCounts,
        serverVersion: `PostgreSQL ${serverVersion ?? 'unknown'} (WebAssembly)`,
        pgliteVersion,
        buildMs,
        generatedAt: new Date(),
      });
      await writeFile(options.out, markdown, 'utf8');
      process.stdout.write(`Wrote ${options.out}\n`);
    } else {
      process.stdout.write('(--only given: BENCHMARK.md not written)\n');
    }

    if (failures.length > 0) {
      process.stderr.write(`\n${failures.length} problem(s):\n`);
      for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
      return 1;
    }

    return 0;
  } finally {
    await lab.close();
  }
}

process.exitCode = await main();
