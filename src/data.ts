import type { PraxClient } from './client.js';
import type { PraxFilter } from './filter.js';
import { f } from './filter.js';
import { routes } from './routes.js';
import { parseMutation, parsePage, type PraxMutationResult, type PraxPage, type PraxRow } from './rows.js';
import type { PraxSchema } from './schema.js';

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);
const ROOT = 't';

interface OrderSpec { field: string; dir: 'asc' | 'desc' }

/**
 * A fluent read query. Nothing is sent until a terminal method is awaited, so a query object is
 * cheap to build and safe to hold.
 *
 * The server caps `limit` per table scope and silently clamps a larger request, so read
 * `page.limit` rather than assuming yours was honoured.
 */
export class PraxQuery<T = PraxRow> {
  private readonly selectItems: unknown[] = [];
  private readonly whereItems: PraxFilter[] = [];
  private readonly orderItems: OrderSpec[] = [];
  private readonly groupItems: string[] = [];
  private readonly havingItems: PraxFilter[] = [];
  private readonly extraRefs = new Map<string, string>();
  private limitValue?: number;
  private offsetValue?: number;
  private totalCount = false;

  constructor(
    private readonly data: PraxData,
    private readonly table: string,
    private readonly signal?: AbortSignal
  ) {}

  /**
   * Restricts the columns returned. Worth doing on wide tables: the gateway meters egress
   * against the workspace plan.
   */
  select(...columns: string[]): this {
    for (const c of columns) if (c?.trim()) this.selectItems.push(c.trim());
    return this;
  }

  /** Includes a related table as a nested array on each row. */
  include(relatedTable: string, columns?: string[], limit?: number): this {
    if (!relatedTable?.trim()) throw new TypeError('A related table name or id is required.');
    const alias = `r${this.extraRefs.size + 1}`;
    this.extraRefs.set(alias, relatedTable.trim());

    const relation: Record<string, unknown> = { table: alias };
    if (columns?.length) relation['select'] = columns.filter((c) => c?.trim()).map((c) => c.trim());
    if (limit !== undefined) relation['limit'] = limit;
    this.selectItems.push(relation);
    return this;
  }

  /** Adds conditions. Multiple calls and multiple arguments are ANDed. */
  where(...filters: PraxFilter[]): this;
  where(column: string, value: unknown): this;
  where(...args: unknown[]): this {
    if (args.length === 2 && typeof args[0] === 'string') {
      this.whereItems.push(f.eq(args[0], args[1]));
      return this;
    }
    for (const filter of args as PraxFilter[]) if (filter) this.whereItems.push(filter);
    return this;
  }

  orderBy(column: string, dir: 'asc' | 'desc' = 'asc'): this {
    if (!column?.trim()) throw new TypeError('A column name is required.');
    this.orderItems.push({ field: column.trim(), dir });
    return this;
  }

  orderByDescending(column: string): this { return this.orderBy(column, 'desc'); }

  limit(n: number): this { this.limitValue = Math.max(1, n); return this; }
  offset(n: number): this { this.offsetValue = Math.max(0, n); return this; }

  /** Asks for the total match count alongside the page. Off by default - it costs a count pass. */
  withTotalCount(): this { this.totalCount = true; return this; }

  /**
   * Adds an aggregate. Aggregations must be enabled on the table scope (off by default), so a
   * 403 here is a scope problem, not a query problem.
   */
  aggregate(fn: string, column: string, alias: string): this {
    const normalized = fn?.trim().toLowerCase();
    if (!AGGREGATES.has(normalized)) {
      throw new TypeError(
        `Unsupported aggregate "${fn}". The gateway accepts ${[...AGGREGATES].join(', ')}.`
      );
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(alias ?? '')) {
      throw new TypeError(`Invalid aggregate alias "${alias}". Use letters, digits and underscore.`);
    }
    this.selectItems.push({ field: column?.trim() || '*', fn: normalized, alias: alias.trim() });
    return this;
  }

  groupBy(...columns: string[]): this {
    for (const c of columns) if (c?.trim()) this.groupItems.push(c.trim());
    return this;
  }

  having(...filters: PraxFilter[]): this {
    for (const filter of filters) if (filter) this.havingItems.push(filter);
    return this;
  }

  // ────────────────────────────────────────────────────────────── terminals

  /** Runs the query and returns the page plus its metadata. */
  async page(): Promise<PraxPage<T>> {
    const body = await this.data.execute(await this.build(), this.signal);
    return parsePage<T>(body);
  }

