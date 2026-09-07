-- For each order of a few heavy accounts: which number it is in that
-- customer's history, and the running total spent up to and including it.
--
-- Each output row triggers two correlated aggregates, and each of those
-- re-reads that customer's order history from the beginning. A customer with
-- 700 orders costs 700 * 700 index entries, twice.
SELECT o.id,
       o.customer_id,
       o.placed_at,
       o.total_amount,
       (SELECT count(*)
          FROM orders o2
         WHERE o2.customer_id = o.customer_id
           AND o2.placed_at <= o.placed_at)          AS order_seq,
       (SELECT sum(o3.total_amount)
          FROM orders o3
         WHERE o3.customer_id = o.customer_id
           AND o3.placed_at <= o.placed_at)          AS running_total
FROM orders o
WHERE o.customer_id BETWEEN 2 AND 6
ORDER BY o.customer_id, o.placed_at, o.id;
