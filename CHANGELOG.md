# Changelog

All notable changes to the Praxsuite SDK for TypeScript.
This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-08-19

First release.

### Added

- **Setup is one field.** `createClient({ workspaceId })` — the publishable key is fetched from
  the workspace's public config endpoint on first use, so there is no second value to keep in
  sync and rotating it in the portal needs no redeploy.
- **Zero dependencies**, ESM, full types, `sideEffects: false` for tree shaking. Runs on Node 18+,
  browsers, Deno, Bun and React Native.
- **Auth** — register, sign in, sign out, rotating refresh tokens, password reset by emailed code,
  change password, resend confirmation, OIDC. `getWorkspaceConfig()` returns branding and enabled
  features for building a sign-in screen that matches the workspace.
- **Data** — fluent queries with filters, OR/AND groups, ordering, paging, total count, relations
  and aggregates; insert, insertMany, update, delete, upsert. Generic over your row types.
- **Endpoints** — `call()` for sync automations, `fire()` for fire-and-forget telemetry that never
  throws.
- **Schema** — address tables by name, or pass a GUID and skip the lookup entirely.
- Retry with exponential backoff, jitter and `Retry-After` for network errors, timeouts, 5xx and
  rate limits. Quota exhaustion is deliberately **not** retried.
- `AbortSignal` support on every method.

### Security

- A secret key (`sk_live_`) is refused at every client entry point, with no opt-out flag.
- A plaintext `http://` gateway URL to a remote host throws at construction; loopback is allowed.
- Credentials travel in headers, never in a URL or query string.
- All SDK logging is scrubbed of keys, JWTs and password/token fields.
- Sessions are in memory by default. `localStorage` persistence is opt-in and documents the
  tradeoff rather than making it silently.
- No client-supplied identity parameter, deliberately — only a value the server derives itself
  can scope anything.

### Verified

45 offline tests, mirroring the shared
[SDK conformance contract](https://github.com/TesseractSoftwares/Praxsuite-SDK-Conformance).
Notably pinned: mutation guardrails throw **synchronously** rather than as a rejected promise
(a caller who does not await must not get silence), `meta.total` is read rather than
`totalCount`, quota and rate limit classify oppositely despite sharing HTTP 429, and only the
operators the gateway implements are exposed.
