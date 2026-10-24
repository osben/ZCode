# ZCode Interaction Behavior

When ZCode's current turn is still running and the user sends more content, there are two product semantics:

- Queue: keep the follow-up as a pending message and send it automatically after the previous turn ends.
- Guide: hand it to ZCode CLI turn steering, injected into the current turn at the next legal model-step boundary.

`AppSettings.zcodeInteractionBehavior` controls this preference; the default is `queue`. The Composer no longer exposes a session-level "append mode" switch; `config.followupMode` in the session projection is only the CLI/runtime's current synchronized copy of the app preference. After the user changes it in Settings, open v4 sessions sync it to the CLI through the `setFollowupMode` command; new or pre-warmed sessions inherit the current app preference via `createSession.config.followupMode`.

## Queue behavior

`queue` is the default. On desktop and mobile, every submitted busy/running input is serially admitted by the CLI/runtime `CommandInbox`; the renderer, host, relay and desktop main keep no second authoritative conversation queue. Desktop receives facts directly through `desktop-continuous`; mobile Web remote recovers the same CLI facts through `web-remote-replayable` snapshot/gap. The delivery profile does not change consumption rules.

The queue is consumed at the session-ready boundary, not when any single timeline bar finishes:

- `context_compaction` `started` / `retrying` and `goal_verification` `started` mean the session still has maintenance or judging activity running; the ordinary queue must not auto-drain in those states.
- After a manual `/compact` completes and the session is ready, the queue can continue. For auto/pre-request compact, `completed` only means the pre-compaction finished and the original prompt may still run, so it is not a queue-ready boundary.

Goal mode additionally requires the whole goal to be met:

- `goal_verification completed` is only the terminal state of one verifier attempt. Verifier `passed: false` enters the next goal continuation. Verifier format errors, request exceptions or wrong tool calls fail open with `passed: true`, so an intermittent judge-chain failure cannot stick a delivered goal.
- After `passed: true`, the ordinary queue is consumed only once the session target is updated to `status: "complete"`. While task meta / projection holds any non-`complete` target, queue messages keep waiting. An empty target means no goal and is not subject to this guard.
- Input sent during an unmet goal goes to the ordinary queue first, not around the goal loop. The guard covers `sendText`, queued `/goal` and queued `/compact`, keeping the original admission FIFO.
- Manually stopping the verifier is not fail-open: verification closes as cancelled/failed, the target becomes paused, and the queue is kept and not auto-consumed by default.

Auto-consumption order of the ordinary queue:

```text
queue head
  -> autoDrain=true ?
  -> session ready ?
  -> target absent OR target.status=complete ?
       no  -> keep the whole FIFO unchanged
       yes -> promote exactly one head item by its original kind
```

"Send now" on a queue item is an explicit user preemption path; it keeps using reservation + Stop barrier and is not subject to the auto-consumption guard above.

## Guide behavior

`guide` is a model/provider-independent runtime capability. It does not rewrite the in-flight request already sent to the provider; it tries turn steering only when the task is streaming, has no attachments and no stop request. An existing ordinary queue expresses the user's intent for a future product turn and does not block an explicit guide entering the active turn; the two inputs are tracked separately by delivery and the ordinary queue's relative order is unchanged.

- A guide can be submitted and wait before any tool call appears. Only after all sibling tool results of the current model step are committed does the runtime consume at most one guide, using it in the next provider request of the same product turn. It is never consumed when one parallel tool finishes early, and never more than one at a time.
- While waiting for the legal model-step boundary the guide is still carried durably by the CLI `pendingInputs` / `TurnSteerQueued`, but the renderer does not show `admittedDelivery=guide` as an ordinary future queue. It immediately shows the user message at the end of the current conversation flow with "等待引导当前任务…" (waiting to guide the current task) below the bubble. On `TurnSteerDrained(delivery=guide)`, the formal `UserInputRow(guided=true)` takes over with the same `sourceCommandId` and the waiting hint disappears. If the runtime downgrades the input to `admittedDelivery=queue`, the temporary flow message disappears and the same authoritative item returns to the ordinary queue panel. The renderer only splits the projection and keeps no second accepted-input queue.
- The pending-guide bubble, waiting hint and action buttons share the bottom input's content column and its 16px horizontal margin on each side, right-edge aligned on desktop and mobile Web. This temporary list renders message rows directly, without the ordinary turn container, so the list itself provides the horizontal margin.

