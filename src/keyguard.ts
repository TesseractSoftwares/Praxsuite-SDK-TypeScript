import { PraxSecurityError } from './errors.js';

export const PUBLISHABLE_PREFIX = 'pk_live_';
export const SECRET_PREFIX = 'sk_live_';

export type KeyKind = 'unknown' | 'publishable' | 'secret' | 'jwt';

/**
 * Classifies Praxsuite credentials and refuses to let a secret key reach client code.
 *
 * Praxsuite issues two kinds of gateway credential. A publishable key (pk_live_) identifies the
 * workspace and carries only the scopes an administrator granted it - safe in a browser bundle.
 * A secret key (sk_live_) carries full credential scope; anyone who extracts it from shipped
 * JavaScript gains that access.
 *
 * The check is deliberately unconditional. There is no opt-out flag, because every
 * "just for testing" opt-out eventually ships.
 */
export function classify(credential: string | null | undefined): KeyKind {
  if (!credential) return 'unknown';
  if (credential.startsWith(SECRET_PREFIX)) return 'secret';
  if (credential.startsWith(PUBLISHABLE_PREFIX)) return 'publishable';

  // A JWT is header.payload.signature - exactly two dots, no whitespace.
  let dots = 0;
  for (const ch of credential) {
    if (ch === '.') dots++;
    else if (/\s/.test(ch)) return 'unknown';
  }
  return dots === 2 ? 'jwt' : 'unknown';
}

/** Throws if `credential` must not be used from client code. */
export function requireClientSafe(credential: string | null | undefined, context: string): void {
  if (classify(credential) !== 'secret') return;

  throw new PraxSecurityError(
    `Refusing to use a secret key (${SECRET_PREFIX}...) from client code in ${context}.\n\n` +
    'A secret key placed in a browser bundle, a mobile app, or any code a user can run ships to ' +
    'that user. Anyone who opens devtools gains that key\'s full access to your workspace.\n\n' +
    `Use a publishable key (${PUBLISHABLE_PREFIX}...) here instead, and give each user their own ` +
    'identity with prax.auth.login(). Row-level filters then scope every read and write to that ' +
    'user, server-side.\n\n' +
    'If you need secret-key access, it belongs in server code the user cannot read - an API ' +
    'route, a worker, a backend service - reading the key from an environment variable.\n\n' +
    'See SECURITY.md.'
  );
}

/**
 * Masks a credential for logs and error messages. Keeps enough to identify which key was used
 * without disclosing it.
 */
export function redact(credential: string | null | undefined): string {
  if (!credential) return '(none)';
  switch (classify(credential)) {
    case 'jwt':
      return '(session token)';
    case 'publishable':
    case 'secret':
      // The prefix is public information; the entropy after it is not.
      return credential.slice(0, Math.min(credential.length, PUBLISHABLE_PREFIX.length + 4)) + '...';
    default:
      return '(redacted)';
  }
}
