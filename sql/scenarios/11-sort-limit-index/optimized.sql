-- Same query again. setup.sql's index stores exactly this ordering, so the
-- sort node disappears and the scan stops after fifty rows.
SELECT id, customer_id, status, placed_at, total_amount
FROM orders
ORDER BY total_amount DESC, id ASC
LIMIT 50;
