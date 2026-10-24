# Streaming Tool Input Preview

## Background

Some models emit tool arguments as a streaming function call before thinking or body text finishes. For example, `Write` first produces `tool_input_start`, then a stream of `tool_input_delta`, and only then the complete `tool_call`. If the app/agent protocol exposed only body and reasoning deltas, the UI would stay on "thinking" and the file tool call would appear abruptly after the model turn ends.

## Goals

- The agent exposes a tool-call placeholder to the app as soon as the model argument stream appears.
- During the argument stream the UI shows a pending tool card, reusing the existing file-change card to show the file path and per-second sampled line counts.
- Tools with side effects still execute only in the tool execution phase after the model turn ends; argument preview must never trigger file writes.
- The desktop `desktop-continuous` main link stays real-time; web remote `web-remote-replayable` keeps the replayable snapshot/event seq as its recovery boundary.

## Protocol

`@zcode/protocol` adds the `model.streaming` session event. Only these model streaming kinds are exposed to the app:

- `text_delta`
- `reasoning_delta`
- `tool_input_start`
- `tool_input_delta`
- `tool_input_end`
- `tool_call`

`tool_input_delta` is merged into larger text chunks in the agent runtime layer before entering the protocol, so a large-file `Write` argument does not produce hundreds of tiny stdio packets per second. Final tool execution results still come from tool execution phase events.

V4 sessions no longer expose these events directly to the renderer; the CLI `ProductProjection` projects them into `ToolCallRow`:

```text
model tool_input_*
  -> core ModelStreaming
  -> v4 ProductProjection
       row.appended(toolCall, inputStreaming)
       row.delta(inputText)           [Write/Edit 最多每秒一次，首包与收尾除外]
       row.upserted(input,inputText)  [continuous/replayable 都可恢复]
  -> UI v4 adapter
       buildZCodeStreamingToolInputPreview(inputText)
  -> ToolCallBlocks
       Write/Edit 路径、内容、行数按同一采样点刷新
```

Delivery profile boundaries:

- `desktop-continuous` keeps `row.delta(inputText)` for real-time tool-argument preview in the active desktop session.
- `web-remote-replayable` filters `row.delta(inputText)` and restores full `input` / `inputText` only through the final `row.upserted` or a snapshot.
- Because replayable filters input-stream deltas, every tool-input finalization event must carry the complete `inputText` in the non-filterable `row.upserted`; otherwise mobile remote recovery loses the tool input's final state.

### Write/Edit one-second sampling

Cumulative `Write` / `Edit` arguments drive partial-JSON recovery, diff computation, and React updates. When the model outputs quickly, materializing per delta has no readability benefit, so desktop-continuous file-tool preview uses deterministic one-second sampling; other tools keep their existing incremental cadence.

```text
tool_input_start ───────────────> 立即创建 pending 工具卡
首个 tool_input_delta ─────────> 立即发布，尽早显示路径/工具形态
后续 delta（距离上次 < 1000ms）─> 只追加 projection buffer
首个达到 1000ms 的 delta ─────> 合并 pending suffix，发布一次 row.delta
end / call / scheduled / cancel ─> 立即冲刷或以完整 input 定稿
```

- The time budget uses `SessionEvent.timestamp`, not a renderer timer; the same event ledger yields the same projection live and in replay.
- The sampling unit is the whole file-tool preview: path, content, inline diff, and `+N/-N` update at the same sampling point; they do not catch up separately.
- The first delta does not wait a second. Normal finalization, scheduling, and cancel boundaries also do not wait, and must not lose an unpublished suffix.
- Sampling only reduces preview projection frequency; it changes neither the tool argument ledger, permission checks, nor tool execution timing.
- The `Write` streaming preview's `+N` is the logical line count of the currently recovered `content`; `Edit` is the line-level LCS of `old_string` and the current partial `new_string`, so it may grow or shrink during streaming. Only the final completed file diff is the actual change fact.

## UI projection

The legacy service adapter projects tool-argument events from `model.streaming` into the existing `tool_call` / `tool_call_update`:

- `tool_input_start` creates the pending tool card.
- `tool_input_delta` accumulates JSON argument fragments and best-effort parses common fields such as `file_path` and `content`.
- `tool_input_end` keeps the last argument preview.
- `tool_call` overwrites the preview input with the complete input but stays pending until the real `tool.updated` execution event arrives.

If a later `tool.updated` scheduled event shares the preview's `toolCallId`, the UI must update the existing tool card, not append a duplicate.

The v4 renderer reuses the same tool cards. `ToolCallRow.input` is the final structured input; when absent and `inputText` is still partial JSON, the adapter uses `buildZCodeStreamingToolInputPreview` to best-effort extract `file_path`, `content`, `new_string`, `old_string`, `command`, and similar fields. An empty preview is not shown as Parameters; raw metadata keeps only the input length and completeness flag, never a copy of the full streaming raw input.

## Execution boundary

Streaming argument preview does not change tool scheduling rules. Read-only, concurrency-safe tools such as `Read` keep using the existing streaming tool coordinator; `Write`, `Edit`, `Bash`, and other side-effectful or approval-requiring tools never execute during the argument stream. File writes, permission requests, and failure/success states continue to come from `tool.updated` events in the tool execution phase.
