-- Every line of every order placed by one customer, rolled up per order.
-- This is the shape of an "order history" page: a handful of orders, a few
-- lines each. It should touch a few dozen rows.
SELECT oi.order_id,
       sum(oi.quantity)   AS units,
       sum(oi.line_total) AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.customer_id = 137
GROUP BY oi.order_id
ORDER BY oi.order_id;
