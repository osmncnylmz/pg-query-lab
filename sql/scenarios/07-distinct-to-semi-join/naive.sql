-- Full customer record for every platinum member who appears in the event log.
--
-- The join to events is there only to answer "does a row exist". Because it is
-- a join, it produces one output row per matching event -- around a hundred per
-- customer -- and DISTINCT then collapses them back down. Almost all of the
-- work is spent building rows that are immediately discarded.
SELECT DISTINCT
       c.id,
       c.email,
       c.full_name,
       c.country,
       c.loyalty_tier,
       c.is_active,
       c.created_at
FROM customers c
JOIN events e ON e.customer_id = c.id
WHERE c.loyalty_tier = 'platinum'
ORDER BY c.id;
