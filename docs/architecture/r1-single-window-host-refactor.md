# R1 Single Window-Scoped Host Process Refactor Specification

## 1. Status and Scope

- Status: In progress
- Phase: Remote architecture refactor R1
- Release approach: atomic switch in a single version; do not retain both old and new architectures
- Core goal: each `BrowserWindow` has exactly one window-scoped Local Host, which centrally hosts local services, remote connections, window-level task projections, and client attachments
- Explicitly excluded: standalone Server CLI, `sourceServerId`, Connection Profile, Transport Adapter, a new remote wire contract, and cross-remote Grouped capabilities; these are deferred to R2/R3/R4 respectively

This is the implementation specification for R1. Current Web remote-control facts remain defined by the architecture, realtime-sync, and task-command-queue documents under `docs/web-remote-control/`; update those fact documents when this specification is complete.

## 2. Decisions

| Decision                  | R1 conclusion                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Host aggregation boundary | Host owns workspace/task membership, online/running/waiting facts, and list-write routing; Renderer owns display preferences only       |
| Process boundary          | One Local Host per window; UI, mobile, and Bot no longer create separate Remote Hosts                                                   |
| Port topology             | The same Local Host exposes the base port and multiple remote-scoped ports                                                              |
| Connection entry point    | Keep `IPlatformService -> Main`; Main only forwards requests, status events, and MessagePorts                                           |
| Remote Host consolidation | Consolidate all Desktop Remote Hosts created by UI, mobile, and Bot                                                                     |
| Projection persistence    | `ControllerProjection` stays in memory and can be rebuilt from a source; add no database                                                |
| Remote protocol           | Do not modify existing zcode-server service channels for SSH/WSL/Docker/Server                                                          |
| List-write routing        | Controller routes cross-workspace list operations; after entering a workspace/conversation, continue using the scoped facade            |
| Realtime Host identity    | One `hostId` per window, routed internally by `workspaceKey + taskId`                                                                   |
| `remoteSessionId`         | Allocated and managed by Local Host; Main stores only async request-correlation data                                                    |
| Disconnected lists        | Retain the last trusted task projection and mark it offline; prohibit writes and local fallback; replace atomically after reconnect     |
| Rollout and rollback      | Gradually roll out the Desktop version; rollback by reverting to the old Desktop version, without database or remote-protocol migration |

Existing invariants:

- The lifecycle of the SSH online-window cache, WSL TTL/task protection, and Docker/Server dedicated sessions remains unchanged;
  only when the last SSH pending waiter explicitly cancels may the connecting entry that is not yet ready be retired and its exclusive initialization aborted.
- Identity isolation consistently uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`; path IO continues to use `workspacePath`.
- Desktop `continuous` and mobile Web `replayable` queues, `seq`, gap handling, and recovery boundaries remain isolated.
- Main and Relay do not own business state such as sessions/tasks, streams, queues, or snapshots.
- A passive task-list observer must not start or reconnect a remote runtime.
- Grouped covers local workspaces only; R1 does not add remote tasks to local groups.

## 3. Process and Responsibility Model

Before the refactor:

```text
Renderer ─┬─ base port ────> Local Host ─────────> Local CLI
          ├─ remote port ──> SSH Remote Host ────> zcode-server
          ├─ remote port ──> WSL Remote Host ────> zcode-server
          └─ remote port ──> Docker/Server Host ─> remote service

Mobile -> Relay/Main -> Local Host or standalone Remote Host
Bot ---------------------> temporary Remote Host
```

R1:

```text
Renderer ───────────────────┐
Mobile -> relay/Main ───────┼─> WindowHostRuntime (one Local Host PID per window)
Bot/background entry ────────────────┘       │
                                    ├─ LocalSource -> Local CLI
                                    ├─ RemoteConnectionRegistry
                                    │    ├─ SSH pooled connection
                                    │    ├─ WSL pooled connection
                                    │    └─ Docker/Server logical connection
                                    ├─ ControllerProjection
                                    └─ AttachmentRegistry
                                         ├─ desktop-continuous
                                         └─ web-remote-replayable
```

Main remains responsible for creating/destroying windows and Host processes, native APIs, creating MessageChannels, and forwarding messages, but no longer owns remote connection pools, logical sessions, task projections, or running-task state. Window close and App quit wait only for the sole Local Host; the Host releases remote resources within a bounded time.

## 4. Host State Hierarchy

```text
WindowHostRuntime
├─ LocalSource
├─ RemoteConnectionRegistry
│  ├─ ConnectionEntry
│  │  ├─ redacted target
│  │  ├─ connection / service collection
│  │  ├─ readiness / lifecycle / generation
│  │  └─ logical remote sessions
│  └─ workspaceKey -> connection / session route
├─ ControllerProjection
│  ├─ workspace / connection facts
│  ├─ task-index membership / metadata
│  ├─ sessions-index live overlay
│  └─ offline snapshot retention
└─ AttachmentRegistry
   ├─ attachmentId
   ├─ trusted clientMode
   ├─ local / remote scope
   └─ independent subscription / seq / backpressure / disposal
