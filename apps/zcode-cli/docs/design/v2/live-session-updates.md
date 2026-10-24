# Live Session Updates

## Document scope

The runtime's live session update channel: lets the TUI, ZCode protocol clients, future debug
panels, or remote UIs see model, tool, permission, and cancellation progress while a turn is still
executing. This is the v2 pre-implementation spec. It does not define ZCode Protocol SDK bindings
and does not change the principle that session events are the source of truth.

## Background

`AgentRuntime.executeTurn()` is externally request/response: the caller submits a prompt, the
runtime runs model requests, tool calls, result feedback, and follow-up model requests, and returns
`TurnResult` when the turn ends. That shape suits `--prompt` and scripts but not interactive
clients, which need to react during the turn: a model request started, a tool call appeared and is
waiting/running/completed/failed, a permission needs confirmation, the turn was cancelled, or the
final response finished.

## Goals

- A generic live event sink in core.
- Reuse existing `SessionEvent`; no second model of truth.
- TUI can render state and tool progress during the turn.
- Stable input for ZCode app-server `session/update` and `session/request_permission` mapping.
- Non-interactive CLI paths can still wait only for the final `TurnResult`.

## Non-goals

- No ZCode app-server types or SDK in core.
- No token-level `streamText()` in this phase.
- No ZCode app-server implementation in this phase.
- No interactive permission broker in this phase.
- Live updates are not persisted facts; facts still come from the event store.

## Core principles

### SessionEvent is the truth

Runtime state changes must first form a `SessionEvent` and be written to `SessionEventStorePort`.
The live sink only observes these events and has no new state-advancement authority.

### The live channel is a projection

Consumers project the same `SessionEvent` into different views: the TUI into status lines, tool
rows, and the current agent message; ZCode app-server into `session/update` notifications or
`session/request_permission` requests; debug panels into timelines, trace waterfalls, or
token/cost views.

Subagent child-session tool lifecycle is a special live projection: raw child `tool_call_*` events
are written to the child session event store first; the runtime may then emit mirror events with
`source: "subagent"` metadata to the parent session live sink. Mirror events serve real-time display
in the parent TUI/ZCode app-server; they are not written to the parent session event store and do
not change the parent message history. Resume/debug consumers needing the full facts follow
`childSessionId` into the child event store.

### Core does not know its consumers

Core exposes only:

```ts
interface SessionEventSink {
  onSessionEvent(event: SessionEvent): void | Promise<void>;
}
```

Consumer-specific mappers live in the TUI, ZCode app-server transport, or other outer modules.

### Sink failure must not corrupt fact writes

`appendEvent()` writes to the event store first, then notifies the sink. A sink throw is only
logged: it must not roll back the event store or invalidate business events that already succeeded.

External clients that disconnect or want to stop the turn cancel through `AbortController` or a
future cancel command, never by relying on a sink throw.

## Minimal event mapping

### TUI projection

| ZCode event | TUI update |
| --- | --- |
| `session_resumed` | append resumed message/part counts |
| `turn_started` | status: `Thinking...` |
| `model_request` | status: `Calling model...` |
| `model_complete` | update token usage panel and status; do not append usage to transcript |
| `turn_error` / `model_error` | append a bounded system error row and update status/sidebar error |
| `tool_call_scheduled` | create/update one tool transcript part with a structured title/detail projection from the scheduled input |
| `tool_call_started` | update the same tool transcript part to running without appending a duplicate row |
| `tool_call_result` | update the same tool transcript part to completed; for `result.display.kind=file_diff`, append a bounded diff preview |
| `tool_call_error` | update the same tool transcript part to failed and render the error description directly under the tool title |
| `permission_requested` | append `Permission requested for <tool>` |
| `permission_denied` | append `Permission denied for <tool>` |
| `compact_boundary` | append compact summary stats |
| `turn_complete` | final result still comes from `TurnResult.response` |
| `turn_error` | final error path still renders the thrown error |

### TUI viewport and status placement

TUI layout keeps execution status close to the active prompt:

1. Header and separator stay at the top.
2. The conversation transcript owns the remaining scrollable viewport.
3. Input or approval prompt renders above the session panel.
4. A session panel below the input stays visible with mode, model, thought level, traceId, token
   usage, and todo state.
5. Status renders as the final footer line below the session panel.

The status line is a live execution indicator only. It must not consume transcript height above the
conversation: model streaming must not push visible assistant content out of view from the top.

The transcript is an in-memory projection of the current TUI session. Rendering supports a bounded
viewport over the full rendered transcript instead of always discarding older lines. `scrollOffset`
is measured in rendered lines above the latest transcript line:

- `0` means follow the newest content.
- PageUp increases the offset up to the oldest available rendered line.
- PageDown decreases the offset back toward the latest content.
- Normal prompt Up/Down are reserved for input-history/editor behavior and must not mutate
  transcript scrollback. Selection, approval, and clarification prompts may keep their own Up/Down
  navigation contracts.
- New model/tool events keep following latest content only when the offset is already `0`;
  otherwise the user stays in scrollback.
- Starting a new prompt resets the offset to `0`.

Streaming assistant text must remain available in the transcript projection while the turn runs.
The renderer may clip the viewport but must not truncate the active assistant message solely to fit
the current terminal height.

When a turn completes, the TUI must not replace a populated live transcript entry with the final
assistant response. If no live model/tool line was rendered, the initial placeholder may be replaced
by the final response. If live lines were rendered, operational lines such as model request status
and tool status remain as the process transcript and the final response is appended as a separate
assistant message so scrollback can still inspect the tool/model path after completion.

