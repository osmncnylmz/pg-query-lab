-- One indexable query per arm, concatenated.
--
-- UNION ALL rather than UNION: UNION would sort and deduplicate the whole
-- result, which can cost more than the scan just eliminated. The second arm
-- instead excludes what the first arm already returned, so there is nothing to
-- deduplicate. Note that the exclusion is the negation of the WHOLE first arm,
-- not just of its status test -- getting that wrong is how this rewrite starts
-- returning duplicate rows.
--
-- The join to customers is dropped from the first arm because it was a no-op:
-- orders.customer_id is a NOT NULL foreign key to customers.id, so the inner
-- join matches exactly one row and cannot change the result.
SELECT o.id, o.customer_id, o.status, o.placed_at, o.total_amount
FROM orders o
WHERE o.status = 'refunded'
  AND o.placed_at >= TIMESTAMPTZ '2025-10-01 00:00:00+00'

UNION ALL

SELECT o.id, o.customer_id, o.status, o.placed_at, o.total_amount
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.email = 'customer137@example.com'
  AND NOT (o.status = 'refunded'
           AND o.placed_at >= TIMESTAMPTZ '2025-10-01 00:00:00+00')

ORDER BY id;
