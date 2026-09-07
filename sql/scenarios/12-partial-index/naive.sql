-- The fulfilment queue: recent orders still waiting to be paid.
--
-- 'pending' is 2% of the table, and the recency filter cuts that further, but
-- with nothing to look it up in, all 100,000 rows are read and then sorted.
SELECT id, customer_id, placed_at, total_amount
FROM orders
WHERE status = 'pending'
  AND placed_at >= TIMESTAMPTZ '2025-12-18 00:00:00+00'
ORDER BY placed_at DESC, id DESC;
