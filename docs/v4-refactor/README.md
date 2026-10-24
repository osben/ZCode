# V4 Conversation Architecture: Current State and Document Navigation

Updated: 2026-07-15

The V4 conversation main path has landed: the CLI maintains canonical facts, the command inbox and the product
projection; Host/relay forward connections and topics; renderer/web subscribe to the projection, send
commands, and keep only local UI state.

This directory mixes two kinds of documents:

- Current specs: schema, recovery, fault, sessions-index and so on still constrain the live code.
- Implementation trail: phasing, review and deletion/parity records document the migration rationale; legacy
  paths, line counts and "to be implemented" in their text describe the state at that time only.

For product semantics read [Conversation Product Protocol](../conversation-product-protocol.md) first; for the
system overview read [ZCode Protocol](../zcode-protocol.md) and [Message Flow](../architecture/message-flow.md).

## Current topology

```text
Electron / Web / mobile remote
  |-- SessionPane + read-only projection stores
  |-- command(commandId, clientId, baseRevision, payload)
  `-- local draft / scroll / focus / optimistic overlay
          |
          | @zcode/rpc MessagePort / remote attachment
          v
Host connection scope
  |-- trusted clientMode / connectionId
  |-- owned topic subscription routing
  |-- runtime generation / stale subscription cleanup
  `-- no conversation reducer or second queue
          |
          | @zcode/shared/zcode-protocol-v4 over stdio
          v
ZCode CLI
  |-- transcript + session metadata + goal facts
  |-- V4 command inbox / durable input admission
  |-- ProductProjection + SessionsIndexProjection
  |-- topic publisher: snapshot / delta / seq / logEpoch
  `-- runtime config, queue, interaction and active/background work
```

Mobile `/remote` connects through a shared-host attachment to the existing Local/Remote Host on the desktop
that carries the target workspace scope. The relay and desktop main only do authentication, pairing,
heartbeat and frame/app payload passthrough; they own no session, queue, snapshot or projection.

## Current invariants

- The conversation UI renders by projection rows and does not re-derive turn, timeline, endedness or action
  availability from a flat message array.
- A command uses the `commandId` idempotency identity and an optional `baseRevision`; ACK and the following
  projection have distinct roles.
- Each attachment/subscription has its own ownership, generation, seq and recovery; downstream frames go only
  to the owner port.
- desktop is continuous online delivery; mobile remote is replayable recovery. Both share CLI facts, but a
  recovery frame must not spread into the desktop online main path.
- A snapshot replaces atomically; deltas must be contiguous; a gap/epoch change triggers resync, and a late
  online frame must not overwrite while recovery is in flight.
- The session queue and interaction pending state live in the CLI; Host, relay and renderer build no second
  accepted queue.
- Identity/cache/topic isolation uses `workspaceIdentity?.trim() || workspacePath`; path execution still uses
  `workspacePath`, and remote links also carry `remoteSessionId`.
- `tasks-index` owns the persistent task row set and organizational state such as pin/archive/group/unread;
  `sessions-index` owns only list liveness and real-time detail summaries; the client does a field-level join
  with the task row as the left table.

## Current code entry points

| Layer              | Entry                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| V4 schema          | `packages/shared/src/zcode-protocol-v4/`                                                                    |
| UI transport/store | `packages/ui/src/v4/agentConversationTransport.ts`, `conversationProjectionStore.ts`, `sessionDataLayer.ts` |
| UI pane/commands   | `packages/ui/src/v4/SessionPane.tsx`, `ConversationComposer.tsx`                                            |
| Host/service route | `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`, `zcodeAgentService.ts`                    |
| CLI gateway        | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`                                     |
| CLI projection     | `product-projection.ts`, `sessions-index-projection.ts`                                                     |
| CLI commands       | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/`                                         |

## Document index

| Document                                                               | Current role                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [01-topology.md](./01-topology.md)                                     | Topology and responsibility design; read with the current overview   |
| [02-projection.md](./02-projection.md)                                 | Projection design and ruling basis                                   |
| [03-commands.md](./03-commands.md)                                     | command/ACK/inbox spec and unfinished items                          |
| [04-sync-and-recovery.md](./04-sync-and-recovery.md)                   | Topic subscription, seq, snapshot, recovery constraints              |
| [05-transport-and-backpressure.md](./05-transport-and-backpressure.md) | transport/wire/backpressure spec                                     |
| [06-ui.md](./06-ui.md)                                                 | V4 UI design and implementation trail                                |
| [07-persistence.md](./07-persistence.md)                               | canonical facts, projection rebuild and migration                    |
| [08-phasing.md](./08-phasing.md)                                       | Historical phasing and cleanup trail, not the current progress table |
| [09-protocol-schema.md](./09-protocol-schema.md)                       | Early schema design; yields to code and 10 on field conflicts        |
| [10-protocol-spec.md](./10-protocol-spec.md)                           | V4 field-level main spec                                             |
| [11-deletion-plan.md](./11-deletion-plan.md)                           | Historical deletion execution list                                   |
| [12-fault-catalog.md](./12-fault-catalog.md)                           | fault/reason code vocabulary                                         |
| [13-golden-test-mapping.md](./13-golden-test-mapping.md)               | Case to reducer/protocol/WDIO evidence mapping                       |
| [14-sessions-index.md](./14-sessions-index.md)                         | sessions-index current spec and implementation entry                 |
| [design-review.md](./design-review.md)                                 | Pre-migration code audit and risk trail                              |
| [review-meeting-brief.md](./review-meeting-brief.md)                   | Review-history input, not a current-state summary                    |
