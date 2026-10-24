# Glob Tool

## Capability

`Glob` finds files by file name or path glob pattern. It only answers "which file paths match this pattern"; it does not read file content and does not take on content search.

`Glob` was originally designed as an Explore-only built-in tool. The current default is the embedded search branch: neither the main agent nor the `Explore` child runtime exposes a direct `Glob`; repository path search is taken over by the `find` function in Bash. Only when Windows CMD or a legacy shell fallback cannot inject a Bash function does it return to the non-embedded/direct branch and expose `Glob`.

The model prompt must clearly distinguish:

- In the embedded branch, the main agent and Explore use Bash `find` to look for file names, extensions and directory structure.
- In the direct fallback branch, the main agent and Explore may use `Glob` to look for file names, extensions and directory structure.
- The main agent must not pretend that `Glob/Grep`, which are absent from the current provider-visible tool pool, are available.

The model-visible description uses short text; in the direct fallback branch the provider-visible description of `Glob` is fixed to:

`Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.`

ZCode currently does not switch the `Glob` description dynamically per model; all models use the same short text.

Open-ended multi-round search is not guided in the `Glob` description. ZCode currently switches the provider-visible search surface by branch: the embedded branch takes over through Bash `find` / `grep`; only the direct fallback branch keeps the `Glob`, `Grep`, `Read` combination for multi-round search.

## Input

| Field     | Type     | Required | Description                                                                                                                                                                                                                                           |
| --------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pattern` | `string` | yes      | `The glob pattern to match files against`                                                                                                                                                                                                             |
| `path`    | `string` | no       | `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.` |

The provider-visible input schema adds no extra restrictions such as `minLength`; runtime path resolution is still owned by the tool layer and `FileSystemPort`.

## Output

| Field        | Type       | Description                                                                     |
| ------------ | ---------- | ------------------------------------------------------------------------------- |
| `durationMs` | `number`   | Search duration.                                                                |
| `numFiles`   | `number`   | Number of files returned.                                                       |
| `filenames`  | `string[]` | Matching file paths. Paths are relative to the session cwd where possible, to save tokens. |
| `truncated`  | `boolean`  | Whether truncated by the result cap.                                            |

## Permissions and side effects

- `readOnly: true`
- `destructive: false`
- `sideEffectScope: "none"`
- `concurrentSafe: true`
- `needsApproval: false`
- Permission rules match `path` and `pattern`; deny takes priority over ask.

`Glob` may access the filesystem only through `FileSystemPort.searchFiles`. The core handler must not call `fs`, `child_process` or a shell directly.

## Result budget

At most 100 paths are returned by default. A result over the model budget must be truncated through `resultBudget` or go into artifact/storage.

## Failure paths

- `invalid_path`: `path` is empty, not a directory, or rejected by a later filesystem permission adapter.
- `invalid_pattern`: the glob pattern is empty or cannot be parsed.
- `permission_denied`: path permission denied.
- `io_error`: underlying filesystem error.
- `cancelled`: the adapter must stop traversing when the call is cancelled.

## Trace

When the handler calls `FileSystemPort.searchFiles` it must propagate `traceId`, `spanId`, `parentSpanId`, `sessionId` and `turnId`.
