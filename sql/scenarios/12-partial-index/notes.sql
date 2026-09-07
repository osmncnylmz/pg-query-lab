-- What the equivalent full index would have cost, measured.
CREATE INDEX orders_status_placed_full_tmp ON orders (status, placed_at DESC, id DESC);

SELECT pg_size_pretty(pg_relation_size('orders_pending_idx'))            AS partial_index,
       pg_size_pretty(pg_relation_size('orders_status_placed_full_tmp')) AS full_index,
       round(pg_relation_size('orders_status_placed_full_tmp')::numeric
             / pg_relation_size('orders_pending_idx'), 1)                AS full_times_larger,
       (SELECT count(*) FROM orders WHERE status = 'pending')            AS indexed_rows,
       (SELECT count(*) FROM orders)                                     AS table_rows;

DROP INDEX orders_status_placed_full_tmp;
