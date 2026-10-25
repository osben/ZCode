# Session Token Throughput (Live tok/s Display)

## Product Rules

- In the main conversation, the "Working for N min N sec" row for each work segment shows live throughput `xx.x tok/s`, right-aligned.
- **Two value sources, with display priority**:
  1. **Streaming estimate `~xx.x tok/s` (with a `~` prefix)**: Update in real time while output is streaming, including reasoning. Estimate tokens from the text of rows currently streaming (body/reasoning when `state === "streaming"`; tool arguments when `status === "inputStreaming"`) using the same formula as the CLI's `estimateTokens` (Chinese characters count double, then divide by `ESTIMATED_TOKEN_CHAR_DIVISOR`).
     - **Use a cumulative average**: `(current tokens - baseline tokens) / (now - baseline time)`, recalculated on a 300 ms tick. The denominator covers the full interval, while bursts only increase the numerator once; this avoids estimates in the tens of thousands of tok/s that a short-window slope can produce. (Reference: pi-web's `tps = tokens / elapsed`, timed from the start of streaming.)
     - **Restart measurement** when a new stream begins (the set of currently streaming rows changes), text retracts (projection rebuild), or a single increment exceeds 12,000 tokens (snapshot resync or stream recovery creates old and new rows together). Tokens already present at the baseline time are excluded from the numerator to avoid treating the initial batch as a false spike.
     - **Do not publish** if less than 500 ms has elapsed since the baseline, the increment is zero, or the latest increment has been silent for more than 2 seconds (tool execution or a gap between requests). In these cases, fall back to the exact value.
     - Estimate tokens with an incremental cache (if the prefix is unchanged, calculate only the new suffix) to avoid degrading to O(n²) by recounting the entire long response after every delta.
  2. **Exact value `xx.x tok/s`**: Use `outputTokens / (durationMs - timeToFirstContentMs)` from the latest **trusted** model request (`calculateOutputTps`, the same source and methodology as the TPS column in the developer tools panel). Treat rounds with a decode window under 100 ms as bursts (a proxy/network delivers a buffered response all at once, collapsing the window); skip them and fall back to the latest round with a sufficiently long window. The developer panel continues to show the raw value for diagnostics. This value takes over when the streaming estimate goes quiet.
- Show throughput only while `workStatus.state === "running"`; hide it when the segment completes and changes to "Worked N".
- Render nothing when neither source has a value; never show `0 tok/s`.
- For child agents in the Agents section of the status panel, show only source 2 for now (child-session row deltas are not included in the parent-session renderer). The "Working" row in a child-session detail pane uses the same component as the main conversation, so both sources apply.

## State Owners and Event Order

```text
Exact value (protocol fact):
ModelNetworkStatus(model_request_completed, querySource=main_turn)
  → CLI agent process session-debug observation (single source of truth, includes usage/durationMs/TTFT)
      ├─ parent session: observeSessionDebug(record, event)          (existing, unchanged)
      └─ child session: observeDetachedChildSessionDebug(id, event)  (added, server-operations child-session branch)
  → UI polls useSessionDebug session/debug RPC every second (read-only, no write-back)
  → useSessionThroughput reads rounds.at(-1).tokensPerSecond

Live estimate (derived by the presentation layer, not a protocol fact):
reasoning/assistantText row.delta → cumulative text from active segment rows
  → useStreamingThroughput rolling-window slope (~4s window, samples = estimated tokens per delta)
  → displayed as the preferred value in the "Working" row (with a ~ prefix)
```

- The exact value is owned by the agent process's session-debug observation; the live estimate is owned by the renderer's rolling window. They represent different quantities: one is marked as an estimate (`~`, with its own tooltip), and the other is a protocol fact. They do not compete to represent the same truth.
- **Why the CLI does not periodically report streaming progress events**: A repository invariant (comment at `publishModelTelemetryMilestone`) says observation-only events must not write SessionEvents or pollute conversation product state. A progress event every second would enter the persistent journal and replay/cold-hydration path, violating that constraint and adding cost. Deriving an estimate in the renderer from row deltas it already consumes requires no protocol change or persistence.
- The estimate formula intentionally matches the CLI's `estimateTokens` (`apps/zcode-cli/packages/core/src/context/utils.ts`); changes to the formula must be made in both places.
- Polls must not overlap (schedule the next poll after the previous one completes). After switching tasks, an old result must not overwrite the new task, following the existing `useSessionDebug` behavior.

## Interfaces

- Reuse the existing `session/debug` RPC and `sessionDebugSnapshotSchema`; **no protocol schema changes**.
- CLI `querySessionDebug` lookup order: active parent-session record → detached-child observation → `requireSession` throws `sessionUnavailable`.
- Child-session observations are an in-process side channel (`Map<childSessionId, Observation>` with a FIFO limit of 16; other limits reuse `SESSION_DEBUG_LIMITS`). They are not persisted or included in the chat projection. When the gateway reclaims a child, FIFO eviction eventually removes the observation; an already-open pane can read it until eviction.

## Version Skew

- Old CLI + new UI: the child-session query returns `sessionUnavailable`, the hook enters an error state, and the value is silently hidden there. The main-session feature is unaffected.
- New CLI + old UI: no behavior change.

## Acceptance Scenarios

1. Start a conversation. While reasoning or the response body is streaming, the "Working" row shows `~xx.x tok/s` at the right within one second and updates as output arrives.
2. After streaming is silent for about two seconds (during tool execution or between requests), fall back to the exact value without `~`. Refresh the exact value after each model request completes.
3. If only a tool is running and there is no streaming or completed request, keep the value unchanged. Hide it when the segment completes.
4. If neither source has a value (the first request has not completed and the sample span is too short, or throughput is unknown), show no value or placeholder.
5. When child agents run concurrently, each row in the status panel's Agents section shows that child session's independent exact throughput.
6. Open a child-agent detail pane. Its "Working" row shows both the child session's estimate and exact value using the same component as the main conversation.
7. After recovery in mobile Web remote control (`web-remote-replayable`), throughput is still visible (the estimate comes from row deltas and the exact value from RPC polling, independent of the link).
