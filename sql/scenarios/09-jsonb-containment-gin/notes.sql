-- Both GIN opclasses, measured side by side.
CREATE INDEX events_payload_gin_default_tmp ON events USING gin (payload);

SELECT pg_size_pretty(pg_relation_size('events_payload_gin'))              AS path_ops_size,
       pg_size_pretty(pg_relation_size('events_payload_gin_default_tmp'))  AS default_ops_size,
       round(pg_relation_size('events_payload_gin_default_tmp')::numeric
             / pg_relation_size('events_payload_gin'), 1)                  AS default_times_larger;

DROP INDEX events_payload_gin_default_tmp;
