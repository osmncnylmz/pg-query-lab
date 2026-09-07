-- Byte-for-byte the same query as naive.sql, on purpose.
--
-- The query was never the problem. What changed is that order_items now has an
-- index on the foreign key column, with the two aggregated columns carried in
-- the index payload, so the whole thing is answered without touching the heap.
SELECT oi.order_id,
       sum(oi.quantity)   AS units,
       sum(oi.line_total) AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.customer_id = 137
GROUP BY oi.order_id
ORDER BY oi.order_id;
