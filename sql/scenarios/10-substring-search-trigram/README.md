# 10 - Case-insensitive substring search

**Technique:** `pg_trgm` GIN index

## Does pg_trgm work in PGlite?

Yes. This was worth checking rather than assuming, because PGlite ships
extensions as separately loadable WASM bundles and not every contrib module is
available. `pg_trgm` is, and it has to be handed to PGlite at startup:

```ts
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const db = await PGlite.create({ extensions: { pg_trgm } });
```

Without that, `CREATE EXTENSION pg_trgm` fails with "extension is not
available", regardless of what the SQL says. `src/lab.ts` always loads it; this
scenario's `setup.sql` then runs `CREATE EXTENSION`, and its `teardown.sql`
drops it again, which the harness verifies.

On a server PostgreSQL the same SQL works with no client-side step, as long as
the `postgresql-contrib` package is installed.

## What is slow

`ILIKE '%...%'` is unindexable by a B-tree. B-trees answer questions of the form
"where does this prefix start", and a leading wildcard means there is no prefix.
So every one of the 50,000 review bodies is lower-cased and scanned.

## The fix

```sql
CREATE EXTENSION pg_trgm;
CREATE INDEX reviews_body_trgm_idx ON reviews USING gin (body gin_trgm_ops);
```

A trigram index stores the three-character sequences that appear in each value.
`ILIKE '%ergonomic canvas backpack%'` is decomposed into its trigrams, their
posting lists are intersected, and the surviving rows are rechecked against the
original pattern.

Patterns shorter than three characters have no trigrams to look up, so the index
cannot help and PostgreSQL falls back to a scan.

## GIN or GiST

`gin_trgm_ops` is the right default: bigger index, much faster search.
`gist_trgm_ops` is smaller and slower to search, but supports
`ORDER BY body <-> 'query' LIMIT n` -- nearest neighbour by similarity, which is
what "did you mean" suggestions are built on. GIN supports the `similarity()`
function and the `%` operator but cannot drive an ordered scan by distance.

## Trigrams or full-text search

They solve different problems, and this repository demonstrates both -- see
scenario 13 for full-text search on `products`.

* **Trigram** matches *characters*. It handles substrings, typos and
  partial words, is language-agnostic, and does not know that "running" and
  "ran" are related. Right for an admin lookup box, a SKU search, a fuzzy name
  match.
* **Full-text search** matches *words*, after stemming and stop-word removal. It
  understands "waterproof jackets" should match "waterproof jacket", supports
  ranking and phrase queries, and cannot find a substring in the middle of a
  word. Right for searching prose.

## What to look for in the plan

Before:

```
Seq Scan on reviews  (rows=50000, Rows Removed by Filter=49989)
```

After:

```
Bitmap Heap Scan on reviews  (rows=11, Recheck Cond: (body ~~* '%...%'))
  -> Bitmap Index Scan using reviews_body_trgm_idx
```

The recheck is mandatory here, not incidental: trigram matching is approximate
and can return rows whose trigrams all appear but not in the right order.
