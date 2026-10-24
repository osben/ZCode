# ZCode Protocol (current facts)

ZCode Protocol is the only Agent protocol among the App, Host Process and `zcode-cli`. The current chat
main path uses V4 conversation topics, the authoritative projection and the command inbox; the old
session schema still in `packages/shared/src/zcode-protocol/index.ts` serves only compatibility calls
not yet deleted and is not an entry for new features.

## Core constraints

- Protocol entities are uniformly called `session`; the product-layer historical `taskId` equals `sessionId` in the chat main path.
- The CLI is the source of truth of a conversation. Message rows, run phase, queue, interaction requests, model config, usage, goal and control capabilities all come from `ConversationSnapshot`.
- The UI owns only purely local display state (draft, scroll, focus, panel expansion) and must not keep a second authoritative message or queue in the renderer.
- Desktop uses `desktop-continuous`, mobile remote control uses `web-remote-replayable`. Both share the same CLI projection, but their recovery semantics must not spill into each other.
- Mobile `/remote` only attaches an existing Host/CLI and creates no independent Agent runtime.

## Transport topology

```text
Renderer
  | MessagePort RPC
  v
Host Process
  | stdio NDJSON
  v
zcode-cli app-server
  |- command inbox
  |- ProductProjection reducer
  '- conversation topic publisher
```

stdio NDJSON frames only on the LF byte `0x0a`; the write format is fixed as
`JSON.stringify(message) + "\n"`. The reader may tolerate a trailing CRLF but must not trim or rewrite
strings inside a frame.

## V4 read path

The client subscribes to the `conversation/<sessionId>` topic. The subscribe ACK itself embeds no
snapshot; the server then delivers an initial/recovery snapshot or continuous deltas by that
subscription's watermark, logEpoch and delivery profile:

```text
subscribe(topic, baseSeq, baseLogEpoch)
  |- base continuable --> delta(fromSeq, toSeq]
  '- base invalid     --> snapshot + subsequent deltas
```

`ConversationSnapshot` is the complete recoverable view, containing:

- session metadata and phase;
- `rows.window` message/tool/marker rows;
- `queue` and `inputRouting`;
- pending interactions;
- model, mode, thought and follow-up config;
- usage, goal, background work and control availability.

Clients may apply deltas only contiguously by seq. Duplicate or late frames are dropped silently; on a
gap, resubscribe and converge by snapshot. Desktop continuous does not splice the mobile replayable
run-state recovery messages.

## V4 write path

All user intents are sent through `v4/command`. The envelope contains a stable `commandId`,
`clientId`, `sessionId`, optional `baseRevision` / `baseLogEpoch`, the command type and payload. CAS
commands require `baseRevision`, row-targeting commands also require `baseLogEpoch`; a retry must
reuse the original `commandId`. The CLI adjudicates idempotency, epoch, CAS and product guards with
the command inbox.

The full command set is typed in `packages/shared/src/zcode-protocol-v4/command.ts` (the single type
source of truth); main groups:

| Group                    | Commands                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Session / input          | `createSession`, `createSelectionSideSession`, `sendText`, `sendGoalCommand`, `renameSession`, `deleteSession` |
| Generation control       | `stop`, `compact`, `retryTurn`, `editUserQuery`, `forkAssistant`                                               |
| File rewind              | `applyFileRewind`                                                                                              |
| Queue                    | `sendQueuedNow`, `editQueueItem`, `reorderQueueItem`, `deleteQueueItem`, `setAutoDrain`                        |
| Config                   | `switchModelConfig`, `switchCollaborationMode`, `setFollowupMode`                                              |
| Goal / background work   | `pauseGoal`, `resumeGoal`, `cancelBackgroundWork`                                                              |
| Blocking interaction     | `resolveInteraction`, `snoozeInteractionAutoResolution`                                                        |

`session/steer`, `session/rewind` and the standalone rewind command are deleted. Guide input is
adjudicated by `sendText` + `inputRouting`/follow-up mode; retry and edit use `retryTurn` and
`editUserQuery`; workspace file undo uses `applyFileRewind` and does not implicitly truncate session
history.

