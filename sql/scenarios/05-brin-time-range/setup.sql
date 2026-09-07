-- BRIN stores one summary tuple per range of table pages -- here the minimum
-- and maximum occurred_at in every 32 pages. A scan consults the summaries,
-- discards the ranges that cannot contain a match, and reads only the survivors.
--
-- That works precisely because events is append-only, so its physical order
-- follows occurred_at. On a table whose rows are updated and moved around, the
-- ranges overlap, every summary matches, and BRIN degenerates into a sequential
-- scan with extra steps.
--
-- pages_per_range = 32 rather than the default 128: smaller ranges mean a
-- larger (still tiny) index and a finer filter. Worth tuning against the size
-- of the windows you actually query.
CREATE INDEX events_occurred_at_brin
    ON events USING brin (occurred_at) WITH (pages_per_range = 32);

ANALYZE events;
