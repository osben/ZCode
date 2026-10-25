# Subscription and Recovery: Connection-level Resync Is the Only Recovery Path

> Current fact (V4 wire v3): refresh, gap, slow-subscriber overflow, relay reconnect, attachment rebuild and CLI runtime restart all converge to connection-scoped recovery. A gap/fault on an active subscription uses same-sub resync; only an attachment/runtime generation rebuild fresh-subscribes. Recovery does not change the desktop `continuous` / mobile `replayable` boundary.

## 1. Subscription lifecycle

The client cannot choose a profile. The host injects `connectionId/clientMode/profile` from the trusted attachment context and sends frames only to the port owning the subscription.

```text
client                  connection facade               CLI publisher
  │ hello(v2, connectionId, trusted clientMode)              │
  │ clientHello(clientId, version, telemetry kind)            │
  │ subscribe(topic, base?) ─►│                                │
  │                            │ inject connection/profile ───►│
  │◄─ SubscribeAck{subId,mode,logEpoch} ───────────────────────│
  │   (after the ACK response is written)                      │
  │◄════════ initial/online TopicWireFrame(subId) only ═══════│
  │                                                            │
  │ gap / fragment loss ── v4/conversation/resync{subId,base} ►│
  │                         (single-flight per connection)      │
  │◄──────────── resume; on another gap forceSnapshot ─────────│
  │                                                            │
  │ attachment close          │ unsubscribeAll(connectionId) ─►│
```

Server ruling:

- `base.logEpoch` equals the current CLI epoch and `base.seq` is still within the retention window: `mode="resume"`, continue from `(base.seq, now]`.
- No base, different epoch, base outside the retention window, or client requests `forceSnapshot`: `mode="snapshot"`.
- Resubscribing the same `(connectionId, topic)` replaces only that connection's old subscription; another connection's same-topic subscription is unaffected.
- `v4/conversation/resync` on an active subscription must exactly hit the `subscriptionId` in the current connection registry, keeping the same subId/profile/topic; the client cannot use resync to choose topic, connection or delivery profile. A valid base is re-ruled from that subscriber's client watermark, not replaced by the publisher's `sentSeq`.

The subscribe response may carry only a small ACK: no embedded logical snapshot and no `frames[]` (the array as a whole could still exceed 1 MiB). After the ACK is written, the initial snapshot/resume is sent as ordinary owned-port wire notifications; until full assembly the client keeps the old store or loading state.

`SubscribeAck.logEpoch` only proves this subscription admission and the server ruling; it **never creates a resume base out of thin air**. If the client really held a consistent projection before the request and ACK=`resume` confirms the same epoch, it may keep using that proven old base; ACK=`snapshot` invalidates the old base immediately until a complete owned snapshot applies atomically. Conversation, sessions-index and workspace-config with no existing base must wait until the logical snapshot is assembled, schema/checksum-validated and applied before establishing `{logEpoch,seq}`. If the initial faults/overflows before that, the client must recover with `base:null + forceSnapshot:true` (or fresh snapshot subscribe); building `{epoch,0}` from the ACK epoch is forbidden. In particular the sessions-index cold seed does not enter the delta log, so a forged seq=0 may get a legal empty resume and permanently miss the cold-session baseline. Without a valid base no delta is applied; a complete owned snapshot (including an online overflow snapshot) can still establish a base.

### 1.1 Post-ACK physical batch and publisher reservation (04B)

The public result schema of all three subscribe kinds (conversation, sessions-index, workspace-config) is strict `{ ack }`. The CLI publisher first establishes a watermark-preserving reservation, the gateway encodes that logical frame into a complete physical notification batch, and the server stores `{messages, commit}` as a one-shot post-response outbox keyed by request id. The NDJSON connection mechanically executes per request:

```text
publisher reserve R(frame, stable logicalFrameId, deliveryKind)
                         │
gateway encode R -> { ack, physical notifications[0..k], commit }
                         │
                         ├─ response.result = { ack }
                         └─ requestId outbox = { messages[0..k], commit }

connection: take(requestId)
  -> write(response line)
  -> write every physical notification in order
  -> commit R only after every line entered this connection-owned write queue
```

