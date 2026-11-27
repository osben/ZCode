# Write Tool

## Purpose

`Write` creates a file or fully overwrites a local file.

## Input contract

`Write` input is a strict object:

| Field       | Type     | Required | Description                                                                                                          |
| ----------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `file_path` | `string` | yes      | Path to write. Relative paths resolve against the session cwd; absolute paths are normalized and handed to the filesystem adapter |
| `content`   | `string` | yes      | Full file content                                                                                                    |

Design requirements:

- `Write` writes full content; it is not a patch.
- The runtime normalizes `file_path` to an absolute path; relative paths use the session cwd and must never implicitly use the adapter's host process cwd.
- An existing file must be `Read` before modification.
- Prefer `Edit` for modifying existing files, because `Edit` carries only diff semantics.
- When overwriting an existing text file, `Write` must reuse the original `encoding` and `lineEndings` metadata returned by `FileSystemPort.readTextFile`, preserving legacy encodings such as GB2312 / GBK / GB18030; new files default to UTF-8.
- If the full content contains characters the original encoding cannot represent, the filesystem adapter must fail and keep the original file; silent replacement with `?` or corrupted bytes is not allowed.
- The model should not create documents or READMEs by default unless the user explicitly asks.

## Output contract

Output:

| Field             | Type              | Description                                        |
| ----------------- | ----------------- | -------------------------------------------------- |
| `type`            | `create \| update` | New file or overwrite of an existing file          |
| `filePath`        | `string`          | Path written                                       |
| `content`         | `string`          | Content written                                    |
| `structuredPatch` | `Hunk[]`          | Diff hunks for display                             |
| `originalFile`    | `string \| null`  | Original content, `null` for a new file            |
| `gitDiff`         | optional object   | A git diff may be attached in remote scenarios     |

The model-visible result is short text:

- Create: file created.
- Update: file updated.

Full content and diff are left to UI, audit and artifacts, not put in the model response.

Minimum current implementation requirements:

- `structuredPatch` must be generated after a successful write, for TUI and debug events.
- The TUI shows only a bounded-line red/green diff preview: a line-number gutter per hunk line, `+`/`-` markers and full-line red/green backgrounds. This UI projection is not a model-visible contract.
- The first TUI preview has no syntax highlighting, word diff, in-permission-dialog editing or full review UI; those need their own spec and tests.
- The model-visible result still goes through result-budget serialization; the UI diff display is an extra projection and business logic must not parse it back.

## Behavior semantics

Core flow:

1. Expand a relative path against the session cwd and normalize to an absolute path.
2. The current version does not hard-reject paths outside the workspace and only normalizes absolute paths; the filesystem permission adapter will later own ask/deny for outside-workspace writes.
3. Locate the parent directory.
4. Run a secret check on the content, especially for team memory files.
5. Check edit deny rules.
6. If the file exists, require that it was fully read earlier.
7. Prevent stale writes through mtime and the read cache.
8. Create the parent directory.
9. Optionally record file history for undo or audit.
10. Synchronously re-read the current file and confirm it was not modified concurrently.
11. Write the full content in the original encoding; ZCode currently passes the existing file's `lineEndings` metadata back to the adapter to keep the existing newline style. If the content cannot be encoded in the original encoding, fail; never degrade to lossy replacement.
12. Notify LSP and IDE that the file was updated (LSP: publish `FileMutatedEvent`; Write does not wait for the language server, see [19-lsp.md](19-lsp.md)).
13. Update `readFileState` to the new content and new mtime.
14. Return the create/update result and a display diff.

## Permission model

`Write` is a write tool: not read-only and not concurrency-safe by default.

Permission decisions come from the unified filesystem write permission:

- Edit deny rules take priority.
- Internal editable paths such as plan and scratchpad may be allowed directly.
- Sensitive directories such as `.claude/**` allow only session-scoped special rules to bypass the safety check.
- Dangerous files, dangerous directories, Claude settings and suspicious Windows paths go to ask.
- In `acceptEdits` mode, writes inside the workspace may be allowed.
- An explicit edit allow may allow.
- Default is ask, with `acceptEdits` or add-working-directory suggestions.

ZCode classifies both create and update as `workspace` side effects and explicitly declares that an existing file may be overwritten.

## Validation and errors

Failure paths:

