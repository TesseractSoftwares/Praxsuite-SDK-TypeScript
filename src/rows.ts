import { PraxError } from './errors.js';

/** A single row, as the gateway returned it. */
export type PraxRow = Record<string, unknown>;

/** A page of rows plus the query's metadata. */
export interface PraxPage<T = PraxRow> {
  rows: T[];
  /** Rows in this page. */
  count: number;
  /** The limit actually applied - the server caps it per table scope, so this may be lower than requested. */
  limit: number;
  offset: number;
  /**
   * Total matching rows ignoring limit and offset. `null` unless the query asked for it via
   * `withTotalCount()`, since counting costs an extra pass. Deliberately null rather than 0, so
   * "no rows" stays distinguishable from "not counted".
   */
  total: number | null;
  durationMs: number;
  /** True when more rows may exist past this page. */
  hasMore: boolean;
}

/** Result of an insert, update or delete. */
export interface PraxMutationResult<T = PraxRow> {
  affectedRows: number;
  /** Rows returned by an insert with `returning` enabled. Empty otherwise. */
  rows: T[];
  /** The first returned row, or undefined. */
  row?: T;
  durationMs: number;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * Reads the `data` array and `meta` block of a PraxQL query response.
 *
 * The total-count field is named `total`. Reading a differently-named field returns undefined
 * and reports zero forever rather than failing - a mistake that shipped in another SDK and went
 * unnoticed for months, which is why it is pinned by a conformance case.
 */
export function parsePage<T = PraxRow>(body: Record<string, unknown>): PraxPage<T> {
  const data = Array.isArray(body?.['data']) ? (body['data'] as T[]) : [];
  const meta = (body?.['meta'] ?? {}) as Record<string, unknown>;

  const count = meta['count'] !== undefined ? asNumber(meta['count']) : data.length;
  const limit = asNumber(meta['limit']);
  const offset = asNumber(meta['offset']);
  const total = meta['total'] === undefined || meta['total'] === null ? null : asNumber(meta['total']);

  return {
    rows: data,
    count,
    limit,
    offset,
    total,
    durationMs: asNumber(meta['durationMs']),
    hasMore: total !== null ? offset + count < total : count >= limit && limit > 0,
  };
}

/** Reads a mutation response. */
export function parseMutation<T = PraxRow>(body: Record<string, unknown>): PraxMutationResult<T> {
  const data = Array.isArray(body?.['data']) ? (body['data'] as T[]) : [];
  const meta = (body?.['meta'] ?? {}) as Record<string, unknown>;

  return {
    affectedRows: asNumber(body?.['affectedRows']),
    rows: data,
    row: data[0],
    durationMs: asNumber(meta['durationMs']),
  };
}

/**
 * Unwraps the platform response envelope used by `/auth/*` and management routes:
 * `{ isSuccess, message, errors, data }`. The payload sits under `.data`.
 *
 * Deliberately NOT applied to `/query`, whose body IS the result. An SDK that unwraps both, or
 * neither, breaks one of them.
 */
export function unwrapEnvelope(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!body) return {};
  const data = body['data'];
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return body;
}

/**
 * Builds a typed error from a non-2xx body, handling all three shapes the gateway uses:
 * `{error:{code,message,details}}` from /query, `{isSuccess,message,errors}` from /auth,
 * and a bare `{error:"..."}` from /files.
 */
export function parseError(status: number, rawBody: string | undefined): PraxError {
  let code: string | undefined;
  let message: string | undefined;
  let details: string[] | undefined;

  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      const errNode = parsed['error'];

      if (errNode && typeof errNode === 'object') {
        const e = errNode as Record<string, unknown>;
        code = typeof e['code'] === 'string' ? e['code'] : undefined;
        message = typeof e['message'] === 'string' ? e['message'] : undefined;
        if (Array.isArray(e['details'])) details = (e['details'] as unknown[]).map(String);
      } else if (typeof errNode === 'string') {
        message = errNode;
      } else {
        if (typeof parsed['message'] === 'string') message = parsed['message'];
        if (Array.isArray(parsed['errors']) && parsed['errors'].length > 0) {
          details = (parsed['errors'] as unknown[]).map(String);
        }
      }
    } catch {
      // Not JSON - an HTML error page from an edge proxy, most likely.
      message = rawBody.slice(0, 400);
    }
  }

  return new PraxError(code ?? `HTTP_${status}`, message ?? describeStatus(status), status, details ?? [], rawBody);
}

function describeStatus(status: number): string {
  switch (status) {
    case 400: return 'The gateway rejected the request as malformed.';
    case 401: return 'Not authenticated. The API key or session token is missing, expired, or does not belong to this workspace.';
    case 403: return "Authenticated, but not permitted. Check the credential's or role's table scopes in API Gateway settings.";
    case 404: return 'Not found. Verify the workspace id, and that you are pointed at the tier that hosts it - a workspace on another tier returns 404 here.';
    case 413: return 'The payload is larger than the workspace plan allows.';
    case 429: return 'Rate limited or out of plan allowance.';
    case 500: return 'The gateway hit an internal error.';
    case 502:
    case 503:
    case 504: return 'The gateway is unavailable or timed out upstream.';
    default: return `The gateway returned HTTP ${status}.`;
  }
}
