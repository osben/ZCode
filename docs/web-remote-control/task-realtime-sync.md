# Task Realtime Sync

> Status: V4 wire v3 current specification.
>
> Desktop and mobile clients attach to the same host/service/CLI runtime, but connections, subscriptions and
> delivery profiles are isolated per client. `TaskRealtimeBus` keeps owner lease, stale-run and cross-host
> command routing; it keeps no second copy of conversation queue, projection or replayable business state.

This document describes the real-time subscription, snapshot/resync, cross-client input and disconnection
recovery boundaries of ZCode task/session.

## Core invariants

- Local desktop and SSH/WSL/Docker desktop windows are fixed to `desktop-continuous`, using the complete direct continuous stream.
- Mobile `/remote` and Web remote are fixed to `web-remote-replayable`, using the replayable gap/snapshot recovery stream.
- `clientMode` and profile are injected by the host attachment as trusted values; a UI-facing subscribe must not select or override them.
- Each connection has its own subscription registry, buffer, fragment assembly and resync lifecycle.
- Busy/running inputs submitted by any client enter one `CommandInbox` FIFO in CLI serial admission order.
- The relay/main only handle authentication, pairing, heartbeat, `rpc-frame`/app payload and connection-level flow-control signal passthrough.
- Owner/lease/stale-run keep guaranteeing a single owner, blocked requests and cross-host command correctness, but own no conversation facts.

Final input invariant: every submitted input is in exactly one of `queue / guided row / transcript / explicit rejected|failed|discarded`.

## Process model

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

The mobile client only attaches to the local/remote workspace scope already existing in the target desktop
window's single Window Host; it cannot start a new Agent runtime, Host or SSH/WSL/Docker session. A mobile
disconnect releases the short-lived attachment without destroying the running Host/CLI.

A remote workspace path passes `workspaceIdentity` and `remoteSessionId`. The identity key is
`workspaceIdentity?.trim() || workspacePath`; file reads/writes and process cwd use `workspacePath`.

- The relay only pairs, heartbeats and passes `data.payload` through; it does not parse tasks, sessions, streams, permissions or snapshots.
- Desktop main only does workspace bridges, MessagePort attachments, RPC frame routing and realtime bus coordination; it does not read/write task repos.
- A mobile reconnect releases the short-lived `BridgeAttachment`; it must not destroy the running `HostEntry`, services or Agent runtime.
- Only real window close, app quit and update installation enter the Host shutdown barrier; minimizing to the tray and a mobile disconnect do not.
- Local and remote workspaces both attach to the window's single Host; a remote scope is located by `remoteSessionId + workspaceIdentity/workspaceKey`, then path/identity are validated by the Host registry. Several SSH logical sessions can share a connection inside one window Host, but the mobile client cannot cross logical sessions to reach another workspace nor create new SSH/WSL/Docker sessions.
- The window Host registers one `hostId` in `TaskRealtimeBus`; owner/lease/session routing keeps isolating by `workspaceKey + taskId`; scope is re-derived on session bind/detach, and replayable state never sinks to main.

## Trusted connection and owned subscription

The host allocates an independent `connectionId` per attachment and injects the trusted connection context into the V4 service facade:

- Local/SSH/WSL/Docker desktop window: trusted clientMode `desktop-continuous`, profile `continuous`.
- Mobile `/remote` / Web remote: `web-remote-replayable`, profile `replayable`.

`hello/clientHello` negotiates wire v3, confirms the connection identity and records a stable `clientId`;
client-reported values cannot override the host-injected connection/profile. The registry keeps at least:

```text
connectionId -> subscriptionId -> {topic, profile, state}
subscriptionId -> owning attachment port
```

Subscription negotiation capabilities follow the same injection path as `clientMode`: the host declares
`workflowRunDeltas` in `hello`; the client declares it in `clientHello` only if the host did; the facade then
injects the conclusion into that connection's subscribe. It is orthogonal to `clientMode`/`deliveryKind`: both
`continuous` and `replayable` can be declarers or non-declarers. Non-declarers (such as old mobile pages whose
version guard has not yet moved the user to the new bundle) keep receiving whole `workflowRuns` keys, clamped
at 256 items per run by the old per-run boundary, so their strict frame validation keeps passing. The clamp
preserves **those still moving**: actors whose status is not `completed` and nodes not yet settled are kept
first, the balance is filled with the earliest entries in table order, and the output keeps the original table
order ([presentation.md](../dynamic-workflow/presentation.md) "The run state the pane draws").

