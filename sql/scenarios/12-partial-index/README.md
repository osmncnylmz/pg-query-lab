# 12 - Selective predicate on a skewed column

**Technique:** partial index

## What is slow

The fulfilment queue asks for orders in one status. That status is 2% of the
table and the interesting ones are recent, so the answer is a few hundred rows
out of a hundred thousand. Without an index the query reads all of them and then
sorts what survives.

## The fix

```sql
CREATE INDEX orders_pending_idx
    ON orders (placed_at DESC, id DESC)
    WHERE status = 'pending';
```

The `WHERE` clause makes this a *partial* index: it contains entries only for
rows that satisfy it. The other 98% of the table is simply not in it.

Two consequences, and the second is the one that matters in production:

* **Size.** The index is roughly 2% of what a full index on the same columns
  would be. Both are measured for this dataset and reported in `BENCHMARK.md`.
* **Write cost.** An index has to be maintained by every write that touches it.
  A partial index is only maintained for rows that match its predicate -- and
  crucially, a row that *leaves* the predicate is removed from it. Orders move
  from `pending` to `paid` and stop costing anything to maintain. The index does
  not grow with the table, it grows with the size of the backlog, which is
  bounded by how fast the business ships.

## `status` is not in the key

Every row in this index has `status = 'pending'`; storing the value would be
storing a constant. The key columns are the ones the query orders by, so the
index is *able* to return the rows in order -- see the next section for what the
planner actually does with that.

## When the planner will not use it

The index's predicate must be *provably implied* by the query's `WHERE` clause.
PostgreSQL's proof machinery is deliberately conservative:

```sql
WHERE status = 'pending'                    -- matches
WHERE status = 'pending' AND total > 100    -- matches (the extra term narrows)
WHERE status IN ('pending', 'paid')         -- does NOT match
WHERE status = $1                           -- does NOT match: $1 is not known
                                            -- to be 'pending' at plan time
```

That last case is the one that catches people: the query works in psql with a
literal and stops using the index the moment the application parameterises it.

## What to look for in the plan

Before:

```
Sort  (Sort Method: quicksort)
  -> Seq Scan on orders  (rows=284, Rows Removed by Filter=99716)
```

After:

```
Sort  (Sort Method: quicksort)
  -> Bitmap Heap Scan on orders  (rows=284)
    -> Bitmap Index Scan using orders_pending_idx  (rows=284)
```

Two things are worth noticing, and the second is the more interesting one.

The scan now emits 284 rows instead of reading 100,000 and discarding 99,716.
That is the whole win, and it is visible in the `buffers` column of
`BENCHMARK.md` as well as in the time.

But the `Sort` is still there. The index *could* have delivered the rows in
order -- its key is exactly the `ORDER BY` -- and the planner chose not to use
it that way. A plain index scan walks the index and follows each entry to a
random heap page; a bitmap scan collects all the matching entries first, sorts
them by page, and then reads the heap in physical order. For a few hundred rows
scattered across a table, reading the heap sequentially and sorting the result
afterwards is cheaper than several hundred random accesses, and the planner
costs it that way.

This is worth internalising: "the index provides the ordering" is a possibility
the planner weighs, not a promise it makes. Scenario 11 is the case where it
takes the offer -- because a `LIMIT 50` means it can stop early, and stopping
early is something a bitmap scan cannot do.

## Related

Scenario 05 is the other way to make an index much smaller than the table it
covers: BRIN summarises page ranges instead of refusing to store rows.
