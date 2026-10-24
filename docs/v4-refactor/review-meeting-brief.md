# V4 Refactor Review Brief: Conversation State Sync and Multi-Client Protocol Convergence

- Meeting goal: review whether the v4 direction systematically fixes conversation state desync, weak-network
  recovery and the local/remote-control protocol fork.
- In scope: conversation product projection, command model, subscription recovery, transport backpressure, and
  the unified protocol boundary of desktop continuous vs web remote replayable.
- Out of scope: concrete UI visual redesign, final TypeScript naming of single fields, making the relay business-aware.

Full history: `git show b8876e8b:docs/v4-refactor/review-meeting-brief.md`

## Background

Many past conversation bugs looked scattered (duplicate messages, timeline misplacement, half messages lost
after refresh, inconsistent stop state, permission dialogs vanishing after a mobile reconnect, queued prompts
lost or sent twice) but share one structural problem: **conversation product facts had no single authoritative
source.** The renderer, service, host, desktop main and mobile replay mirror each kept part of the runtime
state, and stream and snapshot wrote separately into UI memory, so the UI had to merge, compensate and guess.
That survives on a short local link but amplifies timing differences into product bugs on web, mobile remote,
remote workspaces, second-level RTT and frequent refresh/disconnect.

v4 does not add a new fallback per bug class; it turns conversation into:

```text
CLI / agent runtime is the single source of facts
  -> produces the Conversation Product Projection
  -> host only forwards, buffers, applies backpressure and schedules recovery
  -> desktop / web / mobile only render the projection and submit command intents
```

In one line: **the client is demoted from "state reducer" to "projection renderer + command proposer".**

## Problems and the matching v4 improvements

- **Renderer memory is one of the truths; stream and snapshot double-write one message array.** Symptoms:
  missing/duplicate messages after refresh, timeline misplacement, patched turn grouping. v4: the CLI
  generates `ConversationProductProjection`; rows, turn, actionAvailability, sessionControl are authoritative;
  a snapshot replaces wholesale and a delta is applied only contiguously. Check: the UI no longer derives turn
  and button state from flat messages; replaying the same events yields stable rows.
- **Action guards scattered across UI and operations.** Symptoms: inconsistent `canStop`, `canFork`, queue
  routing and multi-client button state. v4: every state-changing action is a command intent; the CLI decides
  by projection revision and a rules module and returns an ACK. Check: any client sees the same
  actionAvailability; repeated stop/permission responses close idempotently.
- **Several recovery paths whose base watermark lives and dies with UI state.** Symptom: after a mobile replay
  gap an old snapshot and new stream are stitched into a nonexistent state. v4: unified
  `subscribe(topic, base?)`: a valid base resumes, an invalid base gets a snapshot; `logEpoch + seq +
  subscriptionId` define generations. Check: late old-subscription frames are silently dropped; a gap triggers
  only a single-flight resubscribe.
- **High-frequency deltas pass through relay and IPC and are batched only on the client.** Symptoms: frame
  count explodes on weak networks, RTT amplification, mobile battery drain and dropped frames. v4: batching
  moves forward to the host channel layer, topics declare coalesce/resync; the frame level only does ACK,
  heartbeat, reconnect replay and congestion signals. Check: one round of output goes from "a frame per delta"
  to windowed delivery; overflow resyncs via snapshot instead of random frame loss.
- **desktop continuous and mobile replayable are two code paths.** Symptom: local and remote behaviors differ;
  fixing one end breaks the other. v4: one topic / snapshot / delta / command protocol, differences kept only
  as delivery profile parameters. Check: client apply logic has no profile branch; desktop defaults to
  continuous, mobile to replayable, terminal states agree.
- **Remote controller relies on extra bridge/mirror semantics.** Symptom: the phone is a "side-channel client"
  that can bypass the local host/runtime boundary. v4: remote control stays a shared-host attachment: relay
  and desktop main pass `rpc-frame` through, the phone attaches to the desktop's existing local/remote host.
  Check: relay/main do not hold task, stream, queue or snapshot business state.
- **Queued prompts and optimistic UI held in local memory.** Symptoms: queue lost on refresh, pending not
  closing when an ACK is lost, duplicates dedup'd by heuristics. v4: a command carries `commandId`, the
  authoritative row/queue item carries `sourceCommandId`; the overlay shows by commandId only and never enters
  real data. Check: the originating client also reads its own authoritative result from the subscription
  stream; the overlay closes on the projection.
- **workspacePath used as the identity isolation key.** Symptom: SSH/WSL/Docker remote workspaces with the
  same path cross-talk. v4: all identity/isolation keys use `workspaceIdentity?.trim() || workspacePath`;
  path execution still uses only `workspacePath`. Check: remote workspace bridge, snapshot, queue and owner
  command all carry the workspace identity.
