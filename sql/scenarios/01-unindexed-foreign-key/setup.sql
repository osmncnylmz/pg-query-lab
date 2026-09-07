-- An index on the foreign key column, with the aggregated columns carried as a
-- non-key payload.
--
-- INCLUDE rather than a four-column key because quantity and line_total are
-- never searched or sorted on -- they only need to be *readable* from the
-- index. Non-key columns do not participate in the B-tree's ordering, are not
-- deduplicated, and are not subject to the index tuple size limit in the same
-- way; the index stays a single-column index that happens to carry luggage.
CREATE INDEX order_items_order_covering_idx
    ON order_items (order_id) INCLUDE (quantity, line_total);

ANALYZE order_items;
