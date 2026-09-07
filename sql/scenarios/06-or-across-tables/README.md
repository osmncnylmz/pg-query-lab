# 06 - OR across two tables

**Technique:** `UNION ALL` rewrite

## What is slow

PostgreSQL can combine several indexes on the *same* table for an `OR`: it
builds one bitmap per arm and ORs the bitmaps together (`BitmapOr`). That
machinery only works within a relation.

When the arms of an `OR` sit on different tables, the condition is no longer a
restriction on either of them. It becomes a filter that can only be evaluated
after the join, so every row of both tables has to be produced first. Both
indexes exist, both are useless, and the plan says `Seq Scan`.

This scenario applies its index to both sides so the comparison is honest: the
naive query has `orders_status_idx` available and still cannot use it.

## The fix

Split the `OR` into one query per arm and concatenate:

```sql
SELECT ... FROM orders
WHERE status = 'refunded' AND placed_at >= '2025-10-01'
UNION ALL
SELECT ... FROM orders JOIN customers ...
WHERE c.email = '...'
  AND NOT (status = 'refunded' AND placed_at >= '2025-10-01')
```

Now each arm is a restriction on one table, which an index can satisfy. The join
to `customers` is gone from the first arm because it was a no-op there:
`orders.customer_id` is a `NOT NULL` foreign key, so the inner join matched
exactly one row and could not change the result.

What the rewrite has to get right:

* `UNION ALL`, not `UNION`. `UNION` deduplicates, which means sorting the entire
  result -- often more expensive than the scan you just eliminated.
* The arms have to be disjoint. An order that is both a recent refund *and*
  belongs to that customer would otherwise appear twice, where the `OR` returned
  it once. The `NOT (...)` in the second arm is what makes the rewrite correct,
  and it has to negate the entire first arm, not just the part that looks like
  the interesting one. This is exactly the sort of thing that gets left out. The
  harness compares both result sets row by row; without that predicate this
  scenario fails rather than reporting a speedup.

## What to look for in the plan

Before:

```
Seq Scan on orders  (rows=100000)
Hash               <- customers, all 20000 of them
Filter: ((o.status = 'refunded') OR (c.email = '...'))
```

After:

```
Append
  -> Bitmap Heap Scan on orders
       -> Bitmap Index Scan using orders_status_idx
  -> Nested Loop
       -> Index Scan using customers_email_uq
```

## Related

The same rewrite is worth trying for `OR` on two columns of one table when the
planner declines to build a `BitmapOr` -- for example when one arm is an
expression the index does not match.
