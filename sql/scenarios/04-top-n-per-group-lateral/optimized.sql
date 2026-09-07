-- The same three rows per customer, fetched one customer at a time.
--
-- LATERAL lets a subquery in the FROM clause reference the row to its left, so
-- each iteration is an ordered index range scan that stops after three rows.
-- The work is proportional to the number of customers asked about, not to the
-- size of the orders table.
SELECT c.id AS customer_id,
       c.email,
       r.id AS order_id,
       r.placed_at,
       r.total_amount,
       row_number() OVER (PARTITION BY c.id
                          ORDER BY r.placed_at DESC, r.id DESC) AS rn
FROM customers c
CROSS JOIN LATERAL (
    SELECT o.id, o.placed_at, o.total_amount
    FROM orders o
    WHERE o.customer_id = c.id
    ORDER BY o.placed_at DESC, o.id DESC
    LIMIT 3
) r
WHERE c.id BETWEEN :cohort_from AND :cohort_to
ORDER BY c.id, rn;