Re-subscribing the same topic on the same connection only replaces its own old subscription. CLI downlink
frames are written only to the owning port; workspace broadcasts followed by the mobile dropping desktop frames
by subId are forbidden. When a port closes, all subscriptions of that connection are unsubscribed at once and
buffers/assembly released. A slow mobile subscription cannot affect the desktop or another pane.

## Buffer, frames and resync

The publisher computes each subscriber's buffer after profile filtering and coalescing:

- `<= 500 ops` and `<= 1 MiB`: normal drain.
- Either limit exceeded: clear that subscriber's buffer at once, mark resync, send only the latest snapshot next.
- Each physical JSON/RPC frame including the envelope must be `<= 1 MiB`; oversized logical snapshots/resumptions are sharded.
- The topic encoder takes the maximum of the actual envelopes of CLI NDJSON, Channel/Socket and mobile relay base64 outer JSON, so neither desktop continuous nor mobile replayable receives topic notifications over 1 MiB.
- Fragment assembly: single-frame limit 16 MiB / 1,024 pieces, at most 32 concurrent pieces, 32 MiB staging and 30 s per consumer. Each subscription's `logicalFrameOrdinal` is strictly monotonic; old ordinal replays are silently dropped, ordinal collision reports conflicts, tombstones are kept after faults/timeouts; missing pieces, collisions, checksum/schema mismatch or overflow discard the whole assembly, and partial apply is forbidden.
- The publisher uses non-destructive reservations: all physical wires are committed to the water level only after the transport accepts them; a retry of the same logical id/content that failed mid-stream does not clear new events.

`onSaturated/onDrained` are connection-level signals. On the mobile path they can pass through relay/main to the
owning attachment, but relay/main never interpret topics, sequences or snapshots. Desktop main writes the
adapter edge only as the owning MessagePort's `connection-flow-v1` sideband; after the host scope serializes
and dedups, it calls `v4/connection/flow` with the trusted `connectionId`. When the CLI is saturated it only
skips reserve/flush for that connection; ingestion and the desktop continuous sibling continue; drained only
restores that connection; closed clears the pause and unsubscribes via the owned registry.

Client apply rules:

1. Replace the whole snapshot after complete assembly; never merge.
2. Late/duplicate frames with `toSeq <= localSeq` are silently dropped.
3. When `fromSeq != localSeq`, start only one in-flight `v4/conversation/resync` per subscription; the owned registry decides topic/profile and the client cannot override.
4. A recovery flight lasts until the logical frame is applied; resuming a gap once upgrades to `forceSnapshot` within the same flight; do not clear the flight at ACK or resume forever.
5. After an attachment rebuild or a CLI `logEpoch` change, automatically re-subscribe all active topics.

The `logEpoch` in the subscribe ACK is only admission metadata and creates no base; an existing projection may
be kept only when `ACK=resume` and the epoch is the same; `ACK=snapshot` invalidates it into a complete
snapshot apply. A delta without a valid base is not applied; faults/overflows must send `base:null +
forceSnapshot:true`; a complete online snapshot can still build a base. If no complete recovery logical frame
arrives within 30 s after the ACK, the resume upgrades to a force once; if the force also times out, the UI
shows an explicit ERROR and the task-index topic does a local fresh subscribe. After the recovery apply, a
residual online gap in the same batch starts a successor flight.

Conversations, sessions-index and workspace-config use independent water levels and recovery flights; a
gap/fault in one mobile topic must not pause desktop siblings or clear healthy index/config topics. A runtime
restart only invalidates the old runtime/subscriptions; the Local/Remote Host frame emitters carrying that
workspace scope stay alive so existing listeners drive a full re-subscribe; true workspace teardown releases the emitter.

## Blocking events and owner routing

Permissions, elicitation, terminal and snapshot invalidation block the runtime or determine UI focus; they
must be visible to online connections of the same task through owned subscriptions, or trigger snapshot
alignment, and must not be swallowed by ordinary owner-only content filtering.

Commands routed to the runtime owner: `stop_generation`, `respond_permission`, `respond_elicitation`, and
remote workspace / bot / proxy fallback conversation commands. Owner commands must carry `workspacePath`,
optional `workspaceIdentity`, `workspaceKey`, `taskId` and the current `runId`. Main finds the lease by
`workspaceKey + taskId` and rejects stale runs. The shared-host main path usually hits the same host manager
directly, but that does not justify removing owner/lease: remote workspace proxies, cross-host owners,
bot/proxy and blocked responses still depend on it.

