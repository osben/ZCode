# Prepare databases uniformly before entering ZCode

Status: implemented 2026-09-14 and code-reviewed; automation results and platform limits are in the
[implementation review](./database-startup-implementation-review.md). Execution and acceptance checklist:
[Todo 145](../working-memory/provider-refactor/steps/todo-145-global-database-startup-loading.md).

## Goal and frozen boundary

The desktop window first shows a standalone startup page, and the business Root mounts only after the local
required databases and service assembly are done. This also runs for new users with no workspace. The original
migration IDs, SQL, checksums, execution order, transactions and ledgers are unchanged; no batching, indexes,
cleanup, empty-database fallback or SQL optimization is added. Provider read-failure protection is kept.

## Startup dependencies and ownership

```text
Main creates window + window-scoped Host
  ├─ Renderer standalone startup page ← Main passthrough ← Host startup state snapshot
  └─ Host preparation coordinator (one per window, one in-flight attempt)
       → resolve the real data path
       → Host Worker: tasks-index.sqlite original migration + required Repo initialization
       → Host-owned Worker loads the matching CLI storage command: original db.sqlite migration, exits after closing
       → createLocalServices / publish the service port
       → ready → Renderer mounts the business Root; Main starts the existing scheduler
failure → failed → stay on the error page → user clicks retry → new attempt / re-read the ledger
```

The Host is the only owner of startup state and retry; the SQLite ledger is the persisted fact of completion.
Main keeps only a discardable notification mirror, passes control messages through, records telemetry and
schedules processes. State is established through a separate IPC control plane and cannot rely on ordinary
services being published. A Renderer reload reads the current snapshot and does not restart migration. A service
port arriving early is kept, and no business service consumers are built before ready.

Coverage: TaskIndexRepo, AutomationRepo and OffPeakTaskRepo share the real `getTasksIndexDatabasePath()`. The
Worker serially completes the original migration plus TaskIndexRepo's historical ID/group repair and OffPeak
legacy-state repair, then releases the connection. Repos in the Host reuse only the path-preparation result
already completed in this startup and add no persisted marker; a path change goes through the original
preparation entry again. SQL inside the Worker and business Repos share one implementation.

The session database is resolved by the Agent's `createConfig` / `getSessionDbPath`, and the storage-specific
entry returns before Provider Registry, login, MCP, telemetry and business runtime. The execution cwd is an
existing real directory; no fictional workspace is created or bound. A relative `sessionDbPath` is resolved and
prepared against each local startup restore/prewarm directory provided by Main (at most three); with no
directory the real fallback cwd is used. Directories are de-duplicated and short-lived Workers run serially, so
several large databases are not migrated at once. Different physical databases added later remain protected by
normal Agent protocol admission. A private preparation protocol first publishes the resolved path for Host
sampling; the path does not enter ARMS. The normal Agent keeps protocol admission per actual physical database,
covering later config changes or new databases.

Host synchronous SQLite lives in the owning Worker, so the Host event loop can keep sampling and answering. The
Main scheduler is deferred until local preparation succeeds so it does not migrate the same database first. The
Host publishes no normal RPC before its required services are assembled; prewarm, bot, Wiki and scheduler do not
touch unprepared databases early.

Remote SSH/WSL/Docker is not a local startup prerequisite; on connection the remote Agent storage admission
applies. Mobile keeps attaching to the existing shared-host and does not start another Host/runtime;
workspaceIdentity, desktop continuous and mobile replayable boundaries are kept. Port attachments during
preparation wait for the existing Host to become ready.

## State, failure and retry

Stages: `starting → preparing_host_storage → preparing_session_storage → starting_services → ready`, with
failed reachable from any stage. Database sub-stages: checking / waiting_for_lock / migrating / committing. State
carries a startup/attempt ID, a monotonic sequence, start time, stage, standard error and diagnostic ID;
snapshots and events share one source.

**Never auto-retry after a migration failure.** The user first sees the reason and advice, and the next
preparation starts only when they click "重试" (retry); repeated clicks while running, requests from an old
attempt and late notifications must not create a second executor. Databases already committed successfully are
not rolled back; the failed database recovers via SQLite transaction and re-checks the ledger. The original
exception takes priority over rollback/close/notification exceptions, and atomic rollback of the whole
multi-database startup is not promised. Checksum mismatch / corrupt databases need diagnosis and repeated
clicking is discouraged. If the databases are ready and failure occurred during service assembly, the user is
prompted to quit and reopen: services are not constructed again in a possibly partially assembled Host, to avoid
duplicate background side effects.

The first-state budget is 30 seconds; an external write lock waits at most 60 minutes while the business busy
timeout stays 5 seconds. No automatic process kill/skip timeout is set for long SQL; 10 minutes only shows a
waiting hint. An executor crash or state-channel disconnect is observable as failure; user quit still uses the
existing window/Host cleanup and does not start another migration.

