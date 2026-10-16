# Task SQLite Index

## Scope

`~/.zcode/v2/tasks-index.sqlite` is the app/host-side index for task list queries. ZCode Agent owns core session content and runtime state; the sqlite index owns fast list metadata and product shell state.

The index is not a replacement for ZCode Protocol session snapshots.

## Library-Level Migrations (Todo109)

`tasks-index.sqlite` also holds Automation and Off-Peak tables. Three Repos reuse `runTasksDatabaseMigrations` before opening read/write access. The library-level `tasks_schema_migration` uses `BEGIN IMMEDIATE` for serial checking and applying migrations, rolling back on failure and recording no success.

`0001_adopt_task_schema` takes over eight existing tables, historical column additions, and indexes; `0002_provider_selection` consolidates decided-upon Automation conversions. From then on, only new migrations may be appended; published SQL, frozen conversion implementations, and their semantic versions must not be modified. Checksums cover declarative SQL, column lists, and conversion semantic versions — no function text that could be rewritten by bundlers.

```text
Any Repo first open → library-level ledger/transaction → all tables ready → Repos normal read/write
Other Repos / other processes → same ledger validation → skip applied versions
```

Old columns and timestamps are not overwritten by Provider conversions; normal Readers/dispatchers only use new columns.

JSON `null` for Automation explicitly means using default configuration; SQL NULL means configuration is missing and needs re-selection. Rollback-generated old and new format records are not caught up by re-running existing migrations; content must still be listable and openable.

Off-Peak missing Provider older selections do not query the current account to re-guess; they do not change Tickets or patch migrations at read time; missing configuration only affects subsequent execution eligibility. TaskIndex-related collection cleanup and projection maintenance do not belong to Provider conversions.

## Responsibilities

- Keep task list queries fast without starting every workspace agent.
- Persist product shell state such as title, pinned, archived, deleted, unread, and title override.
- Store a compact `ZCodeTaskMeta` snapshot in `meta_json` for list rendering.
- Store bounded searchable text for global task search.
- Keep remote workspace identity isolation consistent through `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

## Table

The `tasks` table is keyed by `(workspace_key, task_id)`.

Core columns:

- `workspace_key`
- `workspace_path`
- `workspace_identity`
- `task_id`
- `title`
- `task_status`
- `provider`
- `mode`
- `model`
- `migration_source`
- `forked_from_task_id`
- `created_at`
- `updated_at`
- `unread_at`
- `last_unread_at`
- `pinned`
- `archived`
- `deleted`
- `title_overridden`
- `searchable_text`
- `meta_json`

Indexes cover active workspace list queries, pinned list queries, archived list queries, deleted list queries, recent global timeline, and bounded text search.

## Runtime Rules

- Writes are serialized per `(workspace_key, task_id)` to avoid concurrent metadata overwrites.
- `unread_at` is the current unread membership/CAS marker. `last_unread_at` is an internal allocation watermark that survives clearing `unread_at`; repository writes allocate each new unread marker above that watermark so same-millisecond writes and clock rollback cannot reuse a stale compare-and-clear version.
- `unread_at` is authoritative over the copy in `meta_json`. Writes that do not explicitly mutate unread state must preserve the current row value at the SQLite conflict boundary, so a stale snapshot from another Host cannot roll back a newer marker.
- Every task-index connection uses a bounded SQLite busy timeout. Additive schema migrations are idempotent under concurrent Host startup: after lock contention, a duplicate-column result is accepted only when the column is present.
- `meta_json` is parsed with `zcodeTaskMetaSchema`; invalid rows fall back to scalar columns and log a warning.
- SQLite row columns are authoritative for entity coordinates: reads must overwrite `meta_json` values with `task_id` and `workspace_path`. Because `(workspace_key, task_id)` is the actual query/primary-key boundary, a valid remote `workspace_key` is authoritative over a missing or stale `workspace_identity` projection; non-remote rows use the identity column only when it equals `workspace_key`. This keeps list queries and sessions-index joins on the same isolation key without ever falling back to a remote path.
- `searchable_text` is capped so long tasks cannot grow the sqlite file without bound.
- Query scopes must pass `workspaceIdentity` for remote workspaces; `workspacePath` remains the execution/display path.
- Task-list queries and dynamic workspace-event listeners are passive observers. Registering either one must not start a workspace Agent runtime, reconnect a remote workspace, or promote a dormant runtime retry.
- The desktop Main startup warmup is an explicit lifecycle action rather than a task-list side effect. When multiple local workspaces are restored, it may start at most three deduplicated targets selected from the last active workspace and persisted recent-project order. A failed warmup does not pull in a fourth target.
- The task-index `sessions-index` / `workspace-config` ingestion subscriptions attach only after an explicit workspace operation has made that exact `workspaceKey` runtime available. Their subscribe and retry paths use an `existing-only` policy, so a stopped runtime returns to dormant state instead of being started by observation.
- Runtime availability is keyed by `workspaceIdentity?.trim() || workspacePath`. An available event for one SSH, WSL, or Docker identity must not attach observers belonging to another identity with the same execution path.
- The first authoritative `sessions-index` snapshot is a silent reconciliation boundary: non-draft sessions seed only missing task rows, existing product-shell state is never overwritten, and no per-row list-change broadcast is emitted. This keeps late attachment/reconnect safe without replaying historical terminal events or causing a startup broadcast storm.

## Relationship To Session State

ZCode Agent session state remains authoritative for messages, model/runtime settings, permission requests, stream events, and active turn state.

The task index may cache enough metadata for list rendering, but it must not become the source of truth for session content. Missing rows are seeded from the authoritative `sessions-index` summary during initial reconciliation; opening, resuming, or completing a task later enriches that row from the full session snapshot (including model and searchable message text).

### Index read profile (2026-09-30)

Host task-index origin ( `resyncTaskIndexRowFromAgent` : `phase.completed/error`, `meta.titleUpdated`, `session.became-visible` ) calls `session/read` with `contentProfile: "index"`:

```text
task-index syncer ──session/read {runtimePolicy: existing-only, contentProfile: "index"}──▶ CLI
                                                          │ first build complete snapshot (semantics unchanged)
                                                          │ then strip only large payload fields (do not add/remove messages/part)
