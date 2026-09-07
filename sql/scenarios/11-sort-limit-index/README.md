# 11 - Sort and limit over a large table

**Technique:** an index that provides the ordering

## What is slow

`ORDER BY ... LIMIT 50` over an unindexed ordering has to look at every row.
PostgreSQL is clever about it: a bounded "top-N heapsort" keeps only 50 rows in
memory instead of sorting all 100,000. It still reads the whole table though,
and the sort sits on the critical path before the first row can be returned.

## The fix

An index whose leading columns are the sort key. Then the ordering is a
property of the scan: the executor walks the index from one end, and `LIMIT 50`
stops it after fifty entries.

```sql
CREATE INDEX orders_total_amount_idx ON orders (total_amount DESC, id ASC);
```

## Why the directions are spelled out

A B-tree can be read forwards or backwards, so a single index serves two
orderings: its own, and its exact reverse. An index on `(total_amount, id)`
therefore covers

```
ORDER BY total_amount ASC,  id ASC     -- forwards
ORDER BY total_amount DESC, id DESC    -- backwards
```

and nothing else. The query here asks for `total_amount DESC, id ASC` -- a
*mixed* ordering, which is neither the index order nor its reverse. There is no
traversal of that index that produces it, so the planner sorts.

`CREATE INDEX ... (total_amount DESC, id ASC)` stores the mixed order directly,
and the sort disappears.

Mixed-direction sort keys turn up constantly. Any "biggest first, oldest first
among ties" list is one, and so is any "newest first, alphabetical among ties".

## `NULLS FIRST` / `NULLS LAST`

The same trap applies one level down. `DESC` implies `NULLS FIRST` and `ASC`
implies `NULLS LAST`; if the query overrides that, the index has to as well.
`total_amount` here is a generated column over `NOT NULL` inputs, so it is
`NOT NULL` too and the question never comes up. On a nullable column it is the
next thing to check when the sort refuses to go away.

## What to look for in the plan

Before:

```
Limit
  -> Sort  (Sort Method: top-N heapsort)
    -> Seq Scan on orders  (rows=100000)
```

After:

```
Limit
  -> Index Scan using orders_total_amount_idx on orders  (rows=50)
```

No `Sort` node at all, and the scan reports 50 rows rather than 100,000. If you
add the index and the `Sort` is still there, the ordering does not match --
check the directions before checking anything else.
