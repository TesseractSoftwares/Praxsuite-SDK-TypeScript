import { PraxError, PraxSecurityError } from './errors.js';
import { requireClientSafe, redact } from './keyguard.js';
import { log, setLogLevel } from './log.js';
import { CLOUD_HOST, isInsecureRemote, normalizeBaseUrl, routes } from './routes.js';
import { sendJson, type AuthMode, type TransportOptions } from './http.js';
import { unwrapEnvelope } from './rows.js';
import {
  MemoryTokenStore, LocalStorageTokenStore, isAccessStale, isRefreshExpired,
  type PraxSession, type PraxTokenStore,
} from './storage.js';

export interface PraxOptions {
  /** Workspace GUID. The only required value. */
  workspaceId: string;

  /** Gateway base URL. Defaults to Praxsuite Cloud. */
  baseUrl?: string;

  /**
   * Publishable key (`pk_live_`). Optional - when omitted the SDK fetches it from the workspace's
   * public config endpoint.
   *
   * A secret key here throws immediately. Secret keys belong in server code the user cannot read.
   */
  publishableKey?: string;

  timeoutMs?: number;
  maxRetries?: number;
  /** Refresh the access token this many seconds before it expires. */
  refreshLeadSeconds?: number;

  /**
   * Persist the session across page loads using `localStorage`. Off by default - read the note
   * on `LocalStorageTokenStore` before turning it on.
   */
  persistSession?: boolean;

  /** Supply your own session storage. Takes precedence over `persistSession`. */
  tokenStore?: PraxTokenStore;

  /** Log request and response bodies. Credentials are redacted; user data is not. */
  verbose?: boolean;

  /** Override the fetch implementation (tests, a proxy agent, an older runtime). */
  fetch?: typeof fetch;
}

/**
 * The SDK's core: configuration, credential resolution, and the signed-in session.
 *
 * You normally get this from `createClient()` rather than constructing it directly.
 */
export class PraxClient {
  readonly workspaceId: string;
  readonly baseUrl: string;
  readonly transport: TransportOptions;
  readonly refreshLeadSeconds: number;
  readonly tokenStore: PraxTokenStore;

  private publishableKey: string | null = null;
  private keyDiscovery: Promise<string> | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private session: PraxSession | null = null;
  private sessionLoaded = false;

  private readonly signedInHandlers = new Set<(s: PraxSession) => void>();
  private readonly signedOutHandlers = new Set<() => void>();

  constructor(options: PraxOptions) {
    if (!options?.workspaceId?.trim()) {
      throw new PraxError('INVALID_CONFIG', 'workspaceId is required.');
    }

    this.workspaceId = options.workspaceId.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? CLOUD_HOST);
    this.refreshLeadSeconds = options.refreshLeadSeconds ?? 60;

    if (options.verbose) setLogLevel('verbose');

    if (options.publishableKey?.trim()) {
      const key = options.publishableKey.trim();
      // Defence in depth: a key supplied at runtime has passed through no build-time check.
      requireClientSafe(key, 'PraxOptions.publishableKey');
      this.publishableKey = key;
    }

    if (isInsecureRemote(this.baseUrl)) {
      // Plaintext to a remote host would put the publishable key and every user's session token
      // on the wire in clear. Loopback is allowed for local development.
      throw new PraxSecurityError(
        `Refusing to use a plaintext http:// gateway URL for a remote host (${this.baseUrl}).\n` +
        'API keys and session tokens would travel unencrypted. Use https://, or point at ' +
        'localhost for local development.'
      );
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new PraxError(
        'NO_FETCH',
        'No fetch implementation is available. Node 18+ has one built in; on an older runtime, ' +
        'pass one via the `fetch` option.'
      );
    }

    this.transport = {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 3,
      fetchImpl,
    };

