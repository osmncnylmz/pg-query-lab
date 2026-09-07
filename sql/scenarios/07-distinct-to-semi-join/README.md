# 07 - DISTINCT hiding a fan-out join

**Technique:** `EXISTS` semi-join

## What is slow

`SELECT DISTINCT` is very often a repair, applied after someone noticed
duplicate rows in the output. The duplicates come from a join to a table with
more than one matching child row, and the join is there only to test for
existence.

The event log has around a hundred rows per platinum customer. The naive query
therefore builds roughly seventy thousand wide customer rows -- the same few
hundred customers, over and over -- and then deduplicates them back down to a
few hundred. Every one of those rows is materialised, carried through the plan,
and hashed on seven columns including three text values.

The dedupe is not even the expensive part. Producing the rows is.

## The fix

```sql
WHERE EXISTS (SELECT 1 FROM events e WHERE e.customer_id = c.id)
```

PostgreSQL recognises this as a *semi-join*: a join that emits each left row at
most once and stops scanning the right side at the first match. One index probe
per customer, one output row per customer, no deduplication step.

`IN (SELECT ...)` usually plans identically. `EXISTS` is preferred here because
its NULL semantics are unsurprising -- `NOT IN` against a subquery that can
produce a NULL returns no rows at all, which is one of the great silent
data-loss bugs in SQL, and `NOT EXISTS` has no such trap.

## When DISTINCT is the right tool

When you actually want the distinct values of something, rather than the rows of
one table filtered by the existence of another. The tell for this antipattern is
that every column in the `SELECT DISTINCT` list comes from the same table, and
the other table appears nowhere in the output.

## What to look for in the plan

Before:

```
HashAggregate  (Group Key: c.id, c.email, ...)
  -> Nested Loop  (rows=70000)
    -> Bitmap Heap Scan on customers
    -> Index Only Scan on events  (rows=100 loops=650)
```

After:

```
Nested Loop Semi Join  (rows=650)
  -> Bitmap Heap Scan on customers
  -> Index Only Scan on events  (rows=1 loops=650)
```

Two things to read: the join node says `Semi`, and the inner scan now reports
`rows=1` per loop instead of a hundred. That `rows=1` is the semi-join stopping
early, and it is the entire optimization.
