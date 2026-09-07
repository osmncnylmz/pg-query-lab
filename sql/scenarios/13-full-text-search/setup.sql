-- products.search_vector already exists: it is declared in 01_schema.sql as
--
--   search_vector tsvector GENERATED ALWAYS AS (
--       to_tsvector('english', name || ' ' || coalesce(description, ''))
--   ) STORED
--
-- so the vector is built once per write instead of once per row per query, and
-- can never drift from the columns it summarises. All that is missing is a way
-- to look it up.
CREATE INDEX products_search_gin ON products USING gin (search_vector);

ANALYZE products;
