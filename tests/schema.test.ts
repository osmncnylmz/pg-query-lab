import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Lab } from '../src/lab.js';

/**
 * Schema-level tests do not need volume, only structure, so they run against a
 * deliberately small dataset. Scenario plan assertions live in
 * scenarios.test.ts and do need volume.
 */
const SMALL = { scale: 0.05, seed: 20260101 } as const;

let lab: Lab;

beforeAll(async () => {
  lab = await Lab.create(SMALL);
});

afterAll(async () => {
  await lab.close();
});

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * Run a statement expecting the database to refuse it, and hand back the error
 * so the test can assert on which constraint fired.
 *
 * Wrapped in a transaction that is always rolled back: a failed statement
 * poisons the surrounding transaction, and the tests share one connection.
 */
async function rejected(sql: string): Promise<PgError> {
  await lab.db.query('BEGIN');
  try {
    await lab.db.query(sql);
  } catch (error) {
    return error as PgError;
  } finally {
    await lab.db.query('ROLLBACK');
  }
  throw new Error(`expected the database to reject this statement, but it succeeded:\n${sql}`);
}

async function accepted(sql: string): Promise<void> {
  await lab.db.query('BEGIN');
  try {
    await lab.db.query(sql);
  } finally {
    await lab.db.query('ROLLBACK');
  }
}

async function scalar<T>(sql: string): Promise<T> {
  const res = await lab.db.query<{ v: T }>(sql);
  if (res.rows.length !== 1) throw new Error(`expected one row from: ${sql}`);
  return (res.rows[0] as { v: T }).v;
}

describe('schema applies and seeds', () => {
  it('creates every expected table with rows in it', async () => {
    const counts = await lab.rowCounts();
    expect(counts).toHaveLength(11);
    for (const { table, rows } of counts) {
      expect(rows, `${table} should not be empty`).toBeGreaterThan(0);
    }
  });

  it('records the configuration it was seeded with', async () => {
    const row = await lab.db.query<{ scale: string; seed: number }>(
      'SELECT scale::text AS scale, seed FROM lab_seed_config',
    );
    expect(row.rows[0]?.seed).toBe(SMALL.seed);
    expect(Number(row.rows[0]?.scale)).toBe(SMALL.scale);
  });

  it('gives identity columns the row numbers the seed assumes', async () => {
    // Several scenarios address customers and products by id directly, which is
    // only sound because the seed inserts them in generate_series order into an
    // empty table.
    const gaps = await scalar<number>(`
      SELECT count(*)::int AS v
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM customers) s
      WHERE s.id <> s.rn
    `);
    expect(gaps).toBe(0);
  });
});

