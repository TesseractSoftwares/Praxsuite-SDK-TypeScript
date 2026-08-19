/**
 * Every failure the gateway reports surfaces as a `PraxError`. The `code` is stable and safe to
 * branch on; `message` is human-facing and may change between releases.
 */
export class PraxError extends Error {
  /** Stable machine-readable code, e.g. RATE_LIMIT_EXCEEDED, FORBIDDEN, NETWORK_ERROR. */
  readonly code: string;

  /** HTTP status, or 0 for transport failures that never reached the gateway. */
  readonly status: number;

  /** Per-field validation details, when the gateway supplied them. */
  readonly details: readonly string[];

  /** Raw response body, kept for diagnostics. Never contains your API key. */
  readonly body?: string;

  constructor(code: string, message: string, status = 0, details: readonly string[] = [], body?: string) {
    super(message);
    this.name = 'PraxError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.body = body;

    // Without this, `instanceof PraxError` fails when the package is compiled down to ES5 by a
    // consumer's bundler - a subclassed Error loses its prototype chain.
    Object.setPrototypeOf(this, PraxError.prototype);
  }

  /** Credential missing, malformed, expired, or the session needs a refresh. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  /** Authenticated, but this credential or role is not scoped for the operation. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Too many calls per minute. Backing off and retrying will succeed. */
  get isRateLimited(): boolean {
    return this.code === 'RATE_LIMIT_EXCEEDED';
  }

  /**
   * A plan allowance is exhausted. Retrying will NOT help - the workspace owner has to upgrade
   * or enable pay-as-you-go. Shares HTTP 429 with a rate limit, which is exactly why this is a
   * separate check rather than a status comparison.
   */
  get isQuotaExceeded(): boolean {
    return this.code === 'QUOTA_EXCEEDED' || this.code === 'EGRESS_LIMIT_EXCEEDED';
  }

  /** Transport failure: offline, DNS, TLS, or timeout. */
  get isNetworkError(): boolean {
    return this.code === 'NETWORK_ERROR' || this.code === 'TIMEOUT';
  }

  /** Worth retrying automatically. Quota exhaustion deliberately is not. */
  get isTransient(): boolean {
    if (this.isQuotaExceeded) return false;
    return this.isNetworkError || this.isRateLimited || (this.status >= 500 && this.status <= 599);
  }

  override toString(): string {
    let s = `[Praxsuite] ${this.code}`;
    if (this.status > 0) s += ` (HTTP ${this.status})`;
    s += `: ${this.message}`;
    if (this.details.length > 0) s += `\n  - ${this.details.join('\n  - ')}`;
    return s;
  }
}

/** Thrown when the SDK blocks an operation that would expose credentials or user data. */
export class PraxSecurityError extends PraxError {
  constructor(message: string) {
    super('SECURITY', message);
    this.name = 'PraxSecurityError';
    Object.setPrototypeOf(this, PraxSecurityError.prototype);
  }
}
