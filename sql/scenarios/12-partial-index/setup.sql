-- Index only the rows the query is ever interested in.
--
-- status is not a key column: every row in this index has status = 'pending' by
-- construction, so storing it would waste space per entry and buy nothing. The
-- key columns are the ordering the query asks for, so the index *can* deliver
-- the rows already sorted -- although, as README.md explains, at this row count
-- the planner prefers a bitmap scan and a small sort instead.
--
-- The WHERE clause of the index has to be provably implied by the WHERE clause
-- of the query for the planner to use it. "status = 'pending'" matches
-- literally. Something like "status IN ('pending', 'paid')" would not.
CREATE INDEX orders_pending_idx
    ON orders (placed_at DESC, id DESC)
    WHERE status = 'pending';

ANALYZE orders;
