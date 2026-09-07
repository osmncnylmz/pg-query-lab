-- Which events came from enterprise accounts on iOS.
--
-- @> is a containment test: does the left document contain the right one. With
-- no index it is evaluated by deserialising all 300,000 payloads.
SELECT event_type, count(*) AS events
FROM events
WHERE payload @> '{"plan": "enterprise", "source": "ios"}'::jsonb
GROUP BY event_type
ORDER BY event_type;
