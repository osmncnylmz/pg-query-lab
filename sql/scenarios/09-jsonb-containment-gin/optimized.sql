-- Same query as naive.sql; setup.sql added the GIN index underneath it.
SELECT event_type, count(*) AS events
FROM events
WHERE payload @> '{"plan": "enterprise", "source": "ios"}'::jsonb
GROUP BY event_type
ORDER BY event_type;
