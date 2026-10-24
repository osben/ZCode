# Model-IO to Anthropic Messages Trajectory Tool

Status: complete

## Background

`tools/prompt-trajectory derive` supports only the `trajectory.jsonl` that prompt-trajectory records itself. The ZCode CLI runtime also writes real `model-io-*.jsonl` files under `~/.zcode/cli/debug` or `~/.zcode/cli/rollout`. Their request bodies may be delta-compressed against the previous model-io record and include sidecar requests such as `session_title`.

To review the final prompt a whole main session sent to the provider, one complete model-io session must be converted into a single Anthropic Messages request trajectory instead of exporting each model-io request separately.

## Goals

- A reusable prompt-trajectory command that generates an Anthropic Messages trajectory JSON from ZCode `model-io*.jsonl`.
- By default include only `querySource === "main_turn"` requests of the main session; exclude sidecars such as `session_title`.
- Expand model-io deltas in original file order first, then filter by querySource, so inserted sidecars do not make the main session look non-incremental.
- Output `anthropic_trajectory.json` for direct review of the final provider-visible messages of the whole main session.
- Reuse the existing derive manifest/trajectories output so `non-incremental-change` splits can be inspected.

## Non-goals

- Do not merge subagent, compact, web_search_tool and other sidecars into the main trajectory by default.
- No new production runtime dependency; this capability belongs only to the `@zcode/prompt-trajectory` test tool.
- No change to the runtime model-io record format.

## Command contract

```bash
pnpm --filter @zcode/prompt-trajectory model-io -- \
  --input ~/.zcode/cli/debug/model-io-<session>.jsonl \
  --out tools/prompt-trajectory/out/<run>
```

Defaults: `--query-source` omitted means `main_turn`; `--input` and `--out` are required.

Output:

- `anthropic_trajectory.json`: the Anthropic Messages request body of the first derived trajectory. With no split in the main session this is the whole single trajectory.
- `manifest.json`: the existing derive manifest.
- `trajectories/*.openai_request_body.json` and `trajectories/*.anthropic_request_body.json`: the existing per-trajectory debug artifacts.

### ToolSearch synthesis mode

`model-io` and `derive` accept the optional `--ignore-tool-search-changes` (default off), used only for offline trajectory synthesis when the provider already handles tool changes. The top-level `tools` never take part in continuity comparison; this switch only relaxes ToolSearch projection differences inside messages. It does not change production requests, logs, cache policy or session persistence.

```text
original request (unchanged) -> comparison copy ignores ToolSearch projection -> continuity decision
                                                |
                      synthesized segment uses the last real request + final response
```

- When comparing, ignore, inside the native `tool_result.content` array of a real `ToolSearch` callID, the `tool_reference` entries and the two exact placeholder texts `[Tool references removed - tools no longer available]` and `[Tool references removed - tool search not enabled]`. Adding, removing, restoring or reordering references does not split.
- When comparing, ignore the standalone ToolSearch added/removed/restored catalog `system-reminder` blocks in user messages. Recognize the Native/Local current wording and the connection-reason wording of old logs; other reminders and user text are kept. A message holding only such an announcement may be omitted in the comparison copy; regressions verify the recognition rule with the current announcement generator output.
- When comparing, ignore the `Tool loaded.` derived after a successful ToolSearch result batch containing native references; each valid result corresponds to at most one such hint; parallel results and adjacent-user-merged shapes are supported. The same text in ordinary text, other tool output, or after failed / reference-less results is still compared strictly; the exported content keeps the hint from the last real request.
- ToolSearch callID, call name, input, result error status, ordinary result text, other tool results, thinking, ordinary text, Continue and compact history changes are still compared strictly. Not all tool messages are ignored generically.
- The switch affects only comparison; the exported content still uses the last real request of the segment, keeping its tools, references, announcements, placeholder texts and final response. It does not merge tool schemas, resurrect filtered historical references, or fake calls or results.
- The manifest records `ignoreToolSearchChanges: true` only when enabled; the default output contract is unchanged. The synthesized artifact does not mean per-turn wire equality or cache hits; the original model-io/ledger stay the per-turn source of truth.
- Regression coverage: default strict splitting; merging after removal/restoration when enabled; announcement migration; mixed text/reference order; call/result identity and non-ToolSearch negative cases; thinking completion; delta/sidecar; both CLI entries and file output.

## Acceptance

### Continuity decision (2026-09-12)

`non-incremental-change` means the recorded content changed in a non-incremental way; it does not mean the runtime cancelled or the provider cache missed. The only continuity fact source is adjacent requests after delta expansion; a response only supplements the reply of its request.

```text
original model-io -> expand all deltas -> filter by querySource
                                              |
previous request + response summary <- complete assistant in the next request
                                              |
continuity comparison -> complete trajectory / split at real rewrites
```

- The text/toolCalls of a model-io response are a lossy summary without the full structure and signature of thinking blocks. When the next request keeps the previous request's prefix and its immediately following assistant, with thinking/redacted_thinking removed, equals the summary text in full, use that real assistant to complete the previous reply, keeping thinking and signature as is. Provider blocks or signatures are never fabricated from reasoningText; with no later request, export with the existing summary.
- Only the trailing user of the previous sequence may gain blocks, and only if the original content blocks are fully unchanged; all other message attributes must match. No rewrite, deletion, reorder, role change or non-trailing message extension is accepted.
- Thinking, signatures, text, tool input/result and reminders already present in real requests all take part in strict comparison. Only existing `cache_control` drift is ignored during comparison; the final artifact keeps the latest request's original value.
- Real compact and history-rewrite splits are kept. No change to runtime, provider requests, cache, permissions, desktop continuous or mobile replayable behavior. Re-parsing historical files does not call the model or write the session database.
- Regression coverage: full thinking/signature, redacted thinking, sidecar/delta, trailing user append and negative cases; after re-exporting real samples, compare the latest request and every inserted reminder one by one.

Acceptance:

- Reads real ZCode model-io JSONL.
- Expands `bodyMessagesKind: "delta"` / `bodyMessageOffset` compression correctly.
- `session_title` requests do not enter the default main trajectory.
- An append-only full continuation inside main_turn is not misjudged as `non-incremental-change`.
- Unit tests cover delta expansion, sidecar filtering and the Anthropic Messages output file.

Verification:

```bash
pnpm --filter @zcode/prompt-trajectory exec node --import tsx --test 'tests/*.test.ts'
pnpm --filter @zcode/prompt-trajectory typecheck
pnpm --filter @zcode/prompt-trajectory exec oxlint --no-ignore src tests scripts
```
