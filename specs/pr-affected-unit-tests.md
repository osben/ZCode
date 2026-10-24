# PR Affected Unit Tests (PR CI runs affected selection; full suite scheduled and on demand)

## Background (current source facts)

- PR CI (`.github/workflows/pr-checks.yml`, job `Unit tests`) previously ran the full `pnpm test` on every PR: `test:unit` (root Vitest suite, ~2255 specs across the `unit`, `fork-isolated` and `zcode-cua` projects) plus `test:node` (fixed `tsx --test` list). Measured: ~21.6 min vs ~3.9 min for typecheck/lint/architecture; install plus prerequisite builds are a fixed floor of ~7–8 min.
- The fork already owns an affected selector: `scripts/run-affected-unit-tests.mjs` builds the root Vitest instance through `createVitest` and delegates selection to the official `changed`/`related` API. It supports `--base <commit>`, `--files`, `--files-manifest`, `--dry-run` and `--json`, and is exercised by the pre-push gate (`scripts/run-pre-push.mjs`). Selection cost ~18 s locally for the full suite.
- Full-selection semantics were pre-push-only: when the official selection covers the whole root suite, the entrypoint prints a warning, skips execution and exits 0 (correct for pre-push — a full run must not block `git push`). Wired into CI unchanged, a large PR would get a green `Unit tests` check with zero tests executed.
- Import-graph blind spots: Vitest `related` selection sees module imports only; convention-coupled coverage (locale catalogs read from disk, scripts spawned via child process, dependency bumps) is invisible to it. Partially closed already:
  - the most convention-coupled tests (i18n catalog parity, locale formatting, theme migration, pre-push runner contract) live in the always-full `test:node` list;
  - `vitest.config.ts` adds `**/{vitest,vite}.config.*` and `**/vitest.setup.ts` to `forceRerunTriggers`;
  - remaining gap: dependency manifests — the default `forceRerunTriggers` globs end in `/**` and do not match the files themselves (documented in `vitest.config.ts`), so a `pnpm-lock.yaml` or `package.json` change does not force a full run.
- Node 26's experimental Web Storage shadows jsdom's `localStorage`. `scripts/run-vitest.mjs` injects `--no-experimental-webstorage` for the full CLI run and `run-pre-push.mjs` for the affected runner; the affected entrypoint itself does not and cannot (worker threads inherit process flags, so the flag must be set before the process starts).

## Product rules

- **Ownership of test execution**: PR CI owns affected execution; the scheduled workflow owns full execution. PR CI never executes fewer tests than the official Vitest selection for the PR's own diff, and the scheduled workflow never skips tests.
- **PR base**: full clone (`fetch-depth: 0`) in the `Unit tests` job; base is `git merge-base origin/<base_ref> HEAD` where `<base_ref>` is `github.base_ref` (the checkout on `pull_request` is the merge ref, so the merge-base is the exact fork point and the diff is the PR's changes only).
- **Affected execution**: `pnpm test:unit:affected -- --base <merge-base> --on-full run` with `NODE_OPTIONS=--no-experimental-webstorage` on the step. Job name stays `Unit tests` so any future branch-protection required checks keep matching.
- **`--on-full` interface** (`scripts/run-affected-unit-tests.mjs`): `run` executes the whole suite when the official selection covers it; `skip` (default, unchanged pre-push behavior) skips and exits 0. Invalid or missing values fail argument parsing.
- **Dependency manifest guard**: if the diff `<base>..HEAD` touches `pnpm-lock.yaml` or any `package.json`, the workflow runs the full `pnpm test:unit` instead of affected selection (dependency changes are invisible to the import graph).
- **`test:node`**: always runs in full on PRs; it is small, fixed-list, and carries the convention-coupled coverage.
- **Scheduled full run**: a separate workflow (not `integration-build.yml`, to keep its `concurrency` group untouched) with a nightly `schedule` cron (03:30 UTC) and `workflow_dispatch`, running the same setup as the PR `Unit tests` job and then the full `pnpm test`. It is the safety net for the residual blind spots of affected selection, not an optimization.
- **Docs-only PRs**: affected selection yields zero specs and the job passes without executing Vitest tests (setup still runs); no special-casing in the workflow.

## Acceptance scenarios

- Small code PR touching one source file: selection maps it through the import graph; only related specs run; unrelated failures elsewhere cannot fail this PR's gate.
- PR adding only test files: the new tests are themselves selected and run.
- PR touching `vitest.setup.ts` or any `vitest/vite.config.*`: `forceRerunTriggers` yields full selection; `--on-full run` executes the entire suite (the step log states the full run).
- Large sync/refactor PR: official selection covers the suite; the full suite runs exactly as before this change.
- PR bumping `pnpm-lock.yaml` (or any `package.json`): the manifest guard forces the full `pnpm test:unit`.
- Nightly/manual run: full `pnpm test` executes regardless of any selection logic.
- Pre-push gate: behavior identical to before this change (full selection still skips with exit 0).