Error classification checks the structured code of the original cause and the SQLite primary code
(`errcode & 0xff`): FULL/ENOSPC/EDQUOT, permission, IOERR, CANTOPEN, NOMEM, corrupt database, checksum, lock
timeout and unknown exit. Error text is not used to infer disk full or OOM. FULL can come from a temp disk or a
quota, so it must not be denied because the main database disk still has space.

Insufficient-space hint (zh-CN, kept verbatim): **存储空间不足或已达到容量限制，无法完成数据更新。请检查数据目录及系统临时目录所在磁盘的可用空间，释放空间或调整存储额度后重试。**
(Storage space is insufficient or a quota is reached, so the data update cannot complete. Check free space on
the disks of the data directory and the system temp directory, free space or adjust the quota, then retry.)
The failure page offers the diagnostic ID, copy diagnostics, manual retry (where applicable) and quit. Copied
content contains no keys/accounts/chat text. The startup page reuses the theme, i18n and responsive rules and
shows no fake percentage.

## Disk observation and ARMS

Follows the Todo 145 §9 contract. For each reliably identified storage scope record
`max(0, baselineAvailable - minObservedAvailable)`; it is explicitly named the observed peak drop in available
space, not exclusive physical bytes of the migration. By default one async statfs every 2 seconds, at most one
query at a time, slow queries skipped rather than queued; no directory traversal, no DB content read, no
per-sample array and no disk log. The SQL Worker and sampler are isolated.

The baseline must precede writes for a whole-run peak to be computed; a late/failed one is marked partial or
unknown, and unknown values are not filled with 0. Scopes sharing a filesystem share a baseline and multiple
scopes are not summed; after rollback the historical minimum headroom is kept and the terminal state uses the
cache without needing the failing disk to be readable again.

The Host sends a bounded aggregated snapshot to Main, which keeps the latest summary so an executor crash can
still report observed values. ARMS sends only start, stage, terminal state and the terminal disk summary; this
version sends no periodic network checkpoint and implements no cross-restart outbox, so a mid-run whole-app kill
may lack a terminal state. Recorded: attempt, duration, status, unified error, sampling quality/staleness; not
sent: paths, messages, keys, all samples.

**Bounded reporting retry is entirely separate from database retry.** Send results distinguish SDK enqueued,
HTTP receipt acknowledged and backend-queryable. HTTP non-success and network error/timeout may back off in a
bounded way, with a stable event ID for de-duplication; a reporting fault does not block startup or the error
page. If a cross-restart summary is implemented, the terminal outbox is capped at 64 KiB / 7 days and falls back
to memory on a full-disk write failure. 100% delivery when offline, disk-full and the whole app is force-killed
is not promised.

## Verification and delivery

Tests first, then implementation, with isolated temp databases, no real user database, and no 20 GB performance
test. GLOBALDB-01 to 26 are in Todo 145; new UI cases go to manual-review/pending and are not promoted
unilaterally. Must verify frozen-migration compatibility, new/old/migrated databases, manual retry, missing
first state, lock/commit/cleanup failures, missing disk sampling, SDK failure, reload, service admission and
process resource cleanup.

Run the architecture check, typecheck, lint, affected unit tests, desktop build and startup E2E. After
development, review the actual diff, cross-end boundaries and resource/error paths. Verification not run or
blocked by the environment is recorded explicitly; old tests passing does not mean the new startup experience
is accepted.

## Implementation clarifications

- The startup-specific Repo connection waits for external write locks in the Worker and post-migration repair
  also uses the startup wait budget; the connection is closed after preparation and the business Repo 5-second
  policy is unchanged.
- `http_received` means only that the SDK's original request returned HTTP success. The current SDK offers no
  AbortSignal; a single request not finished in 15 seconds is recorded as unacknowledged without stacking new
  connections. Explicit failure / HTTP non-success tries at most three times. This version has no cross-restart
  outbox, so when offline or the whole app is killed only the start event may exist; delivery is not guaranteed.
- A disk summary with no baseline uses a separate unavailable event and is not mixed into the peak
  distribution as 0.
- Lifecycle review fix: session preparation is also done by the Host-owned Worker loading the matching CLI
  bundle's storage-specific entry (virtual stdio control frames). No standalone lock-holding child process is
  started, so the thread ends with the process when the Host is killed. The lifecycle of normal business Agent
  child processes is unchanged. CLI storage mode does not change the Host process name and resolves relative
  database paths with an explicitly passed cwd.

## 2026-09-15: Host generation and invalid project directory fixes

- Main assigns each new window-scoped Host a unique databaseStartupId, used as the Host coordinator's startupId
  and placed in the initial and reload local ServicePort messages. It identifies only the process generation and
  does not replace the database ledger, workspaceIdentity or task owner.
