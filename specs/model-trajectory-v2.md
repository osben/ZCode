# Model trajectory v2

## Problem

The v1 trajectory pane shows the normalized `request.messages` of each model call, not what actually reached the provider or where time went:

- the tool catalog, about two thirds of the input on the wire (27–160 KB per call);
- request parameters (`max_tokens`, `thinking`, `effort`, `tool_choice`);
- cache breakpoints, `cacheWriteTokens`, and the `cacheReadTokens` / `reasoningTokens` that v1 maps but never renders;
- time to first token, tool execution time, and context fill per call.

v2 is a second, independent view for those questions; v1 stays unchanged and both can be open at once.

## Scope

Seven blocks:

| Block            | Content                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| A Summary        | One line: calls, tokens, cache hit %, peak context %, model time vs tool time                                         |
| B Overview strip | Model and Tools lanes on wall-clock time; model spans split into TTFT and decoding; drag a range to filter the ledger |
| C Event ledger   | One row per turn, request, user message, assistant reply, tool call, or marker                                        |
| D Inspector      | Tabs for the selected row: Summary, Payload, Result, Schema, Timing                                                   |
| E Request facts  | Not a separate block: the request separator row in C and the Payload tab in D                                         |
| F Context chart  | Context % per main call, with compaction and context-reset markers                                                    |
| G Time by tool   | Execution time and call count per tool name, plus a model bar                                                         |

Non-goals: live streaming updates, editing or replaying requests, cross-session aggregation, and changes to v1.

## Owners and event order

```text
writer     CLI runtime        model-io-<session>.jsonl (+ timing, specs/model-io-stream-timing.md)
           CLI runtime        db.sqlite tool_usage / part (existing, owned by the CLI)
           provider registry  model config contextWindow (existing)

open       menu / header / launcher ── requestOpen({kind:"v2"}) ──▶ modelTrajectoryStore (one bridge)
             ──▶ useAppPanels ──▶ side-pane tab "model-trajectory-v2:<taskId>" ──▶ ModelTrajectoryV2Pane

load       pane mount or Refresh: seq += 1; state = data ? "refreshing" : "loading"
             zcode-task RPC getModelTrajectoryV2({taskId})          (desktop: local Host; mobile: attached Host)
               Host, stateless and read-only:
                 1 v1 raw window: tail ≤ 32 MiB → expand writer deltas → keep last N (200)
                 2 v1 record mapping + input-delta projection (unchanged)
                 3 request facts, timing, dedupe of tool definitions and system blocks
                 4 tool_usage lookup for the tool call ids in the window
                 5 contextWindow once per (providerId, modelId)
             response: seq ≠ current or unmounted → dropped; else data = response, state = "ready"
             error: previous data kept with an inline error; no data → error state

derive     useMemo, pure: ledger rows → metrics (A, G) → strip geometry (B) → context series (F)

view       pane memory: selection (row key), range [t0, t1] in epoch ms, zoom; reconciled on new data
           localStorage zcode.modelTrajectoryV2.view.v1: charts collapsed, show sidecars, inspector size
```

The Host owns facts only and keeps no cache. The UI owns presentation: rows, filters and selection are derived on the client so the RPC contract stays stable while the view evolves. Refresh is manual, as in v1. The read is one-shot on both the desktop-continuous and web-remote-replayable links and has no stream, snapshot or replay semantics.

## Interfaces

- RPC: `IZCodeTaskService.getModelTrajectoryV2({ taskId, limit? }): Promise<ZCodeModelTrajectoryV2>` on the existing `zcode-task` channel. Desktop host routing, the server and the mobile allow-list pass it through without changes.
- Host module `model-trajectory-v2-projection` (`packages/services/src/model-trajectory-v2/`). Its `contract.ts` owns the response types.
- UI module `model-trajectory-v2` (`packages/ui/src/model-trajectory-v2/`). Its `contract.ts` is the only file that imports `@zcode/services`.
- Side-pane tab type `model-trajectory-v2`, id `model-trajectory-v2:<taskId>`, deduplicated per task and independent of the v1 tab.

Response shape (summary; the module contract is authoritative):

