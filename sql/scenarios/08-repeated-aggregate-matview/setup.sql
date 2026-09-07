-- A materialized view is a table that remembers the query that filled it. It
-- does not update itself; it is a cache with an explicit refresh, which is the
-- honest trade: stale data in exchange for a two-order-of-magnitude read.
CREATE MATERIALIZED VIEW daily_revenue AS
SELECT date_trunc('day', o.placed_at) AS day,
       count(DISTINCT o.id)           AS orders,
       sum(oi.line_total)             AS revenue
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status IN ('paid', 'shipped', 'delivered')
GROUP BY 1;

-- The unique index is not an optimization, it is a prerequisite:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY refuses to run without one, and a
-- non-concurrent refresh takes an ACCESS EXCLUSIVE lock -- meaning the
-- dashboard this view exists to speed up blocks completely while it rebuilds.
CREATE UNIQUE INDEX daily_revenue_day_uq ON daily_revenue (day);

ANALYZE daily_revenue;
