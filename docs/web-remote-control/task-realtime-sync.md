# Task Realtime Sync

> Status: V4 wire v3 current effective specification.
>
> The desktop and mobile clients attach to the same host/service/CLI runtime, but connections, subscriptions, and delivery profiles are independently isolated.
> `TaskRealtimeBus` continues to handle owner lease, stale-run, and cross-host command routing; it does not maintain a second copy of
> conversation queue, projection, or replayable business state.

This document describes the real-time subscription, snapshot/resync, cross-end input, and disconnection recovery boundaries for ZCode task/session.

## Core Invariants

- Local desktop and SSH/WSL/Docker desktop windows are fixed as `desktop-continuous`, using the complete direct continuous data stream.
- Mobile `/remote` and Web remote are fixed as `web-remote-replayable`, using the replayable gap/snapshot recovery stream.
- `clientMode` and profile are trustedly injected by the host attachment; UI-facing subscribe must not select or override.
- Each connection has an independent subscription registry, buffer, fragment assembly, and resync lifecycle.
- All ends' submitted busy/running inputs enter a `CommandInbox` FIFO in CLI serial admission order.
- The relay/main only handles authentication, pairing, heartbeat, `rpc-frame`/app payload, and connection-level flow control signal passthrough.
- Owner/lease/stale-run continue to guarantee single owner, blocked requests, and cross-host command correctness, but do not own conversation facts.

Final input invariant: every submitted input must be in exactly one of `queue / guided row / transcript / explicit rejected|failed|discarded`.

## Process Model

```text
Desktop attachment A                       Mobile /remote attachment B
{connectionId=A, desktop-continuous}       {connectionId=B, web-remote-replayable}
            │                                           │
            │ MessagePort                                │ relay rpc-frame
            └─────────────────┐             ┌────────────┘
                              v             v
                    one Window Host owning local/remote workspace scopes
                    ├─ connection facade A -> sub-a*
                    ├─ connection facade B -> sub-b*
                    ├─ owner / lease / stale-run routing
                    └─ services -> one CLI runtime
                                      ├─ event log / projection
                                      └─ CommandInbox FIFO
```

The mobile client only attaches to the local/remote workspace scope already existing in the single Window Host of the target desktop window; it cannot start a new Agent runtime,
Host, or SSH/WSL/Docker session. The mobile disconnection releases short-lifecycle attachments without destroying the still-running Host/CLI.

The remote workspace path must pass through `workspaceIdentity` and `remoteSessionId`. The identity key uses
`workspaceIdentity?.trim() || workspacePath`; file reads/writes and process cwd use `workspacePath`.

- The relay only handles pairing, heartbeats, and `data.payload` passthrough; it does not parse tasks, sessions, streams, permissions, or snapshots.
- The desktop main only handles workspace bridges, MessagePort attachments, RPC frame routing, and realtime bus coordination; it does not directly read/write task repos.
- The mobile reconnection releases short-lifecycle `BridgeAttachment`; it cannot destroy still-running `HostEntry`, services, or Agent runtime.
- Only real window closing, app quit, and update installation enter the Host shutdown barrier; minimizing to the tray and the mobile client disconnecting do not enter it.
- Both local and remote workspaces attach to the single Host of the window; the remote scope is first located by `remoteSessionId + workspaceIdentity/workspaceKey`, then validated by the Host registry for path/identity. Multiple SSH logical sessions can share the same connection within a single window Host, but the mobile client cannot cross logical sessions to access another workspace, nor create new SSH/WSL/Docker sessions.
- The window Host registers only one `hostId` in `TaskRealtimeBus`; owner/lease/session routing continues to isolate by `workspaceKey + taskId`; scope is re-derived on session bind/detach, without sinking the replayable state to main.

## Trusted Connection and Owned Subscription

The host allocates an independent `connectionId` for each attachment and injects the trusted connection context into the V4 service facade:

| attachment                          | trusted clientMode      | profile      |
| ----------------------------------- | ----------------------- | ------------ |
| Local/SSH/WSL/Docker desktop window | `desktop-continuous`    | `continuous` |
| Mobile `/remote` / Web remote       | `web-remote-replayable` | `replayable` |

`hello/clientHello` is used to negotiate wire v3, confirm the connection identity, and record a stable `clientId`; client-reported values cannot override the host-injected connection/profile. The registry maintains at least:

```text
connectionId -> subscriptionId -> {topic, profile, state}
subscriptionId -> owning attachment port
```

