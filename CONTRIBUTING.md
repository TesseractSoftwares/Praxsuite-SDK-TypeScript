# Contributing

Contributions welcome — bug reports, fixes, docs, runtime support.

**Security issues do not go in the issue tracker.** See [SECURITY.md](SECURITY.md).

## Licence, up front

Source-available under the [Praxsuite Open SDK Licence](LICENSE). Free to use in anything you
build including products you sell; no reselling the SDK, no competing backend platform. By
contributing you license your contribution under the same terms.

## Running things

```bash
npm ci
npm test         # 45 offline tests - no network, no workspace
npm run typecheck
npm run build
```

## The conformance contract

The test suite mirrors [Praxsuite-SDK-Conformance](https://github.com/TesseractSoftwares/Praxsuite-SDK-Conformance),
which every Praxsuite SDK implements identically. Each case there exists because getting it wrong
produces *silently wrong data* rather than an error, and at least one shipped SDK got it wrong.

**If you change wire-shape behaviour, change the contract first**, then every SDK.

## Traps worth knowing

These have already bitten someone:

- **Never validate arguments inside an `async` function.** The throw becomes a rejected promise,
  so a caller who does not await gets silence — no write, no error. Guardrails validate
  synchronously and hand off to a private async method. There are tests pinning this.
- **The gateway does not use one response envelope.** `/query` returns the result directly;
  `/auth/*` nests it under `.data`; `/files` returns a bare string error. Unwrapping all three
  the same way breaks two.
- **The total-count field is `total`, not `totalCount`.** Reading the wrong name returns
  `undefined` and reports 0 forever.
- **Nothing may log a credential.** Everything goes through `log`, which scrubs keys, JWTs and
  password fields.
- **Zero dependencies is a feature.** Please discuss before adding one.

## Style

Match the surrounding code. Comments explain *why*, not *what*. Public API carries TSDoc written
for someone who has never seen Praxsuite. Error messages say what to do next.

## Pull requests

1. Fork, branch from `master`
2. Keep `npm test` and `npm run typecheck` green
3. Add a test that fails without your fix
4. Update `CHANGELOG.md` under Unreleased
5. No credentials, workspace GUIDs or real hostnames anywhere
