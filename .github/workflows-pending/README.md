# Pending workflow

`ci.yml` belongs at `.github/workflows/ci.yml`. It is parked here only because pushing a file
into `.github/workflows/` requires a GitHub token carrying the `workflow` scope, and the token
used for the first publish did not have it.

To activate it, with a token that has `repo` + `workflow`:

```bash
git mv .github/workflows-pending/ci.yml .github/workflows/ci.yml
git commit -m "ci: enable GitHub Actions"
git push
```

Then restore the badge at the top of the README:

```markdown
[![CI](https://github.com/TesseractSoftwares/Praxsuite-SDK-TypeScript/actions/workflows/ci.yml/badge.svg)](https://github.com/TesseractSoftwares/Praxsuite-SDK-TypeScript/actions/workflows/ci.yml)
```

The Azure pipeline mirrors this repo on every master push, so the same token
(`GithubSdkMirrorToken` in `prax-cicd-kv`) needs the `workflow` scope for the mirror to carry
workflow changes at all.
