-- The same two numbers, computed in a single ordered pass per customer.
--
-- The default frame for a window with ORDER BY is
-- RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW, which includes every peer
-- row with the same placed_at. That is exactly what "placed_at <= o.placed_at"
-- means in the naive version, so the answers match even where timestamps tie.
-- Writing ROWS instead of RANGE here would silently change the answer.
SELECT o.id,
       o.customer_id,
       o.placed_at,
       o.total_amount,
       count(*)             OVER w AS order_seq,
       sum(o.total_amount)  OVER w AS running_total
FROM orders o
WHERE o.customer_id BETWEEN 2 AND 6
WINDOW w AS (PARTITION BY o.customer_id ORDER BY o.placed_at)
ORDER BY o.customer_id, o.placed_at, o.id;
