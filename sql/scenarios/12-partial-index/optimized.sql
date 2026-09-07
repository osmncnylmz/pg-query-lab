-- Identical query. The partial index created by setup.sql is what changed.
SELECT id, customer_id, placed_at, total_amount
FROM orders
WHERE status = 'pending'
  AND placed_at >= TIMESTAMPTZ '2025-12-18 00:00:00+00'
ORDER BY placed_at DESC, id DESC;
