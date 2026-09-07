-- The column order AND the direction of each column both have to match the
-- ORDER BY.
--
-- An index on (total_amount, id) can serve "ORDER BY total_amount DESC, id DESC"
-- by being read backwards, and "ORDER BY total_amount ASC, id ASC" by being read
-- forwards. It cannot serve "total_amount DESC, id ASC", because no single
-- direction of traversal produces that sequence. Only an index that stores the
-- mixed directions can.
--
-- This is the detail that turns "I added the index and it is still sorting" into
-- an afternoon.
CREATE INDEX orders_total_amount_idx ON orders (total_amount DESC, id ASC);

ANALYZE orders;
