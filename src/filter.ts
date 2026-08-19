/**
 * Where conditions.
 *
 * Only the operators the gateway's PraxQL parser actually accepts are exposed:
 *
 *   eq, neq, gt, gte, lt, lte, like, ilike, in, is, between, contains, textsearch
 *
 * There is deliberately no `notIn`, `startsWith` or `endsWith` helper. Those names look
 * reasonable but the server rejects them, so offering them would only produce runtime 400s on a
 * user's machine. Where a concept has no operator, the helper compiles down to one that exists:
 * `isNull` becomes `is null`, `startsWith` becomes a `like` with the wildcard already applied.
 */
export type PraxFilter =
  | { field: string; op: string; value?: unknown }
  | { or: PraxFilter[] }
  | { and: PraxFilter[] };

function simple(field: string, op: string, value?: unknown): PraxFilter {
  if (!field || !field.trim()) throw new TypeError('A column name is required.');
  return value === undefined ? { field: field.trim(), op } : { field: field.trim(), op, value };
}

export const f = {
  eq: (field: string, value: unknown): PraxFilter => simple(field, 'eq', value),
  neq: (field: string, value: unknown): PraxFilter => simple(field, 'neq', value),
  gt: (field: string, value: unknown): PraxFilter => simple(field, 'gt', value),
  gte: (field: string, value: unknown): PraxFilter => simple(field, 'gte', value),
  lt: (field: string, value: unknown): PraxFilter => simple(field, 'lt', value),
  lte: (field: string, value: unknown): PraxFilter => simple(field, 'lte', value),

  /** SQL LIKE, case-sensitive. You supply the wildcards. */
  like: (field: string, pattern: string): PraxFilter => simple(field, 'like', pattern),

  /** Case-insensitive LIKE. */
  ilike: (field: string, pattern: string): PraxFilter => simple(field, 'ilike', pattern),

  /** Substring match, no wildcards needed. */
  contains: (field: string, text: string): PraxFilter => simple(field, 'contains', text),

  /** Full-text search over the column. */
  textSearch: (field: string, query: string): PraxFilter => simple(field, 'textsearch', query),

  /** Prefix match. Compiles to `like 'value%'` since there is no startsWith operator. */
  startsWith: (field: string, value: string): PraxFilter => simple(field, 'like', `${value}%`),

  /** Suffix match. Compiles to `like '%value'`. */
  endsWith: (field: string, value: string): PraxFilter => simple(field, 'like', `%${value}`),

  /** field IN (...). At least one value is required. */
  in: (field: string, values: readonly unknown[]): PraxFilter => {
    if (!values || values.length === 0) {
      throw new TypeError(
        `in("${field}", ...) needs at least one value. An empty IN list matches nothing, which ` +
        'is almost never what a caller means - omit the filter instead.'
      );
    }
    return simple(field, 'in', [...values]);
  },

  /** field BETWEEN low AND high, inclusive. */
  between: (field: string, low: unknown, high: unknown): PraxFilter =>
    simple(field, 'between', [low, high]),

  /** field IS NULL. */
  isNull: (field: string): PraxFilter => ({ field: field.trim(), op: 'is', value: null }),

  /** field IS NOT NULL. Expressed as `neq null`, since `is` only tests for null. */
  isNotNull: (field: string): PraxFilter => ({ field: field.trim(), op: 'neq', value: null }),

  /** Matches when any child matches. */
  any: (...filters: PraxFilter[]): PraxFilter => {
    const kids = filters.filter(Boolean);
    if (kids.length === 0) throw new TypeError('any() needs at least one filter.');
    return { or: kids };
  },

  /**
   * Matches when every child matches. Top-level filters are already ANDed, so this is only
   * needed to nest an AND group inside an `any`.
   */
  all: (...filters: PraxFilter[]): PraxFilter => {
    const kids = filters.filter(Boolean);
    if (kids.length === 0) throw new TypeError('all() needs at least one filter.');
    return { and: kids };
  },
};
