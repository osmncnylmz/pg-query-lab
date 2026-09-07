-- Evidence for the claim in README.md, produced rather than asserted.
--
-- Build the "obvious" single-direction index alongside the matching one and ask
-- the planner what it does with each. The helper returns the chain of node
-- types from a plan, so the presence or absence of a Sort node is visible in
-- the benchmark report.
CREATE FUNCTION lab_plan_shape(query_text text) RETURNS text
    LANGUAGE plpgsql AS
$$
DECLARE
    line  text;
    shape text := '';
BEGIN
    FOR line IN EXECUTE 'EXPLAIN ' || query_text
    LOOP
        IF shape <> '' THEN
            shape := shape || ' <- ';
        END IF;
        shape := shape || split_part(btrim(regexp_replace(line, '^\s*->\s*', '')), '  (cost', 1);
    END LOOP;
    RETURN shape;
END;
$$;

CREATE INDEX orders_total_amount_plain_tmp ON orders (total_amount, id);

SELECT v.ordering,
       lab_plan_shape(
           'SELECT id, total_amount FROM orders ORDER BY ' || v.ordering || ' LIMIT 50'
       ) AS plan_shape
FROM (VALUES
    ('total_amount DESC, id ASC'),
    ('total_amount DESC, id DESC'),
    ('total_amount ASC, id ASC')
) AS v(ordering);

DROP INDEX orders_total_amount_plain_tmp;
DROP FUNCTION lab_plan_shape(text);
