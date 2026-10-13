# Pre-commit Hook

The repository runs a Husky `pre-commit` hook that formats and lints the
**staged** files of every commit at the repository root.

```text
git commit
    → .husky/pre-commit
    → pnpm exec lint-staged --config lint-staged.pre-commit.config.mjs
    → scripts/run-pre-commit-checks.mjs <staged code files>
    → oxfmt (write mode, fixes are re-staged) then oxlint
```

## Behavior

- **Scope**: staged files matching `**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,json}`.
  Only the staged content matters: lint-staged hides unstaged changes while
  tasks run and re-stages formatter fixes, so partial commits keep their
  unstaged part untouched.
- **oxfmt** runs in write mode; the commit always contains formatted code.
  This closes the gap where formatting was only enforced later by the CI
  "Format check (changed files)" step.
- **oxlint** blocks the commit on error-severity findings — the same severity
  semantics as the `pnpm lint` step of the pre-push hook. Warnings are shown
  but do not block.
- **Tool-owned exclusions**: which files each tool processes is the tool's own
  decision. oxfmt honors `.prettierignore` (notably `apps/zcode-cli/`, which
  ships its own newer oxfmt), oxlint honors `.oxlintrc.json` `ignorePatterns`
  and file extensions. Both tools run with `--no-error-on-unmatched-pattern`,
  so a fully excluded set (for example a CLI-only commit) is not an error;
  every other non-zero exit blocks the commit.

## Why a separate lint-staged config

`scripts/run-affected-unit-tests.mjs` reuses the shared `lint-staged.config.mjs`
via `lint-staged --diff` during pre-push (on a temporary index) to select
affected tests. Formatter tasks added to that shared config would run — and
rewrite working-tree files — at push time. The pre-commit tasks therefore live
in `lint-staged.pre-commit.config.mjs`, consumed only by `.husky/pre-commit`.

The task in that config is a plain string command: lint-staged appends the
staged files to string tasks directly as spawn argv (no shell, no
command-string parsing), which keeps filenames containing quotes, spaces or
percent signs intact.

## Relationship to the other gates

| Gate | Scope | Runs |
| --- | --- | --- |
| pre-commit | staged files, seconds | oxfmt (write) + oxlint |
| pre-push | pushed diff | `pnpm run verify:pre-push` (lint, architecture, affected unit tests, node tests) |
| CI | PR diff | typecheck, lint, format check, architecture, unit tests |

Pre-commit does not replace pre-push or CI; it catches formatting and lint
errors before the commit is even created. Typechecking and tests stay out of
it on purpose — they are too slow for an interactive commit.

The separate `apps/zcode-cli` pre-commit hook (its own `pnpm lint` +
`pnpm test`, see `apps/zcode-cli/docs/design/v2/pre-commit-quality-gate.md`)
is unaffected; the root hook skips CLI files entirely.

## Bypassing

`HUSKY=0 git commit ...` disables the hook for one command (emergency use
only; CI still enforces the same checks on the PR).
