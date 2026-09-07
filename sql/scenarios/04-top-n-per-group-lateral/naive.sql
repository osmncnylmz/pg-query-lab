-- The three most recent orders of each customer in a small cohort.
--
-- row_number() is computed over every order in the table, because the window
-- has to be complete before the rn <= 3 filter can be applied. All 100,000
-- orders are sorted to answer a question about a few hundred customers.
SELECT c.id AS customer_id,
       c.email,
       r.id AS order_id,
       r.placed_at,
       r.total_amount,
       r.rn
FROM customers c
JOIN (
    SELECT o.id,
           o.customer_id,
           o.placed_at,
           o.total_amount,
           row_number() OVER (PARTITION BY o.customer_id
                              ORDER BY o.placed_at DESC, o.id DESC) AS rn
    FROM orders o
) r ON r.customer_id = c.id AND r.rn <= 3
WHERE c.id BETWEEN :cohort_from AND :cohort_to
ORDER BY c.id, r.rn;
