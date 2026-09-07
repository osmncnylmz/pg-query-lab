# pg-query-lab

Thirteen PostgreSQL queries that are slow for thirteen different reasons, each
paired with the index or the rewrite that fixes it, and a harness that measures
both sides and refuses to believe either number until it has checked that the
two queries return the same rows.

The database is [PGlite](https://pglite.dev): PostgreSQL 18.3 compiled to
WebAssembly and run in-process. Nothing to install, no container, no server on a
port. The planner, the executor, the statistics and the `EXPLAIN` output are the
genuine article, so a Bitmap Index Scan here is a Bitmap Index Scan on a real
server too.

```
npm install
npm test            # build the lab, run every scenario, assert every plan
npm run bench       # the same, timed, and rewrite BENCHMARK.md
```

Creating and seeding the schema takes ten to twenty seconds; the scenarios
themselves take a few more.

## Results

| # | Scenario | Technique | Naive | Optimized | Speedup |
| --- | --- | --- | --- | --- | --- |
| [01](sql/scenarios/01-unindexed-foreign-key/) | Unindexed foreign key | Covering index with INCLUDE | 7.08 ms | 0.38 ms | **18.7x** |
| [02](sql/scenarios/02-deep-offset-pagination/) | Deep OFFSET pagination | Keyset (seek) pagination | 8.32 ms | 0.25 ms | **33.6x** |
| [03](sql/scenarios/03-correlated-subquery-to-window/) | Correlated subquery per row | Window function | 229 ms | 10.1 ms | **22.7x** |
| [04](sql/scenarios/04-top-n-per-group-lateral/) | Top-N per group over the whole table | LATERAL join | 49.2 ms | 3.95 ms | **12.5x** |
| [05](sql/scenarios/05-brin-time-range/) | Time range on an append-only log | BRIN index | 13.5 ms | 1.19 ms | **11.3x** |
| [06](sql/scenarios/06-or-across-tables/) | OR across two tables | UNION ALL rewrite | 19.2 ms | 3.24 ms | **5.9x** |
| [07](sql/scenarios/07-distinct-to-semi-join/) | DISTINCT hiding a fan-out join | EXISTS semi-join | 21.9 ms | 2.97 ms | **7.4x** |
| [08](sql/scenarios/08-repeated-aggregate-matview/) | Repeated dashboard aggregate | Materialized view | 126 ms | 1.55 ms | **81.3x** |
| [09](sql/scenarios/09-jsonb-containment-gin/) | jsonb containment filter | GIN index with jsonb_path_ops | 37.3 ms | 1.68 ms | **22.2x** |
| [10](sql/scenarios/10-substring-search-trigram/) | Case-insensitive substring search | pg_trgm GIN index | 62.3 ms | 2.26 ms | **27.6x** |
| [11](sql/scenarios/11-sort-limit-index/) | Sort and limit over a large table | Index providing the ordering | 21.7 ms | 0.30 ms | **72.5x** |
| [12](sql/scenarios/12-partial-index/) | Selective predicate on a skewed column | Partial index | 6.07 ms | 0.90 ms | **6.7x** |
| [13](sql/scenarios/13-full-text-search/) | Full-text search computed per row | Stored generated tsvector column with a GIN index | 231 ms | 0.34 ms | **688x** |

Those milliseconds came off one machine -- an Apple M4 under Node 25, at the
default scale of roughly 940,000 rows -- and they will not reproduce on yours.
Absolute timings belong to the hardware, the page cache and the WASM runtime,
which is to say they belong to the run that produced them rather than to the
technique. The ratios are the part that travels.

Even those are not stable to three digits. Back-to-back runs on this machine
moved several scenarios by a third, and the ones whose optimized side lands
under a millisecond move most, because at that size the measurement is
competing with its own overhead. Read the speedup column as an order of
magnitude.

[BENCHMARK.md](BENCHMARK.md) is the full output of the run above: per-scenario
buffer counts, the indexes each plan actually used, the size on disk of
everything a fix creates, and both `EXPLAIN (ANALYZE, BUFFERS)` plans. It is
generated, and `npm run bench` overwrites it end to end.

Scenario 13 is the outlier for a reason worth stating plainly. The naive query
builds a `tsvector` for all 20,000 products on every search, so its cost is
parsing the entire catalogue; the optimized one probes a GIN index over a column
the schema already maintains. Three orders of magnitude is what "stop doing the
work at all" looks like, not a claim about full-text search in general.

## How the harness avoids fooling itself

A before/after benchmark is easy to rig, and it usually gets rigged by accident.

Start with the rows. Every scenario's two result sets are compared as multisets,
or as sequences where the queries carry an `ORDER BY` and row order is part of
the answer. Numeric values are normalised first: `4.50` from a `numeric(12,2)`
column and `4.5` from an aggregate over it are the same number arriving at a
different scale. A scenario whose "optimization" quietly drops a row fails the
run instead of posting a good time, which is what catches the classic mistakes.
A `LEFT JOIN` rewritten as an inner join. A `NOT IN` that swallows a NULL. A
`LIMIT` whose `ORDER BY` lost its tiebreaker.

Then the moment the DDL lands, which each scenario declares in its `meta.json`.
`before-optimized` means the fix *is* the index, so the naive query is measured
while that index still does not exist; measuring it afterwards would measure
nothing. `before-both` means the fix is a rewrite, so both queries see the same
indexes. Otherwise the comparison is between an indexed query and an unindexed
one rather than between two ways of asking the same question. `none` is a pure
rewrite against the schema as shipped.

Nothing is allowed to leak between scenarios. The runner snapshots every
relation and extension in `public` beforehand, runs the scenario, applies its
`teardown.sql`, and diffs the snapshot again. A leftover index would quietly
improve the next scenario's "before" number, so a scenario that fails to clean
up fails the run.

Last, the plans are asserted and not only the times, because a speedup that came
from a warm cache rather than from the technique under test is a real hazard.
Each `meta.json` states what has to appear in a plan and what must not: scenario
05 requires a `Bitmap Index Scan` on `events_occurred_at_brin` and forbids a
`Seq Scan` on `events`. The suite checks every scenario's assertions at a
smaller scale and prints the offending plan when one fails.

Beyond the scenarios it also covers the schema, in three dozen cases over the
`CHECK` constraints, the `ON DELETE` behaviour of each foreign key, the
generated columns, the append-only trigger on `events`, and the claim that
seeding is deterministic.

## The dataset

An e-commerce OLTP schema in [`sql/01_schema.sql`](sql/01_schema.sql): customers,
addresses, a category tree, products and variants, orders and lines, payments,
reviews, and an append-only event log. Money is `numeric(12,2)`, times are
`timestamptz`, `NOT NULL` is the default posture, and constraints carry the
invariants. Several indexes are missing on purpose -- each omission is
commented where it would otherwise sit, and names the scenario that adds it.

[`sql/02_seed.sql`](sql/02_seed.sql) fills it, entirely server-side, from
`generate_series`. It takes `:scale` and `:seed`. The usual `setseed()` +
`random()` recipe is not what the data depends on, because `random()` is only
reproducible if every call happens in the same order, and evaluation order is a
property of the plan rather than of the query. Add a parallel worker and your
"seeded" generator quietly produces something else. Every value here is instead
a pure function of row number and salt, so the same `(scale, seed)` gives
identical data under any plan. At scale 1 that is about 940,000 rows.

[`sql/03_statistics.sql`](sql/03_statistics.sql) runs `VACUUM (ANALYZE)`. Without
it the planner works from hard-coded defaults and every number above would be
measuring the absence of statistics rather than the presence of an index. The
`VACUUM` also matters on its own: an Index Only Scan on a table with a stale
visibility map still visits the heap for every row, and stops being "only".

## Anatomy of a scenario

```
sql/scenarios/05-brin-time-range/
    README.md       what is slow, why, the fix, what to read in the plan, what it costs
    meta.json       setup mode, iteration counts, the plan assertions
    naive.sql       the query as it is usually written
    optimized.sql   the query after the fix
    setup.sql       the DDL the fix needs
    teardown.sql    undoes setup.sql, verified by the snapshot diff
    params.sql      optional: one row of values the queries need but should not compute
    notes.sql       optional: something to report other than time, such as index size
```

The `.sql` files use psql-style `:name` variables, so the same files feed both
`psql` and the TypeScript runner without maintaining two dialects. Substitution
is done by a small scanner in [`src/sql-text.ts`](src/sql-text.ts) that
understands string literals, dollar quoting, quoted identifiers and nested block
comments. A regex would happily rewrite `:session` inside a string, or read
`::text` as a cast of a variable named `text`.

`params.sql` exists for values a real application already has and should not pay
to compute inside the measured query. Scenario 02 is the clear case: keyset
pagination needs the cursor from the previous page, which the application got
from the row it just rendered. Producing it here needs the very `OFFSET` the
scenario argues against, so it runs once, outside the timed region.

## Running it against a real PostgreSQL server

The SQL is not PGlite-specific. Against a server:

```
psql -f sql/01_schema.sql
psql -v scale=1 -v seed=20260101 -f sql/02_seed.sql
psql -f sql/03_statistics.sql
psql -f sql/scenarios/05-brin-time-range/setup.sql
psql -f sql/scenarios/05-brin-time-range/optimized.sql
```

Scenario 10 needs `pg_trgm`, which on a server means the `postgresql-contrib`
package and nothing else. Under PGlite the extension has to be handed in at
startup as a separate WASM bundle, which `src/lab.ts` does.

What PGlite is not is a server. One connection, no background workers, and no
parallel query. A server with several workers would cut the naive times in the
sequential-scan scenarios -- roughly by the number of workers it chose to
use -- which compresses those ratios; it does not change which query has to read
the whole table and which one does not. This is the main reason the ratios are
presented as the headline and the milliseconds as supporting detail.

## Benchmark runner options

```
npm run bench -- --scale 0.25          a quarter of the rows
npm run bench -- --seed 7              a different pseudo-random stream
npm run bench -- --only 05             one scenario; does not rewrite BENCHMARK.md
npm run bench -- --plans               print both EXPLAIN plans as it goes
npm run bench -- --check               exit non-zero if a scenario stops paying off
npm run bench -- --check --min-speedup 3
```

`--check` is the regression guard: it is what catches a scenario that a new
PostgreSQL version has learned to optimize on its own, which is a good thing to
find out about deliberately rather than by having a reader notice.

## Layout

| Path | What is in it |
| --- | --- |
| `sql/` | Schema, seed, statistics, and the thirteen scenario directories |
| `src/lab.ts` | Creates the PGlite database, applies the three scripts, snapshots relations |
| `src/scenarios.ts` | Loads and validates scenario directories |
| `src/runner.ts` | Runs one scenario: setup ordering, timing, teardown, drift check |
| `src/explain.ts` | `EXPLAIN` JSON parsing, node matching, plan formatting |
| `src/compare.ts` | Result-set equality |
| `src/sql-text.ts` | psql variable substitution and statement splitting |
| `src/report.ts` | Renders `BENCHMARK.md` |
| `src/bench.ts` | The CLI |
| `tests/` | Schema tests, scenario tests, SQL-text tests |

## Checks

`npm run lint` (ESLint with `strictTypeChecked`), `npm run typecheck` (TypeScript
`strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`),
`npm test`, and `npm run build`. CI runs all four on Node 20 and 22, plus
`npm run bench -- --check`.

## License

MIT. See [LICENSE](LICENSE).