```

Connection states:

```text
absent -> connecting -> online -> closing -> absent
                |          |
                v          v
             failed     disconnected
                              |
                              v
                         reconnecting
```

`reconnecting` indicates only recovery of an existing connection or an explicit user reconnect; R1 adds no background auto-retry policy. Connection cancellation, late completion, and repeated disposal must be idempotent; async results from an old generation must not overwrite a new connection.

SSH pending cancellation follows these fixed boundaries:

```text
SSH connecting entry
        |
        +-- other waiters remain ------> retain entry / backend; do not interrupt the shared connection
        |
        +-- last waiter cancels ------> retire entry by object identity -> abort exclusive backend/deploy
                                              |
                                              +-> a new request for the same target creates a new entry / uses new credentials

WSL / Docker / Server pending cancel --------> retain the existing transport lifecycle; do not trigger a lower-level abort
SSH online cache cancel ----------------------> retain the window cache; do not destroy the online connection
```

An SSH remote owner staging area may already have been created when cancellation occurs. Once the old backend enters the disposal barrier, it must not reconnect for cleanup
for a cleanup reconnect. The next SSH deployment using a new backend runs a best-effort janitor before writing, deleting only ZCode-owned
UUID-named staging entries older than 24 hours. The current owner, canonical paths, and WSL/Docker/Server staging are outside this
cleanup boundary.

On remote disconnection:

```text
online snapshot
      |
      v disconnect
offline frozen snapshot --x mutation / local fallback
      |
      v reconnect + source snapshot
atomic replacement -> online snapshot
```

- Retain the logical session's most recent trusted task projection and mark it `sourceAvailability=offline`.
- Fail conversation/file/git/terminal operations and all writes immediately; do not fall back to local services.
- Clear the in-memory projection after the user closes the corresponding tab/history scope.
- Do not restore this in-memory snapshot after an App restart; keep the existing behavior where remote history waits for the user to reconnect.

## 5. Main and Host Control Protocol

Control messages use strict runtime schemas; every asynchronous request carries a `requestId`:

- `ConnectRemoteWorkspace`
- `CancelRemoteWorkspaceConnect`
- `BindRemoteWorkspaceContext`
- `DisposeRemoteWorkspaceSession`
- `AttachServicePort`
- `RemoteWorkspaceConnectionLog`
- `RemoteWorkspaceConnected`
- `RemoteWorkspaceConnectFailed`
- `RemoteWorkspaceClosed`

Local Host allocates `remoteSessionId` during connection setup and returns a descriptor. Main correlates the caller only by `windowId + requestId` and forwards completion/failure/close events when received. It does not use `remoteSessionId` to create a connection pool or business lifecycle.

Local Host reports remote-connection progress as structured `RemoteWorkspaceConnectionLog` entries containing at least `requestId`, `level`, and `message`. Main forwards logs only to the Renderer associated with that `windowId + requestId`; it must not infer ownership from a Host process label or stdout without request context. This prevents logs from being misrouted to another connection dialog when one window Host connects to multiple remote targets concurrently.

Attachment scope:

```ts
type WindowHostAttachmentScope =
  | { kind: "local" }
  | {
      kind: "remote";
      remoteSessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    };
```

The Host must validate the session, identity, path, and current registry generation in the scope. Fail closed if a remote scope lacks identity, references a released/old generation, or crosses logical sessions.

After R1 is complete, remove the old initialization protocol and responsibilities:

- `InitRemote`
- `InitRemoteWorkspace`
- `InitRemoteSshHost`
- `InitRemoteWslHost`
- Main-driven WSL acquire/release
- Remote Host process map, pool, and separate shutdown barrier

## 6. Scoped Attachments and Trusted Client Modes

```text
Desktop renderer port
  attachment context = desktop-continuous
       |
       +--> local or remote scope --> scoped facade

Mobile relay port
  attachment context = web-remote-replayable
       |
       +--> local or remote scope --> scoped facade
```

- Always remove `clientMode`/`deliveryKind` from caller payloads; the Host injects them from trusted attachment context.
- Each port independently maintains subscriptions, `seq`, backpressure, and disposal; slow mobile consumption must not block the desktop realtime path.
- Disconnecting an attachment releases only that attachment; do not destroy the connection while a workspace tab, mobile owner, Bot, or another attachment still uses it.
- A Renderer reload rebuilds only the attachment and reuses the existing Local Host, registry, and logical sessions.
- `remoteSessionId` is used only for source routing within the window; it does not replace `workspaceIdentity`.

When a remote directory is bound from the connection root to a canonical workspace, the desktop attachment must switch in two phases:

```text
old attachment A (registered by the Renderer)
        |
        v
