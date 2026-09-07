# 03 - Correlated subquery per row

**Technique:** window function

## What is slow

The naive query looks linear. It is not. Each of its output rows evaluates two
correlated subqueries, and each subquery re-reads that customer's order history
from the start. For a customer with *n* orders the cost is proportional to
*n squared*, and the seeded data deliberately contains a few accounts with
several hundred orders each.

This shape is easy to write and almost impossible to spot in review, because
nothing about it looks like a loop. `EXPLAIN ANALYZE` gives it away: the
`SubPlan` node reports `loops=` equal to the number of output rows.

This scenario adds no index and changes no schema. `orders` already has
`(customer_id, placed_at DESC)`, so the naive query's subqueries are themselves
index-driven; they are about as fast as a correlated subquery gets. The
quadratic term is not an indexing problem and no index will remove it.

## The fix

A window function computes both aggregates in one ordered pass over each
partition:

```sql
count(*)            OVER (PARTITION BY customer_id ORDER BY placed_at)
sum(o.total_amount) OVER (PARTITION BY customer_id ORDER BY placed_at)
```

Both aggregates share the same `WINDOW w` definition, so PostgreSQL sorts once
and evaluates both in a single `WindowAgg`.

## The subtlety that breaks the rewrite

`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` and
`RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` are not the same frame.
`ROWS` stops at the physical current row. `RANGE` includes every *peer* -- every
row whose `ORDER BY` value ties with the current one.

`WHERE o2.placed_at <= o.placed_at` includes ties, so `RANGE` is the correct
translation. `RANGE` is also the default, which is why the optimized query does
not spell out a frame at all. Had it said `ROWS`, the two queries would return
different numbers for any customer with two orders at the same instant, and the
harness would fail the run rather than report a speedup.

## What to look for in the plan

Before:

```
Bitmap Heap Scan on orders  (rows=2161)
  SubPlan 1: Aggregate  (loops=2161)
    -> Index Only Scan using orders_customer_placed_idx  (rows=237 loops=2161)
  SubPlan 2: Aggregate  (loops=2161)
    -> Bitmap Heap Scan on orders  (rows=237 loops=2161)
```

After:

```
WindowAgg
  -> Sort  (one pass over 2161 rows)
    -> Bitmap Heap Scan on orders  (rows=2161)
```

Any `SubPlan` with a large `loops=` is worth a second look. It is the plan's way
of saying "this ran once per row". Multiply `loops` by the rows each iteration
produced (2161 x 237, twice) and you have the real amount of work.

## Asserting on it

`EXPLAIN (FORMAT JSON)` has no node whose type is `SubPlan`. The subquery turns
up as a child plan whose `Parent Relationship` is `SubPlan`, and that is what
this scenario's `meta.json` matches on.
