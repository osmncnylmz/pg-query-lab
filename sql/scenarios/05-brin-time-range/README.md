# 05 - Time range on an append-only log

**Technique:** BRIN index

`events` is the biggest table in the lab and has no index but its primary key,
which is realistic: nobody indexes a firehose by default. A query for one week
out of two years reads all 300,000 rows and throws 99.6% of them away.

```sql
CREATE INDEX events_occurred_at_brin
    ON events USING brin (occurred_at) WITH (pages_per_range = 32);
```

A B-tree would also fix this query. BRIN is interesting because of what it
costs: instead of one index entry per row it keeps one summary per *range of
table pages*, and the summary is just the smallest and largest value found in
that range. The size difference is measured rather than claimed; see the table
in `BENCHMARK.md` for this scenario.

## What BRIN needs from the table

BRIN only works when the physical order of the table correlates with the
indexed column. An append-only log is the canonical case: rows are written in
time order and never move, so page range 40 contains a contiguous slice of
time. The seed enforces this deliberately -- `events.occurred_at` increases
monotonically with the generated row number -- and a trigger on the table
rejects `UPDATE` and `DELETE` so it stays that way.

Build one on a column whose values are scattered across the heap and every
range's min/max spans the whole domain, every range matches every query, and you
have an index that costs writes and returns a sequential scan.

## What to look for in the plan

Before:

```
Seq Scan on events  (rows=300000, Rows Removed by Filter=299178)
```

After:

```
Bitmap Heap Scan on events  (rows=822, Rows Removed by Recheck=...)
  -> Bitmap Index Scan using events_occurred_at_brin
```

The `Recheck` line is expected. BRIN is a *lossy* index: it identifies
candidate page ranges, and every row on those pages is then re-tested against
the predicate, so the heap scan removes a few hundred rows that happened to
share a page range with real matches. `pages_per_range` is the dial that trades
index size against how many of those extra rows you read.

## Related

Scenario 12, the partial index, is the other small-index technique in here.
