-- Both sides get this index, which is the only way the comparison is honest.
-- Without it the naive query is slow because orders.status is unindexed, and
-- the scenario ends up demonstrating scenario 01 all over again.
CREATE INDEX orders_status_idx ON orders (status);

ANALYZE orders;