task-index syncer ◀── same-structure snapshot (tens of KB~hundreds of KB, not 15 MB)──┘
   └─ buildMetaFromSnapshot / searchableText / hasUserVisibleContent: byte-identical to full
```

- Strip rules (`elideSessionSnapshotForIndex`, `@zcode/shared`): tool part `state.input` → `{}`, `state.output/raw/error` → `""`, `state.metadata` → `{}`; reasoning part `text` → `""`; file part `data:` URL → `data:,`. Message count and order, `info`, all parts `type/id/metadata`, text/compaction/timeline/subagent and other parts are preserved as-is.
- Why not `messageLimit`: it keeps the tail N messages, while searchable text takes the first 200K characters, title fallback takes the first real user message, visibility judgment checks all messages; truncation changes index results.
- Revision reason: the old implementation read the full snapshot per turn completion; long sessions had single-line NDJSON reaching 15 MB (mainly 3 MB tool output), and the Host performed a 15 MB JSON/zod parse per turn; task index actually only uses text, info, and part structure.
- This is a read view only for task index: other `session/read` callers must not pass `index`, and snapshots obtained must not be written back to UI/conversation state. Default or `full` behavior unchanged.

## Task Status Projection

`task_status` is a product task state, not a direct mirror of `session.status`.

- `session.status=running|waiting|paused` maps to `task_status=running` when the snapshot still has active runtime.
- `session.status=error|completed` maps directly to the same terminal task status.
- `session.status=idle` only means the agent engine has no active turn. If the latest user-visible assistant message has a completed timestamp and is not a tool-call continuation boundary, the task status is `completed`.
- `projection.lastError` takes precedence over a previously completed assistant message, because provider failures can happen before a new assistant message is persisted.

All snapshot-to-task-status callers must use the shared projection helper from `@zcode/shared`. UI projection, service adapter, and sqlite index sync must not carry separate copies of this logic, otherwise switching workspaces can restore a task from a different terminal-status interpretation than the one used while streaming.

## Implementation

- `packages/services/src/session/taskIndexRepo.ts`
- `packages/services/src/session/zcodeTaskService.ts`
- `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts`
- `packages/shared/src/zcode-task-types.ts`
- `docs/ui/pinned-task-storage.md`
