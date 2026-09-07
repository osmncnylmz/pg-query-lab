-- Run after 02_seed.sql:  psql -f sql/03_statistics.sql
--
-- Skip it and the planner works from hard-coded defaults, at which point every
-- before/after number in this repository is measuring the absence of statistics
-- rather than the presence of an index. VACUUM also sets the visibility map,
-- without which an Index Only Scan still visits the heap for every row and
-- stops being "only".
--
-- VACUUM cannot run inside a transaction block, which is why these live in a
-- file of their own. The TypeScript runner sends them one at a time; psql does
-- the same because there is one statement per line.

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
