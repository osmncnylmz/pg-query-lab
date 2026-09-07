# 04 - Top-N per group over the whole table

**Technique:** `LATERAL` join

## What is slow

"The three most recent orders for each of these customers" is usually written
with a window function, because that is the tool everybody reaches for. But a
window function cannot be filtered until it has been computed, and it can only
be computed once the whole partitioned set has been sorted. `rn <= 3` lives in
the outer query, so PostgreSQL sorts and ranks all 100,000 orders in order to
return roughly 800 rows.

The join to `customers` does not help. `WHERE c.id BETWEEN ...` constrains `c`,
and the only thing connecting it to the ranked subquery is a join condition,
which cannot be pushed through a window function.

This is not an "N+1 in SQL" in the ORM sense, it is the opposite mistake: one
enormous query where several small index lookups would have done. Both mistakes
have the same fix.

## The fix

```sql
CROSS JOIN LATERAL (
    SELECT ... FROM orders o
    WHERE o.customer_id = c.id
    ORDER BY o.placed_at DESC, o.id DESC
    LIMIT 3
) r
```

`LATERAL` is what allows a subquery in the `FROM` clause to see columns from
tables to its left. Each customer row drives one execution of the subquery, and
because `orders` already has an index on `(customer_id, placed_at DESC)`, that
execution is an index range scan that stops after three rows.

No new index. No schema change. The existing index simply becomes usable once
the query stops asking for a global ranking.

## What to look for in the plan

Before:

```
WindowAgg
  -> Sort  (rows=100000, quicksort, several MB)
    -> Seq Scan on orders  (rows=100000)
```

After:

```
Nested Loop
  -> Index Scan on customers
  -> Limit  (loops=401)
    -> Index Scan using orders_customer_placed_idx  (rows=2 loops=401)
```

`loops=401` with two rows each is the signature of the fix working: a few
hundred tiny scans instead of one huge sort.

## When the naive form is right

If you genuinely need the ranking for *every* group -- a full leaderboard, a
report over the whole table -- the window function is the better plan, and
LATERAL becomes the slow one, because it would do one index scan per group over
every group. The rule of thumb: LATERAL wins when the outer side is small
relative to the table being ranked.
