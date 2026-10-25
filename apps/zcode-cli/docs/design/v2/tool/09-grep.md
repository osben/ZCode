# Grep Tool

Implementation status (2026-05-08): L1 has landed. The core handler starts content search only through `FileSystemPort.searchText` and propagates `traceId` / the abort signal; the Node adapter uses the bundled ripgrep WASM by default and degrades to a JS fallback when WASM is unavailable. The failure paths now include the stable `cancelled` FileSystemPort error code and the `grep_cancelled` tool contract code; the handler maps search cancellation to `tool_cancelled`, so a user cancel is not misreported as an ordinary I/O failure.

## Capability

`Grep` searches file content. Semantically it is a controlled ripgrep capability: regex matching, restricting files by glob/type, and returning a file list, matching lines or counts by output mode.

The model-visible description and input schema descriptions use the short text of the direct fallback branch; the embedded branch does not expose the direct `Grep` tool. The input schema adds no extra restrictions such as `minLength`, `minimum` or `integer`.

ZCode currently does not switch the `Grep` description dynamically per model; all models use the same short text.

`Grep` was originally designed as an Explore-only built-in tool. The current default is the embedded search branch: neither the main agent nor the `Explore` child runtime exposes a direct `Grep`; repository content search is taken over by the `grep` function in Bash. Only when Windows CMD or a legacy shell fallback cannot inject a Bash function does it return to the non-embedded/direct branch and expose `Grep`.

The model prompt must state:

- In the embedded branch, the main agent and Explore use Bash `grep` for content search.
- In the direct fallback branch, the main agent and Explore may use `Grep` for content search.
- The main agent must not pretend that `Glob/Grep`, which are absent from the current provider-visible tool pool, are available.

## Input

| Field         | Type                                           | Required | Description                                                                                                                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pattern`     | `string`                                       | yes      | `The regular expression pattern to search for in file contents`                                                                                                                                                                                                                                                              |
| `path`        | `string`                                       | no       | `File or directory to search in (rg PATH). Defaults to current working directory.`                                                                                                                                                                                                                                           |
| `glob`        | `string`                                       | no       | `Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob`                                                                                                                                                                                                                                               |
| `output_mode` | `"content" \| "files_with_matches" \| "count"` | no       | `Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".`                                                                   |
| `-B`          | `number`                                       | no       | `Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.`                                                                                                                                                                                                                     |
| `-A`          | `number`                                       | no       | `Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.`                                                                                                                                                                                                                      |
| `-C`          | `number`                                       | no       | `Alias for context.`                                                                                                                                                                                                                                                                                                         |
| `context`     | `number`                                       | no       | `Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.`                                                                                                                                                                                                           |
| `-n`          | `boolean`                                      | no       | `Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.`                                                                                                                                                                                                                 |
| `-i`          | `boolean`                                      | no       | `Case insensitive search (rg -i)`                                                                                                                                                                                                                                                                                            |
| `-o`          | `boolean`                                      | no       | `Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.`                                                                                                                                 |
| `type`        | `string`                                       | no       | `File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.`                                                                                                                                                                                           |
| `head_limit`  | `number`                                       | no       | `Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).`        |
| `offset`      | `number`                                       | no       | `Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.`                                                                                                                                                                         |
| `multiline`   | `boolean`                                      | no       | `Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.`                                                                                                                                                                                                     |

`-o` takes effect only with `output_mode: "content"`; `files_with_matches` and `count` modes must ignore `onlyMatching`. When a `multiline: true` match spans lines, the adapter must, with `rg -n -o` semantics, expand the matched text into multiple non-empty line entries and increment `lineNumber`; embedded newlines must not be kept in a single provider-visible entry. If `-A` / `-B` / `-C` / `context` is also requested, context lines are still returned as full-line entries with `matched: false`. The provider-visible runtime follows the `--json` parsing path: LF/CRLF are line terminators, a trailing newline produces no extra blank line, a lone `\r` is kept as matched text; a zero-length regex match still keeps an empty-string entry as in native ripgrep.

## Output

| Field          | Type                                           | Description                                                               |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `mode`         | `"content" \| "files_with_matches" \| "count"` | Actual output mode.                                                       |
| `durationMs`   | `number`                                       | Search duration.                                                          |
| `numFiles`     | `number`                                       | Number of files returned.                                                 |
| `filenames`    | `string[]`                                     | File list in `files_with_matches` mode.                                   |
| `content`      | `string`                                       | Text result in `content` or `count` mode.                                 |
| `numLines`     | `number`                                       | Number of lines returned in content mode.                                 |
| `numMatches`   | `number`                                       | Number of matches found.                                                  |
| `truncated`    | `boolean`                                      | Whether truncated by `head_limit` or the result budget.                   |
| `appliedLimit` | `number`                                       | Entry limit actually applied. Omitted when not truncated.                 |
| `appliedOffset`| `number`                                       | Offset actually applied. Omitted when not set.                            |

## Permissions and side effects

- `readOnly: true`
- `destructive: false`
- `sideEffectScope: "none"`
- `concurrentSafe: true`
- `needsApproval: false`

`Grep` may access the filesystem only through `FileSystemPort.searchText`. Core must not call `fs`, `child_process` or a shell directly.

The Node adapter by default runs content search with the ripgrep WASM capability shipped with the package. WASM ripgrep is an infrastructure-layer detail: it is not exposed to core, does not require `rg` installed on the user's system, and does not run external commands through a shell. The adapter must keep a controlled JS fallback for WASM initialization failure, packaging environments without WASI support, or test injection; the fallback's behavior should stay as close to the ripgrep output contract as possible.

The first version adds no `ZCODE_` environment variable switch. Both the ordinary npm package and the SEA package must include the ripgrep WASM runtime code in the release artifact; see `docs/design/v2/tool/11-ripgrep-wasm-packaging.md`.

## Result budget

The default `head_limit` is 250, so broad searches do not pollute the context. `head_limit: 0` is an explicit request for unlimited output, but the executor must still apply `resultBudget`, persisting to artifact/storage when necessary.

## Failure paths

- `invalid_path`: `path` is not a file/directory, does not exist, or is rejected by a later filesystem permission adapter.
- `invalid_pattern`: ripgrep reports a regex parse failure, or the JS fallback cannot compile the regex.
- `permission_denied`: path permission denied.
- `too_large`: a single file, the total result or the WASM output exceeds the adapter capability limit and cannot degrade.
- `io_error`: underlying filesystem error.
- `cancelled`: the adapter must check the cancellation state before entering the search and after the search returns; the JS fallback must also keep checking it during traversal and reads.

## Trace

When the handler calls `FileSystemPort.searchText` it must propagate the unified execution context. The search's adapter I/O, truncation state, errors and result budget serialization all belong to the same `traceId`.