describe('CHECK constraints reject bad data', () => {
  it('rejects an email that is not lower case', async () => {
    const error = await rejected(`
      INSERT INTO customers (email, full_name, country)
      VALUES ('MixedCase@example.com', 'Test Person', 'NL')
    `);
    expect(error.constraint).toBe('customers_email_lowercase_ck');
  });

  it('rejects an email that is not shaped like one', async () => {
    const error = await rejected(`
      INSERT INTO customers (email, full_name, country)
      VALUES ('not-an-email', 'Test Person', 'NL')
    `);
    expect(error.constraint).toBe('customers_email_shape_ck');
  });

  it('rejects a blank name', async () => {
    const error = await rejected(`
      INSERT INTO customers (email, full_name, country)
      VALUES ('blank@example.com', '   ', 'NL')
    `);
    expect(error.constraint).toBe('customers_full_name_nonblank_ck');
  });

  it('rejects a loyalty tier outside the allowed set', async () => {
    const error = await rejected(`
      INSERT INTO customers (email, full_name, country, loyalty_tier)
      VALUES ('tier@example.com', 'Test Person', 'NL', 'diamond')
    `);
    expect(error.constraint).toBe('customers_loyalty_tier_ck');
  });

  it('rejects a country code the domain does not allow', async () => {
    const error = await rejected(`
      INSERT INTO customers (email, full_name, country)
      VALUES ('country@example.com', 'Test Person', 'nl')
    `);
    // Domain constraints report their own name rather than a table constraint.
    expect(error.message).toMatch(/country_code/);
  });

  it('rejects a discount larger than the subtotal', async () => {
    const error = await rejected(`
      INSERT INTO orders (customer_id, status, subtotal, discount_amount, placed_at)
      VALUES (1, 'pending', 10.00, 20.00, now())
    `);
    expect(error.constraint).toBe('orders_discount_le_subtotal_ck');
  });

  it('rejects a shipped_at on an order that is not shipped', async () => {
    const error = await rejected(`
      INSERT INTO orders (customer_id, status, subtotal, placed_at, shipped_at)
      VALUES (1, 'pending', 10.00, now(), now())
    `);
    expect(error.constraint).toBe('orders_shipped_status_ck');
  });

  it('rejects a shipped order with no shipped_at', async () => {
    const error = await rejected(`
      INSERT INTO orders (customer_id, status, subtotal, placed_at)
      VALUES (1, 'shipped', 10.00, now())
    `);
    expect(error.constraint).toBe('orders_shipped_status_ck');
  });

  it('rejects shipping before placing', async () => {
    const error = await rejected(`
      INSERT INTO orders (customer_id, status, subtotal, placed_at, shipped_at)
      VALUES (1, 'shipped', 10.00, now(), now() - interval '1 day')
    `);
    expect(error.constraint).toBe('orders_shipped_after_placed_ck');
  });

  it('rejects a non-positive order line quantity', async () => {
    const error = await rejected(`
      INSERT INTO order_items (order_id, variant_id, quantity, unit_price)
      VALUES (1, 1, 0, 10.00)
    `);
    expect(error.constraint).toBe('order_items_quantity_ck');
  });

  it('rejects a line discount larger than the line', async () => {
    const error = await rejected(`
      INSERT INTO order_items (order_id, variant_id, quantity, unit_price, discount)
      VALUES (1, 1, 2, 10.00, 25.00)
    `);
    expect(error.constraint).toBe('order_items_discount_le_gross_ck');
  });

  it('rejects a rating outside 1..5', async () => {
    const error = await rejected(`
      INSERT INTO reviews (product_id, customer_id, rating, title, created_at)
      VALUES (1, 999999, 6, 'Too good', now())
    `);
    expect(error.constraint).toBe('reviews_rating_ck');
  });

  it('rejects an inventory movement of zero units', async () => {
    const error = await rejected(`
      INSERT INTO inventory_movements (variant_id, delta, reason, occurred_at)
      VALUES (1, 0, 'adjustment', now())
    `);
    expect(error.constraint).toBe('inventory_movements_delta_ck');
  });

  it('rejects a sale that increases stock', async () => {
    const error = await rejected(`
      INSERT INTO inventory_movements (variant_id, delta, reason, occurred_at)
      VALUES (1, 5, 'sale', now())
    `);
    expect(error.constraint).toBe('inventory_movements_sign_ck');
  });

  it('rejects a negative variant price', async () => {
    const error = await rejected(`
      INSERT INTO product_variants (product_id, sku, price, weight_grams)
      VALUES (1, 'SKU-TEST-0001', -1.00, 100)
    `);
    expect(error.constraint).toBe('product_variants_price_ck');
  });

  it('rejects a jsonb payload that is not an object', async () => {
    const error = await rejected(`
      INSERT INTO events (occurred_at, event_type, payload)
      VALUES (now(), 'page_view', '[1,2,3]'::jsonb)
    `);
    expect(error.constraint).toBe('events_payload_object_ck');
  });

  it('rejects a category that is its own parent', async () => {
    const error = await rejected(`UPDATE categories SET parent_id = id WHERE id = 7`);
    expect(error.constraint).toBe('categories_no_self_parent_ck');
  });

  it('rejects a root category at a non-zero depth', async () => {
    const error = await rejected(`
      INSERT INTO categories (parent_id, slug, name, depth)
      VALUES (NULL, 'bad-root', 'Bad Root', 2)
    `);
    expect(error.constraint).toBe('categories_root_depth_ck');
  });
});

describe('uniqueness', () => {
  it('rejects a duplicate email', async () => {
    const error = await rejected(`
      INSERT INTO customers (email, full_name, country)
      VALUES ('customer1@example.com', 'Impostor', 'NL')
    `);
    expect(error.constraint).toBe('customers_email_uq');
  });

  it('allows a second non-default shipping address but not a second default one', async () => {
    await accepted(`
      INSERT INTO addresses (customer_id, kind, line1, city, postal_code, country, is_default)
      VALUES (1, 'shipping', '1 Test Street', 'Testville', '00000', 'NL', false)
    `);

    const error = await rejected(`
      INSERT INTO addresses (customer_id, kind, line1, city, postal_code, country, is_default)
      VALUES (1, 'shipping', '1 Test Street', 'Testville', '00000', 'NL', true)
    `);
    expect(error.constraint).toBe('addresses_one_default_per_kind_uq');
  });

  it('rejects a second review of the same product by the same customer', async () => {
    const existing = await lab.db.query<{ product_id: number; customer_id: number }>(
      'SELECT product_id, customer_id FROM reviews LIMIT 1',
    );
    const row = existing.rows[0];
    expect(row).toBeDefined();
    const error = await rejected(`
      INSERT INTO reviews (product_id, customer_id, rating, title, created_at)
      VALUES (${row?.product_id}, ${row?.customer_id}, 5, 'Again', now())
    `);
    expect(error.constraint).toBe('reviews_product_customer_uq');
  });
});

