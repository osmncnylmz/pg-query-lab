-- pg-query-lab: an e-commerce OLTP schema, and the substrate for the scenarios
-- in sql/scenarios/. A few of its indexing decisions are omissions on purpose;
-- each one is marked "LAB:" and names the scenario that adds the index back.
--
-- House rules:
--   * money is numeric(12,2), never a floating point type
--   * every point in time is timestamptz, never timestamp
--   * NOT NULL is the default posture; nullability has to earn its place
--   * CHECK constraints carry invariants the application must never violate
--   * foreign keys spell out ON DELETE, per relationship
--
-- PostgreSQL 14 and up. Developed against 18.3 through PGlite.

CREATE TYPE order_status AS ENUM (
    'pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'
);

CREATE TYPE payment_method AS ENUM (
    'card', 'bank_transfer', 'paypal', 'store_credit'
);

CREATE TYPE payment_status AS ENUM (
    'authorized', 'captured', 'failed', 'refunded'
);

CREATE TYPE movement_reason AS ENUM (
    'purchase', 'sale', 'return', 'adjustment', 'shrinkage'
);

CREATE TYPE address_kind AS ENUM ('billing', 'shipping');

-- A CHECK-constrained domain: reusable, self-documenting, and enforced by the
-- database rather than by every caller that happens to remember.
CREATE DOMAIN country_code AS char(2)
    CHECK (VALUE ~ '^[A-Z]{2}$');

CREATE DOMAIN currency_code AS char(3)
    CHECK (VALUE ~ '^[A-Z]{3}$');

CREATE DOMAIN money_amount AS numeric(12, 2);

CREATE TABLE customers (
    id            bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         text          NOT NULL,
    full_name     text          NOT NULL,
    country       country_code  NOT NULL,
    loyalty_tier  text          NOT NULL DEFAULT 'bronze',
    is_active     boolean       NOT NULL DEFAULT true,
    created_at    timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT customers_email_lowercase_ck   CHECK (email = lower(email)),
    CONSTRAINT customers_email_shape_ck       CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),
    CONSTRAINT customers_full_name_nonblank_ck CHECK (btrim(full_name) <> ''),
    CONSTRAINT customers_loyalty_tier_ck      CHECK (loyalty_tier IN ('bronze', 'silver', 'gold', 'platinum'))
);

CREATE UNIQUE INDEX customers_email_uq ON customers (email);
CREATE INDEX customers_created_at_idx ON customers (created_at);

CREATE TABLE addresses (
    id           bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id  bigint       NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    kind         address_kind NOT NULL,
    line1        text         NOT NULL,
    city         text         NOT NULL,
    postal_code  text         NOT NULL,
    country      country_code NOT NULL,
    is_default   boolean      NOT NULL DEFAULT false,
    created_at   timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT addresses_line1_nonblank_ck CHECK (btrim(line1) <> ''),
    CONSTRAINT addresses_city_nonblank_ck  CHECK (btrim(city) <> '')
);

CREATE INDEX addresses_customer_id_idx ON addresses (customer_id);

-- "At most one default address per customer per kind" is an invariant the
-- application cannot express with a plain UNIQUE constraint. A partial unique
-- index states it exactly.
CREATE UNIQUE INDEX addresses_one_default_per_kind_uq
    ON addresses (customer_id, kind)
    WHERE is_default;

-- A self-referencing tree, three levels deep in the seeded data.
CREATE TABLE categories (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id  bigint      REFERENCES categories (id) ON DELETE RESTRICT,
    slug       text        NOT NULL,
    name       text        NOT NULL,
    depth      smallint    NOT NULL DEFAULT 0,

    -- A row may not be its own parent. This does not prevent longer cycles --
    -- that needs a trigger or a recursive constraint -- but it removes the
    -- degenerate case for free.
    CONSTRAINT categories_no_self_parent_ck CHECK (parent_id IS DISTINCT FROM id),
    CONSTRAINT categories_depth_ck          CHECK (depth BETWEEN 0 AND 4),
    CONSTRAINT categories_root_depth_ck     CHECK ((parent_id IS NULL) = (depth = 0))
);

