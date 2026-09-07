-- Find reviews mentioning a particular product line.
--
-- A leading wildcard removes any possibility of a B-tree range scan: there is
-- no prefix to seek to. Case-insensitivity would rule out a plain B-tree even
-- without it.
SELECT id, product_id, customer_id, rating, title
FROM reviews
WHERE body ILIKE '%Ergonomic Canvas Backpack%'
ORDER BY id;