1. On encode failure, a synchronous enqueue throw, or the connection closing mid-batch admission, do not commit; the next reserve must return the same `logicalFrameId` and the same logical content.
2. A normal return of Node `Writable.write()` (including the `false` backpressure signal) means the line has been taken over by the current connection and commit is allowed; if an async EPIPE/close happens later, that connection epoch ends as a whole, the old subscription/outbox does not migrate to a new pipe, and the client must resubscribe on the new attachment.
3. New events arriving while a reservation is in flight go to the next buffer and must not be eaten by the current commit. Unsubscribe/resubscribe invalidates the old reservation and a late commit returns false; but if the new initial encode fails before ACK admission, the replacement must roll back to the old subscription/mapping/flush state so the old client is not cut off.
4. With no initial frame the outbox is empty and only the response is written. Online frames use the same reserve -> encode -> emit-all -> commit pipeline.
5. Every reservation's `deliveryKind` is assigned authoritatively by the publisher and written unchanged by the encoder into every physical notification: subscribe admission yields `initial`, ordinary flush (including the publisher's own buffer-overflow snapshot) yields `online`, explicit `v4/conversation/resync` yields `recovery`. All fragments of one logical frame must carry the same value and the assembler fails closed on inconsistency. The UI must not guess the kind from "just called subscribe/resync", a Promise continuation or array position; a late online duplicate must not consume the recovery mark.
6. What the host facade, UI transport and task-index syncer stage before the ACK takes effect is physical wire, at most 1,024 frames and 32 MiB transport bytes. Ownership must be decided before assembly; a foreign `subscriptionId` must not consume assembly memory. Staging overflow must clear the whole batch and explicitly fail/mark `fault.subscription.initialFrameStagingOverflow` (never just shift the oldest fragment). Stale generation, unsubscribe and close clear staging, assembly and timeout references together.

### 1.2 same-sub resync and reservation invalidation

```ts
interface ConversationResyncParams {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}
interface ConversationResyncResult {
  ack: SubscribeAck; // subscriptionId unchanged
}
```

The server uses the same post-response outbox as subscribe: write the strict `{ack}` response, then the complete physical recovery batch in order, committing only after all enter the connection-owned queue. Resync admission immediately supersedes the sub's old reservation; a late commit of the old reservation must return `false`. Authoritative events entering after the old reservation are still covered by the new recovery snapshot/replay and are not lost through supersede.

When `base` matches the epoch, is in the retention window and `forceSnapshot` is not requested, reply `mode="resume"` and regenerate replay from `(base.seq,currentSeq]`; otherwise `mode="snapshot"`. Another topic of the same connection, or the same topic on another connection, is unaffected.

## 2. Client canonical apply

The client first restores wire v3 physical fragments into one logical topic frame, keeping the envelope's authoritative `deliveryKind`; only when envelope, type, length, fragment total and checksum all pass does it apply atomically. A missing fragment, conflicting duplicate, checksum mismatch or assembly overflow never partially modifies the store.

Before assembly, a per-subscription monotonic `logicalFrameOrdinal` gate runs: wire below the completed/fault/timed-out ordinal is silently dropped; at the same ordinal only duplicate fragments of the same `logicalFrameId` are allowed, a different id must raise `proto.frameAssemblyOrdinalConflict`; a higher ordinal may supersede the current fragments, but when the consumer aborts due to a same-batch fault it must keep an ordinal tombstone until unsubscribe cleans it.

```ts
function onLogicalFrame(store, frame, deliveryKind) {
  if (frame.subscriptionId !== store.subscriptionId) return; // old generation

  if (frame.payload.kind === "snapshot") {
    store.replaceAll(frame.payload.snapshot); // replace wholesale
    store.logEpoch = frame.payload.snapshot.logEpoch;
    store.seq = frame.toSeq;
    store.hasAppliedBase = true;
    // An online overflow snapshot is authoritative and may establish a base, but cannot pose as recovery closing the flight.
    if (deliveryKind === "recovery") markRecoveryFrameSeen(store);
    return;
  }

  if (frame.toSeq <= store.seq) {
    // aligned `(N,N]` or a recovery already covered by a newer snapshot is still a valid logical frame.
    if (deliveryKind === "recovery") markRecoveryFrameSeen(store);
    return; // late/duplicate, no projection change
  }

  if (deliveryKind === "online" && store.recoveryFlight) {
    // Residual online after recovery applied goes to the post-ACK successor; earlier online
    // is covered by this recovery's authoritative range. Neither may consume the current recovery flight.
    if (store.recoveryFlight.validFrameSeen) markSuccessorRecoveryNeeded(store);
    return;
  }

  if (frame.fromSeq !== store.seq) {
    requestResyncOnce(store, {
      base: { logEpoch: store.logEpoch, seq: store.seq },
      forceSnapshot: store.lastSubscribeMode === "resume",
    });
    return;
  }

  applyDeltasAtomically(store, frame.payload.deltas);
  store.seq = frame.toSeq;
  store.hasAppliedBase = true;
  if (deliveryKind === "recovery") markRecoveryFrameSeen(store);
}
```

Closed rules:

1. A snapshot always replaces wholesale, never merges.
2. `toSeq <= localSeq` never re-modifies the projection and causes no extra resubscribe; if it is a complete, valid recovery logical frame it must still mark that flight as having received delivery.
3. The first gap creates only one in-flight resync; until a `deliveryKind="recovery"` logical frame is fully validated and accepted, later gap/fault reuse the same flight (not cleared early when the RPC ACK arrives).
4. Only a `deliveryKind="recovery"` `resume` frame having another hole upgrades the same flight and sends one more `forceSnapshot=true`; the state must survive across synchronous ACK activation; no infinite resume loop.
5. While a snapshot/resume logical frame is fragmenting, the old store stays readable; the replace/apply happens once after assembly completes and validates.
6. `base` lives and dies with the projection: after a refresh loses the in-memory projection you cannot keep just the seq; a subscribe ACK cannot establish a base alone. Only the epoch/seq after an initial/recovery/online logical frame applies atomically may resume.
7. Once an initial assembly fault of the original subscribe enters same-sub recovery it must clear `awaitingInitial`; a later recovery gap upgrades by recovery rules, never wrongly fresh-subscribing.
8. A resync ACK is not recovery completion. If within 30s after the ACK not even one complete recovery logical frame arrived (including zero wire / whole batch lost), a normal resume attempt upgrades once to force snapshot; a UI force attempt timing out again goes to an explicit ERROR; task-index fresh-subscribes only the faulted topic without affecting siblings.
9. If, after a recovery logical frame was fully validated and accepted (mark seen) but before the ACK continuation, a non-duplicate online frame/gap shows up in the same batch, it must not be swallowed by the old flight; once the ACK closes the old flight, start an ordinary successor resync from the new applied base immediately.
10. `markRecoveryFrameSeen` only marks that the authoritative recovery logical frame fully arrived; the flight closes only when both it and the ACK are satisfied. An aligned `(N,N]` or a recovery covered by a newer snapshot does not change the projection but must still be marked, so a zero-change recovery never dangles forever.
11. **A deterministic content fault does not take the transient ladder.** Rules 3/4/8 assume a transient fault (lost fragments, timeout, checksum mismatch; a re-delivery may succeed). `proto.frameAssemblyInvalidPayload` is not: the bytes passed the length/checksum/UTF-8/JSON gates, and the rejection means the client cannot read the peer's **content**, while the `resume` tier would only deliver the same deltas again. So this fault sends one `forceSnapshot=true` directly (the only means that can yield different bytes, since a snapshot is regenerated and may no longer contain that content), **skipping the resume tier**; if the forced snapshot is still content-rejected, stop, and write the terminal state `fault.subscription.contentRejected` rather than `recoveryFailed`, and sessions-index does not schedule a backoff resubscribe (for a deterministic failure that loops forever: clear projection -> resubscribe -> rejected again). Self-healing paths remain: runtime generation change, fresh connect and user reconnect all resubscribe. The predicate and the two codes are in `packages/shared/src/zcode-protocol-v4/wire-fault.ts`; every other reason code is still treated as transient (misjudging a transient fault as deterministic leaves a self-healing gap stuck, worse than one useless retry).

    Measured cost (2026-09-21, sess_4142de31): a tool card payload carrying two extra keys burned three frames on the ladder before failing closed; the user manually clicked "Reconnect" twice, each burning three more, and the session could never be opened. The decorative-payload fallback itself is in 10-protocol-spec §4.4.5 (display is not gated at the envelope layer); this rule is the backstop for required-field skew.

## 3. Automatic recovery trigger matrix

| Trigger                                       | Client/host action                                                                                                    | Authoritative recovery result                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Page refresh, new pane, new device            | subscribe without a valid base                                                                                        | snapshot                                                                 |
| Short disconnect, in-memory projection intact | subscribe with `{logEpoch,seq}`                                                                                       | resume or snapshot                                                       |
| delta gap                                     | single-flight `v4/conversation/resync`                                                                                | resume; another gap forces snapshot                                      |
| `sendText` already `accepted                  | duplicate`, and after a short grace the queue item / real-user row with the same `sourceCommandId` is still invisible | single-flight `v4/conversation/resync` on the current owned subscription | resume or snapshot; recovers the projection only, does not replay the command |
| fragment missing/checksum failure             | drop the whole assembly + resync                                                                                      | no half-applied state                                                    |
| subscriber buffer over limit                  | publisher clears that sub's buffer, marks resync                                                                      | next send is only the latest snapshot                                    |
| relay/attachment rebuild                      | after the v2 handshake automatically resubscribe all active topics                                                    | new subId; old frames dropped                                            |
| CLI runtime restart                           | new `logEpoch`; client automatically resubscribes                                                                     | snapshot; old base not resumed                                           |
| port close                                    | host `unsubscribeAll(connectionId)`                                                                                   | release buffer/assembly; other connections unaffected                    |

