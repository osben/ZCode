# dep-refs: symbol-level export reference lookup

`scripts/dep-refs.mjs` (ts-morph based) answers "who uses this specific export" precisely, via TS
LanguageService semantics rather than text matching. It complements `scripts/dependency-graph.mjs`
(file-level) and `pnpm knip` (unused exports only) and does not replace either.

## Goals

- Given `<file>:<exportName>`, list every reference (file, line, column, snippet), distinguishing
  plain references from re-exports.
- List all exports of a file (`--list-exports`), e.g. as a pre-deletion inventory.
- JSON output for agent/jq consumption.

Non-goals: dynamic `import()` or string-based references; full pre-generated graphs (queries are
on demand).

## CLI

```bash
pnpm dep:refs <file>:<exportName>            # all references of one export (core usage)
pnpm dep:refs --list-exports <file>          # all exports of a file
pnpm dep:refs <file>:<exportName> --json     # JSON output (also with --list-exports)
pnpm dep:refs <file>:<exportName> --scope packages/services  # narrow scan range for speed
```

## Output

Human-readable single symbol: symbol header (kind + export location), `References (n)` with file
and snippet lines, `Re-exports (n)`, and the note
`Note: static analysis only. Dynamic import() and string-based usage not detected.`
Zero references prints `References (0). Safe to delete (no static references and no re-exports).`

JSON schema for a symbol query:

```json
{
  "symbol": { "name": "createBotSession", "kind": "function", "file": "packages/services/src/bots/botsService.ts", "line": 12 },
  "references": [
    { "file": "packages/services/src/node.ts", "line": 42, "col": 8, "snippet": "const session = await createBotSession(opts)" }
  ],
  "reExports": [
    { "file": "packages/services/src/index.ts", "line": 5, "snippet": "export { createBotSession } from './bots/botsService'" }
  ],
  "notes": ["Static analysis only. Dynamic import() and string-based usage not detected."]
}
```

`--list-exports --json` returns `{ "file": …, "exports": [{ "name", "kind", "line" }] }`.

## Scan scope

Default globs: `packages/*/src/**/*.{ts,tsx,mts,cts}`, `packages/*/test/**/*.{ts,tsx}`,
`apps/*/src/**/*.{ts,tsx,mts,cts}`, `harness/**/*.{ts,tsx}`. Tests must be scanned, otherwise an
export referenced only by tests reads as unused. `--scope <glob>` overrides the default (single
package loads in seconds; full monorepo load costs a fixed ~10-30s per query). No caching — knip
covers the batch use case.

## Edge cases

| Case | Behavior |
|---|---|
| `export *` | resolved through `getExportedDeclarations` |
| `import { foo as bar }` alias | tracked by `findReferences` |
| type-only vs value imports | both found |
| multi-hop re-export chains (a → b → c) | traversed |
| same-name overloads (multiple declarations) | references merged and deduplicated |
| missing file / symbol | exit code 1, clear stderr error |
| dynamic `import()` string paths | not detected; noted in output |
| no symbol argument | hint to run `--list-exports` first |

## Failure modes

ts-morph load errors (tsconfig problems) exit with the raw error on stderr — no forced tolerance.
`findReferences` empty while the declaration exists is the normal zero-reference case. A mistyped
symbol name suggests `--list-exports` for that file.

## Recommended workflow

1. `pnpm knip` → unused export list.
2. For a suspicious export, `pnpm dep:refs file:name` → who still uses it.
3. Decide: delete now, or migrate callers first.

## Testing

Manual only: compare reference counts with grep on a known-used export; a knip-reported unused
export must return `References (0)`; eyeball `--list-exports` output. No automated tests — the
script depends on the whole monorepo compiling, and unit tests cost more than they return.
