-- The same page, addressed by where the last page ended instead of by how many
-- rows precede it.
--
-- The row-wise comparison (placed_at, id) < (cursor, cursor) is not the same as
-- placed_at <= cursor AND id < cursor: it is a single lexicographic comparison,
-- and PostgreSQL can turn it directly into a starting position in a
-- two-column index. The scan begins at the answer.
SELECT id, customer_id, status, placed_at, total_amount
FROM orders
WHERE (placed_at, id) < (:cursor_placed_at, :cursor_id)
ORDER BY placed_at DESC, id DESC
LIMIT 25;
