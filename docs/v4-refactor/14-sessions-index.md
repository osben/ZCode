# sessions-index topic: Current Spec

Updated: 2026-07-22

`sessions-index/<workspaceId>` is the data source of session liveness and live detail for the sidebar and task list. The set of persisted task rows is decided by `tasks-index.sqlite`; a missing summary only means live detail is not yet available and the left-side row must not be deleted because of it. The schema is in `packages/shared/src/zcode-protocol-v4/sessions-index.ts`; the CLI projection/publisher and the UI store/transport are in the main chain.

## Positioning

1. CLI-authoritative, client read-only: the list no longer scans conversation rows to derive session state; this authority covers only session activity and detail fields, not the existence of persisted task rows.
2. Per workspace: `workspaceId = workspaceIdentity?.trim() || workspacePath`.
3. Conflated latest state: consecutive updates of one session keep only the last summary; after a disconnect recovery is by snapshot, not treated as a complete event log.
4. Orthogonal to the conversation topic: the index gives list summaries, `conversation/<sessionId>` gives full rows, config, control and actions.

## Schema

`SessionSummary` currently contains session identity, workspaceId, phase, title and title source, parent session, creation/activity times, a usage summary, and lightweight permission/user-input counts. It must not carry a full interaction payload, conversation rows or tasks-index organization state.

Frames follow the V4 topic five-piece set: subscribe / unsubscribe; snapshot; delta (`session.upserted` / `session.removed`); seq/logEpoch; resync.

Schema boundaries:

