# Pre-commit Hook

The repository runs a Husky `pre-commit` hook that formats and lints the
**staged** files of every commit at the repository root.

```text
git commit
    → .husky/pre-commit
    → scripts/check-staged-file-tokens.mjs (index size gate)
    → pnpm exec lint-staged --config lint-staged.pre-commit.config.mjs
    → scripts/run-pre-commit-checks.mjs <staged code files>
    → oxfmt (write mode, fixes are re-staged) then oxlint
    → scripts/check-staged-file-tokens.mjs (check formatter output)
```

## Behavior

The size gate applies to every added, copied, modified or renamed regular file
in the Git index, including CLI files. The limit is **5,000 tokens = 20,000
bytes**, inclusive; this is a byte estimate, not a tokenizer. Git blob sizes
measure the staged snapshot, never the working copy. Deleted files, symlinks
and submodule pointers do not contain regular file content and are skipped.
Git errors block the commit. No HEAD commit is required.

Git cannot identify whether uncommitted code was written by an agent or a
human. All manually maintained files are therefore checked. Exclusions are:

- Lock files by exact basename: `pnpm-lock.yaml`, `package-lock.json`,
  `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`, `bun.lockb`, `Cargo.lock`,
  `poetry.lock`, `uv.lock`, `Pipfile.lock`, `composer.lock`, `Gemfile.lock`,
  `go.sum`.
- Generated names containing `.generated.` or `.gen.`.
- Files with `linguist-generated=true` or `linguist-vendored=true` (or the
  corresponding bare attribute) in **staged** `.gitattributes`. This is the
  explicit declaration for other generated output or third-party code; do
  not mark manually maintained code as generated to evade the limit.
- Exact repo-relative paths listed in `.staged-file-size-exemptions`, one path
  per line; `#` starts a comment. Stage the list with the change. Entries are
  temporary: remove an entry when the file is split below the limit.

Oversize errors list each path, byte size and estimated tokens, then instruct
the author to extract cohesive modules or document sections, preserve imports
and exports, and stage the split files again. Both checks read only the index:
the first prevents unnecessary formatter edits; the second catches a formatter
that increases a staged file beyond the limit.

Acceptance cases include the exact limit, UTF-8 bytes, partially staged files
with smaller/larger working copies, deleted working copies, renames, filenames
with whitespace/newlines, staged exclusions, and formatter-induced overflow.

- **Scope**: staged files matching
  `**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,json,md,mdx}`.
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

| Gate       | Scope                 | Runs                                                                             |
| ---------- | --------------------- | -------------------------------------------------------------------------------- |
| pre-commit | staged files, seconds | 20,000-byte size gate + oxfmt (write) + oxlint + final size gate                 |
| pre-push   | pushed diff           | `pnpm run verify:pre-push` (lint, architecture, affected unit tests, node tests) |
| CI         | PR diff               | typecheck, lint, format check, architecture, unit tests                          |

Pre-commit does not replace pre-push or CI; it catches formatting and lint
errors before the commit is even created. Typechecking and tests stay out of
it on purpose — they are too slow for an interactive commit.

The separate `apps/zcode-cli` pre-commit hook (its own `pnpm lint` +
`pnpm test`, see `apps/zcode-cli/docs/design/v2/pre-commit-quality-gate.md`)
is unaffected; root formatting skips CLI files, but the size gate checks them.