  /** Runs the query and returns the rows. */
  async all(): Promise<T[]> {
    return (await this.page()).rows;
  }

  /** The first matching row, or null. Fetches only one row. */
  async first(): Promise<T | null> {
    const saved = this.limitValue;
    this.limitValue = 1;
    try {
      const page = await this.page();
      return page.rows[0] ?? null;
    } finally {
      this.limitValue = saved;
    }
  }

  /** True when at least one row matches. */
  async any(): Promise<boolean> {
    return (await this.first()) !== null;
  }

  /**
   * The number of matching rows, ignoring limit and offset.
   *
   * Implemented with `includeTotalCount` plus a one-row fetch: the gateway clamps `limit` up to a
   * minimum of 1, so a zero-row request is not possible.
   */
  async count(): Promise<number> {
    const savedLimit = this.limitValue;
    const savedTotal = this.totalCount;
    const savedOffset = this.offsetValue;

    this.limitValue = 1;
    this.totalCount = true;
    this.offsetValue = undefined;

    try {
      const page = await this.page();
      if (page.total === null) {
        throw new TypeError(
          'The gateway did not return a total count. Aggregations may be disabled on this ' +
          "table's scope - enable them in API Gateway settings, or use aggregate('count','*','n')."
        );
      }
      return page.total;
    } finally {
      this.limitValue = savedLimit;
      this.totalCount = savedTotal;
      this.offsetValue = savedOffset;
    }
  }

  /** Builds the PraxQL request body. Exposed for tests and debugging. */
  async build(): Promise<Record<string, unknown>> {
    const refs: Record<string, string> = { [ROOT]: await this.data.resolveTable(this.table) };
    for (const [alias, name] of this.extraRefs) refs[alias] = await this.data.resolveTable(name);

    const query: Record<string, unknown> = { from: ROOT };
    if (this.selectItems.length) query['select'] = this.selectItems;
    if (this.whereItems.length) query['where'] = this.whereItems;
    if (this.orderItems.length) query['orderBy'] = this.orderItems;
    if (this.groupItems.length) query['groupBy'] = this.groupItems;
    if (this.havingItems.length) query['having'] = this.havingItems;
    if (this.limitValue !== undefined) query['limit'] = this.limitValue;
    if (this.offsetValue !== undefined) query['offset'] = this.offsetValue;

    const request: Record<string, unknown> = { refs, query };
    if (this.totalCount) request['includeTotalCount'] = true;
    return request;
  }
}

/**
 * Reads and writes table rows.
 *
 * Every call is authorised twice: the credential (or the signed-in user's role) must be scoped
 * to the table, and any row filter on that scope is applied on top of your conditions. A client
 * cannot widen either.
 *
 * There is deliberately no "act as user X" parameter. Identity comes from the caller's own token,
 * because only a value the server derives itself can scope anything.
 */
export class PraxData {
  constructor(private readonly client: PraxClient, private readonly schema: PraxSchema) {}

  /** Starts a query against a table, by name or GUID. */
  from<T = PraxRow>(table: string, signal?: AbortSignal): PraxQuery<T> {
    return new PraxQuery<T>(this, table, signal);
  }

  /** Fetches a single row by primary key. */
  get<T = PraxRow>(table: string, rowId: string, signal?: AbortSignal): Promise<T | null> {
    if (!rowId?.trim()) throw new TypeError('rowId is required.');
    return this.from<T>(table, signal).where(f.eq('ID', rowId)).first();
  }

  /**
   * Inserts one row.
   *
   * Do not include native columns (ID, CREATEDDATE, CREATEDBY, POSITION) - the backend fills
   * those and rejects a request that supplies them.
   */
  insert<T = PraxRow>(
    table: string,
    values: Record<string, unknown>,
    opts: { returning?: boolean; signal?: AbortSignal } = {}
  ): Promise<PraxMutationResult<T>> {
    if (!values || Object.keys(values).length === 0) {
      throw new TypeError('At least one column value is required.');
    }
    return this.insertMany<T>(table, [values], opts);
  }

  /** Inserts several rows in one request - one round trip, and one API call against the plan. */
  insertMany<T = PraxRow>(
    table: string,
    rows: Record<string, unknown>[],
    opts: { returning?: boolean; signal?: AbortSignal } = {}
  ): Promise<PraxMutationResult<T>> {
    const values = (rows ?? []).filter((r) => r && Object.keys(r).length > 0);
    if (values.length === 0) throw new TypeError('At least one row is required.');

    const mutation: Record<string, unknown> = { type: 'insert', table: ROOT, values };
    if (opts.returning !== false) mutation['returning'] = true;
    return this.mutate<T>(table, mutation, opts.signal);
  }