    this.tokenStore =
      options.tokenStore ??
      (options.persistSession ? new LocalStorageTokenStore(this.workspaceId) : new MemoryTokenStore());
  }

  // ─────────────────────────────────────────────────────────────── credentials

  /**
   * Returns the workspace publishable key, discovering it from the public `/auth/config`
   * endpoint when the app did not supply one.
   *
   * That endpoint is deliberately unauthenticated and returns only public information, the same
   * way a Stripe publishable key is public. Discovery runs once; concurrent callers share it.
   */
  async getPublishableKey(): Promise<string> {
    if (this.publishableKey) return this.publishableKey;
    if (this.keyDiscovery) return this.keyDiscovery;

    this.keyDiscovery = (async () => {
      log.info('No publishable key configured; fetching the workspace public config.');
      let body: Record<string, unknown>;
      try {
        body = await this.request('GET', routes.auth(this.baseUrl, this.workspaceId, 'config'), null, 'none');
      } catch (err) {
        if (err instanceof PraxError && err.status === 404) {
          throw new PraxError(
            'WORKSPACE_NOT_FOUND',
            `Workspace ${this.workspaceId} was not found at ${this.baseUrl}.\n\n` +
            'Either the workspace id is wrong, or the workspace lives on a different Praxsuite ' +
            'tier - a workspace hosted on another tier returns 404 here. Check the URL on your ' +
            "workspace's API Gateway settings page.",
            404
          );
        }
        this.keyDiscovery = null; // let a transient failure be retried
        throw err;
      }

      const key = typeof body['publicKey'] === 'string' ? body['publicKey'] : '';
      if (!key) {
        throw new PraxError(
          'NO_PUBLISHABLE_KEY',
          `Workspace ${this.workspaceId} has no credential marked publishable.\n\n` +
          'Create a client credential in the portal under API Gateway / Credentials, scope it to ' +
          'the minimum a public client needs, and mark it publishable.'
        );
      }

      // The endpoint is public; refuse a secret key rather than embed it in requests.
      requireClientSafe(key, 'the workspace public config endpoint');
      this.publishableKey = key;
      log.info(`Resolved publishable key ${redact(key)}.`);
      return key;
    })();

    return this.keyDiscovery;
  }

  /** Picks the credential for a request: the user's access token when wanted, else the key. */
  private resolveCredential = async (mode: AuthMode): Promise<string | null> => {
    if (mode === 'none') return null;

    if (mode === 'preferSession') {
      let session = this.currentSession;
      if (session?.accessToken) {
        // Refresh proactively so the request does not spend a round trip on a 401.
        if (session.refreshToken && isAccessStale(session, this.refreshLeadSeconds)) {
          await this.tryRefresh();
          session = this.currentSession;
        }
        if (session?.accessToken) return session.accessToken;
      }
    }

    return this.getPublishableKey();
  };

  // ───────────────────────────────────────────────────────────────── requests

  /** Sends a request through the shared transport. Used by every module. */
  request(
    method: string,
    url: string,
    body: unknown,
    authMode: AuthMode,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return sendJson(
      method, url, body, authMode, this.transport, this.resolveCredential,
      authMode === 'preferSession' ? () => this.tryRefresh() : undefined,
      signal
    );
  }

  // ───────────────────────────────────────────────────────────────── sessions

  /** The current session, loading a persisted one on first access. */
  get currentSession(): PraxSession | null {
    if (!this.sessionLoaded) {
      this.sessionLoaded = true;
      const stored = this.tokenStore.load();
      if (stored && isRefreshExpired(stored)) {
        log.info("The stored session's refresh token has expired; discarding it.");
        this.tokenStore.clear();
      } else if (stored) {
        this.session = stored;
        log.info(`Restored a stored session for ${stored.email ?? stored.userId}.`);
        this.emitSignedIn(stored);
      }
    }
    return this.session;
  }

  setSession(session: PraxSession | null): void {
    this.session = session;
    this.sessionLoaded = true;
    this.tokenStore.save(session);
    if (session) this.emitSignedIn(session);
    else this.emitSignedOut();
  }

  clearSession(): void {
    this.session = null;
    this.sessionLoaded = true;
    this.tokenStore.clear();
    this.emitSignedOut();
  }

  /**
   * Exchanges the refresh token for a new pair.
   *
   * Refresh tokens rotate: the gateway invalidates the old one as it issues the new one. Two
   * concurrent refreshes would therefore race, with the loser holding a token the server has
   * already retired - so callers share a single in-flight refresh.
   */
  tryRefresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const session = this.currentSession;
    if (!session?.refreshToken) return Promise.resolve(false);

    this.refreshInFlight = (async () => {
      try {
        const body = await this.request(
          'POST',
          routes.auth(this.baseUrl, this.workspaceId, 'refresh'),
          { refreshToken: session.refreshToken },
          'apiKey'
        );

        const refreshed = toSession(body);
        if (!refreshed?.accessToken) {
          log.warn('The refresh response carried no access token; signing out.');
          this.clearSession();
          return false;
        }

        // The refresh response carries tokens but not always the user block; losing the
        // profile mid-session would be a visible bug.
        this.setSession({
          ...refreshed,
          userId: refreshed.userId ?? session.userId,
          email: refreshed.email ?? session.email,
          username: refreshed.username ?? session.username,
          firstName: refreshed.firstName ?? session.firstName,
          lastName: refreshed.lastName ?? session.lastName,
          roles: refreshed.roles.length > 0 ? refreshed.roles : session.roles,
        });
        log.info('Session refreshed.');
        return true;
      } catch (err) {
        if (err instanceof PraxError && err.isTransient) {
          // Keep the session: the token may still be good once the network recovers.
          log.warn(`Could not refresh the session right now (${err.code}). Keeping it.`);
          return false;
        }
        log.info('The refresh token was rejected; signing out.');
        this.clearSession();
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  // ─────────────────────────────────────────────────────────────────── events

  onSignedIn(handler: (s: PraxSession) => void): () => void {
    this.signedInHandlers.add(handler);
    return () => this.signedInHandlers.delete(handler);
  }

  onSignedOut(handler: () => void): () => void {
    this.signedOutHandlers.add(handler);
    return () => this.signedOutHandlers.delete(handler);
  }

  private emitSignedIn(session: PraxSession): void {
    for (const h of this.signedInHandlers) {
      try { h(session); } catch (e) { log.error(`A signedIn handler threw: ${(e as Error).message}`); }
    }
  }

  private emitSignedOut(): void {
    for (const h of this.signedOutHandlers) {
      try { h(); } catch (e) { log.error(`A signedOut handler threw: ${(e as Error).message}`); }
    }
  }
}

/** Maps a gateway auth payload onto a session. Exported for reuse by the auth module. */
export function toSession(body: Record<string, unknown>): PraxSession | null {
  const payload = unwrapEnvelope(body);
  const accessToken = typeof payload['accessToken'] === 'string' ? payload['accessToken'] : '';
  if (!accessToken) return null;

  const user = (payload['user'] ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const unix = (v: unknown): number => {
    if (typeof v !== 'string' || !v) return 0;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  };

  return {
    accessToken,
    refreshToken: str(payload['refreshToken']),
    accessExpiresAt: unix(payload['accessTokenExpiresAt']),
    refreshExpiresAt: unix(payload['refreshTokenExpiresAt']),
    userId: str(user['id']) ?? str(payload['endUserId']),
    email: str(user['email']) ?? str(payload['email']),
    username: str(user['username']),
    firstName: str(user['firstName']),
    lastName: str(user['lastName']),
    roles: Array.isArray(user['roles']) ? (user['roles'] as unknown[]).map(String) : [],
  };
}
