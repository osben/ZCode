# Edit Tool model-visible result contract

## Background

The provider-visible `tool_result` of the Edit tool is how the model judges whether an edit took effect and whether the file must be re-read. This document constrains the model-visible text on Edit success and failure, escaped matching of `old_string`, and read-state judgment for read-before-edit.

## Behavior

- A successful Edit's model-visible text carries the freshness suffix:
  ` (file state is current in your context — no need to Read it back)`.
- Edit execution errors entering the model context are wrapped as
  `<tool_use_error>...</tool_use_error>`, while the raw error message used by UI/logs stays bare text.
- `\uXXXX` escapes in `old_string` must match the real characters in the file; e.g.
  `<tag>` matches `<tag>`.
- A partial-view read state of a file that was read and has not changed since counts as Edit's read-before-edit basis; after a file change, the stale guard still applies.

## Goals

1. Edit success/error model-visible text uses the fixed forms above.
2. Edit error's structured error types and UI display messages stay unpolluted by the `<tool_use_error>` wrapper.
3. `old_string` matching supports the unicode-escape fallback.
4. Stale-file protection is preserved; allowing partial read state does not loosen write protection for changed files.

## Non-goals

- No changes to desktop, Web, or mobile remote paths.
- No changes to the model-visible error formats of other tools (Read/Bash/WebSearch/etc.).

## Verification

- `apps/zcode-cli/packages/core/tests/edit-tool-contract.test.ts`
- `pnpm typecheck`
- `pnpm lint`