- **No reproducible protocol-level evidence for current bugs.** Symptom: fixes rely on manual reproduction and
  UI guessing; regressions slip. v4: golden tests and a network chaos rig: snapshot atomicity, profile
  terminal-state agreement, duplicate/late frame handling, guard and projection from the same source. Check:
  each historical bug class maps to a protocol invariant or reducer case.

## State ownership

The root of desync is not missing sync code but multiple layers believing they can write conversation facts.

```text
CLI / agent runtime                    # single source of conversation facts
|-- canonical transcript               # authoritative record: user input, assistant output, tool results
|-- runtime facts                      # active work, pending permission, token usage, background tasks
|-- event log / logEpoch / seq         # incremental recovery watermark: resume deltas or re-pull a snapshot
|-- command guard and idempotency      # serialized command decisions, dedup and guard checks
`-- Conversation Product Projection    # UI-facing authoritative view
    |-- rows                           # timeline rows: turn grouping, message ownership, virtual-scroll key
    |-- actionAvailability             # canStop/canFork/canRetry, so the UI does not guess buttons
    |-- inputRouting                   # new input executes now, queues, or is rejected by a guard
    |-- sessionControl                 # phase, sessionEnded, stopState, lastError
    |-- queue / pendingInteractions / backgroundWorks

Host / service                         # transport, subscription, buffering; no new conversation semantics
|-- topic subscription registry        # per-connection topics with subscriptionId/visibility/profile
|-- per (connection, topic) flush buffer # short send buffer for batching and throttling; soft state dropped on disconnect
|-- coalesce / conflation / backpressure
`-- no new conversation product decision # host/service must not decide turn ownership, button availability or session state

Renderer / Web / Mobile                # display and intent only, never a fact source
|-- render projection
|-- send command intent
|-- optimistic overlay by commandId    # closed when the authoritative row/queue item arrives
`-- local-only UI state                # draft, scroll anchor (by rowId), hover/focus, pane layout
```

The benefit: conversation product semantics need to be proven once, in the CLI reducer and protocol tests;
desktop, web and mobile no longer each write "how to stitch a stream into a conversation".

## Subscription, recovery and weak networks

A client that was disconnected, refreshed, or is a new device re-aligns with CLI authority by one action for
all cases: subscribing to the conversation topic. They differ only in whether the client holds a trusted old state.

- No old state (refresh, new device): `subscribe(topic)` -> full snapshot.
- Old state with remembered watermark W (short network loss): `subscribe(topic, base=W)` -> if W is still
  valid, only deltas after W.
- Old state but the watermark is too old or the generation changed (long outage, CLI restart):
  `subscribe(topic, base=W)` -> the old state is dropped and a full snapshot is sent.

Terms: topic = which conversation (`conversation/<sessionId>`); snapshot = the full current view computed by
the CLI at a moment; delta = incremental change after the last watermark; seq = watermark in the CLI event
stream; logEpoch = generation of the CLI process/event log (a changed generation means the old seq cannot
resume); base = the client's claim "I hold a consistent view at logEpoch=X, seq=W".

Key invariant: **`base=W` may be used to resume deltas only when the client really holds the consistent view
at seq=W.**

On receiving a frame the client does not guess or patch holes; five rules:

1. `subscriptionId` mismatch -> a late frame of an old subscription, drop.
2. payload is a snapshot -> replace the current projection wholesale, no merge with the old array.
3. `toSeq <= local seq` -> duplicate or late frame, drop.
4. `fromSeq != local seq` -> a hole in between, resubscribe to get a snapshot.
5. `fromSeq == local seq` -> contiguous watermark, safe to apply deltas.

Weak-network recovery is two-layered: jitter of hundreds of ms to seconds is handled by `@zcode/rpc`
(ACK / heartbeat / reconnect replay; the conversation topic does not notice and seq is unbroken); refresh,
long outage, relay/mobile page rebuild and CLI generation changes are handled by the conversation topic with
`subscribe(base)` (base usable -> deltas, otherwise snapshot). This avoids the failure where a phone holds an
old view and keeps stitching new stream onto it, ending with conversation state the CLI never acknowledged.

## Protocol merge: Replay and Continue

v4 merges the protocol model, not the runtime semantics of every end.

- Same protocol: topic = `conversation/<sessionId>`; snapshot = current full projection; delta = row/state
  patch; command = user intent; ack = accepted / rejected / stale / duplicate / failed.
- Different delivery profiles: **desktop continuous** (local MessagePort default; low latency, fine streaming
  granularity; the direct continuous real-time link) and **web remote replayable** (relay / weak-network
  default; larger flush window; machine output such as tool output streams less and closes at terminal state;
  after a disconnect recovers via snapshot + replay).

```text
model event stream
  -> CLI reducer produces authoritative projection delta
  -> host channel layer coalesces by the subscriber's profile
  -> @zcode/rpc does frame-level ACK / heartbeat / reconnect replay
  -> client renders with the same apply algorithm
