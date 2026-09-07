-- Search the catalogue.
--
-- to_tsvector() is evaluated for every row: concatenate, tokenise, stem,
-- discard stop words, build a sorted lexeme vector -- 20,000 times, to return a
-- handful of products.
SELECT id, sku, name
FROM products
WHERE to_tsvector('english', name || ' ' || coalesce(description, ''))
      @@ websearch_to_tsquery('english', 'titanium thermos')
ORDER BY id;
