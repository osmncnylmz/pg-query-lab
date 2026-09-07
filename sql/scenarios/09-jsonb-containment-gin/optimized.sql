-- Identical query. The GIN index created by setup.sql is what changed.
SELECT event_type, count(*) AS events
FROM events
WHERE payload @> '{"plan": "enterprise", "source": "ios"}'::jsonb
GROUP BY event_type
ORDER BY event_type;
