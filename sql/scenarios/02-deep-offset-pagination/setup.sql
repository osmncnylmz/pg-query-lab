-- Applied to BOTH queries. The point of this scenario is the pagination
-- technique, not the index: with no index at all the naive query would also be
-- paying for a sort of the whole table, and the comparison would be measuring
-- two things at once.
CREATE INDEX orders_placed_at_id_idx ON orders (placed_at DESC, id DESC);

ANALYZE orders;
