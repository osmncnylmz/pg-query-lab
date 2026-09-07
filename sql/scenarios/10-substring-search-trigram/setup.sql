-- pg_trgm decomposes text into overlapping three-character sequences and
-- indexes those. "backpack" becomes "  b", " ba", "bac", "ack", "ckp", ... and a
-- search for a substring is answered by looking up the trigrams it contains and
-- intersecting the posting lists.
--
-- Because trigrams are position-independent, this works for a pattern anywhere
-- in the string, and it is case-insensitive by construction -- pg_trgm
-- lower-cases before extracting -- so gin_trgm_ops supports ILIKE directly.
--
-- gin_trgm_ops (inverted, better for search) rather than gist_trgm_ops
-- (smaller, supports nearest-neighbour ordering by similarity).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX reviews_body_trgm_idx ON reviews USING gin (body gin_trgm_ops);

ANALYZE reviews;
