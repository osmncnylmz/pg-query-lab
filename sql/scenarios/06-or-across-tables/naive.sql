-- Every refunded order from the last quarter, plus every order at all from one
-- specific customer.
--
-- Both arms of the OR are individually indexable: orders.status has an index
-- (setup.sql), customers.email has a unique one. Neither can be used, because a
-- row qualifies if EITHER is true, and the two live on different tables. The
-- planner's only option is to join everything and filter afterwards.
SELECT o.id, o.customer_id, o.status, o.placed_at, o.total_amount
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE (o.status = 'refunded' AND o.placed_at >= TIMESTAMPTZ '2025-10-01 00:00:00+00')
   OR c.email = 'customer137@example.com'
ORDER BY o.id;
