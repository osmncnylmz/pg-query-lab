-- Applied to BOTH queries. Neither form can be fast without a way to find a
-- customer's events, and this scenario is about the shape of the query, not
-- about whether the index exists.
CREATE INDEX events_customer_id_idx ON events (customer_id);
CREATE INDEX customers_loyalty_tier_idx ON customers (loyalty_tier);

ANALYZE events;
ANALYZE customers;