ACK statuses are `accepted | rejected | stale | duplicate | noop | failed`. An ACK only means the
command adjudication result; the final UI state must come from the authoritative projection flowing
back with `sourceCommandId`.

## sessions-index and workspace-config

Besides the conversation topic, V4 provides two workspace-level conflated topics:

- `sessions-index/<workspaceId>`: session-list liveness summary; organization state such as pin/archive/group/unread is still read from tasks-index and joined on the client.
- `workspace-config/<workspaceId>`: configOptions such as model/mode and the slash command catalog; it serves the draft and toolbar catalog and does not override the bound session's `snapshot.config`.

Each has its own seq/logEpoch/subscription recovery; they cannot share a conversation's watermark or
substitute workspacePath for the remote workspaceIdentity.

## Queue semantics

The CLI runtime command queue is the only authoritative queue. While running, ordinary input and
`/goal` are decided at the CLI admission boundary by `inputRouting` to run now, enqueue, guide, or ask
the user to handle the held queue. Desktop and mobile do not each maintain an accepted queue.

The UI may show brief optimistic state, but delete, edit, send-now, reorder and auto-drain must send
the matching V4 command and wait for snapshot/delta convergence.

Input is written to the `session_input` lifecycle ledger before execution; it serves promotion
atomicity and cross-restart dedup and is not a persistent queue that resumes execution automatically
after restart. On CLI restart, admitted inputs not yet promoted are explicitly turned into discarded,
and the client can only prompt the user to confirm a resend.

## Process and workspace isolation

One App may run multiple workspace windows; each window has an independent Local Host, and remote
connections are carried by the Remote Host scoped to that window. All Hosts isolate workspaces by
`workspaceKey = workspaceIdentity?.trim() || workspacePath`, and each workspaceKey starts at most one
chat CLI process:

```text
App
  '- workspace window
      |- Local Host
      |  |- workspaceKey A -- zcode-cli A
      |  '- workspaceKey B -- zcode-cli B
      '- Remote Host(s)
          '- remoteSessionId / attachment -- workspaceKey C -- zcode-cli C
```

`workspacePath` is used only for the filesystem and command cwd; identity, cache, queue, session
binding and cross-process correlation must use workspaceKey. A remote workspace must carry
`workspaceIdentity` and `remoteSessionId` end to end.

## Provider config

The Host's `modelProviderService` is the provider registry config source; the CLI is the source of
truth of the session's current model and run state. The Host syncs the revisioned registry to the
corresponding workspace CLI. The chat UI builds selectable models from the app/workspace config
catalog and reads the current config from the conversation snapshot; the endpoint and API key do not
enter the snapshot and are not re-sent with every input. A draft may read the global last selection
under that workspace as the create/prewarm seed, but it cannot override an existing session.

Switching config while running affects the next turn by default. Secrets do not enter the snapshot; a
remote workspace uses the same provider-registry command and does not depend on old config files.

## Compatible tool-scheduling events

The old `session/event` chain still receives `tool.updated(kind=scheduled)` emitted by the CLI. Its
optional `assistantMessageId` denotes the owning assistant message, must pass the App's strict
validation and be preserved; old events without the field stay compatible. When present it must be a
non-empty string, and other unknown fields are still rejected. Both the full `input` and the
`inputOmitted/inputRef=model_stream` scheduling payloads obey this contract.

A 60-round Feishu long task on 2026-09-07 exposed that the consumer-side schema omitted this field: the
CLI sent it normally, but the Host dropped the whole scheduled event with
`Unrecognized key: assistantMessageId`. The fix only completes the existing compatibility field; it
adds no chat capability and changes no delivery or recovery boundary of the V4 projection, workspace
isolation, desktop-continuous or web-remote-replayable.

Regression must cover both deliveryKinds, both input forms, missing-field compatibility and
invalid/unknown-field rejection.

## Change rules

- Before changing the protocol, first change the schema, pure functions and spec in `packages/shared/src/zcode-protocol-v4/`.
- A protocol change must verify the CLI reducer, Host transport, desktop continuous and mobile replayable together.
- Do not copy session/task/stream/queue/snapshot business state into the UI, relay or Electron main.
- The old `packages/shared/src/zcode-protocol/index.ts` may only shrink the compatibility surface and must not take new chat capability.