- `records`: v1 records extended with `request.params`, `request.toolCatalogId`, `request.systemPromptId`, `request.cacheBreakpoints`, `request.cacheBreakpointsComplete`, `response.usage.cacheWriteTokens`, and `timing`.
- `toolDefs`, `toolCatalogs`, `systemBlocks`, `systemPrompts`: interned maps referenced by id from records. Ids are stable only within one response.
- `contextWindows`: `{ providerId, modelId, tokens? }` per distinct model in the window.
- `toolTiming`: `{ source: "session-db", entries }` or `{ source: "unavailable", reason, entries: [] }`.
- `budget`: bytes spent on tool definitions and system blocks, and whether anything was omitted.

## Product rules

### Request facts

1. Parameters come from the wire body. Anthropic: `max_tokens`, `thinking`, `output_config.effort`, `tool_choice`, `temperature`, `stream`. OpenAI-style: `max_completion_tokens` or `max_tokens`, `reasoning_effort`, `tool_choice`. Missing values stay absent.
2. Cache breakpoints are recorded for `cache_control` on system blocks, tool definitions and message parts. Production trimming removes message bodies, so message-level breakpoints are reported only when the body messages are present; otherwise `cacheBreakpointsComplete` is `false`.
3. A record without a wire body has no catalog or system prompt id. The UI falls back to `request.toolNames` and the system-role input messages.
   3a. A subagent session's own loop lives in its own `model-io-<childSessionId>.jsonl` with `querySource: "subagent"`; parent sessions never carry those calls. The Host projection (`promoteSubagentSessionLoop`, `model-trajectory-v2/domain/subagentLoop.ts`) treats a window with no `main` call but with `subagent` calls as a subagent session's trajectory: those calls become `callSource.kind = "main"` (`querySource` stays `subagent`) before input deltas are decided, so they chain as deltas (an exception to input-deltas rule 1, which is about a parent's subagent calls). Main-call metrics, the context chart, ledger turns and input deltas then work for a subagent trajectory opened from the Agent row (specs/conversation-agent-row-context-menu.md). A window with any `main` call is unchanged, and so is the v1 viewer.

### Payload budget

4. Tool definitions are interned per definition by canonical JSON, so a catalog that changes by one tool costs one new definition plus an id list. Each description is bounded to 16 KiB and each schema to 32 KiB (stringified and marked `truncated`). Total definition bytes are capped at 1 MiB; definitions past the cap keep only name and size and are marked `omitted`, and `budget.omitted` is set.
5. System blocks are interned per block. Each block is bounded to 64 KiB (head and tail), total 256 KiB, with the same `omitted` rule.
6. Message parts keep the v1 per-part budget and input-delta projection. Expected response size is the v1 size plus 200–350 KB, at most about 1.5 MiB more. Attaching `request.body` per record is forbidden (200 × 160 KB = 32 MB).

### Tool timing

7. Tool timing is read from the CLI session database resolved by `resolveAgentSessionDbPath()`, opened read-only with a 250 ms busy timeout. The Host never writes it.
8. Rows come from `tool_usage` by `(session_id, tool_call_id)` for the tool call ids present in the window, queried in chunks of 500. `scheduledAt` is `started_at` (includes permission wait). Execution end is `completed_at`; execution start is `completed_at - duration_ms`. `duration_ms` is recorded for completed and failed calls; when it is null (a call still running), execution times are absent. The `part` table is not read.
9. Any failure (path unknown, file missing, read error) returns `source: "unavailable"` with the reason. The trajectory still loads; tool lanes, the Timing tab and block G show that timing is unavailable.
10. Rows pruned by CLI retention simply have no timing. Tool rows without timing fall back to the parent call's `completedAt` as their start, with no duration.

### Context window

11. The window size is resolved per `(providerId, modelId)` from the provider registry's effective model config (`properties.contextWindow`). A miss or an error means unknown.
12. Context % of a main call is `inputTokens / window`. `inputTokens` already includes cache read and write tokens. The tooltip also shows the composer-equivalent `inputTokens + outputTokens`.
13. With an unknown window, block F plots tokens and block A omits the peak %.

### Ledger (block C)

14. Rows in order: `turn` header when the turn id changes, `request` separator per call, then that call's new `user` messages, the `assistant` reply, and one `tool` row per response tool call.
15. User rows of a main call are the messages in its input delta, or its full input when it is the first main call in the window. A main call that is full but not first (compaction or a context rewrite) emits a `context-reset` marker followed by the user messages after the last assistant message.
16. A tool row's result is the `tool-result` part with the same `toolCallId` in any later call's input. A missing result shows as pending.
17. Compact calls emit a `compact` marker. Sidecar and subagent calls are hidden by default behind a toggle; shown, they render as their own request groups. A retried attempt emits a `retry` marker. A truncated window starts with a `window-truncated` marker.
18. The request separator shows model, parameters, catalog size (tool count and KB), system prompt size, breakpoints count, and the change from the previous request of the same source kind: parameters, tools added or removed, system prompt changed, model changed.
19. Row keys are derived from request ids, tool call ids and message indexes, so they stay stable when records are appended.

### Metrics (blocks A and G)

20. Cache hit % is `Σ cacheReadTokens / Σ inputTokens` over main calls with usage.
21. Model time and tool time in A are the wall-clock union of their intervals; parallel tools and overlapping sidecars are not double-counted. The tooltip shows the plain sums.
22. Block G lists plain execution-time sums and call counts per tool name, sorted by time, plus a model bar equal to the sum of model call durations.

### Overview strip (block B)

23. The x axis is wall-clock time over the window. Overlapping spans are packed into sub-rows of their lane.
24. A model span with known TTFT draws the TTFT part lighter and decoding solid. Without TTFT it is drawn solid.
25. Dragging selects a range in epoch milliseconds. The ledger shows every row whose interval intersects the range, inclusive. Clear-range and Escape reset it. A click without drag selects the row under the pointer. Ctrl or Cmd plus wheel zooms around the pointer; Shift plus wheel pans. The strip handles these wheel events with a non-passive listener and prevents their default, so the page neither zooms nor scrolls.

### Inspector (block D)

26. Tabs by row kind: request rows show Summary, Payload (parameters, system blocks, tool catalog, breakpoints, full input) and Timing; tool rows show Summary, Payload (arguments), Result, Schema (the definition from that call's catalog) and Timing (scheduled, execution start and end, duration, approval status); assistant rows show Summary, Result (text, reasoning, tool calls) and Timing (TTFT, decoding, usage); user rows show Summary and Payload. A request whose input is a delta can switch its Payload between new and full input; a message expanded before the switch stays expanded after it, and no other message opens in its place.
27. Unknown values render as "—", never as zero.

### View state

28. Selection survives refresh when its row key still exists; otherwise it clears. The range survives refresh and is clamped to the data extent. Zoom resets when the task changes.
29. The pane keeps previous data visible during refresh and marks it `data-trajectory-v2-state="refreshing"`.

### Layout

30. Container width ≥ 720 px: ledger and inspector side by side in a resizable split; F and G side by side in a collapsible section under the strip.
31. Narrower: single column; selecting a row opens the inspector as a drill-in view with Back.
32. Mobile compact viewport: the inspector opens in a bottom sheet.
33. Styling follows `DESIGN.md`: the `--color-trajectory-*` category tokens, `text-ui-xs` for axis labels, `font-mono` for ids, arguments and commands, no horizontal page scroll.

### Event categories: skills, memory, MCP (H1–H4)

Classification is a pure UI function of the v2 response; the Host contract does not change. It relies on the runtime names and text markers listed below, so a runtime change to any of them must update `domain/eventCategories.ts` and its tests.

34. Categories: `skill`, `memory` (operation `read` or `write`), `mcp`; everything else stays uncategorized.
35. Skill: a tool call named `Skill`. The skill name is `input.skill`, arguments `input.args`. Slash commands also go through this tool (the Skill tool description instructs it; no other injection path exists in the runtime). Loaded size is the result's `truncated.originalBytes` when bounded, otherwise its serialized length.
36. MCP: a tool call whose name starts with `mcp__`. Strip the prefix and split at the first `__`: the left part is the server, the rest the tool (`mcp__plugin_image-search_image_search__search_image` → server `plugin_image-search_image_search`, tool `search_image`).
37. Memory roots are learned from the input: `Contents of <root>/MEMORY.md (user's auto-memory, …)` gives a root, and each `Memory: <path>:` line of a recall attachment gives a file. A path also counts as memory when it matches `/memories/projects/<project>/memory/` (the runtime's `resolveProjectMemoryRoot`). Paths and roots are compared with `\` normalized to `/`, so Windows paths match.
38. Memory read: a `Read` of a memory path; an index injection (`Contents of …/MEMORY.md`); a recall attachment (`Retrieved for possible relevance …` with its `Memory: <path>:` lines). Memory write: `Write`, `Edit` or `MultiEdit` of a memory path.
39. Injections are found only in a main call's new input (its delta, or the messages after the last assistant message of a full record), so a full history is never counted twice. The index shows again after compaction or a context reset; that is a real reload.
40. Injections become ledger rows of kind `context` (`data-trajectory-v2-row-kind="context"`) with source `memory-index` or `memory-recall` and the file list. Their inspector shows Summary and Payload (the injected text).
41. Memory sidecars are model calls with `querySource` `project_memory_recall` (selects recall files) or `dream` (background consolidation). They always produce a `memory` marker row, even when sidecars are hidden; a `dream` row states how many memory writes its tool calls made.
42. H3: tool rows keep `data-trajectory-v2-row-kind="tool"` and gain `data-trajectory-v2-category`. The badge reads SKILL, MEMORY or MCP; the text is `skill-name → loaded, size`, `server · tool {args} → result`, or `read|write · file name`.
43. H1: filter chips above the ledger with counts per category (memory shows reads and writes, MCP the number of servers). One chip at a time; the filter is ANDed with the time range; turn headers of kept rows stay, request separators are hidden while a category filter is on. Counts cover the whole loaded window, including hidden sidecar records.
44. H2: tool spans on the strip are colored by category, and memory sidecar calls get their own lane, drawn only when such calls exist.
45. H4: a second summary line lists loaded skill names, memory reads and writes, and MCP calls per server with total execution time.
46. Category colors are the feature tokens `--color-trajectory-skill`, `--color-trajectory-memory`, `--color-trajectory-mcp`, defined for all four themes; category is never shown by color alone (badge text always present).

## Compatibility and version skew

- Records without `timing`, wire body or `cacheWriteTokens` are valid and show unknown values.
- v1 files, its RPC and its tab are unchanged apart from the shared open bridge gaining an optional `kind` (default v1).
- Host and viewer ship together. A viewer calling a Host without `getModelTrajectoryV2` shows the read error state.

## Acceptance scenarios

Unit tests:

- runtime: `apps/zcode-cli/packages/adapters/tests/runner-debug-stream-timing.test.ts`;
- Host: `packages/services/test/modelTrajectoryV2{RequestFacts,Dedupe,ToolTiming,Read}.test.ts` and the module `contract.test.ts`;
- UI: `packages/ui/test/modelTrajectoryV2{Ledger,RequestDiff,Metrics,TimeScale,ViewState}.test.ts`, render tests, and the updated side-pane tests.

E2E: `packages/desktop/test/e2e/conversation-session/conversation-session-model-trajectory-v2-viewer.test.ts`, cases TRV01–TRV08 in `docs/testing/model-trajectory-e2e-coverage-matrix.md`.

1. A live main turn with a Bash tool call: v2 opens from the task menu next to v1; the ledger shows user, request, assistant and `Bash {command…} → preview`; the tool Timing tab shows scheduled and execution times from `tool_usage`; the request Timing tab shows TTFT.
2. Two catalogs differing by one tool, cached system blocks, effort and `max_tokens` changes, usage with cache write and reasoning, a compact call, and a legacy record: separator chips show the deltas; Payload shows tool count, KB and breakpoints; Schema shows the call-time definition; the legacy record shows "—"; context % is shown for a known model and hidden for an unknown one.
3. Dragging on the strip filters the ledger; clearing restores it; clicking a span selects its row; the range survives refresh.
4. 150 calls stay virtualized; arrow keys move the selection and keep it in view.
5. Refresh keeps the ledger mounted, shows the refreshing state, adds new rows and keeps the selection.
6. After closing the tab, the `+` launcher and the header menu reopen v2 for the active task.
7. A narrow pane uses a single column with drill-in and no horizontal scroll.
8. With the session database unavailable, the trajectory loads and timing shows as unavailable.
9. Skills, memory and MCP: a Skill call, an MCP call, a memory Write, an index and a recall injection, and `project_memory_recall` and `dream` sidecars produce categorized rows with badges, filter chips with correct counts (filtering keeps only that category), strip colors and a memory lane, and the summary line of skills, memory and MCP servers.
10. A subagent session's trajectory (all calls `querySource: "subagent"`) counts them as main calls: the summary shows `N calls`, not `0 calls (+N other)`, the context chart has one point per call, and later calls are input deltas of earlier ones. A parent session's trajectory is unchanged.
