# 01 - Unindexed foreign key

**Technique:** covering index with `INCLUDE`

## What is slow

`order_items.order_id` is a foreign key to `orders`, and PostgreSQL does not
create an index for it. Declaring a foreign key creates an index on the
*referenced* side (it needs one to be unique) and nothing at all on the
referencing side. Nobody tells you.

So "give me the lines of these orders" has no access path. The planner reads
all of `order_items`, hashes it, and throws away everything that does not belong
to the customer. The work is proportional to the size of the whole table, for a
query that wants a few dozen rows.

This is the single most common index bug in production schemas, because the
schema looks complete: there is a constraint, and constraints usually come with
indexes.

## The fix

```sql
CREATE INDEX order_items_order_covering_idx
    ON order_items (order_id) INCLUDE (quantity, line_total);
```

`INCLUDE` puts `quantity` and `line_total` in the index leaf pages as non-key
columns. They are not part of the B-tree ordering and cannot be searched on,
but they can be *read*, which is enough to answer the aggregate without a single
heap access.

The plain `CREATE INDEX ... (order_id)` alone already removes the sequential
scan. `INCLUDE` is what turns the remaining Index Scan into an Index Only Scan.

## What to look for in the plan

Before:

```
Seq Scan on order_items   (rows=183333 ... Rows Removed by Filter)
```

After:

```
Index Only Scan using order_items_order_covering_idx on order_items
  (rows=77 heap_fetches=0)
```

`heap_fetches=0` is the interesting number. It is zero only because
`03_statistics.sql` ran `VACUUM` and set the visibility map: an Index Only Scan
on a table with stale visibility information still has to visit the heap to
check whether each row is visible, and quietly stops being "only".

## Cost of the fix

Indexes are not free. This one adds roughly its own size to every insert and
update of `order_items`, and `INCLUDE` columns make the index wider than the
minimum. The size is reported in `BENCHMARK.md`. The trade is almost always
worth it for a foreign key that is actually joined on -- which is to say, for a
foreign key.