Mobile relay/main only pass through payload and connection lifecycle. The raw adapter's `onSaturated/onDrained` is written by desktop main into the owning attachment's `connection-flow-v1` MessagePort sideband, and the host sends it into the CLI under the trusted connectionId. main/relay must not cache snapshots, fill gaps, maintain seq or choose a pause target themselves. The desktop MessagePort uses the same strict control/binary distinction; the continuous local link usually does not trigger network-level congestion.

conversation, sessions-index and workspace-config each hold an independent `{subscriptionId,appliedBase,recoveryFlight,recoveryFrameDeadline}`. A gap/assembly fault of one topic recovers only itself and must not clear a healthy sibling; task-index's pre-ACK overflow must leave the paused state and fresh-subscribe (never freeze permanently). A CLI runtime restart invalidates only the runtime and old subscriptions and does not destroy workspace-level persistent frame emitters; existing listeners receiving the restart signal make each active store full re-subscribe exactly once. Only a real workspace/service teardown disposes emitters and listeners.

## 4. Three kinds of volatile state, not an offline queue

```text
1. subscriber flush buffer (per subscription, millisecond-level)
   after filter + coalesce ≤500 ops and ≤max(1 MiB, snapshot upper bound); dropped on connection close

2. fragment assembly (per logical frame)
   ≤16 MiB; atomic apply after full validation; dropped and resynced on failure

3. session event log / projection (CLI authoritative)
   event log bounded; the projection can always produce the latest snapshot
```

The server accumulates no per-client persistent event queue for offline clients. After a long disconnect the client either replays the authoritative event log still in the window or takes a snapshot directly. A slow mobile subscription's flush-buffer overflow makes only itself resync and cannot block desktop or other panes of the same window.

"No offline event queue" is not "no input queue": all committed busy/running input enters the CLI/runtime's single `CommandInbox` FIFO; that input queue is a conversation business fact, see [10-protocol-spec.md](./10-protocol-spec.md) §4.2.5/§6.

## 5. Command and input recovery

The UI keeps a 24h pending-command registry for sent ordinary text/goal, containing a re-sendable payload; sensitive interactions keep only a digest. A record is deleted as soon as the QueueItem/guided projection appears; the registry only covers the authoritative-delivery-unknown window and is not a second queue.

```text
send(commandId, payload)
        │
        ├─ ACK / queue / row arrives ──> reconcile by sourceCommandId
        │
        └─ reconnect or ACK lost ───────> commands/query[{sessionId,commandId}]
                                      │
                                      ├─ duplicate/noop/failed -> close
                                      ├─ discarded queue/guide -> silently settle
                                      ├─ discarded startNow    -> resend with a new command only after user confirmation
                                      └─ unknown               -> silently settle, no UI error
```

The CLI queue is reliable only within the current process. On CLI restart an input that was admitted but not yet in the transcript is not auto-restored as an executable queue; a tombstone is written in the discarded-input ledger, and `commands/query` returns `failed` + `fault.command.inputDiscardedOnRestart` + a persisted `delivery`. The ledger only proves "this input was explicitly discarded" and carries no auto-execute semantics. The UI silently settles `queue/guide` and `unknown` with no authoritative conclusion without showing an error; only a `startNow` not in the transcript keeps its original text and attachment references and is resent with a **new commandId** after user confirmation.

Server idempotency memory has three layers: `in-flight pinned / live queue-or-guide pinned / settled LRU`; the 512/session cap applies only to settled. query and execute share one key gate; persistence fallback builds one lazy index per session and updates it incrementally from new anchor/marker/child/discarded facts. Any persistence read failure must return `fault.command.queryUnavailable` and never pose as `unknown`; `unknown` itself is not cached.

Final invariant: every committed input is in exactly one of `queue / guided row / transcript / explicit rejected|failed|discarded`. Lost ACK, gap, reconnect or restart must never cause "UI cleared but no authoritative record".

Mirror invariant (renderer side): once an input is taken over authoritatively (ACK accepted/duplicate, or `sourceCommandId` reconciliation of a queue/row/marker), the composer text belonging to this submission must be cleared, and this obligation does not die with the composer component instance. A transport failure (such as a remote ChannelClient dispose) is only "ACK unknown", not "not admitted": the text may first be restored to the draft, but `{commandId, text}` must be registered in `composerSubmissionSettlement` (module-level, memory only), which holds the registry resolution subscription; after the pane is unmounted and rebuilt by a disconnect, the new composer claims settlement from it when backfilling the draft. If the user has kept editing the backfilled text, do not clear it; failed/unknown/discarded terminals delete the registration and keep the text.
