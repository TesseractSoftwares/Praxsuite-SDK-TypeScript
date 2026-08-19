import type { PraxClient } from './client.js';
import { log } from './log.js';
import { routes } from './routes.js';

/**
 * Calls gateway endpoints - the server-authoritative half of the SDK.
 *
 * An endpoint is a URL in your workspace bound to an automation you built in the portal. The
 * client posts a payload; the automation decides what actually happens. Every rule a user must
 * not be able to break belongs here: granting currency or credit, submitting a score, spending a
 * balance, anything touching another user's data.
 *
 * The test: if a modified client sending an arbitrary payload could get something it should not,
 * that operation belongs in an endpoint and the table behind it must not be writable by the
 * user's role. A direct table write is right for a user's own cosmetic state - preferences,
 * last-viewed page - and wrong for anything with value.
 */
export class PraxEndpoints {
  constructor(private readonly client: PraxClient) {}

  /**
   * Calls a sync endpoint and returns the automation's response.
   *
   * The connection is held while the automation runs, so a slow automation shows up as a slow
   * call. The user's session token is attached automatically, so the automation can identify the
   * caller from a verified claim rather than trusting an id in the payload.
   */
  call<T = Record<string, unknown>>(
    slug: string,
    payload?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    if (!slug || !slug.trim()) throw new TypeError('An endpoint slug is required.');
    return this.client.request(
      'POST',
      routes.endpoint(this.client.baseUrl, this.client.workspaceId, slug.trim()),
      payload ?? null,
      'preferSession',
      signal
    ) as Promise<T>;
  }

  /**
   * Posts to an endpoint without caring about the result - telemetry, analytics, a
   * "user left the page" event.
   *
   * Never throws. A dropped analytics event must not surface as an unhandled rejection in the
   * middle of a user flow, and there is nothing useful for the caller to do about it. Returns
   * false when the call did not land, and logs why.
   */
  async fire(slug: string, payload?: unknown, signal?: AbortSignal): Promise<boolean> {
    if (!slug || !slug.trim()) {
      log.warn('fire() was called with no endpoint slug; ignoring it.');
      return false;
    }

    try {
      await this.client.request(
        'POST',
        routes.endpoint(this.client.baseUrl, this.client.workspaceId, slug.trim()),
        payload ?? null,
        'preferSession',
        signal
      );
      return true;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      log.warn('Endpoint "' + slug + '" did not accept the event (' + (e.code ?? 'error') + '): ' + e.message);
      return false;
    }
  }
}
