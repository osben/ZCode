# V4 Conversation API Retry Status

## Summary

V4 conversation must show the model API retry status from
`ConversationSnapshot.control.apiRetry` at the bottom of the current running
turn. Main sessions and read-only Subagent sessions share the same timeline
presentation. The composer no longer renders this status.

The retry authority belongs to the CLI `ProductProjection`. The renderer only
renders the current session snapshot and must not infer retry state from request
logs, elapsed time, or local network observations.

## Behavior

```text
Agent/runtime retry event
  -> ProductProjection
  -> ConversationSnapshot.control.apiRetry
  -> SessionPane
  -> ConversationTimeline current live turn
  -> ChatApiRetryStatus
```

- `apiRetry: null` renders no retry label.
- A non-null retry state renders only in the current running turn's tail slot,
  after the turn's existing assistant work.
- The retry label replaces the generic `ChatLoading` indicator while retry is
  active; the two statuses are never rendered together.
- The active retry label keeps the running Thinking label's `text-ui-base`,
  `font-medium`, and shimmer motion, but lowers its visual weight with the
  semantic `foreground-subtle` peak color. It deliberately reuses the base
  shimmer's low-alpha soft stop so the moving trough remains visible; Retry
  therefore avoids Thinking's pure black/white peak without flattening the
  animation contrast.
- Historical turns never receive the current `apiRetry` state. If there is no
  running live turn, the renderer does not attach the status to an older turn.
- `model_retry_scheduled` sets the retry state for every runtime-classified
  retryable provider/network reason, not only HTTP 429.
- Core SSE stream recovery (`StreamRecoveryStarted`,
  `StreamRecoveryRetryStarted`, or a recovery-tagged model request) uses the
  same state. `retryNumber/maxRetries` is converted to the V4
  `attempt/maxAttempts` shape.
- V4 keeps `maxAttempts` in the protocol shape. The UI displays retry count, so
  `maxRetries = max(maxAttempts - 1, attempt)`. For example, `maxAttempts=11`
  converts an attempt to the `1/10` user-count shape; the presentation threshold
  below decides whether that early count is visible.
- `nextRetryAt` is computed with the CLI event clock. The current timeline does
  not render a countdown because a single snapshot is not a ticking clock.
- Existing i18n keys remain the only user-facing copy source:
  `chat.apiRetryStatus`. Moving the status into the timeline keeps the former
  composer copy: `重新连接中... x/y` / `Reconnecting... x/y`.

## Presentation threshold (2026-08-17)

When `apiRetry.attempt <= 2`, the UI shows neither the reconnect count nor the
`重新连接中... x/y` copy; the current running turn keeps using the same
`ChatLoading` slot, so the user sees the first two brief recoveries as ordinary
loading. The reconnect copy shows only at `attempt >= 3`, and the count keeps the
existing user-facing form (for example `3/10`). Here `attempt` is the "n-th retry"
already converted by the projection layer, not the raw `maxAttempts` total attempts.

```text
ProductProjection.control.apiRetry
              |
              v
      TurnChatLoadingSlot
        | attempt 1/2 --------------> ChatLoading
        | attempt 3+ ----------------> Reconnecting... 3/10
        | progress / terminal --------> apiRetry cleared
        v
  current live turn only
```

The threshold exists only in the timeline presentation. It must not turn the
1st/2nd retry into `null` in `normalizeZCodeApiRetryStatus`, `ProductProjection`,
the service tracker or the protocol schema, otherwise the recovery state is lost
and snapshot, desktop continuous and mobile replayable recovery consistency
breaks. When `attempt <= 2` and the current turn is blocked by permission/Q&A/
maintenance, the existing gating still applies and no generic loading is shown extra.

## State lifecycle

```text
model_retry_scheduled / stream recovery
                 |
                 v
       apiRetry = current retry
                 |
       +---------+-------------------+
       |                             |
       | next request started        | retryable request failed
       | (no model progress yet)     | before scheduling
       |                             |
       +---------- keep -------------+
                 |
      first meaningful model progress
      (text/reasoning/tool lifecycle)
                 |
                 v
          apiRetry = null

request completed / non-retryable failure / turn terminal / next turn
                 |
                 v
          apiRetry = null
```

