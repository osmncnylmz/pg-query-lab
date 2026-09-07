-- Unchanged from naive.sql. ILIKE became indexable when the trigram index
-- appeared, without the query knowing anything about it.
SELECT id, product_id, customer_id, rating, title
FROM reviews
WHERE body ILIKE '%Ergonomic Canvas Backpack%'
ORDER BY id;
