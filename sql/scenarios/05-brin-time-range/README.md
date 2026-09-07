# 05 - Time range on an append-only log

**Technique:** BRIN index

## What is slow

`events` is the biggest table in the lab and has no index but its primary key,
which is realistic: nobody indexes a firehose by default. A query for one week
out of two years therefore reads all 300,000 rows and discards 99.6% of them.

## The fix

```sql
CREATE INDEX events_occurred_at_brin
    ON events USING brin (occurred_at) WITH (pages_per_range = 32);
```

A B-tree would also fix this query. BRIN is interesting because of what it
costs: instead of one index entry per row, it stores one summary -- the minimum
and maximum value -- per *range of table pages*. The size difference is
measured, not claimed; see the table in `BENCHMARK.md` for this scenario.

BRIN only works when the physical order of the table correlates with the
indexed column. An append-only log is the canonical case: rows are written in
time order and never move, so page range 40 contains a contiguous slice of
time. The seed enforces this deliberately -- `events.occurred_at` increases
monotonically with the generated row number -- and a trigger on the table
rejects `UPDATE` and `DELETE` so it stays that way.

If you build a BRIN index on a column whose values are scattered across the
heap, every range's min/max will span the whole domain, every range will match
every query, and you will have built an index that costs writes and returns a
sequential scan.

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

The `Recheck` line is not a defect. BRIN is a *lossy* index: it identifies
candidate page ranges, and every row on those pages is then re-tested against
the predicate. Expect the heap scan to remove a few hundred rows that shared a
page range with real matches. `pages_per_range` is the dial that trades index
size against how many of those extra rows you read.

## Related

Scenario 12 covers the other way to make an index smaller than the table
suggests: a partial index that simply refuses to store most rows.