`model_request_started` for adapter attempt 2+ does not prove recovery and must
not clear the label. A non-empty text/reasoning delta or meaningful tool event
does prove user-visible progress and clears it. This prevents the status from
flashing off during the retry request itself.

## Delivery and isolation

```text
                         +-> desktop-continuous
one CLI projection -----+
                         +-> web-remote-replayable
```

- `control.apiRetry` is session-scoped. A background session cannot overwrite
  another session's timeline status.
- Both delivery profiles receive the same control state. Continuous versus
  replayable only changes delivery/backpressure behavior; it does not create a
  second retry authority.
- A replayable snapshot may restore an in-progress retry. Relay, Electron main,
  and host routing do not own or synthesize the retry state.
- Retry is runtime-memory state: renderer refresh, task switching, and mobile
  reconnect within the same CLI runtime may restore an active retry from the
  snapshot; a CLI/runtime cold restart clears it.

## Boundaries

- No protocol or schema changes.
- No retry transcript part or timeline row is persisted. The display is a
  transient live-turn slot driven only by `control.apiRetry`.
- The existing `retryNotice` row remains reserved for user-triggered assistant
  retry semantics and is not reused or extended.
- No changes to send, queue, stop, or row retry behavior.
- No changes to retry count, backoff, retry classification, or final-failure
  behavior. Fault catalog cases such as N03/N04 still own those decisions.
- The `attempt <= 2` rule is presentation-only: runtime retry count, backoff,
  retry classification, clearing boundary, and final-failure behavior remain unchanged.
- No changes to desktop `desktop-continuous` or mobile
  `web-remote-replayable` delivery semantics.
- Read-only Subagent detail still forbids manual retry commands; showing the
  provider retry status does not make the timeline interactive.

## Regression evidence

- Projection tests must cover adapter retry schedule, attempt start retention,
  meaningful progress clearing, request terminal clearing, and core stream
  recovery.
- The projected snapshot must pass the V4 runtime schema.
- The same `state.updated` retry delta must survive both delivery profile
  filters.
- Timeline tests prove `maxAttempts=11` renders `3/10` only when `attempt=3`,
  `attempt=1/2` render generic `ChatLoading` without retry text, retry status
  replaces `ChatLoading` at `attempt=3`, and `apiRetry=null` renders nothing.
- Read-only `SessionPane` tests prove child details receive the same state while
  the composer remains absent.
- The SAT25 desktop fault-stream E2E exercises both owners in one run: Main
  observes the hidden early attempts and a visible `3/10` retry before clearing
  on the successful tool response; the spawned child observes the hidden early
  retry in its read-only detail pane and clears on text progress.

## Implementation status (2026-08-17)

1. `packages/ui/src/v4/ConversationTurnGroup.tsx` `TurnChatLoadingSlot` has a
   presentation-only `visibleRetryStatus`: `attempt=1/2` falls back to
   `ChatLoading` and only `attempt>=3` enters `ChatApiRetryStatus`; the existing
   loading gate for blocking interactions is unchanged.
2. `packages/ui/test/v4ConversationTurnGroup.test.ts` covers attempts `1`, `2`,
   `3` and the loading/retry mutual exclusion under a blocking interaction.
3. `ChatApiRetryStatus`, projection normalization, runtime snapshot, protocol
   schema, i18n and retry lifecycle are unchanged; the SAT25 fixture/manifest
   only adds Main's second and third 429 so the UI can observe the hidden early
   attempts and the visible `3/10`.
4. Verification: focused UI test 53/53, `pnpm typecheck`, `pnpm lint` (0
   errors) and the conversation coverage audit passed. The SAT25 WDIO E2E built
   but failed at startup because this environment lacked a downloadable macOS
   arm64 Chromedriver; rerun once a driver is available.
