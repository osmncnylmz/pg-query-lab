# 08 - Repeated dashboard aggregate

**Technique:** materialized view (with a refresh strategy)

## What is slow

Nothing, on any single execution. Aggregating 100,000 orders against 183,000
order lines is a perfectly reasonable amount of work for a report.

The problem is that the answer barely changes and the query runs constantly.
Every dashboard load repeats the full scan to recompute numbers for days that
were closed months ago. The fix is not a better plan, it is not running the
query.

## The fix

```sql
CREATE MATERIALIZED VIEW daily_revenue AS SELECT ...;
CREATE UNIQUE INDEX daily_revenue_day_uq ON daily_revenue (day);
```

The read becomes an ordered scan of a 700-row table.

## The unique index is not optional

`REFRESH MATERIALIZED VIEW daily_revenue` takes an `ACCESS EXCLUSIVE` lock for
the duration of the rebuild. Every reader blocks -- including the dashboard the
view exists to make fast. In a busy system that turns a caching layer into an
outage.

`REFRESH MATERIALIZED VIEW CONCURRENTLY` builds the new contents alongside the
old and swaps them in with `UPDATE`/`DELETE`/`INSERT`, so readers are never
blocked. It requires a unique index on the view, because it needs a key to
match old rows against new ones. Creating that index is the whole cost of
choosing the safe refresh.

The trade-offs of `CONCURRENTLY`: it is slower than a plain refresh, and it
cannot populate a view that has never been populated.

The test suite exercises the concurrent refresh path against this view.

## What to look for in the plan

Before:

```
GroupAggregate
  -> Sort
    -> Hash Join
      -> Seq Scan on order_items  (rows=183333)
      -> Seq Scan on orders       (rows=100000)
```

After:

```
Index Scan using daily_revenue_day_uq on daily_revenue  (rows=730)
```

The index scan rather than a sequential scan plus sort is why the unique index
earns its keep twice: it enables the concurrent refresh *and* it delivers the
`ORDER BY day` for free.

## When not to reach for this

A materialized view is a cache and inherits every problem caches have. If the
report must be correct to the second, this is the wrong tool -- consider an
incrementally maintained rollup table updated by triggers, or a summary table
written by the same transaction that writes the fact. If the report is only
ever run over closed periods, the rollup can be append-only and never refreshed
at all.
