# Protocol Schema: V4 Core Conversation Loop

A structural quick reference to [10-protocol-spec.md](./10-protocol-spec.md): the public shapes of V4 wire v3, the conversation topic, input intent, dedup lookup and fork. Field semantics, limits and guards follow 10; subscription recovery and backpressure are in [04](./04-sync-and-recovery.md) and [05](./05-transport-and-backpressure.md).

## 0. Design stance

1. The UI only applies the CLI authoritative projection and never infers queue/fork state from phase, array position or raw messages.
2. Small objects replace wholesale; rows allow only the closed five deltas; a snapshot always replaces atomically.
3. All committed input shares one CLI `CommandInbox` FIFO; the UI keeps only the draft and the optimistic overlay.
4. transport/profile can change only intermediate frames, never command, queue, row or final-state semantics.

## 1. Wire v3 handshake and trusted connection

```ts
interface HelloMessage {
  kind: "hello";
  protocolVersion: 3; // wire version; the projection snapshot schema is versioned independently
  connectionId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryProfile: "continuous" | "replayable";
  serverTime: number;
  capabilities: HostCapabilities;
  auth: { userId?: string };
}

interface ClientHello {
  kind: "clientHello";
  protocolVersion: 3;
  clientId: string;
  clientKind?: "desktop" | "web" | "mobileRemote" | "mobileApp"; // telemetry/display only
  appVersion: string;
}
```

`connectionId/clientMode/deliveryProfile` are assigned by the host per attachment type and cannot be overridden by the client: desktop (including SSH/WSL/Docker) = `continuous`, mobile remote/WebSocket = `replayable`.

```ts
interface SubscribeParams {
  topic: string;
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  // clientMode / deliveryProfile / connectionId are forbidden: injected by the connection facade.
}

interface SubscribeAck {
  subscriptionId: string;
  mode: "snapshot" | "resume";
  logEpoch: string;
}

interface ConversationResyncParams {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}
```

Method names: `v4/conversation/subscribe`, `v4/conversation/unsubscribe`, `v4/conversation/resync`. Closing the port is equivalent to unsubscribing every subscription of that `connectionId`.

The subscribe response returns only `SubscribeAck`. After the ACK is written, the initial snapshot/resume and online frames all use the owning attachment's `TopicWireFrame` notifications; embedding a logical snapshot or `frames[]` in the response is forbidden.

## 2. Logical TopicFrame and physical TopicWireFrame

```ts
interface TopicFrame<S, D> {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: number;
  payload: { kind: "snapshot"; snapshot: S } | { kind: "deltas"; deltas: D[] };
}

type TopicWireFrame<S, D> =
  | {
      wireVersion: 3;
      kind: "complete";
      logicalFrameId: string;
      frame: TopicFrame<S, D>;
    }
  | {
      wireVersion: 3;
      kind: "fragment";
      logicalFrameId: string;
      subscriptionId: string;
      fragmentIndex: number;
      fragmentCount: number;
      logicalBytes: number;
      checksum: { algorithm: "crc32"; value: string };
      dataBase64: string;
    };
```

1. Every physical JSON/RPC frame including its envelope is strictly `<=1 MiB`.
2. After profile filter + coalesce the subscriber buffer must satisfy both `<=500 ops` and `<=max(1 MiB, snapshot upper bound)` (05 §3); beyond that it is cleared and turns to resync, and the next send is only the latest snapshot.
3. A snapshot/resume logical frame may fragment, with assembly `<=16 MiB`; it applies atomically after full validation, and a missing fragment / conflict / overflow triggers resync.
4. `toSeq <= localSeq` is silently dropped; a gap does a single-flight resync; a gap after resume forces a snapshot.

## 3. ConversationSnapshot and authoritative actions

