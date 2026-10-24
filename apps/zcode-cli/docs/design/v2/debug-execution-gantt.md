# Debug Execution Gantt

The raw `timeline` in `debug` preserves factual order but cannot express concurrency. Tool calls,
model requests, and permissions may overlap, so the debug UI reconstructs sustained spans from the
trace and renders them as a Gantt chart.

## Goals

- Add `spans[]` to `GET /api/traces/:traceId` for sustained execution spans.
- Keep `timeline[]` as the raw events, logs, and SQLite message/part view, newest first, untruncated.
- `spans[]` targets concurrent visualization: each span describes a turn, model, tool, permission,
  subagent, network, storage, or log segment by `startAt`, `endAt`, lane, and status.
- The UI renders the Gantt chart with `vis-timeline`, with horizontal zoom, scrolling, lane grouping,
  and click-to-detail.
- Network capture records can be converted to `network` lane spans and shown together with runtime
  spans of the same `traceId`.

## Non-goals

- The Gantt chart does not replace the raw timeline; the event record is authoritative in the
  timeline and payload details.
- No inference of unobserved concurrency: a record without `startAt` produces no span.
- Network spans are not persisted; they come from the debug server's in-memory live request list.

## Span contract

```ts
type TraceSpanLane =
  | "turn"
  | "model"
  | "tool"
  | "network"
  | "permission"
  | "storage"
  | "subagent"
  | "event"
  | "log";

type TraceSpanStatus = "running" | "ok" | "error" | "cancelled" | "unknown";

interface TraceSpan {
  id: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  lane: TraceSpanLane;
  label: string;
  source: "log" | "eventlog" | "sqlite" | "network";
  startAt: string;
  endAt?: string;
  status: TraceSpanStatus;
  summary?: string;
  payload?: unknown;
}
```

A missing `endAt` means no end event was observed. The frontend renders it as running/unknown but
must not write the current time back into API results.

## Event pairing rules

- `turn_started` -> `turn_complete` / `turn_error`, paired by `sessionId + turnId`.
- `model_request` -> `model_complete` / `model_error`, paired by `modelRequestId/requestId/id` when
  present, falling back to `sessionId + turnId`.
- `tool_call_started` -> `tool_call_result` / `tool_call_error`, paired by `toolCallId`.
- `permission_requested` -> `permission_resolved` / `permission_denied`, paired by
  `permissionId/requestId` when present, falling back to `toolCallId`.
- `subagent_spawned` -> `subagent_stopped`, paired by `subagentId/subagentSessionId/childSessionId`.
- Structured logs with `durationMs` produce a `log` (or more specific lane) span with
  `startAt = timestamp - durationMs`, `endAt = timestamp`.

## UI

- Top level offers three view entries: `Trace`, Gantt, and network requests.
- Without a hash route, default to the Gantt view; it is the main view for debugging execution.
- The filter bar keeps only the project select and Trace select; each Trace option shows both the
  `traceId` and the first user message.
- The Gantt page uses the current `traceId`, merging API `spans[]` with network request spans of the
  same trace.
- The network page provides an independent list, trace filter, proxy status, and copyable
  environment variables.
- Gantt bar content stays compact: only operation name, status, and duration. `traceId`, `turnId`,
  `toolCallId`, `spanId`, and the full payload live in the tooltip and detail panel so bars do not
  become log text.
- Gantt range bars need a UI-only minimum visible width. Millisecond tool calls keep their real
  `startAt`/`endAt`, tooltip, and detail duration, but the canvas draws a bar with at least a
  clickable area so fast segments are not compressed into a vertical line.
- The Gantt toolbar must offer a windowed fullscreen toggle. It only overlays the Gantt panel over
  the current browser window; it must not call the browser Fullscreen API. Esc and the same button
  both exit; the timeline width/height must be re-fit after toggling. In fullscreen the detail panel
  keeps a fixed height and the remaining space goes to the timeline; timeline items sit near the top
  to avoid large empty space above from bottom orientation when zoomed.
- Clicking a `traceId` in network requests switches to that trace; clicking a Gantt span shows
  source, status, duration, trace/session/turn/tool identifiers, and payload.

## Test coverage

- Analyzer produces two overlapping `tool` spans for overlapping tool calls.
- Analyzer produces spans on different lanes for a model request and turn events.
- Unpaired end events still return a span with `startAt` and status `unknown`.
- Frontend typecheck covers the `vis-timeline` data mapping, network request span merging, and the
  new `TraceDetailResponse.spans` contract.
- Frontend unit tests cover the minimum range-bar width style so a fast tool span is not an
  unclickable line.
