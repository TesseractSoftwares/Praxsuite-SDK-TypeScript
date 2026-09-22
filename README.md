# Praxsuite SDK for TypeScript

[![CI](https://github.com/TesseractSoftwares/Praxsuite-SDK-TypeScript/actions/workflows/ci.yml/badge.svg)](https://github.com/TesseractSoftwares/Praxsuite-SDK-TypeScript/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-Praxsuite%20Open%20SDK-blue)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](package.json)
[![Types](https://img.shields.io/badge/types-included-blue)](package.json)

Auth, queries, files and server-authoritative logic for your Praxsuite workspace — in the browser,
Node, Deno, Bun or React Native.

Zero dependencies. One field to configure. Refuses to let a secret key reach client code.

---

## Guides

- [Use Case](https://learn.praxsuite.com/examples/typescript/typescript-sdk-use-case/)
- [Implementation](https://learn.praxsuite.com/examples/typescript/typescript-sdk-implementation/)

## Install

```bash
npm install @praxsuite/sdk
```

Needs a runtime with `fetch` — Node 18+, any modern browser, Deno, Bun. On anything older, pass
your own via the `fetch` option.

## Use

```ts
import { createClient, f } from '@praxsuite/sdk';

const prax = createClient({ workspaceId: 'your-workspace-guid' });

// Sign a user in.
await prax.auth.login(email, password);

// Read their own row. No user id anywhere: the server's row filter scopes it to them.
const save = await prax.data.from('Saves').first();

// Query properly — filters, ordering, paging, aggregates all run in Postgres.
const top = await prax.data.from('Scores')
  .select('PlayerName', 'Score')
  .where(f.gte('Score', 1000))
  .orderByDescending('Score')
  .limit(10)
  .all();

// Anything a user shouldn't be able to forge goes through the server.
const reward = await prax.endpoints.call('claim-daily-reward');
```

That's the whole setup — the publishable key is fetched from the workspace's public config
endpoint on first use, so there's no second value to keep in sync and rotating it in the portal
needs no redeploy.

> **One thing to get right:** Praxsuite runs several independent tiers and a workspace lives on
> exactly one. Point at the wrong host and every call returns 404 — not an error that explains
> itself. Pass `baseUrl` to match your workspace's API Gateway settings page.

---

## What's in it

| | |
|---|---|
| `prax.auth` | Register, sign in, sessions with rotating refresh tokens, password reset, email confirmation, OIDC |
| `prax.data` | Queries with filters, OR/AND groups, ordering, paging, relations and aggregates; insert, update, delete, upsert |
| `prax.endpoints` | Call gateway automations — the server-authoritative path |
| `prax.schema` | Address tables by name instead of GUID |
| `prax.bus` | The Event Bus - ephemeral realtime between connected clients |

Everything is typed. Pass a row type to get it back: `prax.data.from<Score>('Scores')`.

---

## The Event Bus

Live cursors, avatars, "user is typing", a multiplayer lobby. State that is *changing*, where
losing a message is fine because a newer one is 100ms behind it.

```ts
await prax.auth.login(email, password);   // the bus needs a signed-in user, not the workspace key

const room = prax.bus.topic('office').channel('hq');   // the bus "office:hq"

room.on('move', (e) => moveAvatar(e.fromUserId, e.payload));
room.onPeerLeft((userId) => removeAvatar(userId));

// join() returns everyone already there, so a late arrival sees the room instead of an
// empty one until somebody happens to move.
for (const peer of await room.join()) moveAvatar(peer.userId, peer.payload);

await room.publish('move', { x, y });
```

**A topic must exist before anyone can join it.** Declare it once in the portal under
API Gateway / Event Bus (or with the `create_bus_topic` MCP tool) and pick its access rule:
open to any signed-in user, gated on a role from their token, or gated on a grant on that one bus
instance. An undeclared topic is refused - which is what stops somebody else's client squatting in
your namespace.

`prax.bus.self` is the caller's own bus, `user:self`. The server resolves it to your id, so it can
never address anybody else, and it is how you reach one user across their open tabs.

Three things about it are not obvious and will bite:

- **Nothing is persisted.** No history, no retry, no delivery to somebody who was not connected.
  The test is one question: *if this is lost, does it matter?* Yes means it belongs in a table via
  `prax.data`, or in an automation. No, because a newer one is coming, means it belongs here. A
  chat app uses both: the automation stores the message, the bus makes it appear instantly.
- **Payloads are hostile.** The bus relays opaque JSON between *users* and parses none of it, so
  every server-side sanitizer is bypassed. Rendering a payload as HTML is a stored XSS delivered
  peer to peer. Treat it the way you would treat a URL query string.
- **You never receive your own event.** Apply your own change locally.

`publish()` does not throw when the bus refuses a frame - a game loop that throws on a rate limit
is worse than one that skips a frame. Read the result when you care:

```ts
const r = await room.publish('move', { x, y });
if (!r.ok) console.debug(r.error);        // e.g. 'rate_limited'
if (r.recipients === 0) { /* it went out, and nobody was joined */ }
```

`join()` is the opposite and throws: a publish that does not land is one lost frame, a join that
does not land means this client is silently absent for the whole session.

Reconnects are handled. The socket comes back with backoff and every channel you still want is
re-joined, because SignalR group membership does not survive a reconnect - a client that only
reconnects is connected, in no groups, and looks for all the world like a broken server.

---

## Signing in with an external provider

```ts
const { providers } = await prax.auth.getWorkspaceConfig();   // [{ slug, displayName }]

const { authorizationUrl, state } = await prax.auth.startOidcLogin('tesseract');
sessionStorage.setItem('prax_oidc_state', state);
location.href = authorizationUrl;

// ...back at your redirect URI:
const params = new URLSearchParams(location.search);
await prax.auth.completeOidcLogin(
  'tesseract',
  params.get('code')!,
  params.get('state')!,
  'https://app.example/callback',   // byte-identical to the provider's configured redirect URI
);
```

All four arguments are required, and three of them are why an OIDC sign-in fails when it fails:
the gateway scopes its one-time `state` per provider, consumes it once, and compares `redirectUri`
against the value configured for that provider. Pass the URI you were actually redirected to
rather than rebuilding it from `location` - that is how it ends up differing by a trailing slash
and failing with a message about redirect URIs that nobody can act on.

The session lands in the same store as a password login, so refresh, sign-out and every
authenticated call behave identically afterwards.

Only the authorization-code flow exists. There is no route that accepts a provider's own
`id_token`, so a native Google or Apple button still has to make the browser hop.

---

## Security in three lines

The client is untrusted code running on someone else's machine. This SDK assumes that:

1. **Ship only a publishable key (`pk_live_`), and scope it to nothing.** It's an identifier, not
   a credential — anyone can read it out of your bundle or fetch it unauthenticated, so whatever
   it can reach, the anonymous internet can reach. Auth works on a credential with zero table
   scopes, which makes an extracted key worthless. A *secret* key throws immediately.
2. **Give each user their own identity.** Two settings, not one: a `__SELF__` row filter on the
   role's table scope, **and** a `{{claim:sub}}` default value template on the `Enduser` column.
   With only the first, inserts land with a null owner the filter then hides — the user saves and
   can't read it back, with no error anywhere.
3. **Put anything valuable behind an endpoint.** Currency, credit and grants belong in an
   automation you control, not a client-side table write.

Full reasoning in **[SECURITY.md](SECURITY.md)**.

---

## Error handling

Every failure is a `PraxError` with a stable `code`, so you never match on message text:

```ts
try {
  await prax.data.insert('Scores', values);
} catch (err) {
  if (err instanceof PraxError) {
    if (err.isRateLimited)   { /* already retried with backoff */ }
    if (err.isQuotaExceeded) { /* plan exhausted — retrying will not help */ }
    if (err.isForbidden)     { /* a scope problem, not a query problem */ }
    if (err.isNetworkError)  { /* really offline */ }
  }
}
```

Network errors, timeouts, 5xx and rate limits retry automatically with exponential backoff,
jitter and `Retry-After`. Quota errors deliberately don't — retrying an exhausted quota only
burns calls.

## Sessions

In memory by default: the user signs in again on each page load. Opt into persistence with
`persistSession: true`, but read the note on `LocalStorageTokenStore` first — `localStorage` is
readable by any script on your origin, so an XSS bug becomes a stolen session. Supply your own
`tokenStore` to put it somewhere you trust more.

## Cancellation

Every method takes an optional `AbortSignal`:

```ts
const controller = new AbortController();
const rows = await prax.data.from('Scores').all();  // or pass the signal to from()
controller.abort();
```

---

## Conformance is the law

Praxsuite has SDKs in several languages. Where they touch the gateway they do **not** get to
disagree. A single normative contract defines the shared behaviour, and every SDK implements it
identically:

1. **The contract is normative.** Where this SDK and the contract differ, this SDK is wrong.
2. **Every rule cites the backend source it derives from.** No rule rests on memory.
3. **Every rule exists because getting it wrong fails silently.** Wrong data, not an error.
4. **A behaviour change is a contract change first.** Not an implementation detail.

The contract is internal and deliberately has no public repository. Its value is that it is
authoritative for us, not that it is browsable — and it cites backend internals that are not ours
to publish. Everything a consumer of this SDK needs to know is in this README.

What it pins down, and why each one earned its place:

- **Operators.** Only the thirteen the parser accepts. A friendlier name is a runtime 400.
- **`meta.total`, never `meta.totalCount`.** Reading the wrong name returns nothing and reports
  zero, silently, forever. One SDK shipped that for months.
- **Three response envelopes.** `/query` is bare, `/auth/*` nests under `.data`, `/files` errors
  are a bare string. Assuming one shape mis-parses the other two.
- **`limit` is clamped up to a minimum of 1.** A zero-row count request quietly returns a row.
- **Unscoped updates and deletes refused before sending**, synchronously.
- **Secret keys refused wherever a credential would be exposed.** No flag, no override.
- **No client-supplied identity parameter.** The server ignores it, so it would read as a
  security boundary while being decorative.

The suite runs offline — no workspace, no network, no credentials:

```bash
npm test        # 45 checks
```


## Contributing

```bash
npm test        # 45 offline tests, no network or workspace needed
npm run build
```

Bug reports and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues do **not**
go in the issue tracker: see [SECURITY.md](SECURITY.md).

The test suite pins the exact wire shapes the gateway expects — response envelopes, operator
names, metadata field names, error classification. Those cases come from a shared contract every
Praxsuite SDK implements identically, so behaviour does not drift between languages. If a test
looks oddly specific, that is why: each one exists because getting it wrong produces silently
wrong data rather than an error.

## License

**Praxsuite Open SDK Licence v1.0** — source-available. See [LICENSE](LICENSE).

- ✅ Use it free in anything you build, **including products you sell**
- ✅ Read, fork, modify and publish your changes
- ❌ Don't resell the SDK itself, or use it to power a competing backend platform

Source-available, not OSI open source — the field-of-use limits fail OSI criteria 5 and 6.
