-- jsonb_path_ops rather than the default jsonb_ops.
--
-- jsonb_ops indexes every key and every value separately, and supports ?, ?| and
-- ?& (key existence) as well as @>. jsonb_path_ops indexes a hash of each
-- root-to-leaf path, which makes it substantially smaller and more selective for
-- @>, at the cost of the existence operators.
--
-- If the query is a containment filter -- which is the common case -- and you do
-- not need "does this key exist", jsonb_path_ops is the better default.
CREATE INDEX events_payload_gin ON events USING gin (payload jsonb_path_ops);

ANALYZE events;
