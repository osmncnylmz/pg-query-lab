-- Both sides get this index. The scenario is about the pagination technique,
-- not about the index: with no index at all the naive query would also be
-- paying for a full sort, and the comparison would be measuring two things.
CREATE INDEX orders_placed_at_id_idx ON orders (placed_at DESC, id DESC);

ANALYZE orders;
