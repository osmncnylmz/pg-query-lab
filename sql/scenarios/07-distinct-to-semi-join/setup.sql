-- Both sides again. Neither form can be fast without a way to find a
-- customer's events; the shape of the query is what is on trial here.
CREATE INDEX events_customer_id_idx ON events (customer_id);
CREATE INDEX customers_loyalty_tier_idx ON customers (loyalty_tier);

ANALYZE events;
ANALYZE customers;
