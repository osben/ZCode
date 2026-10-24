# Count Lint Script

`pnpm lint:count` is a development-time code-size observation script. It measures the length of
`.ts` and `.tsx` files in the repository. It changes no lint rules and writes no workspace files;
it only gives maintainers input for splitting large files or setting lint thresholds.

## Goals

- Recursively count non-test `.ts` and `.tsx` files from the repository root.
- Output lines, bytes and relative path per file.
- Sort by line count, descending, so the largest files surface first.
- No new environment variables; run through the root `package.json` `lint:count` script.
- Node.js standard library only; no POSIX shell, `wc`, `find` or platform-specific commands.

## Scan contract

The script scans from the current working directory. To keep generated output and dependencies
out of the statistics, recursion skips:

- `.git`
- `.next`
- `.turbo`
- `build`
- `coverage`
- `dist`
- `node_modules`
- `out`

To keep development debug packages out of production code-size observation, recursion also skips:

- `packages/debug`

Test files are excluded so fixtures, fake adapters and integration scenarios do not skew
production split priorities. The script skips:

- files whose path has a `tests` or `__tests__` segment
- files ending in `.test.ts`, `.test.tsx`, `.spec.ts` or `.spec.tsx`

The script does not follow symlinks, avoiding cross-platform symlink permission differences and
directory cycles. Paths are printed as `/`-separated repository-relative paths.

## Output contract

Output contains:

- Title: `TypeScript file lengths (.ts, .tsx)`
- Total file count
- Total lines
- Total bytes
- Table columns: `Lines`, `Bytes`, `File`

Empty files count as `0` lines; a file with only a newline counts as `1` line; a normal file with
a trailing newline does not count an extra line.

## Error behavior

Filesystem errors bubble up to the script entry, and the CLI boundary prints
`lint:count failed: <message>` and exits with code `1`. The script does not swallow underlying
errors or turn them into statistics rows.

## Test coverage

- Line counting covers empty files, missing trailing newline, CRLF and trailing newline.
- File discovery covers `.ts`, `.tsx`, test-file skips, non-TypeScript files, generated-directory
  skips and `packages/debug` skips.
- Formatting covers totals and the descending line-count sort.
