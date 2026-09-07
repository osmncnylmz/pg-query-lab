-- A cohort of a few hundred customers, expressed relative to the table so the
-- scenario selects a comparable slice at any --scale. Three quarters of the way
-- up the id range: ordinary accounts with a handful of orders each, not the
-- handful of very heavy ones at the bottom.
SELECT (max(id) * 3 / 4)::bigint                       AS cohort_from,
       least(max(id), max(id) * 3 / 4 + 400)::bigint   AS cohort_to
FROM customers;
