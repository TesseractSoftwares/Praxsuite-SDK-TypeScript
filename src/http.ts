import { PraxError } from './errors.js';
import { classify, redact } from './keyguard.js';
import { log } from './log.js';
import { parseError } from './rows.js';

export type AuthMode = 'apiKey' | 'preferSession' | 'none';

export interface TransportOptions {
  timeoutMs: number;
  maxRetries: number;
  fetchImpl: typeof fetch;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Attaches the credential to a request.
 *
 * The gateway accepts either header. `x-api-key` carries keys and `Authorization` carries
 * session tokens, matching how the backend middleware documents them - the distinction keeps
 * gateway access logs readable.
 */
function applyCredential(headers: Headers, credential: string | null): void {
  if (!credential) return;
  if (classify(credential) === 'jwt') headers.set('Authorization', `Bearer ${credential}`);
  else headers.set('x-api-key', credential);
}

function backoffMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  const base = 2 ** (attempt - 1) * 1000;
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.min(Math.max(base + jitter, 100), MAX_BACKOFF_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a request, retrying transient failures, and maps any non-2xx into a `PraxError`.
 *
 * `resolveCredential` is a callback rather than a value because the credential may change
 * between attempts - a 401 triggers a token refresh, and the replay must use the new token.
 */
export async function send(
  method: string,
  url: string,
  body: unknown,
  authMode: AuthMode,
  opts: TransportOptions,
  resolveCredential: (mode: AuthMode) => Promise<string | null>,
  onUnauthorized?: () => Promise<boolean>,
  signal?: AbortSignal
): Promise<{ status: number; text: string }> {
  const attempts = opts.maxRetries + 1;
  let refreshAttempted = false;

  for (let attempt = 1; ; attempt++) {
    const credential = await resolveCredential(authMode);

    const headers = new Headers({ Accept: 'application/json' });
    let payload: string | undefined;
    if (body !== undefined && body !== null) {
      payload = JSON.stringify(body);
      headers.set('Content-Type', 'application/json');
    }
    applyCredential(headers, credential);

    log.verbose(`${method} ${url} auth=${redact(credential)}${payload ? ` body=${payload}` : ''}`);

    // A timeout has to abort the request itself, not just stop waiting on it, or a hung
    // connection keeps a socket open for the life of the process.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), opts.timeoutMs);
    const onExternalAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onExternalAbort);

    let response: Response;
    try {
      response = await opts.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: timeoutController.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);

      // An external cancel is the caller's intent, not a failure to retry.
      if (signal?.aborted) throw new PraxError('CANCELLED', 'The request was cancelled.');

      const timedOut = timeoutController.signal.aborted;
      const error = new PraxError(
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        timedOut
          ? `The request to ${url} timed out after ${opts.timeoutMs}ms.`
          : `Could not reach the Praxsuite gateway: ${(cause as Error)?.message ?? cause}\nURL: ${url}`
      );
      if (attempt >= attempts) throw error;
      const delay = backoffMs(null, attempt);
      log.warn(`Attempt ${attempt}/${attempts} failed (${error.code}). Retrying in ${Math.round(delay)}ms.`);
      await sleep(delay);
      continue;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }

    const text = await response.text();

    if (response.ok) {
      log.verbose(`HTTP ${response.status} <- ${url} (${text.length} bytes)`);
      return { status: response.status, text };
    }

    const error = parseError(response.status, text);

    // A 401 on a session-backed call usually means the access token aged out between our expiry
    // check and the server's. Refresh once and replay; if the refresh itself fails the session
    // is genuinely gone.
    if (response.status === 401 && authMode === 'preferSession' && !refreshAttempted && onUnauthorized) {
      refreshAttempted = true;
      if (await onUnauthorized()) {
        log.info('Access token was rejected; refreshed the session and retrying.');
        continue;
      }
    }

    if (!error.isTransient || attempt >= attempts) throw error;

    const delay = backoffMs(response, attempt);
    log.warn(`Attempt ${attempt}/${attempts} failed (${error.code}). Retrying in ${Math.round(delay)}ms.`);
    await sleep(delay);
  }
}

/** Sends a request and parses a JSON response body. */
export async function sendJson(
  method: string,
  url: string,
  body: unknown,
  authMode: AuthMode,
  opts: TransportOptions,
  resolveCredential: (mode: AuthMode) => Promise<string | null>,
  onUnauthorized?: () => Promise<boolean>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const { status, text } = await send(method, url, body, authMode, opts, resolveCredential, onUnauthorized, signal);
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PraxError(
      'MALFORMED_RESPONSE',
      'The gateway returned a body that is not valid JSON.',
      status,
      [],
      text
    );
  }
}