describe('foreign keys behave as declared', () => {
  it('refuses to delete a customer who has orders (ON DELETE RESTRICT)', async () => {
    const error = await rejected('DELETE FROM customers WHERE id = 1');
    // 23001 restrict_violation, not 23503 foreign_key_violation: RESTRICT is
    // checked immediately and reports its own SQLSTATE. NO ACTION -- the
    // default, and deferrable -- reports 23503 instead. Worth knowing when
    // deciding which error an application should special-case.
    expect(error.code).toBe('23001');
    expect(error.constraint).toBe('orders_customer_id_fkey');
  });

  it('cascades a customer delete to their addresses (ON DELETE CASCADE)', async () => {
    const customerId = await scalar<number>(`
      SELECT c.id AS v
      FROM customers c
      WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
        AND EXISTS (SELECT 1 FROM addresses a WHERE a.customer_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.customer_id = c.id)
      LIMIT 1
    `);

    await lab.db.query('BEGIN');
    try {
      await lab.db.query(`DELETE FROM customers WHERE id = ${customerId}`);
      const left = await scalar<number>(
        `SELECT count(*)::int AS v FROM addresses WHERE customer_id = ${customerId}`,
      );
      expect(left).toBe(0);
    } finally {
      await lab.db.query('ROLLBACK');
    }
  });

  it('refuses an order line pointing at a variant that does not exist', async () => {
    const error = await rejected(`
      INSERT INTO order_items (order_id, variant_id, quantity, unit_price)
      VALUES (1, 99999999, 1, 10.00)
    `);
    expect(error.code).toBe('23503');
  });
});

describe('generated columns', () => {
  it('computes line_total from quantity, price and discount', async () => {
    const value = await scalar<string>(`
      SELECT line_total::text AS v FROM order_items ORDER BY id LIMIT 1
    `);
    const parts = await lab.db.query<{ expected: string }>(`
      SELECT (quantity * unit_price - discount)::text AS expected
      FROM order_items ORDER BY id LIMIT 1
    `);
    expect(value).toBe(parts.rows[0]?.expected);
  });

  it('keeps orders.total_amount consistent with its components', async () => {
    const mismatches = await scalar<number>(`
      SELECT count(*)::int AS v
      FROM orders
      WHERE total_amount <> subtotal + shipping_fee - discount_amount
    `);
    expect(mismatches).toBe(0);
  });

  it('refuses a direct write to a generated column', async () => {
    const error = await rejected(`
      INSERT INTO order_items (order_id, variant_id, quantity, unit_price, line_total)
      VALUES (1, 1, 1, 10.00, 999.00)
    `);
    expect(error.code).toBe('428C9');
  });

  it('fills products.search_vector from name and description', async () => {
    const matches = await scalar<number>(`
      SELECT count(*)::int AS v
      FROM products
      WHERE search_vector
            IS DISTINCT FROM to_tsvector('english', name || ' ' || coalesce(description, ''))
    `);
    expect(matches).toBe(0);
  });
});

describe('the event log is append-only', () => {
  it('rejects UPDATE', async () => {
    const error = await rejected(`UPDATE events SET event_type = 'tampered' WHERE id = 1`);
    expect(error.message).toMatch(/append-only/);
  });

  it('rejects DELETE', async () => {
    const error = await rejected('DELETE FROM events WHERE id = 1');
    expect(error.message).toMatch(/append-only/);
  });

  it('still accepts INSERT', async () => {
    await accepted(`
      INSERT INTO events (occurred_at, event_type, payload)
      VALUES (now(), 'page_view', '{"plan": "free"}'::jsonb)
    `);
  });

  it('keeps physical order aligned with occurred_at, which BRIN depends on', async () => {
    // Scenario 05 is only meaningful while this holds, and this is exactly the
    // statistic the planner consults when costing a BRIN scan.
    //
    // The assertion is "almost perfectly correlated" rather than "perfectly
    // ordered" for a reason worth knowing: PostgreSQL's bulk insert path fills
    // several heap pages at a time, so a big INSERT ... SELECT lands a handful
    // of rows slightly out of sequence at page boundaries. The correlation
    // stays above 0.9999 and BRIN does not care.
    const correlation = await scalar<number>(`
      SELECT correlation AS v
      FROM pg_stats
      WHERE schemaname = 'public' AND tablename = 'events' AND attname = 'occurred_at'
    `);
    expect(correlation).toBeGreaterThan(0.99);
  });
});

describe('seeding is deterministic', () => {
  /** md5 of every row of every seeded table, independent of physical order. */
  async function fingerprint(instance: Lab): Promise<string> {
    const tables = (await instance.rowCounts()).map((c) => c.table);
    const parts: string[] = [];
    for (const table of tables) {
      const res = await instance.db.query<{ h: string | null }>(
        `SELECT md5(string_agg(t, '|' ORDER BY t)) AS h FROM (SELECT ${table}::text AS t FROM ${table}) s`,
      );
      parts.push(`${table}:${res.rows[0]?.h ?? 'empty'}`);
    }
    return parts.join('\n');
  }

  it('produces identical data for the same (scale, seed), and different data for a different seed', async () => {
    const tiny = { scale: 0.02, seed: 4242 } as const;

    const first = await Lab.create(tiny);
    const second = await Lab.create(tiny);
    const other = await Lab.create({ ...tiny, seed: tiny.seed + 1 });

    try {
      const a = await fingerprint(first);
      const b = await fingerprint(second);
      const c = await fingerprint(other);

      expect(a).toBe(b);
      expect(a).not.toBe(c);
    } finally {
      await first.close();
      await second.close();
      await other.close();
    }
  });
});