CREATE UNIQUE INDEX categories_slug_uq ON categories (slug);
CREATE INDEX categories_parent_id_idx ON categories (parent_id);

CREATE TABLE products (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id  bigint      NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
    sku          text        NOT NULL,
    name         text        NOT NULL,
    description  text,
    is_active    boolean     NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),

    -- STORED generated column: the search document is computed once on write
    -- instead of once per row per query. Scenario 13 measures the difference.
    -- to_tsvector(regconfig, text) is IMMUTABLE; the single-argument form is
    -- not, and would be rejected here.
    search_vector tsvector
        GENERATED ALWAYS AS (
            to_tsvector('english', name || ' ' || coalesce(description, ''))
        ) STORED,

    CONSTRAINT products_sku_shape_ck     CHECK (sku ~ '^[A-Z0-9-]{4,32}$'),
    CONSTRAINT products_name_nonblank_ck CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX products_sku_uq ON products (sku);
CREATE INDEX products_category_id_idx ON products (category_id);

CREATE TABLE product_variants (
    id            bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id    bigint       NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    sku           text         NOT NULL,
    price         money_amount NOT NULL,
    weight_grams  integer      NOT NULL,
    attributes    jsonb        NOT NULL DEFAULT '{}'::jsonb,
    is_active     boolean      NOT NULL DEFAULT true,

    CONSTRAINT product_variants_price_ck      CHECK (price >= 0),
    CONSTRAINT product_variants_weight_ck     CHECK (weight_grams > 0),
    CONSTRAINT product_variants_attrs_obj_ck  CHECK (jsonb_typeof(attributes) = 'object')
);

CREATE UNIQUE INDEX product_variants_sku_uq ON product_variants (sku);
CREATE INDEX product_variants_product_id_idx ON product_variants (product_id);

CREATE TABLE inventory_movements (
    id          bigint          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    variant_id  bigint          NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
    delta       integer         NOT NULL,
    reason      movement_reason NOT NULL,
    occurred_at timestamptz     NOT NULL,

    -- A movement of zero units is meaningless; recording one is always a bug.
    CONSTRAINT inventory_movements_delta_ck CHECK (delta <> 0),
    -- Sales and shrinkage remove stock; purchases and returns add it.
    CONSTRAINT inventory_movements_sign_ck CHECK (
        (reason IN ('sale', 'shrinkage') AND delta < 0)
        OR (reason IN ('purchase', 'return') AND delta > 0)
        OR reason = 'adjustment'
    )
);

CREATE INDEX inventory_movements_variant_occurred_idx
    ON inventory_movements (variant_id, occurred_at DESC);

CREATE TABLE orders (
    id               bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id      bigint        NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
    status           order_status  NOT NULL DEFAULT 'pending',
    currency         currency_code NOT NULL DEFAULT 'EUR',
    subtotal         money_amount  NOT NULL,
    shipping_fee     money_amount  NOT NULL DEFAULT 0,
    discount_amount  money_amount  NOT NULL DEFAULT 0,
    placed_at        timestamptz   NOT NULL,
    shipped_at       timestamptz,

    -- The invoice total can never drift away from the components it is made
    -- of, and because it is stored rather than virtual it can be indexed
    -- (scenario 11).
    total_amount     money_amount
        GENERATED ALWAYS AS (subtotal + shipping_fee - discount_amount) STORED,

    CONSTRAINT orders_subtotal_ck  CHECK (subtotal >= 0),
    CONSTRAINT orders_shipping_ck  CHECK (shipping_fee >= 0),
    CONSTRAINT orders_discount_ck  CHECK (discount_amount >= 0),
    -- You cannot discount more than the goods are worth.
    CONSTRAINT orders_discount_le_subtotal_ck CHECK (discount_amount <= subtotal),
    -- An order can only have shipped after it was placed, and only in a status
    -- that implies shipment.
    CONSTRAINT orders_shipped_after_placed_ck CHECK (shipped_at IS NULL OR shipped_at >= placed_at),
    CONSTRAINT orders_shipped_status_ck CHECK (
        (shipped_at IS NOT NULL) = (status IN ('shipped', 'delivered'))
    )
);

