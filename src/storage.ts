/** A signed-in user's session as the SDK holds it. */
export interface PraxSession {
  accessToken: string;
  refreshToken?: string;
  /** Access token expiry, epoch seconds. 0 when the gateway did not report one. */
  accessExpiresAt: number;
  refreshExpiresAt: number;
  userId?: string;
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  roles: string[];
}

/**
 * Where a session lives between calls, and optionally between page loads.
 *
 * Implement this to move sessions somewhere your platform trusts more - React Native's
 * encrypted storage, an httpOnly cookie set by your own backend, or nothing at all.
 */
export interface PraxTokenStore {
  load(): PraxSession | null;
  save(session: PraxSession | null): void;
  clear(): void;
}

/**
 * Keeps the session in memory only. The user signs in again on every page load.
 *
 * This is the default on purpose. Browser persistence is a real tradeoff (see
 * `LocalStorageTokenStore`) and an SDK should not quietly make that choice for you.
 */
export class MemoryTokenStore implements PraxTokenStore {
  private session: PraxSession | null = null;
  load(): PraxSession | null { return this.session; }
  save(session: PraxSession | null): void { this.session = session; }
  clear(): void { this.session = null; }
}

/**
 * Persists the session to `localStorage`.
 *
 * Understand the tradeoff before enabling it. `localStorage` is readable by any JavaScript
 * running on your origin, so an XSS bug becomes a stolen session - whereas an in-memory session
 * dies with the tab. The mitigation is not "store it better", it is to make a stolen session
 * worth little: keep authority server-side, give the user's role read-only scopes where you can,
 * and route anything valuable through a gateway endpoint.
 *
 * Falls back to memory when storage is unavailable (Safari private mode, disabled cookies, SSR).
 */
export class LocalStorageTokenStore implements PraxTokenStore {
  private readonly key: string;
  private readonly fallback = new MemoryTokenStore();
  private readonly available: boolean;

  constructor(workspaceId: string, keyPrefix = 'praxsuite.session') {
    // One entry per workspace, so switching workspaces in development cannot cross sessions.
    this.key = `${keyPrefix}.${workspaceId}`;
    this.available = LocalStorageTokenStore.probe();
  }

  private static probe(): boolean {
    try {
      if (typeof localStorage === 'undefined') return false;
      const probe = '__prax_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  load(): PraxSession | null {
    if (!this.available) return this.fallback.load();
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? (JSON.parse(raw) as PraxSession) : null;
    } catch {
      // A corrupt entry is not worth surfacing - fail closed and let the user sign in again.
      this.clear();
      return null;
    }
  }

  save(session: PraxSession | null): void {
    if (!this.available) return this.fallback.save(session);
    try {
      if (session) localStorage.setItem(this.key, JSON.stringify(session));
      else localStorage.removeItem(this.key);
    } catch {
      // Quota exceeded, or storage disabled mid-session. Degrading to memory is safe.
      this.fallback.save(session);
    }
  }

  clear(): void {
    if (!this.available) return this.fallback.clear();
    try { localStorage.removeItem(this.key); } catch { /* nothing useful to do */ }
  }
}

/** True when the access token is expired or within `leadSeconds` of it. */
export function isAccessStale(session: PraxSession, leadSeconds: number): boolean {
  if (!session.accessExpiresAt) return false; // unknown expiry - let a 401 drive the refresh
  return Date.now() / 1000 + leadSeconds >= session.accessExpiresAt;
}

export function isRefreshExpired(session: PraxSession): boolean {
  if (!session.refreshExpiresAt) return false;
  return Date.now() / 1000 >= session.refreshExpiresAt;
}
