-- The fifty largest orders.
--
-- Note the mixed sort directions: descending by amount, ascending by id. That
-- is a deliberate tiebreaker choice -- oldest order first among equal amounts --
-- and it is what makes this scenario about index *direction* rather than just
-- index presence.
SELECT id, customer_id, status, placed_at, total_amount
FROM orders
ORDER BY total_amount DESC, id ASC
LIMIT 50;
