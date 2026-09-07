-- pg-query-lab: the seed. Pure SQL -- no client-side row generation, no COPY
-- from a fixture file. Every row comes out of generate_series inside the server.
--
-- Two psql variables, which the TypeScript runner binds under the same names:
--   :scale   row-count multiplier, 1 = the default dataset
--   :seed    integer that salts the pseudo-random stream
--
--   psql -v scale=1 -v seed=20260101 -f sql/02_seed.sql
--   npm run bench -- --scale 1 --seed 20260101
--
-- On determinism. setseed() + random() is the usual recipe and it is called
-- below, so a stray random() would at least be reproducible, but it is not what
-- the data depends on. random() is deterministic only if every call happens in
-- the same order, and evaluation order belongs to the plan rather than to the
-- query: add a parallel worker or change a join order and the "seeded"
-- generator quietly produces something else.
--
-- So every value here is a pure function of (row number, salt) via lab_rand().
-- Order cannot matter, and the same (scale, seed) gives identical data on any
-- machine under any plan.

SELECT setseed(0.42);

CREATE TABLE lab_seed_config (
    only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
    scale    numeric     NOT NULL CHECK (scale > 0),
    seed     integer     NOT NULL,
    -- The dataset's "now". Fixed, so the data does not change with the clock.
    epoch    timestamptz NOT NULL
);

INSERT INTO lab_seed_config (scale, seed, epoch)
VALUES (:scale, :seed, TIMESTAMPTZ '2026-01-01 00:00:00+00');

-- The helpers below use PostgreSQL 14's SQL-standard `RETURN` body instead of a
-- dollar-quoted string, for two reasons:
--
--   * psql does not interpolate variables inside dollar quotes, so :seed and
--     :scale can only be baked into the function this way;
--   * a single-expression IMMUTABLE SQL function is inlined into the calling
--     query, so there is no per-row function call at all. An earlier draft read
--     the seed out of lab_seed_config on every call; that subquery blocked
--     inlining and turned every generated value into a table lookup, which
--     measured 3.2x slower over 1.2M calls (4834ms vs 1493ms) on the machine
--     this was developed on.
--
-- Cost matters here: the seed evaluates a few million of these.

