-- Two values the measured queries need but should not have to compute:
--
--   deep_offset       how far into the list to page. Expressed as a fraction of
--                     the table so the scenario means the same thing at every
--                     --scale, rather than falling off the end of a small one.
--   cursor_placed_at  the sort key of the last row of the previous page.
--   cursor_id
--
-- A real application already has the cursor: it is the last row it just
-- rendered, handed back in the "next" link. Materialising it here needs the
-- very OFFSET this scenario argues against, which is exactly why it runs once,
-- outside the measured region.
SELECT deep_offset,
       placed_at AS cursor_placed_at,
       id        AS cursor_id
FROM (
    SELECT o.placed_at,
           o.id,
           row_number() OVER (ORDER BY o.placed_at DESC, o.id DESC)   AS rn,
           (SELECT greatest(2, (count(*) * 2 / 5)::int) FROM orders)  AS deep_offset
    FROM orders o
) ranked
WHERE rn = deep_offset;
