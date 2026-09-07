# 13 - Full-text search computed per row

**Technique:** stored generated `tsvector` column plus a GIN index

## What is slow

```sql
WHERE to_tsvector('english', name || ' ' || coalesce(description, '')) @@ query
```

This is the form full-text search usually starts life in, and it has two
separate costs:

1. **The expression runs per row.** Building a `tsvector` means concatenating,
   tokenising, stemming and stop-word filtering the text. Doing that 20,000
   times to answer one search is most of the runtime.
2. **It cannot be indexed as written** -- not without an expression index that
   repeats the expression exactly, character for character.

## The fix, in two parts

**A stored generated column** moves the work to write time:

```sql
search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', name || ' ' || coalesce(description, ''))
) STORED
```

It is computed on `INSERT` and on any `UPDATE` that touches its inputs, it
cannot be written to directly, and it cannot get out of sync with `name` and
`description` -- which is the failure mode of the trigger-maintained
`tsvector` column this replaces.

Note the two-argument `to_tsvector(regconfig, text)`. The single-argument form
depends on the `default_text_search_config` GUC, which makes it `STABLE` rather
than `IMMUTABLE`, and PostgreSQL will refuse to use it in a generated column.
The same restriction applies to expression indexes, for the same reason: if the
session can change the meaning of the expression, the stored result is a lie.

**A GIN index** makes it searchable:

```sql
CREATE INDEX products_search_gin ON products USING gin (search_vector);
```

## Why the two queries return identical rows

The generated column's expression and the naive query's expression are the same
text. That is not a coincidence to be maintained by hand -- it is why the
harness compares result sets on every run. Change one and the scenario fails
rather than quietly reporting a speedup on a different question.

## `websearch_to_tsquery`

`websearch_to_tsquery` accepts the syntax users already type -- bare words are
AND-ed, `"quoted phrases"` are phrase searches, `or` and `-excluded` work -- and
never raises a syntax error on malformed input. `to_tsquery` requires `&`, `|`
and `!` operators and throws on anything else, which means user input has to be
escaped before it gets there. `plainto_tsquery` is the middle ground: it
AND-s everything and ignores operators.

## What to look for in the plan

Before:

```
Seq Scan on products  (rows=20000)
  Filter: (to_tsvector('english'::regconfig, ...) @@ '...'::tsquery)
```

After:

```
Bitmap Heap Scan on products
  -> Bitmap Index Scan using products_search_gin  (Index Cond: search_vector @@ ...)
```

## Ranking

Real search also ranks. `ts_rank_cd(search_vector, query)` is the usual next
step, and it is worth knowing that ranking is *not* indexable: it has to read
every matching row. That is fine when the index has already reduced the
candidates from 20,000 to 40, and it is a trap if the query is broad enough to
match a large fraction of the table.

## Related

Scenario 10 does substring search with trigrams on the same kind of data, and
its README compares the two approaches.
