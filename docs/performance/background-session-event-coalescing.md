# Background Session Event Coalescing

## Background

When deep-search style tasks run concurrently, several background tasks keep producing
`model.streaming`, `tool.updated:progress` and recovery progress events. Even if the UI shows only
one task, the renderer is woken by every protocol event of the background tasks and keeps doing
projection, Zustand writes and React updates, which raises renderer CPU noticeably at 5 concurrent
tasks.

## Strategy

- The active task keeps the real-time `desktop-continuous` subscription, preserving the feel of
  streaming text, reasoning and tool calls.
- The background monitor of an inactive task declares the `background-summary` merge mode when it
  subscribes to `desktop-continuous` session events.
- An inactive desktop task enters tombstone content mode: the background monitor maintains only run
  state, title, permission, usage, plan, queue, unread and terminal state, and no longer writes body /
  reasoning / tool progress chunks into the React message tree.
- Merging happens only on the subscriber side. It does not change the shared emitter, the agent/runtime
  event source of truth, or the `web-remote-replayable` snapshot/gap recovery semantics of mobile
  `/remote`.
- Events a background subscriber may merge: `model.streaming:text_delta`,
  `model.streaming:reasoning_delta`, `model.streaming:tool_input_delta`, `tool.updated:progress`,
  `streamRecovery.updated`.
- Events that must not be delayed first flush the merged events and are then delivered immediately:
  turn start / terminal; tool scheduled / started / result / error / batch; permission / user input;
  snapshot / state update / provider runtime headers; structured session changes such as title, mode,
  target.

## Goal

A background task still keeps run state, permission requests, terminal state, unread state and the
ability to recover after switching back, but an invisible task no longer drives the renderer at
token/tool-progress frequency. When the user switches to a task, the foreground subscription takes
over the full UI again through snapshot/live stream; background merging only carries a low-frequency
summary and is not a replayable recovery boundary.

## Tombstone content mode

- For a desktop background task, `agent_message_chunk`, `agent_thought_chunk`, `tool_call` and ordinary
  `tool_call_update` no longer call `updateTaskMessages`.
- `tool_call_update:completed` still fills the todo plan lightly from the tool title: for example when
  `Write/Edit <path>` matches the file name of a plan step, that step is marked completed.
- `task_complete` / `task_error` on an invisible desktop task only close out runtime, usage, error,
  unread and queue; they do not pull a residual snapshot into large messages.
- `task_snapshot_updated` on an invisible desktop task is only a recovery hint; except explicit release
  reasons such as archive/delete it does not read full messages in the background.
- The current active task, the fallback window before the active task's foreground subscription is
  established, and the mobile `web-remote-replayable` mirror do not use tombstone and keep the original
  real-time/recovery semantics.
- A batch session stress run does not auto-switch to the last successful task after triggering; those
  tasks stay background tombstones and recover full content when the user opens one explicitly.
- The first dispatched sessions of a batch stress run are staggered by 1000ms, at most 5s delay: 5
  concurrent tasks all enter running within 4s and 10 concurrent finish triggering within 5s, so task
  creation, subscription and runtime writes do not all hit the renderer in the same second.
- Background first-dispatch tasks of a batch stress run use lightweight initialization: task list
  insertion, optimistic meta, runtime=`streaming`, `activeInputId` and provider binding merge into one
  Zustand write, and the first user/assistant optimistic messages are not written for invisible tasks.
- Each event handling of the background monitor is wrapped in React batched updates, reducing React
  commits when a terminal event updates runtime, usage, unread and permission together.
- A title-only `session_info_update` of an invisible desktop task is merged and written back to the
  task cache every 2s; goal/status updates carrying `target` and terminal events flush the pending
  title first and then continue notifying and closing out.
- Streaming diagnostic logs such as tool-input projection sampling, message-write sampling and
  background usage breakdown must go through `debug`, so deep search does not make the renderer
  serialize large objects repeatedly and write production logs.

## Boundaries

- The `clientMode` / `deliveryKind` boundary does not spread: this strategy is enabled only on the
  `desktop-continuous` subscription parameters of the UI background monitor.
- Mobile remote replayable does not use this merge mode; recovery is still guaranteed by `seq`, gap
  recovery and snapshot.
- The app-agent protocol `@zcode/protocol` gains no field; the merge parameter is an internal
  subscriber policy of services and is not passed to the zcode-cli runtime.
