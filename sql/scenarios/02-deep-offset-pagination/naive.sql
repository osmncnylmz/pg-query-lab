-- One page of an order list, 25 rows, deep into the sequence.
--
-- The index below can produce the rows in exactly this order, so there is no
-- sort. It still has to walk :deep_offset index entries and fetch that many
-- heap tuples before it reaches the ones being asked for, and then throw all of
-- them away.
SELECT id, customer_id, status, placed_at, total_amount
FROM orders
ORDER BY placed_at DESC, id DESC
OFFSET :deep_offset
LIMIT 25;
