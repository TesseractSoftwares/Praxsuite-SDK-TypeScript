# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Email **security@tesseractsoftwares.com** with:

- what the issue is, and what an attacker gains
- steps to reproduce, or a proof of concept
- the SDK version and runtime
- whether it affects the SDK, the Praxsuite gateway, or both

We aim to acknowledge within **2 business days** and to give you an assessment and a fix
timeline within **10 business days**.

If you would like credit in the release notes, say so and tell us how to name you. If you would
rather stay anonymous, that is fine too.

We will not take legal action against good-faith research that follows this policy: report
privately, do not access or modify data belonging to anyone else, and give us a reasonable
window to fix the issue before disclosing it.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |
| < 1.0 | ❌ |

## What counts as a vulnerability here

The SDK runs where an attacker may control the host. That shapes what is a bug and what is simply the
threat model, so please check this list before reporting.

**In scope:**

- The SDK sending a credential somewhere it should not, or logging one unredacted
- A secret key reaching a browser bundle without the SDK refusing it
- Session tokens stored less carefully than the token store documents
- A way to make the SDK talk to a host other than the configured gateway
- Anything letting one player's session reach another player's data

**Not vulnerabilities — these are documented properties, not defects:**

- *The publishable key can be extracted from a bundle.* It is designed to be public, like a
  Stripe publishable key. That is why the guidance is to scope it to nothing and rely on
  per-player tokens instead.
- *A user can read their own session token from their own browser.* Any client-side credential
  store on hardware the owner controls has this ceiling. The mitigation is to make a stolen
  session worth little: keep authority server-side.
- *A modified client can send arbitrary requests.* Assumed. The gateway is the boundary, which
  is why anything valuable belongs behind an endpoint.

If you are unsure which side of that line something falls on, report it. We would rather triage
a non-issue than miss a real one.

## For developers using this SDK

Most incidents involving a backend SDK are configuration, not code. Before shipping:

- No `sk_live_` key anywhere in client code - the SDK refuses one, but do not rely on that as
  your only check. Secret keys belong in server code, read from an environment variable.
- Your publishable key scoped to the minimum, ideally **no table scopes at all**. Auth works
  without them, and anything it can reach, anyone holding your workspace id can reach.
- Per-user tables carry an `Enduser` column with a `__SELF__` row filter **and** a
  `{{claim:sub}}` default value template - both, not one. With only the filter, inserts land with
  a null owner the filter then hides, so a user saves a record and cannot read it back.
- Currency, credit and anything else valuable written through gateway endpoints, not client
  table writes.
- `verbose` off in production - it logs request and response bodies.
