# Changelog

All notable changes to the Praxsuite SDK for TypeScript.
This project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-09-07

### Added

- **`prax.bus` - the Event Bus.** Ephemeral realtime between connected clients: cursors, avatars,
  typing indicators, multiplayer state. `prax.bus.topic('office').channel('hq')` gives a channel
  with `join()`, `publish()`, `leave()` and `on()`, plus presence and the caller's own
  `prax.bus.self` bus. Reconnects with backoff and re-joins every channel, because SignalR group
  membership does not survive a reconnect and a client that only reconnects is connected, in no
  groups, and silent.

  The SDK speaks SignalR's JSON protocol directly rather than depending on `@microsoft/signalr`:
  the surface is four message types wide, this package ships with zero dependencies, and the
  official client defaults `withCredentials` to true - which is exactly the setting that makes the
  handshake fail against our gateway, since the CORS spec forbids answering a credentialed request
  with the wildcard origin the front door sends.

- **`auth.startOidcLogin`**, which returns the `state` alongside the URL instead of making callers
  re-parse it out of the query string, and **`getWorkspaceConfig().providers`**, which carries each
  provider's display name so a button can be labelled.

### Fixed

- **`completeOidcLogin` could never succeed.** It sent `{ code, state }`, and the gateway requires
  `providerSlug` and `redirectUri` as well: the one-time state is scoped per provider, so omitting
  the slug makes every callback look expired, and the redirect URI is compared against the value
  configured for that provider. The signature is now
  `completeOidcLogin(providerSlug, code, state, redirectUri)`. This is a breaking change to a call
  that returned 401 or 400 every time it was made.

## [1.0.1] - 2026-08-22

No API changes. This release exists because the 1.0.0 artifact was empty.

### Fixed

- **The published 1.0.0 tarball contained no code.** The publish stage is a fresh checkout, and it
  ran `npm pack` without `npm ci && npm run build` first - so `dist/` did not exist, and because
  `package.json` lists `dist` under `files`, npm packed a missing directory without complaining.
  The release asset was 7 KB of README, LICENSE, SECURITY and package.json. Every gate passed,
  because each one checked that an artifact existed rather than that it was usable.

  The publish stage now builds, and asserts the tarball carries at least five `.js` and five
  `.d.ts` files before anything is uploaded. The npm step re-reads `dist.unpackedSize` from the
  registry afterwards and fails if it looks empty.

- `publishConfig.access` is now `public`. A scoped package publishes as restricted by default,
  which a free organisation cannot host - it would have failed with a 402 that reads like a
  billing problem rather than a configuration one.

### Added

- Published to npm as `@praxsuite/sdk`.

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

45 offline tests, pinning the wire shapes every Praxsuite SDK implements identically.
Notably: mutation guardrails throw **synchronously** rather than as a rejected promise
(a caller who does not await must not get silence), `meta.total` is read rather than
`totalCount`, quota and rate limit classify oppositely despite sharing HTTP 429, and only the
operators the gateway implements are exposed.
