/**
 * SDK logging. Every message passes through `scrub`, so a credential or bearer token cannot
 * reach the console, a log aggregator, or an error reporter that a user might see.
 */
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'verbose';

const ORDER: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, verbose: 4 };

/** Defaults to `warn`. Raised to `verbose` by the `verbose` client option. */
export let minimumLevel: LogLevel = 'warn';

export function setLogLevel(level: LogLevel): void {
  minimumLevel = level;
}

const KEY_PATTERN = /\b(pk|sk)_live_[A-Za-z0-9]+/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;
const SECRET_FIELD_PATTERN =
  /"(refreshToken|accessToken|password|newPassword|currentPassword|confirmPassword|sessionToken|publicKey)"\s*:\s*"[^"]*"/gi;

/**
 * Removes credentials from a string. Exported because callers building their own diagnostics
 * should run untrusted text through it too.
 */
export function scrub(text: string): string {
  if (!text) return text;
  return text
    .replace(KEY_PATTERN, (_m, p1: string) => `${p1}_live_<redacted>`)
    .replace(JWT_PATTERN, '<jwt redacted>')
    .replace(SECRET_FIELD_PATTERN, (m) => `${m.slice(0, m.indexOf(':') + 1)}"<redacted>"`);
}

function emit(level: LogLevel, fn: (m: string) => void, message: string): void {
  if (ORDER[minimumLevel] >= ORDER[level]) fn(`[Praxsuite] ${scrub(message)}`);
}

export const log = {
  error: (m: string) => emit('error', console.error, m),
  warn: (m: string) => emit('warn', console.warn, m),
  info: (m: string) => emit('info', console.info, m),
  verbose: (m: string) => emit('verbose', console.debug, m),
};
