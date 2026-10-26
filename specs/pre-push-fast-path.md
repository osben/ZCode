# Pre-push fast path

## Rules and ownership

`pnpm verify:pre-push` (`scripts/run-pre-push.mjs`) owns the sequential local
gate: lint, `architecture:check --changed`, `test-copy:check`,
`instruction-commands:check` (specs/instruction-command-contract.md),
`db:migrations:check` (specs/upstream-migration-freeze.md), affected Vitest
(`test:unit:affected -- --scope push`), then the complete `test:node` suite. A
failed stage stops the gate and preserves its nonzero exit status. Every executed
stage reports its start, result and elapsed time; the gate also reports total
elapsed time. The SQLite schema contract check is not part of the gate yet; it
returns with the product sync that provides its shared migration module.

The affected stage receives its base from the fork resolver: `run-pre-push.mjs`
computes the merge-base of the resolved target and `HEAD` and passes it as
`ZCODE_AFFECTED_TEST_BASE`. Upstream `scripts/affected-unit-tests/scope.mjs`
honours that override before its own first-push fallback, which hard-codes
`origin/staging` (absent in this fork, whose default branch is `fork`, see `specs/fork-branch-model.md`).
`scope.mjs` stays byte-identical to upstream.

`scripts/pre-push-diff-target.mjs` owns the documentation-only comparison target:
explicit base, Git pre-push input, upstream, then default branch. The
default-branch fallback prefers `origin/HEAD`, then `origin/fork`, then
`origin/staging`, `origin/main`, `origin/master`, `main` and `master`. An existing
remote branch still uses the remote SHA supplied by Git. Affected Vitest scope
selection is owned by upstream `scripts/run-affected-unit-tests.mjs`.

Only a nonempty, known diff consisting entirely of root-level `.md` files or
`.md` files inside `docs/` and `specs/` may skip both test stages. Lint and
architecture still run. Deleted paths and both sides of renames participate in
this decision. Runtime Markdown, MDX, configuration, scripts, source code and
unknown paths retain the existing test gate. Unknown comparison targets and
pushes containing multiple refs cannot use the documentation shortcut. Git
errors fail the gate rather than silently skipping tests. CI continues to run
the full test suite.

Child checks reuse a local Node compile cache at
`.cache/pre-push/node-compile`, which is already ignored by Git. An explicitly
configured `NODE_COMPILE_CACHE` or `NODE_DISABLE_COMPILE_CACHE` remains effective.
This cache only accelerates compilation; it never caches a test result or skips
an executed check.

```text
Git refs -> pre-push diff target resolver -> documentation classification
                                          -> lint -> architecture:check --changed
                                              -> test-copy:check -> instruction-commands:check
                                              -> db:migrations:check
                                              -> documentation only: skip tests
                                              -> otherwise: affected (--scope push) -> node tests
                                          -> result + elapsed time
```

## Acceptance scenarios

1. A new branch with both `origin/staging` and default `origin/fork`
   available compares against fork. Without origin/HEAD, fork is
   preferred when present; the legacy fallbacks remain usable.
2. A committed docs/specs/root Markdown change or deletion runs static checks
   and skips both test commands. Source edits, config edits, application Markdown,
   MDX, mixed changes and code renamed into documentation run all four stages.
3. An existing-branch push uses Git's supplied remote SHA, not an unrelated
   default branch. A missing target or multi-ref push runs all stages.
4. A failing stage reports its duration and exit code, suppresses subsequent
   stages and reports total time. Git comparison failures do not reach the skip
   path.
5. Repeated checks receive the same ignored compile-cache path; an explicitly
   configured cache or disable flag is preserved.
6. A first push of a new branch in a repository without `origin/staging` passes
   the merge-base with the default branch to the affected stage and does not
   reach upstream's `origin/staging` fallback.

Regression tests live in `scripts/test/run-affected-unit-tests.test.mjs` and
`scripts/test/run-pre-push.test.mjs` and run with `pnpm test:pre-push` in PR CI.
They remain separate from `test:node` so their temporary Git repositories and
subprocesses do not add latency to every ordinary push.
