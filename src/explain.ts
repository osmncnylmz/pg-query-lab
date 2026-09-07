import type { PGlite } from '@electric-sql/pglite';

/**
 * A node of a PostgreSQL `EXPLAIN (FORMAT JSON)` plan. Only the fields this
 * project reads are named; the rest are left as an index signature because the
 * shape varies by node type and PostgreSQL version.
 */
export interface PlanNode {
  readonly 'Node Type': string;
  readonly Plans?: readonly PlanNode[];
  readonly [key: string]: unknown;
}

export interface ExplainOutput {
  readonly Plan: PlanNode;
  readonly 'Planning Time'?: number;
  readonly 'Execution Time'?: number;
  readonly [key: string]: unknown;
}

/** Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) and return the parsed plan. */
export async function explainAnalyze(db: PGlite, sql: string): Promise<ExplainOutput> {
  const res = await db.query<Record<string, unknown>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
  );
  const raw = res.rows[0]?.['QUERY PLAN'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('EXPLAIN returned no plan');
  }
  return raw[0] as ExplainOutput;
}

/** Depth-first list of every node in the plan, root first. */
export function planNodes(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  const visit = (node: PlanNode): void => {
    out.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  return out;
}

/**
 * How a test or a scenario names the plan node it expects.
 *
 * A bare string is shorthand for `{ node: '<string>' }`. Node type matching is
 * a prefix match on purpose: "Index Scan" should also accept
 * "Index Scan Backward". Note that "Index Scan" does NOT match
 * "Index Only Scan", which is the distinction most of these assertions care
 * about.
 */
export interface NodeMatcher {
  readonly node?: string;
  readonly relation?: string;
  readonly index?: string;
  readonly joinType?: string;
  /**
   * The plan's "Parent Relationship", which is how JSON EXPLAIN marks a
   * correlated subquery: there is no node whose type is "SubPlan", there is a
   * child plan whose relationship to its parent is "SubPlan". Matching on it is
   * the only reliable way to assert "this query executes a subplan per row".
   */
  readonly parentRelationship?: string;
}

export function normaliseMatcher(m: string | NodeMatcher): NodeMatcher {
  return typeof m === 'string' ? { node: m } : m;
}

export function describeMatcher(m: string | NodeMatcher): string {
  const n = normaliseMatcher(m);
  const parts = [n.node ?? 'any node'];
  if (n.relation !== undefined) parts.push(`on ${n.relation}`);
  if (n.index !== undefined) parts.push(`using ${n.index}`);
  if (n.joinType !== undefined) parts.push(`(${n.joinType} join)`);
  if (n.parentRelationship !== undefined) parts.push(`as ${n.parentRelationship}`);
  return parts.join(' ');
}

export function matchesNode(node: PlanNode, matcher: string | NodeMatcher): boolean {
  const m = normaliseMatcher(matcher);
  if (m.node !== undefined && !node['Node Type'].startsWith(m.node)) return false;
  if (m.relation !== undefined && node['Relation Name'] !== m.relation) return false;
  if (m.index !== undefined && node['Index Name'] !== m.index) return false;
  if (m.joinType !== undefined && node['Join Type'] !== m.joinType) return false;
  if (
    m.parentRelationship !== undefined &&
    node['Parent Relationship'] !== m.parentRelationship
  ) {
    return false;
  }
  return true;
}

export function findNodes(root: PlanNode, matcher: string | NodeMatcher): PlanNode[] {
  return planNodes(root).filter((n) => matchesNode(n, matcher));
}

export function hasNode(root: PlanNode, matcher: string | NodeMatcher): boolean {
  return findNodes(root, matcher).length > 0;
}

/** Every index the plan actually reads, in plan order, de-duplicated. */
export function indexesUsed(root: PlanNode): string[] {
  const names = planNodes(root)
    .map((n) => n['Index Name'])
    .filter((n): n is string => typeof n === 'string');
  return [...new Set(names)];
}

/** Total shared buffer pages the plan touched (hits plus reads). */
export function sharedBlocks(root: PlanNode): number {
  return planNodes(root).reduce((total, n) => {
    const hit = typeof n['Shared Hit Blocks'] === 'number' ? n['Shared Hit Blocks'] : 0;
    const read = typeof n['Shared Read Blocks'] === 'number' ? n['Shared Read Blocks'] : 0;
    return total + hit + read;
  }, 0);
}

function numeric(node: PlanNode, key: string): number | undefined {
  const v = node[key];
  return typeof v === 'number' ? v : undefined;
}

/** One line describing a plan node, in roughly the shape EXPLAIN prints. */
export function formatNode(node: PlanNode): string {
  const bits: string[] = [];

  const subplanName = node['Subplan Name'];
  if (typeof subplanName === 'string') bits.push(`${subplanName}:`);
  bits.push(node['Node Type']);

  const relation = node['Relation Name'];
  const index = node['Index Name'];
  if (typeof index === 'string') bits.push(`using ${index}`);
  if (typeof relation === 'string') bits.push(`on ${relation}`);

  const detail: string[] = [];
  const rows = numeric(node, 'Actual Rows');
  const loops = numeric(node, 'Actual Loops');
  const time = numeric(node, 'Actual Total Time');
  if (rows !== undefined) detail.push(`rows=${rows}`);
  if (loops !== undefined && loops !== 1) detail.push(`loops=${loops}`);
  if (time !== undefined) detail.push(`actual=${time.toFixed(3)}ms`);

  const hit = numeric(node, 'Shared Hit Blocks') ?? 0;
  const read = numeric(node, 'Shared Read Blocks') ?? 0;
  if (hit + read > 0) detail.push(`buffers=${hit + read}`);

  const removed = numeric(node, 'Rows Removed by Filter');
  if (removed !== undefined && removed > 0) detail.push(`filtered=${removed}`);

  const method = node['Sort Method'];
  if (typeof method === 'string') detail.push(`sort=${method}`);

  const heapFetches = numeric(node, 'Heap Fetches');
  if (heapFetches !== undefined) detail.push(`heap_fetches=${heapFetches}`);

  return `${bits.join(' ')}${detail.length > 0 ? `  (${detail.join(' ')})` : ''}`;
}

/** The whole plan as an indented tree, the way EXPLAIN's text format reads. */
export function formatPlan(explain: ExplainOutput): string {
  const lines: string[] = [];
  const visit = (node: PlanNode, depth: number): void => {
    const arrow = depth > 0 ? '-> ' : '';
    lines.push(`${'  '.repeat(depth)}${arrow}${formatNode(node)}`);
    for (const child of node.Plans ?? []) visit(child, depth + 1);
  };
  visit(explain.Plan, 0);
  const planning = explain['Planning Time'];
  const execution = explain['Execution Time'];
  if (typeof planning === 'number') lines.push(`Planning Time: ${planning.toFixed(3)} ms`);
  if (typeof execution === 'number') lines.push(`Execution Time: ${execution.toFixed(3)} ms`);
  return lines.join('\n');
}