Host binds the canonical context and invalidates A under the new generation
        |
        v
Main creates candidate attachment B and delivers its port to the Renderer
        |
        v
Renderer registers B's services and returns attachment-ready(B)
        |
        v
Main promotes B to the current Renderer attachment
        |
        v
BindRemoteWorkspaceContext IPC returns; the caller reads B's services again
```

- `BindRemoteWorkspaceContext` completion semantics visible to the Renderer means “the Renderer has registered the new port,” not “Main has delivered the port.”
- Host generation changes remain fail-closed and allow a bounded unavailable window between A and B; the caller must not continue RPCs to A before bind returns.
- Do not promote B to the current attachment if delivery fails, readiness times out, or an expired ACK arrives. Reclaim candidate B on failure; the connection, binding, or reload caller then releases or retries the logical session according to existing policy.
- After readiness, the caller must not continue using services from A captured before binding; it must reread B from the Renderer session store using the same `remoteSessionId`.
- Attachment replacement changes only the desktop `desktop-continuous` port. It does not create a Host, remote connection, or Agent, and does not touch mobile/Bot `web-remote-replayable` attachments.

## 7. Controller Projection Protocol

Window-level V4 topics:

- `controller/workspaces`
- `controller/tasks-index`

Both topics provide `subscribe` / `unsubscribe`, `snapshot` / `delta`, `seq + logEpoch`, and resync after gap detection.

```text
task-index (membership left table)
             |
             +-- sessions-index live overlay
             |
             +-- source availability
             v
        controller task row
```

`ControllerProjection` stores only workspace/connection facts, task membership/metadata, live overlays, and offline summaries; it does not store conversation rows, streams, permission payloads, tool payloads, or runtime snapshots.

Host Controller maintains a passive `runtimePolicy: existing-only`
`sessions-index` subscription for each source, combining title, phase, pending-interaction, and activity summaries as an in-memory live overlay
with task-index membership. Live state is not written back to SQLite, preventing a false running state from remaining after process exit.
The subscription observes only existing runtimes; opening a list must not start a local Agent, create a remote runtime, or trigger remote reconnection.
When a runtime becomes unavailable or is replaced, clear that source's live overlay and atomically replace it when a new snapshot arrives.

Renderer maintains only one window-level shared subscription each for `controller/workspaces` and `controller/tasks-index`.
Requests to `listTaskList` with the same projection revision and query parameters must be single-flight and reuse results. Do not let each
`useGlobalTaskList` call site subscribe independently and repeat a full read on the same frame.

Shared-subscription invalidation must be scoped to queries, rather than clearing all list caches whenever any Controller frame arrives:

- `controller/tasks-index` snapshot, gap resync, or a delta whose old row cannot be identified may conservatively invalidate the relevant scope;
- An upsert/remove with known old/new rows invalidates only matching workspace scopes and queries whose `kind` intersects membership before or after the change;
  for example, a live/activity change in a timeline task must not also refresh pinned/archived;
- `controller/workspaces` maintains only workspace facts/cursors and does not directly invalidate the task list. Source online/offline changes, removals,
  and reconnects that affect visible list rows must also publish a `controller/tasks-index` delta;
- Manual refresh and legacy task-list versions during the compatibility period may still force a query-cache bypass;
- Related deltas arriving in the same Renderer scheduling cycle may be coalesced with a bound, but unbounded debounce must not delay
  desktop continuous list state.

```text
controller/tasks-index delta
          |
          v
  matches workspace scope? -- no --> retain this query cache
          |
         yes
          v
     known old row? -- no --> conservatively invalidate all kinds for this scope
          |
         yes
          v
old membership kind ∪ new membership kind
          |
          v
invalidate only intersecting query caches --> coalesce into one Renderer revision per scheduling cycle
```

Task address:

```ts
interface WindowHostTaskAddress {
  remoteSessionId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}