CREATE INDEX orders_customer_placed_idx ON orders (customer_id, placed_at DESC);

-- LAB: orders is deliberately left without an index on (status), on
-- (placed_at) alone, and on (total_amount). Scenarios 02, 06, 11 and 12 add
-- and measure them.

CREATE TABLE order_items (
    id          bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    bigint       NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    variant_id  bigint       NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
    quantity    integer      NOT NULL,
    unit_price  money_amount NOT NULL,
    discount    money_amount NOT NULL DEFAULT 0,

    -- Derived, so it is not writable and cannot go out of step with quantity,
    -- unit_price and discount.
    line_total  money_amount
        GENERATED ALWAYS AS (quantity * unit_price - discount) STORED,

    CONSTRAINT order_items_quantity_ck   CHECK (quantity > 0),
    CONSTRAINT order_items_unit_price_ck CHECK (unit_price >= 0),
    CONSTRAINT order_items_discount_ck   CHECK (discount >= 0),
    CONSTRAINT order_items_discount_le_gross_ck CHECK (discount <= quantity * unit_price)
);

-- Note: there is intentionally no UNIQUE (order_id, variant_id). Real carts do
-- allow the same variant on two lines (different personalisation, different
-- promotion). It also means the schema ships with no index whose leading
-- column is order_id -- which is the unindexed-foreign-key problem scenario 01
-- exists to demonstrate.
CREATE INDEX order_items_variant_id_idx ON order_items (variant_id);

CREATE TABLE payments (
    id            bigint         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id      bigint         NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    method        payment_method NOT NULL,
    status        payment_status NOT NULL,
    amount        money_amount   NOT NULL,
    external_ref  text           NOT NULL,
    processed_at  timestamptz    NOT NULL,

    CONSTRAINT payments_amount_ck CHECK (amount > 0)
);

CREATE UNIQUE INDEX payments_external_ref_uq ON payments (external_ref);
CREATE INDEX payments_order_id_idx ON payments (order_id);

CREATE TABLE reviews (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id  bigint      NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    customer_id bigint      NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    rating      smallint    NOT NULL,
    title       text        NOT NULL,
    body        text,
    created_at  timestamptz NOT NULL,

    CONSTRAINT reviews_rating_ck        CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT reviews_title_nonblank_ck CHECK (btrim(title) <> '')
);

-- One review per customer per product.
CREATE UNIQUE INDEX reviews_product_customer_uq ON reviews (product_id, customer_id);
CREATE INDEX reviews_customer_id_idx ON reviews (customer_id);

CREATE TABLE events (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at  timestamptz NOT NULL,
    event_type   text        NOT NULL,
    -- Deliberately NOT a foreign key. A high-volume append-only log that
    -- references the OLTP tables buys referential integrity at the cost of a
    -- lock and an index probe on every insert, and it makes customer deletion
    -- a fan-out operation. The log is decoupled on purpose; the value is
    -- treated as a soft reference.
    customer_id  bigint,
    payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT events_type_nonblank_ck CHECK (btrim(event_type) <> ''),
    CONSTRAINT events_payload_object_ck CHECK (jsonb_typeof(payload) = 'object')
);

-- Append-only is an invariant, so the database enforces it rather than trusting
-- every writer to remember. Scenario 05 relies on the physical order of this
-- table matching occurred_at, which is exactly what append-only guarantees.
CREATE FUNCTION events_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql AS
$$
BEGIN
    RAISE EXCEPTION 'events is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER events_append_only
    BEFORE UPDATE OR DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION events_reject_mutation();

-- LAB: events carries no index other than its primary key. Scenario 05 adds a
-- BRIN index on occurred_at and scenario 09 adds a GIN index on payload.