```

Two constraints hold at once: desktop is not polluted by mobile replayable semantics and stays the continuous
main path; mobile does not bypass the replayable recovery boundary, and after a large gap a snapshot must align it.

## Remote-control and local link boundary

Remote v4 must not turn the relay or desktop main into a business-state layer. The valid fact stays the
shared-host attachment:

```text
mobile /remote
  -> external relay: auth / pair / heartbeat / payload relay
  -> desktop main: workspace bridge and rpc-frame routing
  -> existing host process
  -> services / runtime / task persistence
  -> CLI / agent runtime
```

- The relay passes only `rpc-frame` through and does not parse task, session, stream, queue or snapshot.
- Desktop main only schedules attachments and holds no conversation business state.
- The phone cannot start an independent Agent runtime for remote control, nor create an independent SSH/WSL/Docker session.
- Bridge, snapshot, queue and owner command of a remote workspace must carry `workspaceIdentity` and `remoteSessionId` end to end.

## Command and optimistic overlay

The client is a proposer, not a writer:

```text
UI action
  -> command(commandId, clientId, sessionId, baseRevision, type, payload)
  -> CLI guard / dedupe / enqueue / execute
  <- ACK
  -> projection delta
  -> UI closes the overlay by sourceCommandId
```

- `accepted` only means the authority accepted it; it does not let the UI write real messages locally.
- The overlay is for immediate feedback only, mounted by commandId, and never merged into rows.
- The authoritative userInput row, queue item and timeline marker all carry `sourceCommandId`.
- After a disconnect, unclosed commands are reconciled with `commands/query`, not blindly resent.
- Multi-client concurrency is serialized by the CLI; no OT/CRDT.

This unifies the boundary of "continue sending" and "recovery replay": continue is a command, replay is
subscription recovery; both close on the same projection, rather than a local queue plus a remote mirror stream.

## Phases

- **Phase 0, protocol finalization:** fix state ownership, the five-piece topic, command ACK, delivery profile
  and invariants. Output: field spec, case catalog, coverage matrix, golden test list.
- **Phase 1, CLI projection:** move rows, actionAvailability, sessionControl, queue and other product facts
  into the CLI reducer. Output: reducer, schema, snapshot atomicity tests, sourceCommandId anchor.
- **Phase 2, subscription recovery and transport:** unified subscribe/apply, productionized ACK/reconnect/
  backpressure, remote control stays shared-host. Output: topic runtime, coalesce, logEpoch, subscriptionId,
  chaos test.
- **Phase 3, UI convergence:** the UI deletes its local reducer and derivation, rendering projection + overlay
  only. Output: v4 chat store, virtual-scroll rowId anchor, old-path deletion plan.

## Review questions

1. Is "the CLI projection is the single authority for conversation product facts" accepted?
2. Is "protocol merge = one topic/command/apply, end differences expressed only by delivery profile" accepted?
3. Is "no per-client offline queue; long disconnect/refresh recovers uniformly by snapshot" accepted?
4. Is "relay and desktop main do not push task/session/stream business state down" accepted?
5. Is the command inbox / queue lifecycle stance accepted: a renderer disconnect is recoverable, a host/CLI
   process exit does not promise continued execution, and persisted effects close idempotently by `sourceCommandId`?
6. Are the G-12 fault catalog and G-13 auth surface mandatory Phase 0 content?

## Expected gains

- Conversation bugs converge from "multi-client patches" to "protocol invariants + reducer tests".
- Web and mobile weak networks no longer rely on UI-guessed recovery; refresh and disconnect are the ordinary subscription path.
- Remote control and the local link share one protocol model while keeping the desktop continuous / mobile
  replayable boundary.
- Host/relay/main duties get lighter and state no longer spreads across the forwarding layers.
- A new client form only needs a transport and capability, not a rewritten conversation reducer.

## Related documents

- [V4 refactor README](./README.md)
- [ZCode Protocol v4 field-level spec](./10-protocol-spec.md)
- [Subscription and recovery](./04-sync-and-recovery.md)
- [Transport and backpressure](./05-transport-and-backpressure.md)
- [V4 refactor design review](./design-review.md)
- [Web remote-control external relay architecture](../web-remote-control/web-remote-control-architecture.md)
- [Task Realtime Sync](../web-remote-control/task-realtime-sync.md)
- [Mobile remote task command queue](../web-remote-control-task-command-queue.md)
