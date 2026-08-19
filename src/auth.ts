import { toSession, type PraxClient } from './client.js';
import { PraxError } from './errors.js';
import { log } from './log.js';
import { routes } from './routes.js';
import { unwrapEnvelope } from './rows.js';
import type { PraxSession } from './storage.js';

export interface PraxUser {
  id?: string;
  email?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  roles: string[];
  /** Username, then full name, then the email local part - whichever exists. */
  displayName: string;
}

export interface PraxAuthResult {
  isSignedIn: boolean;
  user: PraxUser | null;
  /** True when the account exists but cannot sign in until the email link is clicked. */
  requiresEmailConfirmation: boolean;
  email?: string;
  emailVerified: boolean;
  postLoginRedirectUrl?: string;
}

/** A workspace's public configuration - publishable key, branding, enabled auth features. */
export interface PraxWorkspaceConfig {
  publishableKey?: string;
  workspaceName?: string;
  lightPrimary?: string;
  darkPrimary?: string;
  hasLogo: boolean;
  logoUrl?: string;
  defaultLanguage: string;
  requireEmailConfirmation: boolean;
  termsUrl?: string;
  privacyUrl?: string;
  enabledRegisterFields: string[];
  oidcProviders: string[];
}

function toUser(session: PraxSession | null): PraxUser | null {
  if (!session) return null;
  const full = [session.firstName, session.lastName].filter(Boolean).join(' ').trim();
  const local = session.email ? session.email.split('@')[0] : undefined;
  return {
    id: session.userId,
    email: session.email,
    username: session.username,
    firstName: session.firstName,
    lastName: session.lastName,
    roles: session.roles,
    displayName: session.username || full || local || 'User',
  };
}

function required(value: string | undefined, name: string): string {
  if (!value || !value.trim()) throw new TypeError(name + ' is required.');
  return value.trim();
}

/**
 * User accounts.
 *
 * This is what makes per-user data safe. On sign-in the gateway issues a JWT, and the workspace's
 * role scopes apply a row filter to every query made with it - typically "the Enduser column of
 * this row equals the caller's own id". That filter is applied server-side and cannot be
 * overridden by the client.
 *
 * Setting it up in the portal takes two settings, not one:
 *   1. On the role's TABLE scope, set the row filter to __SELF__ (covers select/update/delete).
 *   2. On the Enduser COLUMN's scope, set the default value template to {{claim:sub}}
 *      (covers insert, which a row filter cannot reach - an insert has no WHERE clause).
 *
 * Configure only the first and inserts land with a null owner that the filter then hides: the
 * user saves a record and cannot read it back, with no error anywhere.
 */
export class PraxAuth {
  constructor(private readonly client: PraxClient) {}

  get isSignedIn(): boolean {
    const session = this.client.currentSession;
    return !!(session && session.accessToken);
  }

  get currentUser(): PraxUser | null {
    return toUser(this.client.currentSession);
  }

  /** The signed-in user's id - the JWT `sub` claim a __SELF__ filter compares against. */
  get currentUserId(): string | undefined {
    const session = this.client.currentSession;
    return session ? session.userId : undefined;
  }

  onSignedIn(handler: (user: PraxUser) => void): () => void {
    return this.client.onSignedIn((s) => handler(toUser(s) as PraxUser));
  }

  onSignedOut(handler: () => void): () => void {
    return this.client.onSignedOut(handler);
  }