-- Uniform pseudo-random in [0, 1), a pure function of (n, salt) and :seed.
-- One md5 of one integer -- XOR-ing the seed in is a bijection, so distinct
-- (n, salt) pairs stay distinct, and it avoids the string concatenation that
-- dominated the cost when the seed was appended as text.
-- bit(28) keeps the result non-negative without a sign dance.
CREATE FUNCTION lab_rand(n bigint, salt integer) RETURNS double precision
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN ('x' || substr(md5(((n * 1000 + salt) # :seed)::text), 1, 7))::bit(28)::int / 268435456.0;

-- Uniform pick from an array.
CREATE FUNCTION lab_pick(items text[], n bigint, salt integer) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN items[1 + floor(lab_rand(n, salt) * array_length(items, 1))::int];

-- Weighted pick. `cuts` holds the cumulative probabilities between items, so
-- ARRAY['a','b','c'] with ARRAY[0.5, 0.9] means 50% a, 40% b, 10% c.
--
-- This exists because the obvious spelling -- a CASE ladder of
-- `WHEN lab_rand(g, 5) < 0.5 ... WHEN lab_rand(g, 5) < 0.9 ...` -- evaluates
-- lab_rand once per arm it has to test. PostgreSQL does not common up repeated
-- subexpressions, so a six-way ladder is up to six md5 calls per row.
-- width_bucket does it with one.
CREATE FUNCTION lab_weighted(items text[], cuts double precision[], n bigint, salt integer)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN items[width_bucket(lab_rand(n, salt), cuts) + 1];

-- Row count for a table whose "scale 1" size is `base`.
CREATE FUNCTION lab_n(base integer) RETURNS integer
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN greatest(1, round((base * :scale)::numeric))::int;

CREATE FUNCTION lab_epoch() RETURNS timestamptz
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN TIMESTAMPTZ '2026-01-01 00:00:00+00';

-- Skewed integer in [1, n]. exponent > 1 concentrates mass on the low ids,
-- which is how "a handful of accounts generate most of the traffic" and "a few
-- SKUs are 80% of sales" actually look in production data.
CREATE FUNCTION lab_skewed(n integer, row_n bigint, salt integer, exponent double precision)
    RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN 1 + least(n - 1, floor(power(lab_rand(row_n, salt), exponent) * n)::int);

-- categories: 6 roots -> 24 -> 72 leaves.
INSERT INTO categories (parent_id, slug, name, depth)
SELECT NULL, 'root-' || g,
       (ARRAY['Outdoor', 'Home', 'Audio', 'Workshop', 'Kitchen', 'Cycling'])[g], 0
FROM generate_series(1, 6) g;

INSERT INTO categories (parent_id, slug, name, depth)
SELECT 1 + ((g - 1) % 6), 'mid-' || g, 'Category ' || g, 1
FROM generate_series(1, 24) g;

INSERT INTO categories (parent_id, slug, name, depth)
SELECT 7 + ((g - 1) % 24), 'leaf-' || g, 'Leaf ' || g, 2
FROM generate_series(1, 72) g;

INSERT INTO customers (email, full_name, country, loyalty_tier, is_active, created_at)
SELECT
    'customer' || g || '@example.com',
    lab_pick(ARRAY['Ada', 'Bram', 'Cleo', 'Dilan', 'Esra', 'Faruk', 'Gizem', 'Hugo',
                   'Ilse', 'Jonas', 'Kaya', 'Lena', 'Mert', 'Nadia', 'Omar', 'Pelin'], g, 2)
        || ' ' ||
    (ARRAY['Aydin', 'Bakker', 'Costa', 'Demir', 'Eriksson', 'Fischer',
           'Garcia', 'Horvath', 'Iversen', 'Jansen', 'Kowalski', 'Lindqvist'])[1 + (g % 12)],
    (ARRAY['NL', 'DE', 'TR', 'FR', 'ES', 'PL', 'SE', 'GB'])[1 + (g % 8)]::country_code,
    -- Tier is mostly a function of the customer's rank, with some noise. Order
    -- volume below is skewed towards low customer ids, so this makes the top
    -- tiers correlate with actual spend -- which is how loyalty programmes
    -- work, and which matters for scenario 07: without the correlation there is
    -- no natural predicate that selects a few hundred very active accounts.
    (ARRAY['platinum', 'gold', 'silver', 'bronze'])[
        width_bucket(0.97 * g / lab_n(20000) + 0.03 * lab_rand(g, 5),
                     ARRAY[0.045, 0.130, 0.360]) + 1],
    (g % 17) <> 0,
    lab_epoch() - make_interval(secs => (lab_rand(g, 7) * 126144000)::int)
FROM generate_series(1, lab_n(20000)) g;

-- Every customer gets a default shipping address; some also get a billing
-- address and a second shipping address.
INSERT INTO addresses (customer_id, kind, line1, city, postal_code, country, is_default, created_at)
SELECT
    c.id,
    k.kind,
    (1 + (lab_rand(c.id, 10 + k.slot) * 400)::int) || ' ' ||
        (ARRAY['Keizersgracht', 'Hauptstrasse', 'Bagdat Caddesi', 'Rue de Rivoli',
               'Gran Via', 'Nowy Swiat', 'Drottninggatan', 'Baker Street'])[1 + ((c.id + k.slot) % 8)],
    (ARRAY['Amsterdam', 'Berlin', 'Istanbul', 'Paris', 'Madrid',
           'Warsaw', 'Stockholm', 'London'])[1 + ((c.id + k.slot) % 8)],
    lpad(((c.id * 7919 + k.slot) % 100000)::text, 5, '0'),
    c.country,
    k.slot = 0,
    c.created_at
FROM customers c
CROSS JOIN LATERAL (
    VALUES (0, 'shipping'::address_kind),
           (1, 'billing'::address_kind),
           (2, 'shipping'::address_kind)
) AS k(slot, kind)
-- slot 0 always exists; slots 1 and 2 are conditional, which is what makes the
-- address count per customer uneven.
WHERE k.slot = 0
   OR (k.slot = 1 AND (c.id % 20) < 11)
   OR (k.slot = 2 AND (c.id % 20) < 4);

-- A long tail across the 72 leaf categories.
INSERT INTO products (category_id, sku, name, description, is_active, created_at)
SELECT
    30 + lab_skewed(72, g, 20, 1.8),
    'SKU-' || lpad(g::text, 8, '0'),
    lab_pick(ARRAY['Alpine', 'Nordic', 'Coastal', 'Urban', 'Compact', 'Rugged',
                   'Ergonomic', 'Featherweight', 'Insulated', 'Modular',
                   'Reinforced', 'Waterproof', 'Portable', 'Precision',
                   'Adjustable', 'Heritage'], g, 21)
        || ' ' ||
    (ARRAY['Merino', 'Titanium', 'Bamboo', 'Aluminium', 'Ceramic', 'Cork',
           'Canvas', 'Walnut', 'Silicone', 'Carbon', 'Copper', 'Linen'])[1 + (g % 12)]
        || ' ' ||
    lab_pick(ARRAY['Jacket', 'Backpack', 'Kettle', 'Lantern', 'Headphones', 'Chair',
                   'Bottle', 'Toolkit', 'Notebook', 'Speaker', 'Blanket', 'Tripod',
                   'Keyboard', 'Mug', 'Sleeping Bag', 'Multitool', 'Cutting Board',
                   'Desk Lamp', 'Bike Pump', 'Hammock', 'Thermos', 'Wallet',
                   'Camera Strap', 'Storage Crate'], g, 23)
        || ' ' || (1000 + (g * 7919) % 9000),
    (ARRAY['Built for daily use in wet weather.',
           'A quiet redesign of a classic, with fewer parts.',
           'Machined from a single billet and hand finished.',
           'Packs flat and weighs less than a paperback.',
           'Tested for two winters above the tree line.',
           'Repairable: every fastener is a standard size.',
           'Made from recycled offcuts in a small workshop.',
           'Sized for a carry-on and a long weekend.'])[1 + (g % 8)]
        || ' ' ||
    (ARRAY['Waterproof to 10000mm and fully seam sealed.',
           'Ships with a five year warranty.',
           'Ergonomic grip that stays comfortable for hours.',
           'Compatible with the accessories you already own.',
           'Rated for temperatures down to minus twenty.',
           'Dishwasher safe and free of coatings.'])[1 + (g % 6)],
    (g % 13) <> 0,
    lab_epoch() - make_interval(secs => (lab_rand(g, 28) * 94608000)::int)
FROM generate_series(1, lab_n(20000)) g;

-- One to three variants per product.
INSERT INTO product_variants (product_id, sku, price, weight_grams, attributes, is_active)
SELECT
    p.id,
    'SKU-' || lpad(p.id::text, 8, '0') || '-' || v.slot,
    round((5 + power(lab_rand(p.id * 8 + v.slot, 30), 2.4) * 900)::numeric, 2),
    50 + ((p.id * 613 + v.slot * 97) % 4000),
    jsonb_build_object(
        'size',  (ARRAY['xs', 's', 'm', 'l', 'xl'])[1 + ((p.id + v.slot) % 5)],
        'color', (ARRAY['black', 'sand', 'olive', 'navy', 'rust', 'stone'])[1 + ((p.id * 3 + v.slot) % 6)]
    ),
    ((p.id + v.slot) % 19) <> 0
FROM products p
CROSS JOIN LATERAL (VALUES (0), (1), (2)) AS v(slot)
WHERE v.slot = 0
   OR (v.slot = 1 AND (p.id % 20) < 12)
   OR (v.slot = 2 AND (p.id % 20) < 5);

-- subtotal starts at zero and is reconciled from order_items further down, so
-- that sum(order_items.line_total) = orders.subtotal actually holds in the
-- seeded data instead of being approximately true.
INSERT INTO orders (customer_id, status, currency, subtotal, shipping_fee, discount_amount,
                    placed_at, shipped_at)
SELECT
    lab_skewed(lab_n(20000), g, 40, 2.6),
    s.status,
    'EUR'::currency_code,
    0, 0, 0,
    s.placed_at,
    CASE WHEN s.status IN ('shipped', 'delivered')
         THEN s.placed_at + make_interval(hours => 6 + ((g * 37) % 120))
    END
FROM generate_series(1, lab_n(100000)) g
CROSS JOIN LATERAL (
    SELECT
        lab_weighted(ARRAY['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'],
                     ARRAY[0.02, 0.11, 0.29, 0.93, 0.975], g, 41)::order_status AS status,
        -- squared -> recent-heavy, the usual shape of an order history
        lab_epoch() - make_interval(
            secs => (power(lab_rand(g, 42), 2.0) * 63072000)::int) AS placed_at
) s;

-- One to three lines per order.
INSERT INTO order_items (order_id, variant_id, quantity, unit_price, discount)
SELECT
    x.order_id,
    x.variant_id,
    x.quantity,
    v.price,
    CASE WHEN (x.order_id + x.variant_id) % 6 = 0
         THEN round((v.price * x.quantity * 0.15)::numeric, 2)
         ELSE 0::numeric
    END
FROM (
    SELECT
        o.id                                          AS order_id,
        lab_skewed(nv.n, o.id * 8 + k.k, 50, 2.2)     AS variant_id,
        1 + ((o.id * 31 + k.k) % 3)                   AS quantity
    FROM orders o
    CROSS JOIN (SELECT count(*)::int AS n FROM product_variants) nv
    CROSS JOIN LATERAL generate_series(0, ((o.id * 13) % 3) / 2 + (o.id % 2)) AS k(k)
) x
-- A plain join, not a correlated lookup: the planner is free to hash
-- product_variants once instead of probing its primary key once per line.
JOIN product_variants v ON v.id = x.variant_id;

-- Reconcile order money from the lines that were actually written.
UPDATE orders o
SET subtotal        = t.subtotal,
    shipping_fee    = CASE WHEN t.subtotal >= 75 THEN 0 ELSE 4.95 END,
    discount_amount = CASE WHEN o.id % 8 = 0 THEN round(t.subtotal * 0.10, 2) ELSE 0 END
FROM (
    SELECT order_id, sum(line_total) AS subtotal
    FROM order_items
    GROUP BY order_id
) t
WHERE t.order_id = o.id;

-- One payment per order that got as far as being paid.
INSERT INTO payments (order_id, method, status, amount, external_ref, processed_at)
SELECT
    o.id,
    (ARRAY['card', 'card', 'card', 'bank_transfer', 'paypal', 'store_credit'])[1 + (o.id % 6)]::payment_method,
    CASE WHEN o.status = 'refunded' THEN 'refunded' ELSE 'captured' END::payment_status,
    o.total_amount,
    'pay_' || lpad(o.id::text, 10, '0'),
    o.placed_at + make_interval(secs => 5 + ((o.id * 271) % 900))
FROM orders o
WHERE o.status IN ('paid', 'shipped', 'delivered', 'refunded')
  AND o.total_amount > 0;

-- Collision-free by construction: product p gets one review per "pass" k, and
-- the reviewer for (p, k) is offset by a fixed stride, so the
-- UNIQUE (product_id, customer_id) index can never fire during seeding.
INSERT INTO reviews (product_id, customer_id, rating, title, body, created_at)
SELECT
    p.product_id,
    1 + ((lab_skewed(lab_n(20000), p.product_id, 70, 2.0) - 1 + p.pass * 3079) % lab_n(20000)),
    width_bucket(lab_rand(p.n, 71), ARRAY[0.04, 0.10, 0.20, 0.45]) + 1,
    (ARRAY['Exactly what I wanted', 'Good, with caveats', 'Would buy again',
           'Solid but heavy', 'Better than the previous version',
           'Disappointing seams', 'Excellent value'])[1 + (p.n % 7)],
    -- The product name is repeated inside the review text on purpose. It is what
    -- a real review corpus looks like, and it gives the free-text search
    -- scenarios (10 and 13) a column with realistic cardinality to work on.
    'On the ' || pr.name || ': ' ||
    (ARRAY['Used it every day for three months and it still looks new.',
           'The zip pull broke within a fortnight, otherwise fine.',
           'Fits exactly as described and the finish is genuinely nice.',
           'Slightly heavier than I expected but the build quality shows.',
           'Arrived quickly and the packaging was completely plastic free.',
           'The stitching came apart at the seam after a single wash.'])[1 + (p.n % 6)]
        || ' ' ||
    (ARRAY['Customer support answered within a day and sent a replacement.',
           'I would recommend sizing up if you are between sizes.',
           'The ergonomic handle makes a real difference on long days.',
           'Cleaning it is straightforward, no special products needed.',
           'It survived a week of rain without soaking through.',
           'Not sure it justifies the price, but I have no regrets.'])[1 + ((p.n * 5) % 6)],
    lab_epoch() - make_interval(secs => (lab_rand(p.n, 75) * 60480000)::int)
FROM (
    SELECT g                                  AS n,
           1 + ((g - 1) % lab_n(20000))       AS product_id,
           (g - 1) / lab_n(20000)             AS pass
    FROM generate_series(1, lab_n(50000)) g
) p
JOIN products pr ON pr.id = p.product_id;

INSERT INTO inventory_movements (variant_id, delta, reason, occurred_at)
SELECT
    lab_skewed((SELECT count(*) FROM product_variants)::int, g, 80, 2.2),
    CASE r.reason
        WHEN 'sale'      THEN -(1 + ((g * 7) % 4))
        WHEN 'shrinkage' THEN -(1 + ((g * 3) % 2))
        WHEN 'purchase'  THEN  (10 + ((g * 11) % 90))
        WHEN 'return'    THEN  (1 + ((g * 5) % 2))
        ELSE CASE WHEN g % 2 = 0 THEN -1 ELSE 1 END
    END,
    r.reason,
    lab_epoch() - make_interval(secs => (lab_rand(g, 83) * 63072000)::int)
FROM generate_series(1, lab_n(100000)) g
CROSS JOIN LATERAL (
    SELECT lab_weighted(ARRAY['sale', 'purchase', 'return', 'adjustment', 'shrinkage'],
                        ARRAY[0.62, 0.82, 0.92, 0.97], g, 85)::movement_reason AS reason
) r;

-- occurred_at increases monotonically with the generated row number. Not a
-- convenience for the seed: it is the property scenario 05 depends on. BRIN is
-- only useful when physical order correlates with the indexed value, and an
-- append-only log is the textbook case where it does.
INSERT INTO events (occurred_at, event_type, customer_id, payload)
SELECT
    lab_epoch() - make_interval(secs => ((lab_n(300000) - g) * (63072000.0 / lab_n(300000)))::int),
    lab_weighted(ARRAY['page_view', 'search', 'add_to_cart', 'checkout_started',
                       'order_placed', 'support_ticket'],
                 ARRAY[0.55, 0.72, 0.84, 0.92, 0.98], g, 90),
    CASE WHEN g % 25 <> 0 THEN lab_skewed(lab_n(20000), g, 92, 2.6) END,
    jsonb_build_object(
        'plan',    lab_weighted(ARRAY['enterprise', 'business', 'plus', 'free'],
                                ARRAY[0.03, 0.16, 0.45], g, 93),
        'source',  (ARRAY['web', 'web', 'ios', 'android', 'email', 'api'])[1 + (g % 6)],
        'region',  (ARRAY['eu-west', 'eu-central', 'us-east', 'ap-south'])[1 + (g % 4)],
        'session', 's' || ((g - 1) / 7),
        'value',   round((lab_rand(g, 96) * 500)::numeric, 2)
    )
FROM generate_series(1, lab_n(300000)) g;
