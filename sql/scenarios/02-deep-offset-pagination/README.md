# 02 - Deep OFFSET pagination

**Technique:** keyset ("seek") pagination

## What is slow

`OFFSET n` is not a seek. There is no way to jump to the n-th row of an ordered
result: the server must *produce* n rows and then discard them. Page 2 is
cheap, page 1601 costs 1600 pages worth of work, and the cost grows linearly
with how deep the user scrolls.

Both queries here have a perfect index for the ordering, so neither sorts. The
only difference is that the naive one walks tens of thousands of index entries
and fetches that many heap tuples on the way to the 25 it returns. The depth is
40% of the table, so the scenario means the same thing at every `--scale`.

There is a second, quieter problem: `OFFSET`/`LIMIT` pagination is not stable.
If a row is inserted while the user is on page 3, page 4 shifts by one and a row
is silently skipped. Keyset pagination has no such window.

## The fix

Remember where the last page ended and ask for what comes after it:

```sql
WHERE (placed_at, id) < (:cursor_placed_at, :cursor_id)
ORDER BY placed_at DESC, id DESC
LIMIT 25
```

The parenthesised form matters. `(a, b) < (x, y)` is a *row constructor
comparison*, and PostgreSQL knows it can satisfy it by positioning a
two-column index and reading forward. The naive translation

```sql
WHERE placed_at < :cursor_placed_at
   OR (placed_at = :cursor_placed_at AND id < :cursor_id)
```

is logically identical but usually plans as a filter, not as a starting
position.

The tiebreaker is not optional. `placed_at` is not unique, so ordering by it
alone leaves rows with equal timestamps in an arbitrary order, and a cursor
built from it would skip or repeat them. `id` makes the sort key total.

## What to look for in the plan

The node types are the *same* on both sides -- `Limit` over an `Index Scan`.
This scenario is a reminder that "is it using the index?" is the wrong question.
Look at the row counts instead:

```
naive:      Index Scan ... (rows=40025)   <- produced, then discarded
optimized:  Index Scan ... (rows=25)
```

(at the default scale, where the offset works out to 40000)

and at `buffers` in `BENCHMARK.md`, which is the same story in pages.

## The trade

Keyset pagination cannot jump to an arbitrary page number, because page numbers
are exactly the thing it refuses to compute. It gives you "next" and "previous",
not "page 1601 of 4000". For infinite scroll and API cursors that is all anyone
needed. For a UI that genuinely requires numbered pages over a large table,
the usual answer is to restrict how deep the numbering goes.
