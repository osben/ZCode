# Fork branch model

## Rules

- `origin/main` is an exact mirror of `upstream/main` (`zai-org/ZCode`). It carries no fork commits and only ever moves to an upstream commit; it is never a PR target and is not reviewed.
- `origin/fork` is the default branch and the only integration branch of the fork. Every fork PR targets it; CI (`pr-checks.yml`, `git-hooks.yml`, `fork-build.yml`), Dependabot and CodeRabbit are scoped to it, and the repository ruleset (no deletion, no non-fast-forward, PR + required checks) protects it. Until the cut-over completes, the workflow branch filters also list `integration` so the PR that introduces this model can pass its required checks; a follow-up PR to `fork` removes it.
- Upstream syncs merge an upstream commit into `fork` (`Merge upstream vX.Y.Z (<sha>) into fork`) and bump `fork-upstream-base.json` (`specs/fork-format-scope.md`). The pinned upstream commit must stay an ancestor of `fork`.
- `integration` is retired. Its history up to PR #341 was squashed into the first fork-owned commit of `fork`, whose only parent is upstream `3c5b2276` (v3.16.2); the tree is byte-identical to the last `integration` tip.

## Release counter after the cut-over

- All `v*-fork.N` tags of the squashed history were deleted. `scripts/release-fork.mjs` takes `max(highest tag N, root version N) + 1`, so the root `package.json` version is raised to `3.16.2-fork.5` (the last published release) and the next release is `3.16.2-fork.6`, never reusing a published release name.

## Acceptance

1. `git merge-base origin/fork upstream/main` equals the `fork-upstream-base.json` pin.
2. A PR to `fork` runs `PR checks`; a push to `fork` runs `Fork build`; PRs to `main` run nothing.
3. Without `origin/HEAD`, the pre-push documentation fast path compares against `origin/fork` before `origin/staging`/`origin/main` (`specs/pre-push-fast-path.md`).
4. `node scripts/release-fork.mjs --print` with no fork tags prints `3.16.2-fork.6`.
