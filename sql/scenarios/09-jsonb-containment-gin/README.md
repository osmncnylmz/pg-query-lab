# 09 - jsonb containment filter

**Technique:** GIN index, `jsonb_path_ops` opclass

## What is slow

`payload @> '{"plan": "enterprise", "source": "ios"}'` has to be evaluated
against every row, and evaluating it means walking the binary jsonb
representation of each document. 300,000 documents later, 0.5% of them matched.

B-tree cannot help: there is no total order on jsonb documents that makes
containment a range query. This is what GIN, the Generalised Inverted Index, is
for. It maps *pieces of a value* back to the rows that contain them, the same
way a book index maps words to pages.

## The fix

```sql
CREATE INDEX events_payload_gin ON events USING gin (payload jsonb_path_ops);
```

## Choosing the opclass

`jsonb` has two GIN opclasses, and for containment queries you usually want the
one that is not the default:

| | `jsonb_ops` (default) | `jsonb_path_ops` |
| --- | --- | --- |
| Indexes | every key and every value separately | a hash of each root-to-leaf path |
| Supports | `@>`, `?`, `?|`, `?&`, `@?`, `@@` | `@>`, `@?`, `@@` |
| Size | larger | smaller |
| `@>` selectivity | looser: matches rows containing the key *or* the value anywhere | tighter: matches the key and value *together, at that path* |

Both sizes are measured for this dataset and reported in `BENCHMARK.md`.

Pick `jsonb_ops` if you need key-existence operators. Otherwise `jsonb_path_ops`
is smaller, faster to search, and produces fewer false positives for the
recheck.

## The narrower alternative

If only one field is ever queried, a plain B-tree on the extracted expression
beats both:

```sql
CREATE INDEX ON events ((payload->>'plan'));
```

It is far smaller than a GIN index and supports ordering and ranges. GIN earns
its size when the set of queried keys is open-ended -- which, for an event
payload, it usually is.

## What to look for in the plan

Before:

```
Seq Scan on events  (rows=300000, Rows Removed by Filter=298...)
```

After:

```
Bitmap Heap Scan on events  (rows=1500, Recheck Cond: ...)
  -> Bitmap Index Scan using events_payload_gin
```

A `Recheck Cond` on a GIN scan is normal: GIN can return candidate rows that do
not actually satisfy the operator, so the heap scan re-tests them. With
`jsonb_path_ops` the number of candidates it has to discard is small.

## The cost

GIN indexes are expensive to maintain. Every insert has to break the document
into its indexable pieces and merge them into posting lists. PostgreSQL softens
this with the *pending list* (`fastupdate`, on by default), which batches new
entries and folds them in during vacuum. The consequence worth knowing: an
unvacuumed GIN index with a long pending list gets slower to *read*, because
every scan must also walk the unmerged entries.
