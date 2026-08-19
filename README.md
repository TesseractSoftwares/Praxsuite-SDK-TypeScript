# Praxsuite SDK for TypeScript

[![Licence](https://img.shields.io/badge/licence-Praxsuite%20Open%20SDK-blue)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](package.json)
[![Types](https://img.shields.io/badge/types-included-blue)](package.json)

Auth, queries, files and server-authoritative logic for your Praxsuite workspace — in the browser,
Node, Deno, Bun or React Native.

Zero dependencies. One field to configure. Refuses to let a secret key reach client code.

---

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

Everything is typed. Pass a row type to get it back: `prax.data.from<Score>('Scores')`.

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
