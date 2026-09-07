-- What the equivalent B-tree would have cost, measured rather than asserted.
CREATE INDEX events_occurred_at_btree_tmp ON events (occurred_at);

SELECT pg_size_pretty(pg_relation_size('events_occurred_at_brin'))       AS brin_size,
       pg_size_pretty(pg_relation_size('events_occurred_at_btree_tmp'))  AS btree_size,
       round(pg_relation_size('events_occurred_at_btree_tmp')::numeric
             / pg_relation_size('events_occurred_at_brin'), 1)           AS btree_times_larger,
       pg_size_pretty(pg_relation_size('events'))                        AS table_size;

DROP INDEX events_occurred_at_btree_tmp;
