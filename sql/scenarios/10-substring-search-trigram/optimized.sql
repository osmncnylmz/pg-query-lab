-- Identical query. The trigram index created by setup.sql is what changed.
SELECT id, product_id, customer_id, rating, title
FROM reviews
WHERE body ILIKE '%Ergonomic Canvas Backpack%'
ORDER BY id;
