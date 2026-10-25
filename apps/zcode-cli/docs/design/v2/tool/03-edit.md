# Edit Tool

## Purpose

`Edit` performs exact string replacement in a file.

## Input contract

`Edit` input is a strict object:

| Field         | Type      | Required | Description                                             |
| ------------- | --------- | -------- | ------------------------------------------------------- |
| `file_path`   | `string`  | yes      | Absolute path to modify                                 |
| `old_string`  | `string`  | yes      | Original text to replace                                |
| `new_string`  | `string`  | yes      | Replacement text; must differ from `old_string`         |
| `replace_all` | `boolean` | no       | Replace every match; default `false`                    |

Design requirements:

- The model must use `Read` at least once in the current conversation before calling `Edit`. The runtime read-cache guard has not landed yet, but the provider-visible prompt must already state this constraint so the model does not write blind.
- `old_string` must come from real file content in the `Read` output, without the line-number prefix.
- The current `Read` model-visible format is `<lineNumber>: <fileContentLine>`; when copying from a Read result the model must drop the line number, the colon and the first space and keep only the real content after them. Real content that itself starts with a tab or spaces must be kept as is.
- `Edit` must also accept the old `Read` format `<lineNumber>\t<fileContentLine>`, as a fallback for historical conversations, log replay and a model copying old results.
- When editing text copied from Read output, the model must keep exact indentation, tabs, spaces and context after the line-number prefix.
- `Read` display, `Edit` matching and diff generation all use LF logical content; for Windows CRLF files the filesystem adapter records `lineEndings=CRLF` on read and restores CRLF on write. The model does not need to, and should not, hand-write `\r\n` in `old_string`.
- `old_string` and `new_string` are Unicode logical text copied or derived from the `Read` result. The filesystem adapter owns decoding GB2312 / GBK / GB18030 and other legacy encodings and writing back the original encoding; the model must not transcode first through Bash, Node, Python, iconv or sed.
- Exact matching is first priority. Only when exact matching fails may a conservative compatibility matcher run; every matcher must return the real old string from the file, and the final candidate must be unique.
- Allowed compatibility matchers: quote normalization, line-number prefix stripping, per-line trim, common-indentation difference, literal escape `\n` / `\t` / `\r` normalization, first/last anchor block matching. No open-ended semantic guessing, AST guessing or cross-file search-and-replace.
- With `replace_all=true` only strategies that do not widen the match range may be used: exact, quote normalization, line-number prefix stripping and literal escapes; per-line trim, indentation flexibility and block anchors must not be used for bulk replacement.
- When a compatibility matcher hits, the structured output must record `matchStrategy` for logs, traces and later diagnosis.
- `old_string` must be unique in the file by default; if not, `Edit` must fail, and the model should widen the context to make `old_string` unique or explicitly set `replace_all`.
- `replace_all` is for replacing and renaming the same string throughout a file, for example renaming a variable.
- Multiple replacements must explicitly set `replace_all`.
- Always prefer editing existing files in the codebase; do not create new files unless the user explicitly asks. ZCode `Edit` rejects an empty `old_string`; creating a new file uses `Write`.
- Add emoji to files only when the user explicitly asks.

## Output contract

Output:

| Field             | Type            | Description                                                      |
| ----------------- | --------------- | ---------------------------------------------------------------- |
| `filePath`        | `string`        | Path edited                                                      |
| `oldString`       | `string`        | Old string actually matched                                      |
| `newString`       | `string`        | New string                                                       |
| `originalFile`    | `string`        | Full content before the edit                                     |
| `structuredPatch` | `Hunk[]`        | Diff hunks for display                                           |
| `userModified`    | `boolean`       | Whether the user changed the proposed change in the permission UI |
| `replaceAll`      | `boolean`       | Whether all matches were replaced                                |
| `gitDiff`         | optional object | A git diff may be attached in remote scenarios                   |

The model-visible result only confirms the file was updated; if `replaceAll` is true it states that all matches were replaced.

Minimum current implementation requirements:

- `structuredPatch` must be generated after a successful edit from the before/after content, for TUI and debug events.
- The TUI shows only a bounded-line red/green diff preview: a line-number gutter per hunk line, `+`/`-` markers and full-line red/green backgrounds. This UI projection is not a basis for model flow decisions.
- The default TUI title is `Edit <path>`. `<path>` is relative inside the current workspace and absolute outside it; the result area does not repeat `file_path`, `replace_all`, `diff: ... (+n -n)` or `@@ ... @@`.
- The TUI diff preview is rendered internally from structured hunks: narrow screens show a unified single-column line number, wide screens a split multi-column layout. Syntax highlighting uses Shiki: infer the Shiki language from the file path, tokenize changed/context lines and convert token foreground colors to OpenTUI `StyledText` chunks; full-line red/green backgrounds, line-number gutter and `+`/`-` markers keep using TUI theme tokens. A language Shiki does not support, a load failure or a highlight timeout must degrade to a plain-text diff. Line numbers serve human audit only and never enter model-visible results.
- The first TUI preview has no word diff, in-permission-dialog editing or full review UI; those need their own spec and tests.
- The diff display is a UI projection of `tool_call_result`; it does not replace the `EditOutput` contract and is not a basis for model flow decisions.

## Behavior semantics

Core flow:

1. Expand the path and normalize to an absolute path; the current version does not hard-reject outside-workspace paths, and the filesystem permission adapter will later own ask/deny for outside-workspace edits.
2. Reject writing secrets to team memory.
3. Reject `old_string === new_string`.
4. Check edit deny rules.
5. For a UNC path skip early I/O and leave it to permission handling.
6. stat to prevent OOM on huge files; limit 1 GiB.
7. Read file bytes through `FileSystemPort.readTextFile`; the adapter infers the text encoding from BOM, UTF-8 validation and legacy Chinese encoding detection, and returns LF-normalized Unicode logical content plus the original `encoding` and `lineEndings` metadata.
8. ZCode currently rejects an empty `old_string` to avoid implicit insertion into existing files; creating a new file or a full rewrite uses `Write`.
9. Creating a file when it does not exist and `old_string` is empty is not exposed by ZCode for now; supporting it later requires updating the `Write/Edit` boundary and tests first.
10. Reject `.ipynb` files; there is no dedicated notebook edit tool, so the error message says to read and rewrite the whole notebook JSON with Write if necessary, and must not point to a nonexistent tool.
11. An existing file must have been fully `Read` earlier.
12. If mtime changed, continue when the full read-cache content is still identical; otherwise reject as a stale edit.
13. Find the actual string using exact first, then quote normalization and restricted compatibility matchers.
14. Reject when there is no match or a non-unique match; a fallback with more than one candidate must also be rejected, and the tool must not guess a position for the model.
15. Run extra validation on settings files.
16. Generate the patch and call `FileSystemPort.writeTextFile` with `encoding` and `lineEndings`, writing back in the original encoding and newline style; if `new_string` cannot be encoded in the original encoding the tool must fail and write nothing.
17. Notify LSP and IDE (LSP: publish a `FileMutatedEvent` with `changedRange`; Edit does not wait for the language server, see [19-lsp.md](19-lsp.md)).
18. Update `readFileState`.

## Permission model

`Edit` and `Write` share the filesystem write permission. It is a write tool and not concurrency-safe.

Extra requirements:

- `preparePermissionMatcher` matches wildcards by file path.
- `toAutoClassifierInput` uses `file_path` and `new_string` for automatic permission classification.
- Session-scoped exceptions for `.claude`, settings and dangerous paths are handled in the permission layer, not scattered across tools.

## Validation and errors

Error semantics:

| Scenario                                    | Semantics                                          |
| ------------------------------------------- | -------------------------------------------------- |
| Secret check fails                          | Writing sensitive content refused                  |
| Old and new strings identical               | No change                                          |
| Deny rule                                   | Permission denied                                  |
| Target missing and old string non-empty     | File does not exist                                |
| Target exists and old string empty          | Cannot create, file already exists                 |
| Notebook                                    | Edit unsupported; use Write to rewrite notebook JSON |
| Unread or partial read                      | Must read fully first                              |
| mtime/content changed                       | Stale edit                                         |
| Old string not found                        | Match failure                                      |
| Multiple matches without replace_all        | Ambiguous replacement                              |
| File too large                              | Exceeds the edit size limit                        |
| Empty `file_path`                           | Path must not be empty                             |
| Unsupported encoding or new content not encodable | Rejected, original file unchanged            |

ZCode gives these errors stable codes so flow never depends on English text. When the Edit handler finds an expected rejection at the existing check position it returns `{ result:false, errorCode, message }` instead of `throw`ing to the executor; the success path, read count and execution order are unchanged. The executor assembles the structured error generically and wraps only the provider-visible `modelContent` in `<tool_use_error>`; UI, logs and the structured error keep the bare message.