```text
TurnSteerQueued(admitted=guide)
  -> CLI queue fact kept
  -> renderer pending guide (conversation flow + waiting hint)
  -> TurnSteerDrained(guide) -> formal guided user row
  -> delivery fallback(queue) -> ordinary queue panel
```

```text
guide admitted
  -> wait for next tool result batch
  -> commit every sibling ToolCallResult
  -> drain exactly one guide inline
  -> persist guided user fact
  -> start the next provider request in the same product turn
```

If the current turn text-only completes, stops or is interrupted without forming a usable tool result batch, the unconsumed guide is redelivered in place to the ordinary queue with the same `ConversationInputIntent`; text, attachments, clientId, `sourceCommandId`, `queueItemId` and admission FIFO are unchanged. The same fallback applies when attachment/compact/verifier busy makes it ineligible or the runtime steer rejects; it is never silently lost.

Model/provider dimension is pruned by invariant: every connected model reuses the same message history and the next ordinary provider request, so there is no guide allowlist by model name, provider name or upstream protocol format.

## Per-message override (desktop)

While a task runs, `Cmd+Enter` or holding `Cmd` while clicking send (macOS), and `Ctrl+Enter` or holding `Ctrl` while clicking send (Windows/Linux), apply the opposite delivery to the session `followupMode` for that one message only:

| `followupMode` | `Enter` | `Cmd/Ctrl+Enter` |
| --- | --- | --- |
| `queue` | ordinary queue | send now: atomic `sendText(requestedDelivery=startNow)` preempts the current turn, no QueueItem created |
| `guide` | guide the current turn | ordinary queue |

- The combo or modifier click overrides only this input; it does not call `setFollowupMode` or change persisted settings. Plain `Enter`, `Shift+Enter` and plain send-button click keep current behavior.
- In idle state (including a new-task draft) `Cmd/Ctrl+Enter` sends normally like Enter; `Cmd/Ctrl+Shift+Enter` keeps newline.
- The combo is disabled only in the mobile input viewport of mobile Web remote. Desktop Electron must keep the platform primary-modifier submit even when the window is narrower than 768px or a Windows device reports `hover: none` / `pointer: coarse`; a generic media query must not replace the desktop / Web remote product boundary.

```text
running composer Cmd/Ctrl+Enter OR Cmd/Ctrl+click send
  -> queue mode: sendText(requestedDelivery=startNow)
  -> guide mode: sendText(requestedDelivery=queue)
  -> CLI CommandInbox serial admission
  -> changes only this one input intent
```

Queue-mode `startNow` must atomically take the foreground promotion lease in the CLI, run the Stop barrier, wait for the old foreground to become fully idle and start the new turn directly. This path must not call ordinary queue admission, create or briefly project a QueueItem, or depend on the renderer observing the queue and sending a second promotion command. After the CLI accepts `sendText(startNow)` the sender clears the Composer immediately; if the command is rejected before acceptance, the draft and attachments stay unchanged. `sendQueuedNow` is only for explicitly promoting an existing QueueItem, no longer for the immediate send of new input.

### Modifier tooltip

When the desktop running composer has sendable content and the send button is enabled, pressing the platform primary modifier opens the send-button tooltip automatically, without hover. The title shows this message's opposite behavior: "立即发送" (send now) when the default is queue, "加入队列" (add to queue) when the default is guide; the shortcut area shows `⌘ + Enter` on macOS and `Ctrl + Enter` on Windows/Linux. The auto tooltip closes on modifier release, window blur, submit start, input becoming unsendable, switch to idle/mobile, or unmount. The ordinary hover tooltip keeps showing the original send behavior; the modifier hint is not written to settings or protocol.

```text
keydown(Cmd/Ctrl)
  -> running && canSend && desktop ?
  -> open tooltip(opposite action, Cmd/Ctrl + Enter)
keyup / blur / submit / !canSend
  -> close modifier tooltip
```

## Boundaries

The setting only changes whether turn steering is tried first when busy; it does not change task realtime transport:

- Desktop main path stays `desktop-continuous`; mobile remote stays `web-remote-replayable`.
- The relay and desktop main own no session, stream, queue or snapshot business state.
- The CLI product guards for guide/queue do not fork by delivery profile; replayable only recovers and owns no business queue.