- Team memory secret check fails.
- Path hits an edit deny rule.
- Existing file was not read.
- Existing file was read only as a partial view.
- The file was modified by the user, a formatter or a linter after the last read.
- A UNC path does no early I/O and is left to permission handling.
- Filesystem errors during the write bubble up.

These errors keep the original cause. Failures the handler can anticipate are told apart by a numeric `errorCode` (see the next section); permission denials go through the permission chain, and filesystem I/O errors are thrown as they are. None of these are in the table below.

### Text the model sees (2026-11-14)

For the failures below the handler returns `{ result: false, errorCode, message }` and the executor wraps it in
`<tool_use_error>…</tool_use_error>`. The App shows the original text without the tags. All checks run in the handler,
after permissions, at the same point as before. `<file_path>` is the raw value the model passed.

| Condition | errorCode | Text |
| --- | --- | --- |
| An existing file was not read, or the latest view is partial (Read returned only one page, compaction restored only a reference, or MEMORY.md was injected into the context truncated) | 2 | `File has not been read yet. Read it first before writing to it.` |
| Changed after it was read | 3 | `File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.` |
| The target is a directory | 17 | `<file_path> is a directory, not a file. To create a file inside it, include the file name in file_path.` |
| The target exists but is not a regular file | 18 | `<file_path> exists but is not a regular file (a device, FIFO or socket). Write only creates or overwrites regular files.` |

A truncated injected MEMORY.md gets no separate "only the beginning was seen, use Edit instead" text: ZCode's Edit also
requires a full read first (03-edit.md), so following that advice would fail once more. "Read first" holds for both
Write and Edit.
Directories and non-regular files used to return the filesystem-level `Cannot read directory as text file: <path>` /
`Cannot read non-file path as text: <path>`, and the model could not tell that `file_path` was wrong. When the encoding
of an existing file cannot be read, a filesystem error is still thrown, with unchanged text.

Why this was fixed: these failures used to be thrown exceptions without `<tool_use_error>`, while the same failures in
Edit always carried the tags, so the two tools disagreed.

## Implementation status (2026-05-08)

| Capability                              | Status      | Notes                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic create/overwrite                  | implemented | `Write` reads the original content through `FileSystemPort`, writes the full content and generates `structuredPatch`.                                                                                                                               |
| Relative path resolved against cwd      | implemented | Path resolution does not depend on the host process cwd.                                                                                                                                                                                           |
| Hard block of outside-workspace paths   | disabled    | The current version only normalizes paths and does not reject outside-workspace writes in core path-policy, because a subagent needs to operate on external repos or files on user instruction; fine-grained ask/deny will converge in the filesystem permission adapter. |
| Model-visible usage guidance            | in progress | Guidance added: `Read` before modifying an existing file, prefer `Edit` for existing files, do not proactively create documents.                                                                                                                    |
| Model-visible short result              | in progress | A successful `Write` result serializes to a short confirmation; full content and diff stay in structured output / UI projection only.                                                                                                               |
| Existing file read-before-write         | missing     | The runtime does not yet require an existing file to be fully `Read` first.                                                                                                                                                                         |
| Stale write protection                  | partial     | Relies on the single read/write protection of `FileSystemPort.writeTextFile(expectedRevision)`; read-cache-based unread, partial-read and mtime/content comparison are missing.                                                                     |
| File history / LSP / IDE notification   | partial     | After a successful write `FileMutatedEvent` is published and consumed by LSP document sync (see [19-lsp.md](19-lsp.md)); file history and IDE notification are not wired yet.                                                                      |
| Secret/settings/dangerous path checks   | missing     | Currently relies mainly on the generic path policy and permission declarations; special-file safety checks are not covered yet.                                                                                                                    |

Only model guidance and short-result serialization have landed; read cache, stale guard and safety checks come in later stages.

`Write` must not be a thin shell over `fs.writeFile`. It is a controlled file mutation pipeline:

- The business layer only submits a `WriteFileIntent`.
- `FileMutationService` owns read-cache validation, mtime/content comparison, diff generation, history and LSP notification.
- `FileSystemPort` owns mkdir, stat, read and atomic write.
- `FileSystemPort` is the write capability boundary; Node local writes and ZCode app-server `fs/write_text_file` must implement the same contract.
- `PermissionPort` owns workspace, dangerous path, mode and rule decisions.
- After a successful write the read cache must be updated, otherwise the next `Edit` misjudges staleness.
- Tests must cover unread write, partial read, mtime false positives, creating a nonexistent file, path permission and newline preservation.
