-- Identical query. The index created by setup.sql matches the ordering exactly,
-- so the sort disappears entirely and the scan stops after fifty rows.
SELECT id, customer_id, status, placed_at, total_amount
FROM orders
ORDER BY total_amount DESC, id ASC
LIMIT 50;