```ts
interface ConversationSnapshot {
  protocolVersion: 1; // projection schema version, separate from wire v3
  sessionId: string;
  logEpoch: string;
  seq: number;
  revision: number;
  control: SessionControl;
  availability: SessionActionAvailability;
  inputRouting: InputRouting;
  config: SessionConfigState;
  usage: SessionUsageState;
  queue: QueueState;
  pendingInteractions: PendingInteraction[];
  pendingCommands: CommandStateSummary[];
  backgroundWorks: BackgroundWorkSummary[];
  goal: GoalState | null;
  plan: PlanState | null;
  rows: RowsWindow;
}

type ActionAvailability = { allowed: true } | { allowed: false; reasonCode: string };

interface SessionActionAvailability {
  fork: ActionAvailability; // session/global operation lock; target eligibility still follows row.actions.canFork
  compact: ActionAvailability;
  switchModelConfig: ActionAvailability;
  setFollowupMode: ActionAvailability;
  queueEdit: ActionAvailability;
  sendQueuedNow: ActionAvailability;
  resumeGoal: ActionAvailability;
}

interface RowActions {
  canFork?: true;
  canEdit?: true;
  canRetry?: true;
}
```

The UI shows fork based on `availability.fork` and the target row's `actions.canFork`, and must not infer it from `control.phase`, whether the assistant is at the array tail, or the raw message type.

## 4. ConversationInputIntent: conservation of all input fields

```ts
interface ConversationInputIntent {
  sourceCommandId: string; // original submitted commandId, carried through all later facts
  queueItemId: string; // assigned at admission, unchanged by edit/reorder/reserve/drain
  clientId: string;
  kind: "sendText" | "sendGoalCommand";
  text: string; // original text; never a parsed summary substitute
  attachments: AttachmentRef[]; // [] when none, so undefined never drops a field along the way
  delivery: {
    requested: "auto" | "startNow" | "queue" | "guide";
    admitted: "startNow" | "queue" | "guide";
    fallbackReasonCode?: string;
  };
  order: {
    admissionSeq: number; // CLI serial admission order
    queuePosition?: number;
  };
  steer: {
    state: "notRequested" | "submitting" | "steering" | "guided" | "fellBack";
    reasonCode?: string;
  };
  dispatch: {
    state: "admitted" | "queued" | "reserved" | "promoting" | "drained";
    reservationId?: string;
  };
  admittedAt: number;
}

type QueueItem = ConversationInputIntent & {
  dispatch: ConversationInputIntent["dispatch"] & {
    state: "queued" | "reserved" | "promoting";
  };
};

interface QueueState {
  items: QueueItem[]; // order = the authoritative FIFO order after CLI admission/reorder
  autoDrain: boolean;
}
```

The same intent runs through:

```text
CommandInbox admission
  -> QueueItem(sourceCommandId=S, queueItemId=Q)
  -> drain/guided event(sourceCommandId=S, queueItemId=Q)
  -> UserInputRow(sourceCommandId=S, attachments, guided, clientId)
  -> transcript message anchor(sourceCommandId=S)
```

When guide does not apply, carries attachments, or compact/verifier is busy, the full intent must fall back to the ordinary queue. empty/oversize/runtime reject must return `rejected/failed`; never clear the UI first and then lose the payload.

`editQueueItem` updates in place, keeping `queueItemId/sourceCommandId/clientId/order/attachments` and changing only the explicitly submitted new fields. `sendQueuedNow` is:

```text
reserve(Q) -> stop barrier -> start/promote(Q) -> remove(Q)
   │                              │
   └─ timeout/failure -> release ─┘ (original item, position and fields kept)
```

Repeated clicks or multi-end competition on the same Q may have only one reservation owner.

## 5. Row, marker and persisted anchors

```ts
interface UserInputRow extends RowBase {
  kind: "userInput";
  text: string;
  origin: "realUser" | "backgroundResult" | "goalContinuation" | "mailbox" | "synthetic";
  sourceCommandId?: string; // required for realUser/guided
  queueItemId?: string;
  clientId?: string;
  guided?: true;
  attachments?: AttachmentRef[];
}

interface TimelineMarkerRow extends RowBase {
  kind: "timelineMarker";
  sourceCommandId?: string; // required for markers produced by user commands
  marker: TimelineMarker;
}

interface MessageAnchorMetadata {
  sourceCommandId?: string;
  productTurnId?: string;
  orderedMessageIds?: string[];
  boundaryMessageId?: string;
}

interface ChildSessionMetadata {
  parentSessionId: string;
  sourceCommandId: string; // a fork duplicate returns the same child
  forkTarget: StableForkTarget;
}
```