  /**
   * Fetches the workspace's public configuration. Requires no credential.
   *
   * Use it to build a sign-in screen that matches the workspace: its name, logo and colours, only
   * the registration fields it wants, only the social providers actually configured.
   */
  async getWorkspaceConfig(signal?: AbortSignal): Promise<PraxWorkspaceConfig> {
    const body = await this.client.request(
      'GET', routes.auth(this.client.baseUrl, this.client.workspaceId, 'config'), null, 'none', signal
    );

    const branding = (body['branding'] || {}) as Record<string, unknown>;
    const page = (body['authPageConfig'] || {}) as Record<string, unknown>;
    const providers = Array.isArray(body['oidcProviders']) ? (body['oidcProviders'] as unknown[]) : [];
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

    const logo = str(branding['logoUrl']);
    return {
      publishableKey: str(body['publicKey']),
      workspaceName: str(branding['name']),
      lightPrimary: str(branding['lightPrimary']),
      darkPrimary: str(branding['darkPrimary']),
      hasLogo: branding['hasLogo'] === true,
      // The gateway returns a workspace-relative logo path; make it usable directly.
      logoUrl: logo ? (logo.startsWith('http') ? logo : this.client.baseUrl + logo) : undefined,
      defaultLanguage: str(page['defaultLanguage']) || 'en',
      requireEmailConfirmation: page['requireEmailConfirmation'] === true,
      termsUrl: str(page['termsUrl']),
      privacyUrl: str(page['privacyUrl']),
      enabledRegisterFields: Array.isArray(page['enabledRegisterFields'])
        ? (page['enabledRegisterFields'] as unknown[]).map(String) : [],
      oidcProviders: providers
        .map((p) => (typeof p === 'string' ? p : str((p as Record<string, unknown>)['slug'])))
        .filter((s): s is string => !!s),
    };
  }

  /**
   * Creates an account and signs the user in.
   *
   * When the workspace requires email confirmation the account is created but no session is
   * issued: the result carries `requiresEmailConfirmation` with `isSignedIn` false. Check it
   * before moving the user past your sign-in screen.
   */
  async register(input: {
    email: string; password: string; username?: string; firstName?: string; lastName?: string;
  }, signal?: AbortSignal): Promise<PraxAuthResult> {
    const payload: Record<string, unknown> = {
      email: required(input && input.email, 'email'),
      password: required(input && input.password, 'password'),
    };
    if (input.username && input.username.trim()) payload['username'] = input.username.trim();
    if (input.firstName && input.firstName.trim()) payload['firstName'] = input.firstName.trim();
    if (input.lastName && input.lastName.trim()) payload['lastName'] = input.lastName.trim();

    return this.completeAuth(await this.post('register', payload, signal));
  }

  /** Signs a user in and stores their session. */
  async login(email: string, password: string, signal?: AbortSignal): Promise<PraxAuthResult> {
    const body = await this.post('login', {
      email: required(email, 'email'),
      password: required(password, 'password'),
    }, signal);

    const result = this.completeAuth(body);
    if (!result.isSignedIn && result.requiresEmailConfirmation) {
      log.info('Sign-in blocked: this account has not confirmed its email address yet.');
    }
    return result;
  }

  /**
   * Signs out: revokes the refresh token server-side and clears local state.
   *
   * Local state is cleared even when the network call fails, so a user is never left looking
   * signed in with a session the SDK has given up on.
   */
  async logout(signal?: AbortSignal): Promise<void> {
    const session = this.client.currentSession;
    const refreshToken = session ? session.refreshToken : undefined;
    this.client.clearSession();
    if (!refreshToken) return;

    try {
      await this.post('logout', { refreshToken }, signal);
    } catch (err) {
      log.warn('Signed out locally, but the server-side revoke failed: ' + (err as PraxError).code);
    }
  }

  /** Forces a token refresh. The SDK already refreshes on its own; this is rarely needed. */
  refresh(): Promise<boolean> {
    return this.client.tryRefresh();
  }

  /**
   * Emails a 6-digit reset code.
   *
   * Always succeeds, whether or not the address exists - the gateway does that deliberately so
   * the response cannot be used to enumerate accounts. Show the same message either way.
   */
  async forgotPassword(email: string, signal?: AbortSignal): Promise<void> {
    await this.post('forgot-password', { email: required(email, 'email') }, signal);
  }

