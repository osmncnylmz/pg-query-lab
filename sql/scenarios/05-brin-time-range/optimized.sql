-- Not one character of this differs from naive.sql. The BRIN index does.
SELECT event_type,
       count(*)                            AS events,
       round(sum((payload->>'value')::numeric), 2) AS value
FROM events
WHERE occurred_at >= TIMESTAMPTZ '2025-06-01 00:00:00+00'
  AND occurred_at <  TIMESTAMPTZ '2025-06-08 00:00:00+00'
GROUP BY event_type
ORDER BY event_type;