Subscription negotiation capabilities and `clientMode` follow the same injection path: the host declares `workflowRunDeltas` in `hello`; the client only declares in `clientHello` when the host declares; the facade then injects the conclusion into that connection's subscribe. It is orthogonal to `clientMode`/`deliveryKind` — both `continuous` and `replayable` can be declarers or non-declarers. Non-declarers (such as old mobile pages whose version guard has not yet switched the user to the new bundle) continue to receive whole keys `workflowRuns`, clamped at 256 items per run by the old per-run boundary, so their strict frame validation continues to pass normally. The clamped boundary preserves **those still moving**: actors whose status is not `completed` and nodes that have not yet been settled are kept first; the balance is supplemented with the earliest entries in table order, and the output still follows the original table order ([presentation.md](../dynamic-workflow/presentation.md) "The run state the pane draws").

Re-subscribing to the same topic on the same connection only replaces its own old subscription. CLI downlink frames are written only to the owning port;
workspace broadcasts followed by the mobile discarding desktop frames by subId are prohibited. When a port closes, all subscriptions for that connection are unsubscribed at once, and buffers/assembly are released. A slow mobile subscription cannot affect the desktop or another pane.

## Buffer, Frames, and Resync

The publisher calculates each subscriber's buffer after profile filtering and coalescing:

- `<= 500 ops` and `<= 1 MiB`: normal drain.
- Either upper limit exceeded: immediately clear that subscriber's buffer, mark resync, send only the latest snapshot next.
- Each physical JSON/RPC frame including the envelope must be `<= 1 MiB`; oversized logical snapshots/resumptions use sharding.
- The topic encoder takes the maximum of the actual envelopes for CLI NDJSON, Channel/Socket, and mobile relay base64 outer JSON; therefore, both desktop continuous and mobile replayable never receive topic notifications exceeding 1 MiB.
- Fragment assembly has a single-frame upper limit of 16 MiB / 1,024 pieces, with a maximum of 32 concurrent pieces, 32 MiB staging, and 30s per consumer; each subscription's `logicalFrameOrdinal` is strictly monotonically increasing; old ordinal replays are silently discarded, ordinal collision reports conflicts, tombstones are retained after faults/timeouts; missing pieces, collisions, checksum/schema mismatches, or overflow discard the entire assembly, prohibiting partial apply.
- The publisher uses non-destructive reservations: all physical wires are committed to the water level only after being accepted by the transport; retries of the same logical id/content that fail mid-stream do not clear new events.

`onSaturated/onDrained` are connection-level signals. The mobile path can be passed through the relay/main to the owning attachment, but
the relay/main does not interpret topics, sequences, or snapshots. The desktop main only writes the adapter edge as the owning MessagePort's
`connection-flow-v1` sideband; after the host scope is serialized and deduplicated, it calls
`v4/connection/flow` with the trusted `connectionId`. When the CLI is saturated, only skip the reserve/flush for that connection; ingestion and the desktop
continuous sibling continue; drained only restores that connection; closed clears the pause and unsubscribes via the owned registry.

Client apply rules:

1. Replace the entire snapshot as a whole after complete assembly; never merge.
2. Late/duplicate frames with `toSeq <= localSeq` are silently discarded.
3. When `fromSeq != localSeq`, initiate only one in-flight `v4/conversation/resync` of the same subscription; the owned registry
   determines the topic/profile; the client cannot override.
4. Recovery flights continue until the logical frame is successfully applied; resuming a gap once upgrades to `forceSnapshot` within the same flight; do not clear the flight at ACK or infinitely resume.
5. After the attachment is rebuilt or the CLI `logEpoch` changes, automatically re-subscribe all active topics.

The `logEpoch` in the subscribe ACK is only admission metadata and does not create a base; existing projections can only be retained when `ACK=resume` and the same epoch; `ACK=snapshot` invalidates it to a complete snapshot apply. Deltas without a valid base are not applied; faults/overflows must `base:null + forceSnapshot:true`; complete online snapshots can still build a base. If no complete recovery logical frame arrives within 30s after the ACK, the resume upgrades to a force once; if the force also times out, the UI clearly ERRORS and the task-index topic-local fresh-subscribes. After the recovery apply, the residual online gap in the same batch starts a successor flight.

Conversations, sessions-index, and workspace-config use independent water levels and recovery flights; a gap/fault in one of the mobile's topics must not pause desktop siblings or clear healthy index/config topics. Runtime restarts only invalidate old
runtime/subscriptions; the Local/Remote Host frame emitters carrying that workspace scope remain alive, allowing existing listeners to drive full
re-subscribe; true workspace teardown releases the emitter.

## Blocking Events and Owner Routing

Permissions, elicitation, terminal, and snapshot invalidation block the runtime or determine the UI focus; they must be visible to online connections of the same task through the
owned subscription, or trigger snapshot alignment; they cannot be swallowed by ordinary owner-only content filtering.

Commands that need to be routed to the runtime owner include:

- `stop_generation`
- `respond_permission`
- `respond_elicitation`
- Remote workspace / bot / proxy fallback conversation commands