  /** Verifies the code and returns a short-lived token for `resetPassword`. */
  async verifyResetCode(email: string, code: string, signal?: AbortSignal): Promise<string> {
    const body = await this.post('verify-reset-code', {
      email: required(email, 'email'), code: required(code, 'code'),
    }, signal);

    const token = unwrapEnvelope(body)['sessionToken'];
    if (typeof token !== 'string' || !token) {
      throw new PraxError('INVALID_RESET_CODE', 'The reset code was not accepted. It may be wrong or expired.');
    }
    return token;
  }

  /** Sets a new password using the token from `verifyResetCode`. */
  async resetPassword(sessionToken: string, newPassword: string, signal?: AbortSignal): Promise<void> {
    await this.post('reset-password', {
      sessionToken: required(sessionToken, 'sessionToken'),
      newPassword: required(newPassword, 'newPassword'),
      confirmPassword: required(newPassword, 'newPassword'),
    }, signal);
  }

  /** Changes the signed-in user's password. The one auth route authenticated by the user's token. */
  async changePassword(currentPassword: string, newPassword: string, signal?: AbortSignal): Promise<void> {
    if (!this.isSignedIn) {
      throw new PraxError('NOT_SIGNED_IN',
        'changePassword needs a signed-in user. Use forgotPassword for someone who cannot sign in.');
    }
    await this.client.request(
      'POST', routes.auth(this.client.baseUrl, this.client.workspaceId, 'change-password'),
      {
        currentPassword: required(currentPassword, 'currentPassword'),
        newPassword: required(newPassword, 'newPassword'),
        confirmPassword: required(newPassword, 'newPassword'),
      },
      'preferSession', signal
    );
  }

  /** Resends the confirmation email. Like forgotPassword, always reports success. */
  async resendConfirmation(email: string, signal?: AbortSignal): Promise<void> {
    await this.post('resend-confirmation', { email: required(email, 'email') }, signal);
  }

  /** Returns the provider URL to open for a social or enterprise sign-in. */
  async getOidcUrl(providerSlug: string, signal?: AbortSignal): Promise<string> {
    const slug = encodeURIComponent(required(providerSlug, 'providerSlug'));
    const body = await this.client.request(
      'GET', routes.auth(this.client.baseUrl, this.client.workspaceId, 'oidc/' + slug), null, 'apiKey', signal
    );
    const payload = unwrapEnvelope(body);
    const url = payload['authorizationUrl'] || payload['url'];
    if (typeof url !== 'string' || !url) {
      throw new PraxError('OIDC_NO_URL',
        'The gateway returned no authorization URL for provider "' + providerSlug + '". Check that ' +
        'it is configured and enabled for this workspace.');
    }
    return url;
  }

  /** Completes an OIDC sign-in by exchanging the provider's code for a session. */
  async completeOidcLogin(code: string, state?: string, signal?: AbortSignal): Promise<PraxAuthResult> {
    const payload: Record<string, unknown> = { code: required(code, 'code') };
    if (state) payload['state'] = state;
    return this.completeAuth(await this.post('oidc/callback', payload, signal));
  }

  private post(action: string, payload: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.client.request(
      'POST', routes.auth(this.client.baseUrl, this.client.workspaceId, action), payload, 'apiKey', signal
    );
  }

  private completeAuth(body: Record<string, unknown>): PraxAuthResult {
    const session = toSession(body);
    if (session) this.client.setSession(session);

    const payload = unwrapEnvelope(body);
    const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
    return {
      isSignedIn: !!(session && session.accessToken),
      user: toUser(session),
      requiresEmailConfirmation: payload['requiresEmailConfirmation'] === true,
      email: email || (session ? session.email : undefined),
      emailVerified: payload['emailVerified'] === true,
      postLoginRedirectUrl: typeof payload['postLoginRedirectUrl'] === 'string'
        ? payload['postLoginRedirectUrl'] : undefined,
    };
  }
}