1. **sessions-index contains only pure session state** and **not pin/archive/groups**: organization state (the user's marks on the list) goes through the slim CRUD (pin/archive/groups) of the host-side tasks-index.sqlite and is **client-joined** in the sidebar state layer (M5 (2)); it does not enter this topic and does not break the schema freeze.
2. **Unread is not in the schema**: unread belongs to tasks-index organization state, queried in parallel with pin/archive as `unreadAt` and joined on the client; `lastActivityAt` only serves activity sorting and must not be modified by unread reads/writes.
3. **Scheduled-task identity is not in the schema**: `cronAutomationId` is tasks-index persisted metadata, with `tasks.meta_json` / `cron_automation_id` remaining authoritative. Every sessions-index-derived list must back-fill this field by `taskId` at the client membership join, so workspace, grouped, timeline and pinned/archived rows judge the clock icon uniformly; relying on `SessionSummary` alone is forbidden, as is breaking the frozen schema for this.
4. **Blocking interactions enter only a lightweight summary**: the sidebar needs permission/userInput attention synchronously but does not subscribe to full conversation rows. The summary carries only an optional kind/count summary; the full pending-interaction payload belongs only to the conversation snapshot.
5. **archived does not enter sessions-index**: archived rows and section membership come from tasks-index, and the client then joins the available session detail.

A draft prewarm session is filtered by the gateway's `isDraftSession` and does not enter the sidebar; the event fan-out adds it to the index only after the first input promotes it to a real session.

## CLI write side

```text
session runtime/product projection event
  -> SessionsIndexProjection.deriveSessionSummary
  -> SessionsIndexPublisher upsert/remove
  -> conflation + seq/logEpoch
  -> owner subscription wire frame
```

### Event fan-out pacing

By default every session event fans out once: if the summary changed it is flushed immediately to list subscribers. High-frequency event streams must be throttled first, otherwise list subscribers recompute task rows at event frequency:

1. `ModelStreaming` (streaming body increments) never triggers a list recompute; the preview updates at turn closeout or other events.
2. `DynamicWorkflowRunProgress` (workflow run progress, up to hundreds per second in one run) is throttled by a leading + trailing window: the first after quiet publishes immediately, and later progress within the `WORKFLOW_PROGRESS_INDEX_FANOUT_MS` (250ms) window merges into one publish at the window end. The sidebar run row (`workflowActivity`) therefore refreshes at no more than 4Hz, and the run terminal state is still delivered within one window.
3. Other events publish immediately. Any immediate publish inside a window satisfies and cancels the pending trailing one, with no duplicate frame.

The throttle changes only frame pacing: `record.updatedAt` / `lastActivityAt` semantics and delta order are unchanged. The window timer is held per session; session cleanup and gateway dispose must clear it, and it must not keep the process from exiting.

A cold subscription first builds a lightweight summary from the persisted session store and then overlays it with the live projection of currently registered sessions. When reading a remote workspace the full identity must be resolved to the actual directory execution path while filtering exactly by the full `workspace_id`:

1. A local session keeps using path + `workspace_id is null`.
2. A remote session writes the full `workspaceIdentity`.
3. Old `workspace_id is null` data must not be auto-claimed into a remote identity by the same path alone.
4. Different SSH/WSL/Docker identities on the same path must not appear in each other's index.

### 3.3.6 SSH/WSL historical session upgrade compatibility

When 3.3.6 created remote sessions, the CLI session store did not yet persist `workspace_id`, while the remote host's `tasks-index.sqlite` already isolated tasks by the full `workspaceIdentity`. So on the first SSH or WSL `sessions-index` subscription in 3.4+, the host may pass verified `taskId`s of the current identity's task index as a bounded allowlist with subscribe. The CLI may do a one-time ownership migration only for a session that meets all of:

1. `session.id` is in the allowlist the host provided;
2. `session.directory` is exactly equal to the actual path resolved from the identity;
3. `session.workspace_id is null`;
4. the current topic is a legal remote workspace identity.

The migration must atomically write the current full `workspaceIdentity` and then build the snapshot under the normal strict identity condition. A session already carrying another identity must not be overwritten; a local-path subscription must not consume the allowlist; an empty allowlist must not degrade to claiming by path. The host reads the allowlist from tasks-index by the exact `workspaceKey`, takes only undeleted GLM tasks, and limits it to the cold-seed cap of one sessions-index (to avoid cross-reading different SSH authorities on the same path or unbounded protocol-frame growth). If reading tasks-index fails the old-data migration must be abandoned and the strict identity subscription continues; compatibility logic must not block the current session list.

The migration opportunity must not be tied to the first construction of the `sessions-index` publisher. Cold seeding and migration for the same `workspaceId` must be serialized; any later subscription carrying a non-empty allowlist must re-run the idempotent claim and, after the claim, re-read the store by strict identity. The re-read must complete even if this time `claimedCount = 0`, since a previous run may have claimed successfully but failed before reading or merging summaries. After a successful read, previously missing summaries must merge into the existing publisher and be pushed to existing subscribers as a normal `session.upserted` delta; a migration or read failure may only let this subscription keep the current strict snapshot and must leave no "migrated" mark, so a later allowlist-carrying subscription can retry. The re-read only adds store summaries missing in the publisher; existing live or old-seed summaries continue to be updated by the normal event projection and must not be downgraded by cold-store defaults.

```text
same-workspace subscription A (no allowlist) -> strict read / initialize publisher
                                      |
                                      v (serialization boundary)
same-workspace subscription B (allowlist)    -> idempotent claim -> strict re-read -> merge + delta
```

A local workspace does not consume the allowlist, does not enter the migration branch above, and keeps the existing query and publisher lifecycle semantics of `workspace_id is null + directory`.

3.4.2 wrongly parsed a WSL identity with an explicit user (`remote:wsl:<distro>:<user>:<path>`) as the execution path, so the `directory/path` of some persisted sessions was written as the identity itself or as `<workspacePath>/<workspaceIdentity>`. Cold recovery must repair these deterministic, reversible historical shapes before materializing the runtime:

1. When `workspace_id` exists, accept only a legal remote identity and restore the two polluted shapes above to the `workspacePath` the identity resolves to; normal paths and legal subdirectories are not rewritten; data containing the identity but not matching a known shape fails closed.
2. When `workspace_id is null`, only a legal identity of the currently recovered workspace that can fully prove itself from the polluted shapes qualifies; the repair must atomically write `workspace_id + directory + path`; after a write miss it must re-read, and may continue only if a concurrent request already wrote the same identity and real `directory/path`, otherwise it fails closed with a recoverable session corruption and the runtime must not be materialized.
3. A path repair for an existing identity must use a narrow CAS updating only `directory/path` and a monotonic `time_updated`, never reusing the general `updateSession` that would write back concurrent facts such as title, summary, permission, revert and archive; on a CAS miss re-read and re-rule, and a transient write exception may continue this recovery with the same deterministic in-memory result while keeping later retry chances.
4. The repair must not depend on client mode and must not change the message-recovery boundary of desktop `continuous` and mobile `replayable`.

```text
host task allowlist + clean path + null identity -> atomic claim -> strict sessions-index read
known polluted path + proven remote identity     -> path repair -> runtime materialize -> resume
unknown/mismatched shape                         -X-> no claim / fail-closed
```

remote identity parsing must fail closed: any workspace id starting with `remote:` that does not match the unified parser must not fall back to a local path. This repairs the wrong-persistence root cause of 3.4.2, rather than adding a fallback at the send button.

Entry points:

- `packages/services/src/zcode-agent/zcodeAgentService.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-publisher.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-publisher-registry.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`

## UI read side

`agentSessionsIndexTransport` hands the service's V4 frames to `SessionsIndexStore`. The store applies snapshots atomically and requires contiguous deltas; a gap, runtime generation change or wire assembly fault triggers recovery, and failed recovery fails closed.

The task-list subscription uses the `existing-only` runtime policy. Scope acquire only registers the observation relation; while the workspace Agent is not yet running, the store enters `dormant`, does not spawn, does not count as hydration and does not treat the earlier live summary's `running` as the current activity. Persisted rows continue to be displayed by tasks-index. Only after an explicit draft prewarm, opening a session, sending a command or another real running entry publishes runtime available does the dormant store fresh-subscribe. The Host task-index syncer's dormant state, on the first available, must first idempotently install the workspace-level sessions-index/workspace-config frame listener and only then subscribe, so an initial frame arriving in the same stdio read after the ACK promise resolves but before the await continuation / subscription ownership takes effect is not lost. Later runtime generation changes reuse the same listeners and only resubscribe; after runtime unavailable, subscriptions and retries are revoked and the store returns to dormant.

```text
restored inactive workspace -> tasks-index row + dormant observer -X-> Agent spawn
explicit runtime operation  -> runtime available -> install listener -> fresh subscribe -> live detail
runtime unavailable         -> clear live ownership/retry -> dormant -X-> implicit restart
```

`start-if-needed` is kept only for entries with explicit user/system execution intent; task-list, grouped/timeline/pinned/archived consumers and the Host task-index syncer must not use it. Runtime lifecycle and subscriptions are isolated by `workspaceIdentity?.trim() || workspacePath`.

Main's local cold-start prewarm list is a different explicit system intent: when restoring multiple local workspaces it selects only the last-activated workspace (cap 1) and hands it to the same Host with the first `InitLocal`. The Host reuses the existing full `initializeWorkspace` path for that target; `recentProjects` and other restored workspaces stay dormant. A prewarm failure is not backfilled by another workspace, a renderer reload only reattaches the existing Host, and remote shared-host/mobile attachments neither consume nor extend this local list.

Multiple consumers of the same endpoint + workspaceKey share the store/subscription through `sessionsIndexRegistry` with reference counting. Multi-endpoint aggregation reconciles scopes differentially with `workspaceSessionsIndexSubscriptionSet`:

```text
existing local-A + remote-A
  -> add remote-B: keep A's store/subscription, acquire only B
  -> remove remote-B: release only B
  -> service generation change: replace only the affected scope
```

This rule avoids tearing down an already-ready list while a new remote endpoint hydrates. A remote pane must use its own endpoint service and must not query the local `__base__` for same-path sessions.

Entry points:

- `packages/ui/src/v4/agentSessionsIndexTransport.ts`
- `packages/ui/src/v4/sessionsIndexStore.ts`
- `packages/ui/src/v4/sessionsIndexRegistry.ts`
- `packages/ui/src/v4/useSessionsIndex.ts`
- `packages/ui/src/v4/useWorkspaceSessionsIndexItems.ts`
- `packages/ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts`

## Join with tasks-index

tasks-index provides the persisted base task rows and the following organization state; sessions-index only overrides the live fields it hits by `workspaceKey + taskId(sessionId)`: pinned / archived / group membership; unreadAt; the search text or slim metadata needed by compatible list queries.

The client projection uses the task-index row as the left table: when a summary hits it fills phase, lastActivityAt, background work, pending interaction and the session title; when the summary is missing it keeps the persisted row and forbids deriving a spinner from a historical `status=running`. A newly created task not yet persisted is shown temporarily only through the renderer's existing optimistic/live overlay.

An organization-state mutation does not change sessions-index, so `taskListMembershipVersion.ts` explicitly triggers a membership refetch; it must not wait for a nonexistent index delta. Task creation also changes tasks-index's forward row set: the Host emits `task_created` after the task row and the grouped initial order are committed, and the renderer must use that event to roll the task-row/membership read generation. Updating only session activity is not enough, otherwise an old membership Promise keeps the new row out of Project/Timeline/Grouped after it is persisted.

## Recovery and multi-end boundary

1. Desktop online continuous and mobile replayable recovery may consume the same index authority, but each attachment has independent subscription ownership and recovery state.
2. relay/main do not cache the index and do not broadcast one client's saturated/resync state to other clients.
3. A snapshot is a wholesale replacement for the current workspace; frames of an old generation must be dropped.
4. The index seq serves subscription continuity only and is not a permanently replayable business history.

## Test boundary

Evidence should come at least from these layers: shared (session summary / snapshot / delta / topic schema and wire codec); CLI (projection derivation, publisher conflation, cold seed, draft filtering, remote identity); UI (snapshot/delta/gap, store reference reuse, multi-endpoint differential lifecycle, list join); WDIO (list visibility after create, open, rename, archive/delete, and remote scope not crossing lines); process lifecycle (when a single window restores multiple local workspaces, only the one active workspace selected at startup may be explicitly prewarmed as a runtime; expanding any task-list view must not increase the Agent count; a workspace outside the list can start only via an explicit open/send/background-task entry, and after runtime unavailable the passive observer must not pull it up again).

Only existing tests in the coverage matrix count as automatic coverage; a historical M5 list or suggested file names cannot replace test evidence.