```

Read scope:

- Timeline, Pinned, Archived, Active, and Search aggregate current local and connected/temporarily offline remote scopes.
- Search queries online sources only; offline sources may show existing summaries but must not fabricate new search results.
- Grouped continues to use membership/order from the local task index and consumes only local task facts provided by Controller.
- WSL connections continue to be reused per distro/user within a window; closing a logical session releases only the corresponding workspace runtime.
  If tasks are running, release is delayed until the count reaches zero. A quick reopen uses the workspace generation to invalidate an old release that has not started;
  a new attachment waits inside the Host until an in-flight release completes.

For list-source writes, Controller resolves the unique source before executing: pin/unpin, archive/unarchive, delete/restore, mark read/unread, local grouped membership/order, and opening/restoring a task from a list. Fail explicitly when offline, when identity does not match, or when the address is ambiguous; do not try local fallback.

Cross-workspace list operations must not reuse the ambient scoped facade captured when the initiating component rendered. If the target is a local workspace,
start from the window base attachment and let Controller resolve the unique local source. If the target is a remote workspace,
use the exact `remoteSessionId` attachment for the target tab. If the target remote is disconnected, fail and roll back optimistic state; do not fall back based on
the same `workspacePath` to the base/local or another remote attachment.

```text
Renderer (may still hold an old remote ambient facade)
          |
          v
activate the target tab first, then read workspaceIdentity + remoteSessionId
          |
          +-- local target  --> window base attachment --> Controller's unique local source
          |
          +-- remote target --> exact remoteSessionId attachment --> corresponding remote source
                                  |
                                  +-- session disconnected --> roll back; do not fall back
```

After entering a workspace/conversation, files, Git, terminals, Agent/sessions, and similar capabilities are still accessed through the validated scoped facade; do not expand them into explicit Controller routing.

## 8. Realtime Boundaries

- One WindowHostRuntime registers only one realtime `hostId`.
- Continue isolating owner/lease/stale-run/session routing by `workspaceKey + taskId`; do not remove owner checks because of shared-Host consolidation.
- Desktop remains direct continuous; do not append replayable runtime-recovery messages.
- Mobile Web must use the replayable gap/snapshot recovery boundary; it must not bypass recovery and consume desktop continuous directly.
- Bridges, snapshots, queues, owner commands, caches, and deduplication keys for remote workspaces must carry `workspaceIdentity` and `remoteSessionId`.
- Submitted busy/running input from desktop and mobile enters the CLI/runtime `CommandInbox`; FIFO follows the CLI serial
  admission order. Renderer retains only unsubmitted drafts and the pending optimistic overlay; the Host's
  owner/lease handles routing only and does not store a second accepted-input queue.

## 9. Remote RPC Compatibility Layer

R1 wraps existing remote service channels with `LegacyRemoteWorkspaceRpcContract` for typing and channel-integrity validation, but adds no handshake, version negotiation, remote deployment requirement, or persistent field.

- Files, Git, terminals, and Agent/sessions are provided by the remote authority.
- Desktop app-global services are provided by the local authority.
- Lifecycle semantics for SSH window cache, WSL TTL/running-task protection, and Docker/Server dedicated logical sessions remain unchanged;
  Cancellation by the last waiter on an SSH pending connection is the only new lower-level abort boundary.

## 10. Implementation Slices

1. Start with the specification, feature graph, conversation case catalog, and coverage matrix; capture baselines for PID, connection reuse, reload, mobile attachments, and task lists.
2. First write contract tests for the control protocol, registry, scoped attachments, projections, and disconnect/recovery.
3. Move remote connections and logical-session/generation lifecycles into WindowHostRuntime.
4. Reduce Main to thin forwarding of requests, events, and MessagePorts.
5. Unify base, remote, mobile, and Bot as scoped attachments to the same Host.
6. Have Host aggregate task facts and list-write routing; make Renderer a consumer of the window projection.
7. Remove the old Remote Host architecture and complete logging, fact documents, all gates, and representative-path E2E coverage.

## 11. Acceptance Cases and Pruning

Acceptance cases are registered in group R1H of `docs/conversation-session-case-catalog.md`; the coverage matrix is in `docs/testing/conversation-session-e2e-coverage-matrix.md`.

Confirmed E2E pruning: SSH covers the complete representative path; dual windows and Renderer reload are covered separately; WSL, Docker, and Server transport differences are covered mainly by contract/integration tests plus platform smoke tests. Mobile-attachment and Bot reuse must assert that no extra Host/Agent is created. Grouped verifies only that local-only semantics have not expanded.

Gate order: focused tests, `pnpm test:unit`, conversation coverage audit, Desktop E2E typecheck, `pnpm typecheck`, `pnpm lint`, representative Electron E2E, container conversation E2E, platform smoke tests, and before/after comparisons of PID, connection count, task lists, routing, and shutdown residue.

## 12. Observability and Shutdown

- Process Monitor and lifecycle logs show the window Host PID and counts of connections, logical sessions, and attachments.
- Use production `info` for process, session, connection, and port startup/shutdown; `warn` for recoverable exceptions; and `error` for unrecoverable handshake/process errors.
- Per-item details at message-stream frequency, such as V4 frames, stream deltas, and tool updates, must use `debug` only.
- Window close/App quit must release connections, ports, and Agents within bounded time; failure or shutdown of one remote connection must not affect local or other remote connections.
