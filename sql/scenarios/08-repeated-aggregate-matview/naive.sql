-- Revenue per day. The kind of query behind the first chart on every internal
-- dashboard, run again on every page load, by every user, all day.
SELECT date_trunc('day', o.placed_at) AS day,
       count(DISTINCT o.id)           AS orders,
       sum(oi.line_total)             AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status IN ('paid', 'shipped', 'delivered')
GROUP BY 1
ORDER BY 1;