Numeric error codes are fixed: no change `1`, file exists and `old_string` empty `3`, file not found `4`, Notebook `5`, not fully read `6`, stale `7`, not found `8`, non-unique `9`, file too large `10`. I/O failures, cancellation and expected-revision conflicts remain execution exceptions and keep the generic exception path. ZCode path policy additionally rejects an empty `file_path`; the Edit handler returns the local stable error code `13` with the existing `Tool path must not be empty` message before entering shared path resolution, so the shared exception does not bypass Edit's provider error envelope. These numeric codes are exported by the Edit tool contract; the handler keeps no second private mapping, so provider errors and the public tool contract do not drift.

## Implementation status (2026-05-08)

| Capability                                       | Status      | Notes                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic exact replacement                          | implemented | `Edit` runs the `old_string` -> `new_string` replacement through `FileSystemPort` and generates `structuredPatch`.                                                                                                                                  |
| Relative path resolved against cwd               | implemented | Path resolution does not depend on the host process cwd.                                                                                                                                                                                            |
| Hard block of outside-workspace paths            | disabled    | The current version only normalizes paths and does not reject outside-workspace edits in core path-policy, because a subagent needs to operate on external repos or files on user instruction; fine-grained ask/deny will converge in the filesystem permission adapter. |
| Model-visible usage guidance                     | implemented | Guidance added: `Read` first, no line-number prefix, keep indentation, unique match by default, explicit `replace_all` for multiple replacements, prefer editing existing files, emoji only on explicit request.                                    |
| Model-visible short result                       | in progress | A successful `Edit` result serializes to a short confirmation; full original text and diff are not fed back to the model.                                                                                                                           |
| read-before-edit                                 | missing     | The runtime does not yet require a prior full `Read`, so unread, partial read and stale edit cannot be told apart.                                                                                                                                  |
| Uniqueness check                                 | implemented | With `replace_all=false`, multiple matches are rejected, asking the model for a more specific `old_string` or an explicit `replace_all`.                                                                                                            |
| Quote normalization                              | implemented | On match failure `Edit` tries curly quote normalization and keeps the file's original curly quote style in `new_string`.                                                                                                                            |
| Line-number prefix compatibility                 | implemented | `Edit` strips an accidentally included `<lineNumber>: ` or historical `<lineNumber>\t` view prefix.                                                                                                                                                 |
| Indentation fallback                             | implemented | On exact miss, with a unique candidate, tolerates common indentation, leading/trailing whitespace or literal `\n` / `\t` transcription differences.                                                                                                 |
| CRLF / UTF-16LE / legacy Chinese encoding / original newline preservation | in progress | `FileSystemPort` returns LF logical content, original encoding and line-ending metadata; `Edit` matches in LF space and writes back in the original format.                                                       |
| Empty `old_string` create semantics              | partial     | An empty `old_string` is explicitly rejected to avoid implicit insertion from JS includes/replace; creating new files via `Edit` is unsupported, use `Write`.                                                                                       |
| Notebook/settings/secret validation              | missing     | `.ipynb` rejection and settings/team memory safety checks are not implemented yet.                                                                                                                                                                  |
| Stable business errors                           | implemented | The handler returns fixed numeric `errorCode + message` at the existing check positions; the executor assembles the provider error generically without changing the success path.                                                                   |

Landed so far: model guidance, short-result serialization and multi-match rejection for `replace_all=false`; read cache, stale guard, encoding fidelity and structured errors come in later stages.

`Edit` is ZCode's core NL-to-code mutation primitive. Implementation must prioritize verifiability:

- Exact `old_string` matching and uniqueness are the core contract; compatibility matchers may only fix format drift when the model copies text from the Read view and must not freely guess where to edit.
- Structured patch editing belongs to `ApplyPatch`; patch semantics must not be squeezed into `Edit.old_string`.
- The read-before-edit constraint must share the `Read` cache structure.
- Write-back must keep the original encoding and newline style; `Edit` does not guess the host EOL and consumes the `lineEndings` metadata of `FileSystemPort`.
- File read, stale validation and write-back go through `FileSystemPort`; core handlers must not call Node `fs` directly.
- The permission UI should show the diff and let the user reject or modify the proposal.
- Tests must cover indentation, CRLF, UTF-16LE, GB2312/GBK/GB18030, duplicate matches, quote normalization, stale edit, unencodable character failure and settings file protection.