## Canonical input queue

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

Mobile V4 bypasses the host runtime command queue of `IZCodeTaskService.enqueueTaskCommand`; desktop accepted
busy inputs no longer stay in a renderer-local queue. The owner route only delivers the command to the right
CLI and does not change CLI admission order. Each `ConversationInputIntent` self-containedly keeps
`sourceCommandId`, `queueItemId`, `clientId`, kind, original text, attachments, delivery, order and steer/dispatch status.

When guide does not apply, with attachments, compact/verifier busy, or runtime steer rejects, fall back to the
ordinary queue with the original fields. Empty, over-limit or runtime-rejected input returns explicit
`rejected/failed`; the UI keeps text and attachments. `editQueueItem` updates in place, keeping the ID,
position, attachments and source command.

`sendQueuedNow` always runs:

```text
reserve(item) -> stop barrier -> start/promote(item) -> remove(item)
     |                                  |
     └─ timeout/failure -> release ─────┘  # the original item is kept in place
```

Multiple endpoints or consecutive clicks on the same item have exactly one reservation owner.

## ACK reconciliation and process restart

After a QueueItem appears, the UI keeps the 24-hour pending-command record until it enters the transcript or is
cancelled, fails or is discarded. Regular text/goal payloads can be saved and resent; sensitive interactions
save only a digest. When an ACK is lost or on reconnect, the UI calls `commands/query`, at most 64
`{sessionId, commandId}` at a time. The CLI lookup order:

```text
in-flight pinned -> live queue/guide pinned -> settled LRU (512/session)
  -> transcript / message anchor sourceCommandId
  -> timeline marker sourceCommandId
  -> fork child metadata sourceCommandId
  -> discarded input ledger
  -> unknown
```

Queries and executions of the same key are single-flight, avoiding duplicate side effects from the async dedup
window. `commands/query` and execute share `keyGate(sessionId|null, commandId)`; new commands take the
per-session admission gate in a fixed order. In-flight and live inputs do not take part in LRU eviction; only
settled commands can be evicted and sourced back; admissions of one session are serial and different sessions
run in parallel. The persistent index is built lazily per session, updated incrementally and isolated by
`workspaceIdentity?.trim() || workspacePath`; a full transcript scan per query is forbidden.

Queues are reliable only within the current CLI process. After a CLI restart, admitted inputs that have not
reached the transcript/terminal state return `fault.command.inputDiscardedOnRestart` plus the persisted
`delivery`: `queue/guide` settles silently once the old runtime is invalid; only `startNow` or `unknown` not in
the transcript prompts the user to confirm resending; automatic recovery or replay is never attempted. Ordinary
network disconnects still recover the current runtime's authoritative queue from the replayable snapshot; the
relay, main and host never cover boundaries with private queues.

## Running stable fork

While the primary turn, foreground subagent, goal continuation or goal verifier is running, the last completed
assistant segment of an earlier `completedSuccess` product turn can be forked; compaction remains the
operation lock. The running fork copies only the stable transcript, fork-point configuration and goal state
before the fork point; it copies no queue, active/background work or continuation inbox, does not rewind the
shared workspace, and the parent keeps running as is. Retrying the same `sourceCommandId` returns the same
child. The existing workspace checkpoint behavior for completed/idle is not expanded here.

## Implementation boundaries

- `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts`: mobile attaches to the existing host.
- `packages/desktop/src/host/windowRemoteConnectionRegistry.ts`: authority for remote connections/logical sessions within a window.
- `packages/desktop/src/host/windowHostAttachmentRegistry.ts`: trusted clientMode and scoped attachment lifecycle.
- `packages/desktop/src/main/taskRealtimeBus.ts`: owner lease, stale-run and cross-host routing.
- `packages/shared/src/zcode-protocol-v4/`: V4 wire, topics, commands and runtime schemas.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`: gateway, publishers, projections and CommandInbox.
- `packages/services/src/zcode-agent/`: connection-scoped V4 service facades.
- `packages/ui/src/v4/`: owned subscription client apply, pending-command reconciliation and projection stores.

Relay/main must not add session/task streams, queues, snapshots or fork business state; such state must be
recoverable from the CLI projection/event log and command lookups.
