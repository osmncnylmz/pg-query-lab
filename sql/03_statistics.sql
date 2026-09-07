-- ---------------------------------------------------------------------------
-- pg-query-lab :: statistics
-- ---------------------------------------------------------------------------
-- Run after 02_seed.sql.
--
-- Without this step the planner is working from hard-coded defaults, and every
-- "before/after" number in this repository would be measuring the absence of
-- statistics rather than the presence of an index. VACUUM additionally sets the
-- visibility map, without which an Index Only Scan still has to visit the heap
-- for every row and stops being "only".
--
-- These statements cannot run inside a transaction block, so they live in their
-- own file: the TypeScript runner sends them one at a time, and psql does the
-- same because there is one statement per line.
--
--   psql -f sql/03_statistics.sql
-- ---------------------------------------------------------------------------

VACUUM (ANALYZE) customers;
VACUUM (ANALYZE) addresses;
VACUUM (ANALYZE) categories;
VACUUM (ANALYZE) products;
VACUUM (ANALYZE) product_variants;
VACUUM (ANALYZE) inventory_movements;
VACUUM (ANALYZE) orders;
VACUUM (ANALYZE) order_items;
VACUUM (ANALYZE) payments;
VACUUM (ANALYZE) reviews;
VACUUM (ANALYZE) events;
