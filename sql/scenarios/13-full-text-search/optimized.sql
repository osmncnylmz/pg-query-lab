-- The same search against the stored generated column, which holds exactly the
-- expression the naive query recomputes, and is covered by a GIN index.
SELECT id, sku, name
FROM products
WHERE search_vector @@ websearch_to_tsquery('english', 'titanium thermos')
ORDER BY id;