- Each window has one valid startup relay; binding a new Host revokes the old relay's control listener. After
  the old Host exits, the mirror becomes transport_closed and cannot replay ready; late status from the old
  generation does not update the current window. A failure mirror is still readable for current-window refresh.
- The Renderer mounts the business Root only with a ready and a service port of the same startupId, in either
  arrival order; a missing ID or crossing generations does not pass. A reload reuses the live Host's ID and does
  not re-run migration. Mobile scoped attachment and the remote replayable protocol are unchanged.

```text
Main assigns B → InitLocal(B) → Host status(B)
           └→ ServicePort(B)
Renderer: ready(B) + port(B) → Root
          ready(A) + port(B) → keep waiting
```

- The original Agent and global preparation share an asynchronous working-directory choice: when the project
  path does not exist, is ENOTDIR, has no permission or is not a directory, the fallback directory is adopted
  only if the original fallback is available; a custom command.cwd outside the default workspace fallback
  scenario keeps its original behavior.
- This only handles the execution cwd; database open, config read, disk-full and database permission errors
  still fail, with no switching databases or creating an empty-database fallback. The new async preflight
  re-checks cancellation/destruction/generation before the actual spawn.
- Regression: old Host ready then exit/rebuild, late old-generation message, both arrival orders, live Host
  reload, port missing ID; real ENOTDIR, plain file, injected EACCES, unavailable fallback directory and real SQL
  errors still fail. E2E adds GLOBALDB-27/28, kept pending.

## 2026-09-15: silent startup when nothing needs migrating (Todo 146)

This section supersedes the old rule that "the preparation stages always show copy". Details:
[Todo 146](../working-memory/provider-refactor/steps/todo-146-silent-database-startup.md). A normal start shows
only the Logo; the initializing/upgrading, saving and completing-startup text is shown only after a pending
migration is confirmed. Failures always show. Maintenance no longer reports migrating; an empty check
transaction shows no upgrade result. The Host aggregates the executor's migration kind, actual executions and
commit counts, and Renderer and ARMS consume the same facts. The SQLite pre-check is for display only; the
ledger is re-checked after taking the write lock, and the original SQL/ID/checksum/transaction boundaries are
unchanged. A successful session database in this run is reused by real path; failures and new attempts do not
reuse. Silent does not mean skipping maintenance or guaranteeing zero IO.

## 2026-09-15: report the last applied ID before migration

- Goal: together with the current `app_version` and any failed `migration_id`, locate the migration starting
  point, without uploading the full ledger or checksums.
- After `BEGIN IMMEDIATE` succeeds and before any versioned migration SQL runs, the executor reads the last item
  from the small ledger in descending ID order (frozen IDs sort by zero-padded sequence). A newly created empty
  ledger records `null`; failing to take the lock or to read records a missing field. Later commits/rollbacks
  must not overwrite this starting point.
- Optional `migration.lastAppliedMigrationId` travels through the existing strict startup protocol. The Host
  keeps the starting point of each recognized database for this attempt, task and session databases separately;
  kept on failure, cleared on retry; per-database starting points are not stuffed into the cumulative migration
  statistics.
- At the existing `database_startup_result` moment, one extra `database_startup_baseline` is sent per database,
  value=1, with attributes `database_id` (existing internal identifier/hash), `database_kind`
  (tasks-index/session) and `last_applied_migration_id` (ID/none/unknown). The event ID includes the database
  identifier to separate databases within one attempt. It is not repeated after the first report; an early
  failure with no recognized database fabricates no starting-point event.
- An invalid ledger ID is not uploaded verbatim and is marked unknown; a real read failure follows the original
  database exception path. UI, disk sampling, migration SQL/checksum/transactions, mobile shared-host and
  continuous/replayable boundaries are unchanged; there is no new interaction, so existing GUI E2E needs no
  change.

```text
SQLite takes lock → read starting point → original migration/COMMIT or failure
                  ↓              ↓
            original state protocol → Host keeps per database → Main reports at the preparation result
```

Acceptance: empty database none, old database exact starting point, reopened at the latest ID; another writer
committing first is read as its result; execution failure keeps the pre-migration ID; unknown and no-record are
distinguished; databases are not confused, repeated snapshots do not report twice, manual retry clears; original
SQL and checksums unchanged.

Verification record: app side 7 files / 39 tests, CLI original-migration/async-lock/crash-recovery/session-store
4 files / 60 tests passed; root `pnpm typecheck`, `pnpm lint` (45 warnings / 0 errors), architecture (0
violations), CLI adapters/bootstrap tsc and adapters lint, desktop tsup passed. The built real tasks Worker was
verified on an isolated temp database: empty database starting point null; only 0003 missing starts at 0002
with 1 commit; opening again starts at 0003 with 0 executions. No UI/E2E interaction changed, no production
ARMS event was sent, and backend ingestion is still to be verified.
