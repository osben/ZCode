# ApplyPatch Tool

## Purpose

`ApplyPatch` is a structured file patch tool for verifiable multi-line, multi-hunk or multi-file edits. It is neither a free-text script nor a shell command.

## Input contract

| Field        | Type     | Required | Description                                                          |
| ------------ | -------- | -------- | -------------------------------------------------------------------- |
| `patch_text` | `string` | yes      | Full patch text; must contain `*** Begin Patch` and `*** End Patch`  |

Supported file operations:

- `*** Add File: <path>`: add a file; the following content lines must start with `+`.
- `*** Update File: <path>`: update an existing file; one or more following `@@` hunks describe local changes.
- `*** Move to: <path>`: immediately after the Update header; writes the updated content to the new path and deletes the old path.
- `*** Delete File: <path>`: delete an existing file.

Update hunk semantics:

- `@@` starts a hunk; `@@ some context` can provide an extra locating anchor.
- A line starting with a space is a context line and must take part in old-content matching.
- A line starting with `-` is an old line.
- A line starting with `+` is a new line.
- `*** End of File` may serve as an EOF anchor, matched from the end of the file first.

## Output contract

| Field             | Type   | Description                                                                         |
| ----------------- | ------ | ----------------------------------------------------------------------------------- |
| `files`           | array  | Path, operation type, diff and added/removed line counts of each affected file      |
| `structuredPatch` | array  | Display diff hunks of all files                                                     |
| `summary`         | string | Short summary, for example `M src/a.ts`, `A src/b.ts`                               |

The model-visible result returns only a short confirmation and file summary; the full diff goes into structured output, the permission UI, events and the debug projection. The TUI diff preview shares the same structured hunk projection and Shiki token highlight path as `Edit`, degrading to a plain-text diff on failure.

## Behavior semantics

Core flow:

1. Parse the patch envelope and all file sections.
2. Normalize relative paths to absolute paths under the session cwd.
3. Verify all files first; verification must not be interleaved with writes.
4. Update hunks are matched in LF Unicode logical content; write-back keeps the original file encoding and lineEndings, including legacy Chinese encodings such as GB2312 / GBK / GB18030.
5. The matching strategies in order are exact, trimEnd, trim, Unicode punctuation normalization. No cross-file search or open-ended semantic guessing.
6. If any hunk is not found, a path is illegal, a file state does not fit the operation type, or the parser fails, the whole patch fails and produces no file side effects.
7. After all verification succeeds, generate the per-file diff and enter edit permission approval.
8. If any file has an unsupported encoding, is suspected binary, or the patched content cannot be encoded back to the original encoding, the whole patch must fail and write no file.
9. After approval, apply writes and deletes file by file.

## Permission model

`ApplyPatch` shares the `edit` permission with `Edit` / `Write`:

- `readOnly=false`
- `destructive=false`
- `concurrentSafe=false`
- `sideEffectScope=workspace`
- `riskLevel=medium`
- `needsApproval=true`

The permission patterns come from all affected paths in the patch.

## Validation and errors

Stable error codes or structured context must be provided for:

- Patch missing begin/end marker.
- Empty patch.
- Invalid file section header.
- Update target does not exist.
- Delete target does not exist.
- Update hunk cannot find the expected lines.
- Verification fails for any file in a multi-file patch.

On failure, other files that verified successfully must not be written.

## ZCode design conclusions

`ApplyPatch` solves the problem that `Edit.old_string` is easily affected by copying line numbers, tabs, newlines and long strings. Through structured hunks, context lines and pre-verification it confines compatibility to the local diff. It is not a replacement shell for Python/sed replacement scripts, but a first-class tool uniformly managed by permission, trace, adapter and diff UI.
