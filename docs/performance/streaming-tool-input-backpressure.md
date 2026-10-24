# Streaming Tool Input Backpressure

## Background

ZCode Protocol already splits the tool-argument stream into `tool_input_start` / `tool_input_delta` /
`tool_input_end`, the basis of streaming function calls. A two-task field case on 2026-06-13 showed that
the renderer CPU being pegged was not agent compute overload: on every `tool_input_delta` the UI
re-parsed the accumulated `rawInput` into a full preview, wrote it to the task message store and
triggered a React render.

A typical case is a `Write` input of about 36KB split into 785 deltas. Each real network delta is small,
but the UI scanned an ever longer accumulated string on every delta, an approximately O(n²) parse and
render cost; background tasks also wrote the store at the same frequency, and two concurrent tasks
stacked onto the main renderer.

## Goals

- Keep streaming function calls: an active task still sees the tool card and argument preview as fast as
  possible.
- Non-active tasks no longer materialize every tool-argument delta into the message tree.
- Large `Write` / `Edit` inputs no longer fully parse and fully write the store on every delta.
- Switching back to a running background task keeps using the already accumulated tool-input buffer and
  loses no earlier argument segment.
- Tool status events no longer write the same input into the UI store repeatedly on
  queued/started/closed/committed.
- The delivery-semantics boundary between desktop `desktop-continuous` and mobile
  `web-remote-replayable` is unchanged.

## Design

### Active live

The active task keeps consuming the full continuous stream, but the tool-argument preview is budgeted:

- `tool_input_start` creates the tool card immediately.
- The first `tool_input_delta` previews immediately, to quickly recognize the tool shape of
  `Write` / `Edit` / `Bash` etc.
- Later `Write` / `Edit` deltas preview only on a 1000ms budget by `SessionEvent.timestamp`, merging the
  suffix of that period into one update; cumulative byte growth cannot bypass the time budget.
- Other tools keep the existing time/byte budget, so file-tool throttling does not slow the feedback of
  command arguments.
- `tool_input_end` is only a lightweight boundary update of tool-card state and no longer parses the
  complete raw input; the final `tool_call` carrying the full input materializes once, avoiding
  repeated parsing of big JSON across end/call.
- The `raw` of a preview event keeps only `streamingRawInputLength` and never writes the full
  `streamingRawInput` into the message store.

### Background summary

The background monitor of a non-active task uses a summary profile:

- `tool_input_start` may create a lightweight tool card so the background task still looks like it is
  advancing.
- `tool_input_delta` enters only the tombstone buffer of the projection state; no message store write,
  no React render.
- The tombstone buffer records `rawInput`, `deltaCount`, the latest preview position and the full-input
  state.
- `tool_input_end` still passes lightweight state immediately; the final `tool_call`, tool result,
  permission, elicitation and task terminal are still delivered immediately.
- On switching to active, the foreground subscription inherits the background projection state and the
  next delta/end/tool_call can materialize from the full accumulated buffer.

### Tool input dedup

The input of one tool call may repeat in tool status events such as `tool_call_closed`, `scheduled`,
`tool_queued`, `tool_started`, `tool_result_committed`. UI projection maintains the tool-input
materialized state:

- The first time a full input is seen it emits `tool_call` and caches it.
- Later status events with the same input emit only `tool_call_update`, without the input.
- The duplicate raw payload drops the full input and keeps only `inputOmitted: true` and
  `inputRef: "tool_call"` for debugging.

### Protocol payload backpressure

The ZCode Protocol boundary must also avoid repeating the full payload:

- Consecutive `model.streaming:tool_input_delta` events are merged into larger diff packets at the
  protocol server boundary; the first delta flushes immediately, later ones flush on the existing event
  timestamp budget or a deterministic byte budget, and any non-delta control event flushes first when it
  arrives. The UI-visible projection of `Write` / `Edit` converges to 1000ms again in ProductProjection
  / the compatible projection and cannot be bypassed by the protocol byte threshold.
- Consecutive `model.streaming:text_delta` / `reasoning_delta` events are merged at the same boundary.
  The first delta flushes immediately to keep the feel that "the model has started output"; later ones
  flush on the event-timestamp budget and the deterministic byte budget, avoiding waking the renderer
  tens of thousands of times when a provider cuts the reasoning stream into 1-5 character packets,
  without making the body feel non-streaming.
- `streaming_tool_ledger_updated` is a runtime replay ledger only for the agent reducer to restore run
  state and is no longer mapped to app `session.updated`.
- After `model.streaming:tool_call` has already delivered the full input, `tool.updated:scheduled` of
  the same `toolCallId` no longer carries the input again.
- The scheduled tombstone keeps `inputOmitted: true`, `inputRef: "model_stream"` and `inputByteLength`
  so logs can confirm the omission.
- If scheduled appears before `tool_call` or there is no provably delivered full input, the protocol
  keeps the original input to avoid breaking recovery.

## Boundaries

- Renderer projection/store, the services compatible task projection and the ZCode Protocol payload all
  take part in throttling/dedup; the runtime's internal eventStore keeps the complete ledger.
- Desktop continuous still subscribes with `deliveryKind: "desktop-continuous"`; only the deterministic
  projection throttles the UI-visible input updates of `Write` / `Edit`.
- Protocol coalescing keeps diff semantics and merges only the `delta` field of adjacent
  `tool_input_delta` / `text_delta` / `reasoning_delta`, never putting accumulated full input back into a
  delta event; batch boundaries are decided only by eager first packet, event-timestamp budget, byte
  budget and event order. The time budget must use `SessionEvent.timestamp`, not a live timer, so live
  and replay share the same `afterSeq` recovery boundary.
- The snapshot/gap recovery semantics of web remote replayable are unchanged; if background summary is
  later pushed down into the service layer it must explicitly carry `clientMode` / `deliveryKind`.
- Permission requests, user-input requests, task completion/failure and stream-gap snapshots must not be
  throttled.

## Acceptance

- With two concurrent tasks and large Write input the renderer CPU peak is clearly below the
  pre-optimization level and no longer sits at 100% for a long time.
- In the CDP profile `streaming-tool-input-preview.ts` is no longer the main hotspot on every delta.
- An active task sees the `Write` / `Edit` tool card and the first argument segment immediately; the
  expensive preview materializes at most once per second while running, and the exact final state
  appears immediately at the end.
- `+N/-N` jumps atomically to the true statistic at each sampling point; no per-line
  `requestAnimationFrame` catch-up.
- A background task shows the complete tool input after switching back.
- The final snapshot matches the message tool-card input/result.
- `pnpm lint` and `pnpm typecheck` pass.
