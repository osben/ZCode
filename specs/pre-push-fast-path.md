# Pre-push fast path

## Rules and ownership

`pnpm verify:pre-push` owns the sequential local gate: lint, architecture,
affected Vitest, then the complete `test:node` suite. A failed stage stops the
gate and preserves its nonzero exit status. Every executed stage reports its
start, result and elapsed time; the gate also reports total elapsed time.

The existing affected-test resolver remains the single owner of the comparison
target: explicit base, Git pre-push input, upstream, then default branch. The
default-branch fallback prefers `origin/HEAD`, then `origin/integration`, before
the legacy `origin/staging` fallback. An existing remote branch still uses the
remote SHA supplied by Git.

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
Git refs -> affected-test target resolver -> documentation classification
                                         -> lint -> architecture
                                              -> documentation only: skip tests
                                              -> otherwise: affected -> node tests
                                         -> result + elapsed time
```

## Acceptance scenarios

1. A new branch with both `origin/staging` and default `origin/integration`
   available compares against integration. Without origin/HEAD, integration is
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

Regression tests live in `scripts/test/run-affected-unit-tests.test.mjs` and
`scripts/test/run-pre-push.test.mjs` and run with `pnpm test:pre-push` in PR CI.
They remain separate from `test:node` so their temporary Git repositories and
subprocesses do not add latency to every ordinary push.
