# Fork test pipeline (after upstream 3.17.1)

## Background

Upstream 3.17.1 retired App business unit tests. The root Vitest config no longer discovers
`**/*.test.ts`; it runs an explicit `engineering` project fed by
`scripts/engineering-test-files.json`, plus `packages/zcode-cua/vitest.config.ts`. Upstream removed
`test`, `test:unit`, `test:unit:affected` and `test:coverage`, renamed
`scripts/run-affected-unit-tests.mjs` to `scripts/run-affected-engineering-tests.mjs`, and replaced
the affected selector's dirty-worktree guard with `scripts/check-push-worktree.mjs`.

The fork keeps its own unit tests (fork features, fork fixes, rescued upstream tests that carry fork
cases). Taking the upstream model unchanged would silently stop running them.

## Rules and ownership

- `scripts/engineering-test-files.json` is upstream-owned. The fork only removes entries for files
  the fork deleted (for example the account auth-gate fixture test); it never adds fork tests there.
- `scripts/fork-test-files.json` is fork-owned: a sorted, duplicate-free JSON array of repository
  paths of fork-run Vitest files. It never lists a file that is already in the engineering manifest.
- `vitest.config.ts` keeps upstream's structure and adds fork projects (two fed by the fork manifest):
  - `fork-unit`: threads pool (`ZCODE_TEST_POOL=forks` switches to process isolation), 4 workers
    locally and 2 in CI;
  - `fork-isolated`: `forks` pool, serial, for tests that spawn real build/tool subprocesses
    (`packages/provider-node/test/builtin-provider-build.test.ts`).
  - `relay`: the self-hosted relay suites, by glob (`packages/remote-relay/**/*.test.ts`,
    `packages/shared/src/web-remote-relay/**/*.test.ts`), threads pool. Only `test:relay` selects it;
    PR CI and `pnpm test` call it explicitly because the affected selection never reaches it.

  Both manifests are listed in `forceRerunTriggers`, so a manifest change selects the whole suite.

- Scripts (root `package.json`):
  - `test:engineering` = upstream engineering project, started through `scripts/run-vitest.mjs`
    (Node 26 Web Storage flag);
  - `test:fork` = `fork-unit` + `fork-isolated` through `scripts/run-vitest.mjs`;
  - `test` = `test:engineering && test:fork && test:node && test:relay`;
  - `test:engineering:affected` = `scripts/run-affected-engineering-tests.mjs`, selecting across the
    `engineering`, `fork-unit` and `fork-isolated` projects. It keeps the fork's `--on-full run|skip`
    option and Web Storage re-exec; `--files-manifest` is dropped with its only caller (the
    lint-staged Vitest runner upstream deleted).
  - `test:relay` = the `relay` project through `scripts/run-vitest.mjs` (root Vitest no longer discovers
    `**/*.test.ts`, so a path filter alone finds no files).
  - `test:node`, `test:git-hooks`, `test:pre-push` stay fork-owned.
- Tests run by other runners are not listed in either manifest: `apps/zcode-cli` tests (its own
  Vitest), desktop E2E (WDIO), `packages/ui` browser tests, `test:node` and `test:relay` lists.
- New fork Vitest unit tests must be added to `scripts/fork-test-files.json`;
  `scripts/test/fork-test-files.test.mjs` (in `test:node`) checks that the manifest is sorted,
  unique, points to existing files and does not overlap the engineering manifest.

## Pre-push and CI

`scripts/run-pre-push.mjs` (specs/pre-push-fast-path.md) runs upstream's gate stages plus the fork
stages, in this order: `check:push-worktree`, `check:e2e-remote-targets`, `lint`,
`docs:stale-phrases:check`, `db:schema:check`, `test:architecture`, `architecture:check --changed`,
`test-copy:check`, `instruction-commands:check`, `db:migrations:check`, then (unless the push is
documentation-only) `test:engineering:affected --scope push` and `test:node`.

PR CI (specs/pr-affected-unit-tests.md) runs `test:engineering:affected --base <merge-base> --on-full run`,
or `test:engineering` + `test:fork` when a dependency manifest changed, then `test:node` and
`test:relay`. The scheduled workflow runs `pnpm test`.

```text
scripts/engineering-test-files.json (upstream) --> project engineering --+
scripts/fork-test-files.json (fork) ---------> project fork-unit -------+--> test:engineering:affected
                                          \--> project fork-isolated --+     (pre-push, PR CI)
pnpm test = test:engineering -> test:fork -> test:node -> test:relay   (scheduled full run)
```

## Acceptance scenarios

1. `pnpm test:fork` runs every file in `scripts/fork-test-files.json`; the isolated file runs only
   in `fork-isolated`.
2. `pnpm test:engineering:affected --dry-run --files <fork source>` lists the related fork tests
   under `fork-unit`, and engineering tests under `engineering`.
3. Editing either manifest or `vitest.config.ts` selects the whole suite; pre-push skips it with
   exit 0, CI (`--on-full run`) executes it.
4. A pre-push from a dirty worktree fails at `check:push-worktree` before any test runs.
5. A fork test missing from disk, listed twice, unsorted, or also present in the engineering
   manifest fails `scripts/test/fork-test-files.test.mjs`.
6. PR CI and `pnpm test` run `test:relay`, so a relay suite failure blocks the PR even though the
   relay project is outside both manifests.
