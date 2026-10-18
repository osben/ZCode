# Fork Format Scope (`pnpm fmt` / `pnpm fmt:check` cover fork-changed files only)

## Background (current source facts)

- This repository is a fork of `zai-org/ZCode`. Upstream syncs are merge commits such as `Merge upstream v3.15.1 (aac47556) into integration`; the `upstream` remote points at `zai-org/ZCode`.
- Upstream does not run oxfmt over its whole tree. At the last sync (`aac47556`, v3.15.1) about 1480 files fail `oxfmt --check`, and every one of them is byte-identical to the upstream blob. Reformatting them would turn every later upstream sync into a conflict on each of those files.
- Before this spec, `fmt` / `fmt:check` were plain `oxfmt` / `oxfmt --check` over the whole tree, so `pnpm fmt:check` always failed, and `pnpm fmt` would have rewritten upstream files. PR CI ran its own inline check over the PR diff only and skipped PRs labelled `upstream-sync`.
- The pre-commit hook (`lint-staged.pre-commit.config.mjs` → `scripts/run-pre-commit-checks.mjs`) formats staged files in write mode, which is why fork-touched files are already clean. Until it was aligned with this spec it only matched `js mjs cjs jsx ts tsx mts cts json md mdx`, so a fork edit to e.g. a `.yml` file could be committed unformatted and fail only in CI.

## Product rules

- **Scope**: `pnpm fmt` (write) and `pnpm fmt:check` process exactly the files the fork has added or modified relative to the **upstream sync base**, and nothing else. Files identical to the upstream sync base are never formatted or checked.
- **Upstream sync base (single rule)**: the full upstream commit SHA stored in the fork-owned file `fork-upstream-base.json` (`upstreamCommit`). It is the upstream commit that the last sync merged — not the sync merge commit itself (that would drop every pre-sync fork change from scope).
  - The base is resolved the same way locally and in CI; there is no fallback to `upstream/main`, a tag, or the whole tree.
  - The script fails loudly (non-zero exit, nothing formatted) when:
    - `fork-upstream-base.json` is missing, unparsable, or `upstreamCommit` is not a 40-hex SHA;
    - the commit is not present in the local object database (typically a shallow clone; CI must use `fetch-depth: 0`);
    - the commit is not an ancestor of `HEAD`;
    - a local `upstream/main` remote-tracking ref exists and `git merge-base HEAD upstream/main` differs from the pinned SHA (stale pin: a sync was merged without bumping the pin, so `pnpm fmt` would otherwise reformat freshly merged upstream files). When that merge-base is an ancestor of the pin, the local `upstream/main` is merely behind (fetched before the last sync) and the error asks for `git fetch upstream` instead of a pin change. This is an assertion, not a resolution path; it only runs where the ref exists.
- **File selection** (one command for local and CI; on a clean CI checkout it equals `<base>...HEAD`):
  - `git diff -z --name-only --no-renames --diff-filter=AM <base>` — base against the working tree, so it includes committed, staged and unstaged changes. `--no-renames` makes a renamed-and-edited file show up under its new path as added.
  - plus `git ls-files -z --others --exclude-standard` (untracked, not ignored).
  - keep only regular files that exist on disk (deleted files, symlinks and submodule gitlinks are dropped);
  - keep only files oxfmt formats: extensions `js jsx mjs cjs ts tsx mts cts json jsonc json5 md mdx markdown yml yaml toml css scss less html htm vue graphql gql hbs handlebars`, plus the extensionless JSON names `.prettierrc`, `.babelrc`, `.swcrc`;
  - ignore rules stay oxfmt's own (`.gitignore`, `.prettierignore` — e.g. `apps/zcode-cli/` with its own formatter — and `.oxfmtrc.json` `ignorePatterns`); the script passes `--no-error-on-unmatched-pattern`.
- A file that was edited and later reverted to the base content is out of scope (it no longer differs from the base). A file the fork edits even slightly is fully in scope and is formatted as a whole; that is the accepted cost of keeping fork files formatted.
- **Execution**: `scripts/fork-format.mjs` runs the root `oxfmt` bin via `process.execPath` (Windows `.cmd` shims cannot be spawned without a shell) with the file list split into argv chunks under the Windows command-line limit. Exit code is non-zero if any chunk fails; an empty selection exits 0. `--list` prints the selection without running oxfmt.
- **Pre-commit uses the same formattable set**: `scripts/fork-format.mjs` exports the extension and basename lists (`FORMATTABLE_EXTENSIONS`, `FORMATTABLE_BASENAMES`) and `formattableFilesGlob()`, and `lint-staged.pre-commit.config.mjs` uses that glob as its only key. There is no second list. A staged file `pnpm fmt:check` would check is formatted (write mode) and re-staged on commit; `scripts/run-pre-commit-checks.mjs` then runs oxlint over the same paths, which lints only the file types it understands (`.vue` script blocks included) and exits 0 for a set with nothing lintable (`--no-error-on-unmatched-pattern`).
  - Known gap (accepted): lint-staged globs are case-sensitive while `isFormattable` lowercases the extension, so an upper-case extension such as `Foo.YML` is checked by `fmt:check` but not formatted on commit.
- **CI**: `.github/workflows/pr-checks.yml` runs `pnpm fmt:check` with `fetch-depth: 0`, for every PR including upstream syncs (the former `upstream-sync` label skip is removed: a sync PR bumps the pin, so upstream-only files fall out of scope by themselves, and a forgotten bump must not be waved through by a label). CI has no `upstream` remote, so the stale-pin assertion does not run there; a forgotten bump instead keeps upstream-changed files in scope, and CI fails on any of them that upstream left unformatted. The assertion catches it locally for whoever runs `pnpm fmt` with an `upstream` remote.

## Upstream sync procedure (pin bump)

Part of every upstream sync PR, in the same PR as the merge:

1. `git fetch upstream` and merge the upstream commit `<sha>` into the sync branch.
2. Set `upstreamCommit` in `fork-upstream-base.json` to the full `<sha>` that was merged, and `upstreamVersion` to its version (informational only).
3. Run `pnpm fmt:check`. Files changed only by upstream are now out of scope; files both sides changed are in scope and must be formatted (`pnpm fmt`).

## Acceptance scenarios

- An upstream-identical unformatted file is neither checked nor rewritten.
- A fork-added or fork-modified unformatted file makes `pnpm fmt:check` exit non-zero, and `pnpm fmt` formats it.
- Uncommitted edits and untracked files are in scope locally; deleted files and fork edits reverted to the base are not.
- A missing pin file, a pin absent from history, a pin that is not an ancestor of `HEAD`, or a pin that disagrees with `merge-base HEAD upstream/main` fails before any formatting; an `upstream/main` behind the pin asks for a fetch.
- A staged unformatted `.yml` file (or any other formattable type, including `.prettierrc`) is formatted and re-staged by the pre-commit hook; a staged set containing only non-JS formattable files passes oxlint.
- On the repository at the time of writing, `pnpm fmt:check` passes: all ~3840 fork-changed formattable files are already formatted, and all ~1480 failing files are upstream-identical.

Tests: `scripts/fork-format.test.mjs` (temporary git repositories) and `scripts/run-pre-commit-checks.test.mjs` (pre-commit glob parity with the formattable set, staged yml formatting); both are part of `pnpm test:node`.
