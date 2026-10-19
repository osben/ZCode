# Lefthook Git hooks

Lefthook replaces Husky as the hook manager. `lefthook.yml` owns the hook jobs;
`pnpm prepare` installs the project-pinned Lefthook. The existing lint-staged
formatter configuration and affected Vitest runner remain unchanged.

## Owners and order

```text
git commit -> run-lefthook adapter (Lefthook staging disabled)
           -> staged-size check
           -> lint-staged: hide partial edits -> format/lint -> stage fixes
                         -> restore edits, or roll back on conflict/failure
           -> staged-size check -> commit or nonzero failure

git push -> Lefthook forwards stdin to one pre-push shell adapter
         -> adapter captures refs and removes Git-local environment
         -> existing pnpm verify:pre-push gate -> push or nonzero failure
```

`run-lefthook.mjs` adds `--no-stage-fixed` only to `run pre-commit`. This disables
Lefthook's competing stash/staging mechanism, not any checks. lint-staged remains
the single owner of partial staging and rollback. In Lefthook 2.2.2, overlapping
formatter/unstaged edits can leave the working edits only in an automatic stash;
retaining lint-staged preserves the existing working-tree recovery behavior.
Native `stage_fixed` also stages after all jobs, which would let a post-format
size check inspect the old index. Both existing staged-size checks remain
mandatory, with lint-staged staging successful fixes before the second check.

Paths containing spaces, apostrophes, percent signs, Unicode and leading dashes
retain the current argv handling. The formatter/linter keep their existing
ignore rules and shared formattable glob. Checks remain sequential and stop on
failure. No unrelated unstaged/untracked work may enter a commit or disappear
from the working tree after a failed hook.

## Installation and worktrees

The installer uses the pinned package's executable. With no custom hooks path,
it installs normally. It recognizes the legacy relative `.husky/_` migration
path and installs Lefthook shims there using the explicit install `--force`
option. This preserves the existing checkout-local hook directory without
changing shared/global Git configuration or sibling worktrees. Other custom
paths keep Lefthook's refusal to overwrite them. Repeated prepare is safe.

The package's automatic postinstall is disabled in `allowBuilds`: root prepare
is the single installation owner and handles the legacy path deliberately.
Missing Lefthook fails closed via `assert_lefthook_installed`.

The pre-push adapter retains the same refs, environment cleanup and verification
command. This migration is independent of the pre-push fast-path PR.

## Acceptance scenarios

- Fresh and legacy installs run real hooks; repeated prepare succeeds.
- Linked-worktree migration preserves sibling hooks/shared configuration;
  nonoverlapping partial edits commit only staged content and restore the rest.
- Overlapping formatter/unstaged edits block the commit and restore the original
  index and working copy. Lint failures preserve unrelated/untracked work.
- YAML/JSON and special filenames format and stage with the existing rules.
- Oversized staged files block before formatting; a formatter-expanded file is
  rejected after staging. The size checks remain unmodified.
- A real push to a temporary local remote forwards the exact Git refs, removes
  Git-local variables from child checks and prevents a push on verification failure.
- Existing formatter, staged-size, lint, typecheck and format checks pass.

Hook integration tests run separately via `pnpm test:git-hooks` in PR CI, keeping
their temporary repositories out of ordinary push latency.