  /**
   * Updates rows matching `filters`.
   *
   * A filter is mandatory, and this throws SYNCHRONOUSLY rather than returning a rejected
   * promise. A caller who fires this without awaiting would otherwise get silence: no update,
   * no error, just an unhandled rejection. For a guardrail whose job is stopping an accidental
   * table-wide write, silence is the worst outcome.
   */
  update<T = PraxRow>(
    table: string,
    set: Record<string, unknown>,
    filters: PraxFilter[],
    signal?: AbortSignal
  ): Promise<PraxMutationResult<T>> {
    if (!set || Object.keys(set).length === 0) {
      throw new TypeError('At least one column to set is required.');
    }
    const where = (filters ?? []).filter(Boolean);
    if (where.length === 0) {
      throw new TypeError(
        'update() requires at least one filter. An update with no WHERE clause would rewrite ' +
        'every row the credential can reach, so both this SDK and the gateway refuse it. To ' +
        'target one row, filter on its ID.'
      );
    }
    return this.mutate<T>(table, { type: 'update', table: ROOT, set, where }, signal);
  }

  /** Updates a single row by primary key. */
  updateById<T = PraxRow>(
    table: string, rowId: string, set: Record<string, unknown>, signal?: AbortSignal
  ): Promise<PraxMutationResult<T>> {
    if (!rowId?.trim()) throw new TypeError('rowId is required.');
    return this.update<T>(table, set, [f.eq('ID', rowId)], signal);
  }

  /** Deletes rows matching `filters`. Throws synchronously without one, as `update` does. */
  delete<T = PraxRow>(table: string, filters: PraxFilter[], signal?: AbortSignal): Promise<PraxMutationResult<T>> {
    const where = (filters ?? []).filter(Boolean);
    if (where.length === 0) {
      throw new TypeError(
        'delete() requires at least one filter. A delete with no WHERE clause would empty the ' +
        'table, so both this SDK and the gateway refuse it.'
      );
    }
    return this.mutate<T>(table, { type: 'delete', table: ROOT, where }, signal);
  }

  /** Deletes a single row by primary key. */
  deleteById<T = PraxRow>(table: string, rowId: string, signal?: AbortSignal): Promise<PraxMutationResult<T>> {
    if (!rowId?.trim()) throw new TypeError('rowId is required.');
    return this.delete<T>(table, [f.eq('ID', rowId)], signal);
  }

  /**
   * Updates the row matching `filters`, or inserts one when none matches.
   *
   * This is two requests, not an atomic upsert - the gateway has no single-call upsert. Two
   * clients racing on the same key can both insert, so put anything contended behind an endpoint.
   */
  async upsert<T = PraxRow>(
    table: string,
    values: Record<string, unknown>,
    filters: PraxFilter[],
    signal?: AbortSignal
  ): Promise<PraxMutationResult<T>> {
    if (!values || Object.keys(values).length === 0) {
      throw new TypeError('At least one column value is required.');
    }
    const where = (filters ?? []).filter(Boolean);
    if (where.length === 0) throw new TypeError('upsert() needs a filter identifying the row to match.');

    const existing = await this.from<PraxRow>(table, signal).where(...where).select('ID').first();
    const id = existing?.['ID'];
    if (typeof id === 'string' && id) return this.updateById<T>(table, id, values, signal);
    return this.insert<T>(table, values, { signal });
  }

  /** Sends a hand-built PraxQL request. An escape hatch for shapes the builder does not cover. */
  execute(request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!request) throw new TypeError('A request body is required.');
    return this.client.request(
      'POST', routes.query(this.client.baseUrl, this.client.workspaceId), request, 'preferSession', signal
    );
  }

  resolveTable(nameOrId: string): Promise<string> {
    return this.schema.resolve(nameOrId);
  }

  private async mutate<T>(
    table: string, mutation: Record<string, unknown>, signal?: AbortSignal
  ): Promise<PraxMutationResult<T>> {
    const body = await this.execute(
      { refs: { [ROOT]: await this.resolveTable(table) }, mutation },
      signal
    );
    return parseMutation<T>(body);
  }
}
