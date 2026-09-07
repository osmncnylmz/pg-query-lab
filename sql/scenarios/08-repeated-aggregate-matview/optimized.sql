-- The same answer, read from a materialized view that already contains it.
SELECT day, orders, revenue
FROM daily_revenue
ORDER BY day;