Token usage is session metadata, not conversation text. `model_complete.usage` updates the panel
below the input box and the live status area but must not append a `Usage:` line to the transcript,
avoiding a transient line that appears under the assistant text and disappears when the viewport or
final answer projection changes.

Live model text is response material, not an independent process step. When the live model text
equals the final assistant response, the TUI removes that live model text before appending the final
response; otherwise the same answer shows twice. `model_complete.content` follows the same rule:
usage/status may render as progress, but the content must not create a second visible copy of the
final answer.

An empty final assistant response must not create a visible placeholder transcript row. Empty final
text means there is no additional assistant content; errors use the explicit error path instead of
masquerading as a normal agent message.

### TUI flicker-safe rendering

Streaming deltas may arrive faster than the terminal can repaint, so the TUI renderer treats live
model text as frame-paced UI input, not a command to repaint per token:

- Initial TUI entry and terminal resize may clear the whole screen.
- Routine rerenders, including model streaming, must not emit full-screen clear sequences; they
  reposition the cursor and update only affected rows, clearing individual rows before writing
  replacement content.
- The first visible streaming delta renders immediately so the user sees progress; subsequent
  deltas coalesce to a bounded frame cadence (initially 16ms, matching the mature CLI pattern of
  frame-paced rendering without a full virtual-screen engine).
- Final turn completion, permission prompts, input editing, and explicit scroll actions may render
  immediately: they are user-visible state changes, not high-frequency deltas.
- Any pending scheduled streaming repaint must be cancelled before shutdown or a forced immediate
  render so stale frames cannot draw after the UI exits.

Design rationale: a terminal renderer should throttle render commits around a shared frame interval
and use screen diff/damage tracking instead of full clears for steady-state frames, and model stream
chunking should be validated against a commit cadence. ZCode's first implementation keeps it smaller
by diffing rendered terminal rows, but the same contract applies: bounded streaming commits and no
steady-state full-screen erase.

### ZCode app-server projection, future phase

| ZCode event | ZCode app-server behavior |
| --- | --- |
| `turn_started` | optional progress `session/update` |
| `model_complete` | `session/update` with `agent_message_chunk` |
| `tool_call_scheduled` | `session/update` with `tool_call`, status `pending` |
| `tool_call_started` | `session/update` with `tool_call_update`, status `in_progress` |
| `tool_call_result` | `session/update` with `tool_call_update`, status `completed` |
| `tool_call_error` | `session/update` with `tool_call_update`, status `failed` |
| `permission_requested` | `session/request_permission` |
| `turn_complete` | `session/prompt` response with `end_turn` |
| cancellation | `session/prompt` response with `cancelled` |

## Delivery shape

`AgentRuntime` owns a small set of event sinks. `bootstrap` registers a per-turn sink when
`submitPrompt()` receives `onEvent` and unregisters it when the turn completes or fails. This keeps
the runtime reusable: `zcode --prompt` passes no `onEvent`; the TUI passes `onEvent` and updates the
screen; ZCode app-server passes `onEvent` and maps events to JSON-RPC notifications.

## Ordering

Within one runtime instance, events reach sinks in the same order `appendEvent()` sees them. The
first implementation awaits each sink call before returning from `appendEvent()` so tests and simple
clients stay deterministic. Avoid long-running sink work: heavy consumers enqueue lightweight
updates and process them outside the runtime critical path.

## Current limitation

The first implementation still uses `generateText()`, so model text appears when `model_complete` is
emitted rather than token by token. Token-level UI streaming requires a later `streamText()` path
emitting `model_streaming` deltas before `model_complete`.

## Minimal file diff display

`Write` and `Edit` results may attach a UI-only display payload to `tool_call_result`:

```ts
type ToolResultDisplay =
  | {
      kind: "file_diff";
      filePath: string;
      additions: number;
      deletions: number;
      structuredPatch: DiffHunk[];
      truncated?: boolean;
    };
```

This payload is a projection for interactive clients, not the model-visible tool result, and stays
bounded before rendering. The TUI renders a small red/green diff preview with a line-number gutter,
`+`/`-` markers, full-line red/green backgrounds when color is available, and a plain-text fallback
when color is disabled. It provides no syntax highlighting, word-level diffing,
permission-dialog editing, or full review UI.

The same bounded display payload must be persisted on the completed tool part as
`part.state.metadata.display` with `metadata.schemaVersion = 1`. Live clients read it from
`tool_call_result.payload.result.display`; resumed clients read it from the stored
`message + part` projection. Both paths share the same runtime schema and bounded projection helper
so a session reload does not lose the diff preview. Legacy parts without this metadata remain valid
and fall back to the stored model-visible `completed.output` text.

## Test requirements

- Core: the event sink receives live events in append order.
- Core: sink failure does not prevent the turn or the event store append.
- Bootstrap: `submitPrompt({ onEvent })` registers a per-turn sink and unregisters it after
  completion.
- TUI: live events render model/tool progress before the final response.
- TUI: `tool_call_result` with `result.display.kind=file_diff` renders the file path and bounded
  hunk lines.
- Runtime/bootstrap/TUI: completed file mutation tool parts persist `metadata.display`, resume
  restores it, and legacy completed tool parts without display metadata still render `output`.
- TUI: streaming status renders below the input footer.
- TUI: long assistant output can be scrolled with PageUp/PageDown without losing the latest
  transcript view.
- TUI: normal prompt Up recalls input history instead of scrolling even when transcript overflow
  exists.
- TUI: streaming delta rerenders do not emit a full-screen clear sequence.
