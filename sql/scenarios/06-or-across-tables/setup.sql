-- Applied to BOTH queries. Without it the naive query would be slow because
-- orders.status is unindexed, and the scenario would be demonstrating scenario
-- 01 again instead of the cost of OR.
CREATE INDEX orders_status_idx ON orders (status);

ANALYZE orders;