Owner commands must carry `workspacePath`, optional `workspaceIdentity`, `workspaceKey`, `taskId`, and the current
`runId`. The main finds the lease by `workspaceKey + taskId` and rejects stale runs. The shared-host main path usually directly hits the same
host manager, but this does not justify removing owner/lease; remote workspace proxies, cross-host owners, bot/proxy, and blocked responses still depend on it.

## Canonical Input Queue

V4 no longer splits queues by endpoint:

```text
desktop send ─┐
              ├─> CLI serialized admission -> CommandInbox FIFO
mobile send ──┘                  |
                                  ├─ queue item
                                  ├─ guided row
                                  ├─ transcript
                                  └─ explicit rejected/failed/discarded
```

The mobile V4 bypasses the host runtime command queue of `IZCodeTaskService.enqueueTaskCommand`; desktop accepted busy
inputs are no longer left in the renderer-local queue. The owner route only delivers the command to the correct CLI, without changing the CLI admission
order. Each `ConversationInputIntent` self-containedly saves `sourceCommandId`, `queueItemId`, `clientId`, kind, original text,
attachments, delivery, order, and steer/dispatch status.

When guide is not applicable, with attachments, compact/verifier busy, or runtime steer rejects, fall back to the ordinary queue with the original fields. Empty, exceeded, or runtime rejected returns explicit `rejected/failed`; the UI retains text and attachments. `editQueueItem` updates in place,
preserving the ID, position, attachments, and source command.

`sendQueuedNow` always executes:

```text
reserve(item) -> stop barrier -> start/promote(item) -> remove(item)
     |                                  |
     └─ timeout/failure -> release ─────┘  # the original item is retained in place
```

Multiple endpoints or consecutive clicks on the same item have only one reservation owner.

## ACK Reconciliation and Process Restart

After a QueueItem appears, the UI still retains the 24-hour pending-command record, until it enters the transcript, is cancelled, fails, or is discarded.
Regular text/goal payloads can be saved and re-sent; sensitive interactions only save the digest.

When the ACK is lost or reconnected, the UI calls `commands/query`, at most 64 `{sessionId, commandId}` at a time. The CLI lookup order is:

```text
in-flight pinned -> live queue/guide pinned -> settled LRU (512/session)
  -> transcript / message anchor sourceCommandId
  -> timeline marker sourceCommandId
  -> fork child metadata sourceCommandId
  -> discarded input ledger
  -> unknown
```

Queries and executions for the same key use single-flight, avoiding duplicate side effects from the async deduplication window.

`commands/query` and execute share `keyGate(sessionId|null, commandId)`; new commands obtain the
per-session admission gate in fixed order. In-flight and live inputs do not participate in LRU eviction; only settled commands can be evicted and sourced back; admissions for the same session are serial; different sessions can run in parallel. The persistent index is built lazily per session, updated incrementally, and isolated by
`workspaceIdentity?.trim() || workspacePath`; full transcript scans are prohibited for each query.

Queues only guarantee reliability within the current CLI process. After the CLI restarts, admitted inputs that have not entered the transcript/terminal state explicitly return
`fault.command.inputDiscardedOnRestart` and the persistent `delivery`; `queue/guide` silently settles after the old runtime is invalidated; only `startNow` or `unknown` that has not entered the transcript prompts the user to confirm re-sending; automatic recovery or replay is never attempted. Regular network disconnections
still recover the current runtime's authoritative queue from the replayable snapshot; the relay, main, and host do not cover boundaries through private queues.

## Running Stable Fork

During the primary turn, foreground subagent, goal continuation, or goal verifier running, you can fork an earlier
`completedSuccess` product turn's last completed assistant segment; compaction is still the operation lock.

The running fork only copies the stable transcript, fork-point configuration, and goal state before the fork point; it does not copy the queue, active/background
work, or continuation inbox; it does not rewind the shared workspace; the parent session continues running as-is. Retrying the same `sourceCommandId` returns the same child. The existing workspace checkpoint behavior for completed/idle is not expanded this round.

## Current Implementation Boundaries

Key landing points:

- `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts`: Mobile attaches to the existing host.
- `packages/desktop/src/host/windowRemoteConnectionRegistry.ts`: The authority for remote connections/logical sessions within a window.
- `packages/desktop/src/host/windowHostAttachmentRegistry.ts`: Trusted clientMode and scoped attachment lifecycle.
- `packages/desktop/src/main/taskRealtimeBus.ts`: Owner lease, stale-run, and cross-host routing.
- `packages/shared/src/zcode-protocol-v4/`: V4 wire, topics, commands, and runtime schemas.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`: Gateway, publishers, projections, and CommandInbox.
- `packages/services/src/zcode-agent/`: Connection-scoped V4 service facades.
- `packages/ui/src/v4/`: Owned subscription client apply, pending-command reconciliation, and projection stores.

The relay/main must not add new session/task streams, queues, snapshots, or fork business state; these states must be recoverable from the CLI
projection/event log and command lookups.