QueueItem, the drain event, the user row, the message anchor, user-produced markers and fork child metadata must keep the original `sourceCommandId`; promotion/send-now must not replace it with a new command id.

## 6. Command ACK, query and single-flight

```ts
interface CommandKey {
  sessionId: string;
  commandId: string;
}

interface CommandsQueryParams {
  commands: CommandKey[]; // 1..64
}

interface CommandsQueryResult {
  results: Array<{
    key: CommandKey;
    result: CommandAck | "unknown";
  }>;
}
```

The per-key lookup order is fixed:

```text
in-memory LRU
  -> transcript user/message anchor sourceCommandId
  -> timeline marker sourceCommandId
  -> fork child metadata sourceCommandId
  -> discarded input ledger
  -> unknown
```

A discarded hit returns `CommandAck{status:"failed", reasonCode:"fault.command.inputDiscardedOnRestart", result:{type:"inputDisposition",delivery}}`, not `unknown`. `command execute` and `commands/query` for the same key share a single-flight/mutual-exclusion entry: a query must not report unknown in the window "execution started, LRU/transcript not yet written", and must not trigger a second side effect.

The UI pending registry TTL is 24h: ordinary text/goal keep a re-sendable payload, sensitive interactions keep only a digest; the record is deleted as soon as the QueueItem/guided projection appears. After a CLI restart a discarded `queue/guide` is silently settled; only a `startNow` not in the transcript, or `unknown`, prompts the user to confirm a resend; a discarded input is never auto-restored or auto-replayed.

## 7. Stable assistant fork

```ts
interface StableForkTarget {
  productTurnId: string;
  transcriptTurnId: string;
  orderedMessageIds: string[];
  boundaryMessageId: string;
}

type StableForkGoalBoundary =
  | { kind: "none" }
  | {
      kind: "snapshot";
      target: SessionGoal;
      verificationEntryIds: string[];
    };

resolveStableForkTarget(target: { rowId: number; entityId: string }, baseLogEpoch: string):
  | {
      ok: true;
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundary;
    }
  | { ok: false; reasonCode:
      | "guard.forkAssistantOnly"
      | "guard.forkTargetNotStable"
      | "guard.forkTargetAmbiguous"
      | "guard.compactOperationLock" };
```

1. The only valid target is the **last completed assistant segment** of a `completedSuccess` product turn. New data follows the persisted turn anchor; old data falls back only when the message/turn boundary is unique.
2. For new data the final assistant anchor must persist the raw message segment, boundary and explicit `goalBoundary` before `TurnComplete` is published. A missing `goalBoundary` means historical data only; new data with no goal must write `{ kind: "none" }` and must not guess the fork-point state from the parent's current goal. `snapshot.verificationEntryIds` contains only verifier entries persisted before that transcript boundary.
3. While a primary turn, foreground subagent, goal continuation or goal verifier is running, an earlier stable target can be forked.
4. compact remains the global operation lock.
5. streaming/interrupted/failed partial, an intermediate assistant segment, user/tool/timeline targets are all rejected.
6. A running fork copies only the stable transcript, the fork-point config and the goal before the fork point; it does not copy queue, active/background work or continuation inbox, does not rewind the shared workspace, and the parent keeps running.
7. The existing workspace checkpoint behavior for completed/idle is not widened.
8. A retry with the same `sourceCommandId` returns the same child.
9. E10/FX08 copy tool blocks, the final assistant after the tool result and the file facts already produced by that turn by logical turn boundary, not by truncating at "the last raw assistant message".

## 8. Deltas and the final invariant

```ts
type ConversationDelta =
  | { op: "row.appended"; row: ConversationRow }
  | { op: "row.upserted"; row: ConversationRow }
  | { op: "row.removed"; fromRowId: number }
  | { op: "row.delta"; rowId: number; path: StreamablePath; append: string }
  | { op: "state.updated"; patch: StatePatch };
```

coalesce must not cross `row.removed`; `state.updated` only replaces whole keys; stream paths are a closed whitelist. Any structure that cannot be expressed safely, buffer overflow or non-contiguous seq sends a snapshot resync and never introduces a compensating reducer in the UI.

Final invariant: every committed input is in exactly one of `queue / guided row / transcript / explicit rejected|failed|discarded`; at no moment may "UI cleared but no authoritative record" occur.
