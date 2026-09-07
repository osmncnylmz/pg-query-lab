-- The same question asked as a question.
--
-- EXISTS is a semi-join: the executor stops probing as soon as it finds one
-- matching event, and the customer row is emitted once. There is nothing to
-- deduplicate because nothing was duplicated.
SELECT c.id,
       c.email,
       c.full_name,
       c.country,
       c.loyalty_tier,
       c.is_active,
       c.created_at
FROM customers c
WHERE c.loyalty_tier = 'platinum'
  AND EXISTS (SELECT 1 FROM events e WHERE e.customer_id = c.id)
ORDER BY c.id;
