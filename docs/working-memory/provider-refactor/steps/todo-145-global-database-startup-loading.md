# Todo 145: Prepare databases before entering ZCode

> Status: code implemented and reviewed; desktop GUI, Windows/macOS and ARMS backend acceptance have not
> passed, so it is not releasable (2026-09-14; baseline `fix-database-migration-startup`, `845391b5dc`).
> Scope: rework the app startup flow, including Host database initialization, ARMS startup diagnostics and
> light disk sampling; migration scripts are not modified.
> This Todo replaces Todo 144's follow-up checklist and its workspace-loading design. Plan review:
> [kickoff review](../../../desktop/database-startup-plan-review.md); implementation evidence:
> [implementation review](../../../desktop/database-startup-implementation-review.md) (done items, boundaries
> and failed release acceptance).

## 1. Goal and invariants

After opening ZCode the user first sees a standalone startup page. Only after the local databases required
for startup are ready is the normal business Root mounted, the workspace restored and database-dependent
background work released. Covering the UI is not enough: Root hooks or the scheduler must not keep touching
a not-ready database behind it. Users without a workspace take the same flow.

- Migration IDs, SQL, checksums, ledger and execution order are unchanged; completed items are verified and skipped by the existing rules.
- No SQL optimization, replacement executor, batch, new index, data cleaning or migration-format fork; no promise to reduce the original scripts' peak memory or disk use.
- SQLite transactions and the ledger decide migration mutual exclusion and completion; the Host holds only the current startup state, with no persisted "migrated" marker or cross-process file lock.
- Local startup covers `tasks-index.sqlite`, the session `db.sqlite` and any other startup-required databases found by audit (list the real set; "all databases" must not hide omissions).
- Historical SSH/WSL/Docker environments are not actively connected; remote databases are prepared when their connection is established and are not a local startup prerequisite.
- Paths follow the real config resolution (custom data dir, session db path); never migrate one database and have the business open another.
- The independent Provider config read protection is kept; account, Provider and model-selection semantics are not changed.

## 2. Target order and responsibilities

```text
Main creates the window, starts the Host, forwards startup messages
Renderer shows the standalone startup page, subscribes and reads the startup snapshot
Host builds a startup control plane reachable early
resolve local config and database identity (no wait for login, Key, entitlement or optional network)
prepare Host databases: migration + required post-migration initialization
prepare the session database through the Agent's own storage entry
all databases ready + required services assembled
startup coordinator reports ready -> release business consumers -> mount business Root / restore workspace
any stage fails -> failed -> diagnostics and recovery actions; user retry -> new attempt -> re-resolve config and real migration ledger
```

The startup status channel is established before blocking database operations; with different start
orders or early messages the snapshot fills in state. Main only schedules and relays; the Host owns startup
orchestration, the Agent owns session-database migration, the UI shows state and submits retry intent. The
startup page must show failure even if the normal service channel is not published yet.

States: `starting -> preparing_host_storage -> preparing_session_storage -> starting_services -> ready`,
any stage can go `failed`. Per-database sub-stages: checking / waiting_for_lock / migrating / committing /
ready / failed. Keep attempt, database identity, stage sequence, start time, error code and diagnostic ID;
old attempts and out-of-order events cannot overwrite newer state. A `starting_services` failure says the
service start failed, never a database migration failure.

### 2.1 Retry rule

After a migration failure the page stays on failure with reason and advice; no auto-retry, no SQL restart on
timeout, no new migration on page refresh. Only a user click creates a new attempt; duplicate requests while
running or from old attempts are ignored. SQLite lock waiting belongs to the current attempt; ARMS network
retry is separate telemetry behavior and never triggers database operations. A corrupt database / checksum
mismatch points to diagnosis and never suggests that repeated retry will fix it.

## 3. Old implementation disposition

| Scope                                                                                      | Disposition                                                   | Must prove before reuse                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Migration interception in `Root.tsx`, `useStorageStartup`, workspace snapshot subscription | remove old wiring, reimplement at app startup                 | business Root not mounted early; users without workspace protected                                           |
| `prepareStorage(workspace)` and workspace-destroy retry                                    | not a global entry; audit callers then delete or narrow       | no fake workspace; no global restart on tab switch                                                           |
| Original SQL runner, lock wait, rollback, ready after COMMIT                               | reuse item by item                                            | still runs frozen original SQL, ledger-compatible, observable waiting                                        |
| Agent early notification and protocol request admission                                    | keep needed abilities, adjust wiring, fix failure propagation | terminal state observable even with no first notification or process exit; ordinary RPC timeout not degraded |
| Loading components, styles, copy                                                           | reusable as needed                                            | no workspace state mixed in; multi-stage and error recovery                                                  |
| Transaction, frozen SQL, lock contention, crash recovery tests                             | keep for acceptance                                           | run on the new startup entry; old passes do not substitute                                                   |
| Workspace hook / Root / startup E2E                                                        | remove stale assertions, add new scenarios first              | verify the real startup order                                                                                |
| Independent Provider config protection                                                     | keep independent commit and tests                             | not withdrawn by the startup rewrite                                                                         |

No whole-branch hard reset or rewriting pushed history: later commits replace the old implementation and
delete unused protocols, exports, copy and tests.

## 4. Execution checklist and status

A. Spec and dependency audit: [x] startup plan doc `docs/desktop/database-migration-startup-gate-plan.md` rewritten; [ ] architecture context/check and feature-boundary scan, Main/Renderer/Host/CLI order of creation, status channels, config reads, DB opens, service publication, warm-up and scheduler/bot/Wiki start order; [x] AutomationRepo, OffPeakTaskRepo, TaskIndexRepo construction/ensureReady/migration/post-migration repair checked (construction is not "migrated"); [x] session path vs workspace config checked, the prepared physical database set matches later consumers (a new different physical database needs its own admission); [x] Host synchronous SQLite execution placed (Host-owned Worker so the event loop stays responsive); [x] workspace-independent Agent storage-prepare entry and connection reuse/close rules (Host never copies SQL, never starts a full business Agent to probe); [x] startup protocol, error classification, timeout, exit, retry and multi-window contract frozen.

B. Behavior tests: [x] frozen-SQL sync/async runner, same data/ledger, error rollback, cross-version Reader regression; [x] failure snapshots for Host post-migration init failure, service assembly failure, missing first status and process exit; [x] new startup E2E (not bypassed by a "wait for chat input ready" fixture); [ ] isolated databases with real old data and stage barriers proving the startup page is visible before Host migration and Root/background consumers are not entered; [ ] new user without workspace, old user pending migration, partial ledger, migrated, user edits not overwritten; [ ] section 5.1 classification and end-to-end copy tests (original cause, commit/cleanup failure, temp-disk-full, generic IO not misreported).

C. Host and Agent orchestration: [x] early status channel, snapshot read and retry entry (strict types + runtime schema, shared protocol updated); [x] one Host preparation entry per physical database, serialized required initialization, repos reuse the result; [x] SQLite cross-Host / standalone CLI exclusion kept (in-process dedupe is not a cross-process lock); [x] Agent original-SQL prepare entry with status sent before long SQL and ready after COMMIT; [x] missing-first-status failure observable, migration not killed by ordinary-request watchdog or idle reclaim; [x] shared semantic error classification with safe error codes passed explicitly (not everything squashed to `sql_failed`); original error kept for diagnostics; [x] ARMS lifecycle, duration, error and disk sampling (sampling/reporting faults never change the startup result); [ ] split services into prepare and start (registration/construction must not start database-dependent background tasks; scheduler, bot, Wiki, warm-up and remote-control access obey admission); [ ] distinguish storage ready from app ready (later assembly failure stays on the failure page and releases unpublished services/subscriptions/Workers).

D. Standalone startup page: [x] entry outside the normal Root (initializes theme, language, error boundary without the full business store/services); [x] real stages and elapsed time ("preparing local data", "updating task index / chat history", "waiting for another window to finish data update"); no fake percentage or ETA; long-wait hints never imply success, skip or auto-restart; [x] failure shows reason, diagnostic ID, copy details, applicable retry and exit (corruption never encourages endless retry); [x] storage-full uses the section 5.1 copy and recovery; UI and ARMS consume the same standard error category (never derive it from translated text); [x] workspace-driven global loading deleted; remote connection errors go back to the connection flow and are not misjudged as local DB failures; [ ] zh/en, light/dark, keyboard and window resize; phone shows the existing shared-host prepare/failure state, no second runtime.

E. Verification and cleanup: [ ] acceptance matrix with UI, stage logs, process and ledger evidence (UI mock tests do not replace real processes and E2E); [ ] `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, CLI typecheck, affected unit tests and desktop E2E; [ ] spec, case catalog and coverage matrix updated only with real evidence; [x] stale workspace interfaces and duplicate state deleted, migration definitions' diff against the target branch empty, Provider patch retained; [ ] draft MR scope, evidence and limits updated (push/MR via the zcode-mr skill).

## 5. Failure, rollback and recovery contract

Transaction boundaries are per database; no cross-database rollback. If the session database fails after
the Host database committed, the Host database stays committed and retry skips completed migrations,
running only truly missing items. Post-migration Host repairs may sit outside the migration transaction:
their commit boundaries, idempotence and repeated-init side effects are checked; a complete ledger alone
does not mean the Host is usable.

- SQL/COMMIT failure follows the original transaction rollback; if rollback itself fails keep the original error and recovery state and never promise rollback completed.
- Crash / forced exit: next start SQLite recovers and the ledger is re-checked; a lost post-COMMIT notification must not trigger repeated conversion.
- Disk full, permission, I/O, allocation failure, corruption, checksum mismatch, lock-hold over budget and executor exit are classified separately; unknown errors keep safe diagnostics.
- Retry opens a new attempt only after the previous execution ended and transaction/connection cleanup is clear; a waiter never terminates another window's migration owner.
- Page refresh or phone disconnect does not cancel migration; re-subscribing returns the current snapshot. Exit flows are tested for normal close and forced kill; graceful rollback on every OS kill is not guaranteed.
- Never delete DB/WAL/SHM or the ledger, build a substitute empty database, auto-override checksums or treat failure as first start.
- No default 20 GB full-database backup, and "free space > database size" is not presented as an exact minimum. With a full disk the necessary error can still be copied from the status snapshot, independent of exporting a ZIP.
- Logs are per stage, migration item and terminal state with attempt, stage, duration, error code and redacted database identity; no lock-polling spam, message bodies or API keys.

### 5.1 Recognizing storage-full and other failures

The code had only coarse classes (open_failed / lock_timeout / checksum_mismatch / sql_failed...); the
runner put non-BUSY SQLite exceptions under `sql_failed` with the original error in `cause`. This change is
about error propagation and display, not migration definitions.

| Raw evidence                                                       | Standard category                     | UI behavior                                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite primary code 13 (SQLITE_FULL)                               | storage_full                          | storage full / capacity limit; retry after freeing space / checking quota                                                                                  |
| system file operation ENOSPC                                       | storage_full                          | storage full; never auto-clean user files                                                                                                                  |
| system file operation EDQUOT (if exposed)                          | storage_quota_exceeded                | storage quota insufficient; freeing other user files may not help                                                                                          |
| SQLITE_BUSY; SQLITE_LOCKED judged separately                       | database_busy / database_locked       | external BUSY follows the lock-wait budget; same-connection LOCKED is not waited blindly, reports a conflict; not a disk problem, never ends another owner |
| explicit EACCES / EPERM / SQLITE_READONLY                          | access_denied / read_only             | permission/read-only prompt; SQLITE_PERM alone does not imply a specific OS cause                                                                          |
| SQLITE_NOMEM / explicit ENOMEM (incl. recognizable extended codes) | memory_unavailable                    | allocation failure; an unknown process exit is not proven OOM                                                                                              |
| SQLITE_CORRUPT / NOTADB / checksum mismatch                        | database_invalid / migration_mismatch | block, offer diagnostics and help; no delete, ledger change or auto repair                                                                                 |
| generic SQLITE_IOERR / CANTOPEN, unknown exception                 | io_failed / open_failed / unknown     | read/write/open failure or unknown; without explicit evidence never say "disk full"                                                                        |

SQLite uses the raw numeric errcode (low 8 bits when extended) and structured reasons; Node's generic
`ERR_SQLITE_ERROR` cannot replace SQLite sub-codes, and English `message` matching is forbidden. Reading
the `cause` chain is bounded and cycle-safe; across Worker/IPC only allowed fields are serialized. If an
explicit capacity limit such as `max_page_count` is identified, show the capacity-limit message;
SQLITE_FULL itself does not prove any disk has zero space, and the temp-file disk may be the full one, so
"drive D is full" is never stated without confirmation.

Default copy (final per DESIGN and i18n): "Storage space is insufficient or has reached its capacity limit,
so the data update cannot complete. Check the free space of the disk holding the data directory and the
system temp directory, free space or adjust the storage quota, then retry." Actions: retry, copy error
details, exit; a confirmed specific failing path is shown only in local details (the main-db path is never
guessed to be the failing temp file path). Retry waits for this attempt's cleanup and then prepares from
the real ledger (never bypasses migration into the business). Disk sampling is only auxiliary: space
freed by rollback, a last positive free-space value, no sample or a failed sample never override an
explicit storage-full error. Open, migration SQL, COMMIT and post-migration repair are all covered by
classification; secondary exceptions from rollback/close/recovery PRAGMA are recorded separately, never
override the first migration failure, and "safely rolled back, data intact" is not claimed while recovery
state is unconfirmed.

Acceptance: isolated tests produce FULL via a real SQLite capacity cap, unit tests with explicit OS error
objects, fault injection for other filesystem errors (never fill a user disk); UI E2E asserts copy, action
and standard error code are consistent; a capacity-cap fixture does not prove every real OS disk-full path.

## 6. Wait budget

| Scenario                  | Rule                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global loading            | no total timeout that kills a process; state is determined by stage and executor lifecycle                                                                                |
| Control-plane first state | keep 30 s, only for establishing the control plane; established before long SQL, not wrapping the whole migration                                                         |
| SQLite write-lock wait    | keep the 60-minute cap with async backoff (single native busy 25 ms, async backoff 10-200 ms), independent of the business 5 s busy timeout; over budget fails explicitly |
| Original SQL executing    | no auto-kill SQL timeout; no "no progress update" death judgment (synchronous SQL can run long)                                                                           |
| Long-wait hint            | show elapsed-time note at 10 minutes and keep waiting; not a deadline and no guarantee that memory/space suffice                                                          |
| Ordinary business request | keep the original timeout; migration-admission waiting is separate from business request timing                                                                           |

The execution thread and status channel keep the window responsive; "no SQL timeout" is never a reason for
a UI without state or an endless loading after the process exits. After ready the business 5 s busy
timeout is restored. A custom old Agent keeps the old path and switches to the new wait semantics after a
valid startup frame. Historical ledger rows with unknown IDs keep their existing compatibility (only
currently known IDs are checksum-verified; no new "fail on future ID" rule). With non-standard triggers
the frozen original SQL runs; the two known AFTER INSERT sequence triggers of original 0015 are
unaffected.

## 7. Acceptance matrix (all pending; old Todo ticks are not inherited)

| ID               | Scenario                                                                   | Must prove                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GLOBALDB-01      | new user without workspace, no account/Key, network down                   | local required databases prepared, then normal first-use flow                                                              |
| GLOBALDB-02      | Host old-database migration paused                                         | startup page visible, state readable, window responsive, business not started                                              |
| GLOBALDB-03      | Host done, long session-database migration                                 | stages switch correctly; Root entered only when both databases and services are ready                                      |
| GLOBALDB-04      | migrated, partially migrated, user edited after migration                  | completed items not repeated, later edits not overwritten; original SQL/checksum/ledger compatible                         |
| GLOBALDB-05      | Host succeeds, session database fails, then retry                          | committed Host database not rolled back; uncommitted session transaction recovered; no config rebuild                      |
| GLOBALDB-06      | Host post-migration repair fails; required service assembly fails          | no fake ready, accurate error ownership, retry has no repeated side effects or leaks                                       |
| GLOBALDB-07      | multiple windows / standalone CLI, same and different databases            | same database SQLite-exclusive, no repeated migration; different databases do not mix state                                |
| GLOBALDB-08      | lock wait over the old 5 s; over budget                                    | the former continues to success; the latter is diagnosable, never terminates the lock owner                                |
| GLOBALDB-09      | kill before COMMIT; notification lost after COMMIT                         | real child process recovers correctly, ledger and data consistent                                                          |
| GLOBALDB-10      | first status missing, Worker/Agent crash, IPC break                        | observable failure/reconnect state, no permanent feedback-less loading                                                     |
| GLOBALDB-11      | page refresh, double-click retry, late old ready                           | no repeated start or cancelled migration; new attempt not overwritten by old state                                         |
| GLOBALDB-12      | FULL, permission, I/O, checksum, corrupt database                          | clear reason, safe recovery entry, no fake success or empty-database fallback                                              |
| GLOBALDB-13      | custom data dir and different session db configs                           | prepared database equals the business-opened one; no false global ready                                                    |
| GLOBALDB-14      | scheduler / bot / Wiki / warm-up triggered together                        | server-side admission works without relying on a UI mask; accepted queue not copied                                        |
| GLOBALDB-15      | local start with remote history, remote connection failure, old Agent      | does not connect all environments, network failure not reported as DB error; old protocol has explicit compatibility       |
| GLOBALDB-16      | phone pairing, reconnect, access during shared-host preparation            | no second runtime; desktop continuous vs phone replayable boundaries unchanged                                             |
| GLOBALDB-17      | Windows/macOS/Linux, theme, language, narrow screen                        | visible, operable, no white screen; packaged Worker/child-process resource paths work                                      |
| GLOBALDB-18      | cold start of a migrated database, quit and restart                        | no stray Agent/Worker, duplicate background tasks or visible startup regression                                            |
| GLOBALDB-19      | ARMS events, stage changes, failure copy and retry                         | accurate time boundaries, UI and telemetry errors from one source, terminal dedupe; final payload within attribute budget  |
| GLOBALDB-20      | free space drops then recovers during long SQL                             | sampling independent; keeps the maximum drop vs the start baseline, recovered space after rollback does not erase the peak |
| GLOBALDB-21      | multiple volumes, missing file, probe failure, SDK exception, offline      | missing values not zero-filled, per-volume distinction, business still prepares, no scan/report blocking                   |
| GLOBALDB-22      | migration executor crash, forced app exit, only a start event              | confirmed failure vs unknown terminal state distinguishable; no invented SQL error, true peak or guaranteed report         |
| GLOBALDB-23      | SQLite FULL / ENOSPC / EDQUOT; sampling still has space or is missing      | classification/copy accurate, not dependent on sampling, no wrong disk blamed                                              |
| GLOBALDB-24      | IOERR / CANTOPEN / permission / NOMEM / unknown process exit               | no false disk-full or OOM, unknown stays unknown, UI and telemetry same source                                             |
| GLOBALDB-25      | COMMIT or post-migration repair fails, then rollback/close fails           | original cause kept, cleanup/retry state clear, no false rollback claim                                                    |
| GLOBALDB-26      | main-db disk has space, temp disk fails; space recovered at retry          | main-db headroom does not negate FULL; old peak kept, new attempt independent, ledger correct                              |
| GLOBALDB-27 / 28 | Host rebuild revokes old startup listeners; historical project unavailable | pending E2E from the 2026-09-15 review fixes (see section 11)                                                              |

The 20 GB performance test stays deferred until explicitly authorized; this round is isolated-database
functional verification only. A small-database success does not prove low-memory or low-disk users migrate
successfully. Platforms, remote, E2E or performance that cannot be run stay open; a visible loading page
alone is not delivery.

## 8. Release and delivery boundary

- One package covers new users, users with unfinished migration and migrated users; migration is chosen by the real ledger, not version number or UI marker.
- Until the new scheme passes the existing MR stays draft. Verify migrated start first, then unmigrated, concurrency, failure recovery and cross-end; release runs its own flow.
- Rolling back startup code does not reverse committed database migrations; whole-package rollback keeps the existing version-readability contract and deletes no ledger or data.

## 9. ARMS startup diagnostics and disk sampling (2026-09-14)

The user asked to report duration, status and errors of the unified database preparation and record the
disk peak during migration where possible. Constraints: monitoring must not noticeably burden low-memory /
low-free-space devices; duration/status/error first, the disk peak is a degradable diagnostic, no precise
peak pursuit, and telemetry never delays ready.

### 9.1 Wiring and responsibility

Existing fact entries: `packages/desktop/src/main/desktopArmsCustomEvent.ts` (unified custom payload,
version/platform context, pre-send E2E capture), `packages/desktop/src/main/desktopRemoteUsageArmsTelemetry.ts`
(Host/lifecycle facts reported from Main), `packages/services/src/storage/adapters/volumeProbe.ts` (async
stat/statfs volume probe, null on failure; reuse through a domain interface or injection, no cross-domain
internal import), `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts` (existing
migration notification; UI and telemetry are both generated from the same startup state, never by parsing
log text).

```text
Host/Agent startup facts -> startup coordinator -> UI stages and safe error text
                                              `-> bounded diagnostic events -> Main's existing ARMS exit
Host independent sampler (async free-space read of the file system) -> local aggregation -> disk summary event
SQLite runs in a Worker / Agent; synchronous SQL never blocks the sampler
```

Main does not parse DB, run the migration state machine or probe disks. The reporter is injected, so Web /
standalone CLI do not depend on the Electron SDK. Telemetry does not wait for login, follows the existing
collection config and switches, and adds no startup-required network request; ARMS not ready, offline or
throwing is bounded and never blocks migration, ready or the error page.

### 9.2 Duration, status and error semantics

- `startup_id` identifies this window start, `attempt_id` the prepare/retry; database sub-attempts link to it; a page refresh does not record another migration.
- **Database preparation total**: from the coordinator starting config resolution / database preparation to all required databases and initialization succeeding or the stage failing; includes lock waiting, excludes later business service assembly.
- **Main UI release time**: coordinator start to required services ready and app ready emitted; separate from the preparation time. Window creation to first paint remains an existing app-startup metric and is not faked by cross-process wall-clock subtraction.
- Per-database check, lock wait, migration execution, commit and post-migration initialization durations. Single-process timing uses a monotonic clock; cross-process passes computed durations; the cross-database total is computed by the coordinator, not by summing parallel spans.
- Statuses: started / current stage / success / failed / interrupted or unknown; stage changes come from authoritative state, not Renderer duplicates.
- Errors record failing stage, database kind, migration ID when available, standard error code, stable UI message key, recovery action type and diagnostic ID; UI copy and reporting come from the same classification. ARMS never receives raw exception messages, full paths, SQL, chat content or keys (safe message templates; raw cause stays in local diagnostics, redacted).
- SDK acceptance does not equal backend ingestion; kill/power loss may lose tail events; a start event alone is not a migration failure, and never asserts OOM.

Events (schema frozen at implementation): `database_startup_started` (once per attempt), `database_startup_stage` (per real stage change, value = previous stage duration), `database_startup_result` (one terminal state per attempt, value = total preparation duration), `app_startup_ready` or a failure summary (one terminal per release attempt, value = coordinator-to-app-ready/failure duration), `database_startup_disk` (one terminal summary per observed scope; long migrations at most one aggregated summary per 5 minutes; not per sample). Keep full collection for the few started/result/error events (if sampling is needed, sample consistently per attempt and record the ratio). Correlation IDs are diagnostic only, not high-cardinality aggregation dimensions; success rate must account for offline/unclosed samples. ARMS custom has a 20-attribute budget (shared fields count); split by event and test the final payload.

### 9.3 One disk primary metric

```text
A0 = effective free bytes of the target file system before preparation starts
Amin = lowest effective free bytes during preparation (including A0)
observed_available_drop_peak_bytes = max(0, A0 - Amin)
e.g. start 30 GB -> lowest 18 GB -> after rollback 29 GB: report peak drop 12 GB, not the end difference 1 GB
```

This is the **observed net change** of the target file system, not the migration's exclusive physical
usage, cumulative writes, a required-space upper bound or an exact instantaneous peak; other programs'
writes/releases, system reclaim and quota changes can alter or mask it, so the name and dashboard keep the
"observed" meaning. (Chosen over DB/WAL logical length because it captures temp files and real block
allocation in the same pool, and over physical block traversal because it needs no scan.) Default dashboard
shows only total preparation time, result / failing stage / error category and this peak; `min_available_bytes`
is a failure-diagnosis helper (collapsed); total capacity, per-file lengths and per-round samples are not
reported. Quality info per result: metric_version, baseline/coverage state, time since last sample; with no
valid baseline or sample the metric is omitted, never 0 (a single start sample proves no growth).
Results are deduplicated per attempt; checkpoint vs terminal are distinct; success rate and final peak
distribution use terminal only.

| OS      | Entry and semantics                                                                                    | Interpretation limits                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | Node async statfs `bavail * bsize`; verify the packaged libuv's CallerAvailableAllocationUnits mapping | caller-available amount, not total free ignoring quota; NTFS compression/sparse files make logical length differ from physical use                          |
| macOS   | same statfs available-block semantics; no mixing with Finder capacity or Foundation estimates          | APFS volumes in one container share space; clones/snapshots change allocation; readings of different volumes may reflect the same pool and are never summed |
| Linux   | same statfs `bavail * bsize`, not statvfs units or `bfree`                                             | ordinary-user available amount, not guaranteed to include all user quota / inode / metadata limits; ext4/Btrfs/overlay behave differently                   |

Principle: unify "OS-reported free-space change" without claiming equivalence across quota, reclaimable
space and allocation policy; keep platform dimension grouping. Two local databases on the same file system
share one continuous sample per attempt (baseline not reset per database); different file systems produce
one summary per scope and peaks are never added; the same pool cannot be proven from drive letter or
`st_dev`. statfs targets the real database directory directly (a nonexistent directory resolves to an
existing ancestor once at path-resolution time, not per tick); the temp-dir file system is an extra scope
only when reliably confirmed, with no global disk search.

Cost control: default every 2 s, one async statfs per target scope; no per-round 4 file stats; keep only A0,
Amin, count and time (no time series, no per-sample disk write or ARMS network). At most one file-system
request in flight, scopes polled in turn; a slow call skips ticks, no pile-up (libuv async IO uses the
thread pool; "parallel per round" is not bounded concurrency). No file/directory scan, no database
statistics SQL, no checkpoint/fsync, no new sampler process; the sampler lives in the responsive Host while
SQLite runs in the Agent or planned migration Worker. Start the first query as soon as real paths resolve;
only a baseline finished before the corresponding writes start counts as complete; no unbounded startup
barrier for telemetry; a late baseline is marked partial/late and not mixed into the complete distribution;
no baseline keeps duration/error and marks unavailable. The minimum is maintained until the terminal state;
a failure does not reset the peak; one best-effort terminal re-sample never blocks the error page or ready
and space recovered after cleanup is not the historical peak. slow/unavailable only lowers observation
completeness and never overrides the migration error.

Failure retention and delivery:

```text
Host samples and keeps the summary -> mirrors the latest diagnostic to Main on change (at most once per 2 s, small message)
executor fails -> Host builds failed + existing peak -> Main reports the terminal state
Host exits -> Main reuses existing process-exit facts + latest mirror -> reports interrupted
whole-app forced exit -> relies on previously delivered checkpoints / persisted terminal state; tail values not guaranteed
```

The Main mirror is discardable telemetry, not a coordinator, completion ledger or retry decider; UI reload
does not re-report; failure does not depend on Renderer mount, login, ZIP export or re-reading the failing
disk. The 5-minute aggregated checkpoint may stay (dashboard hides intermediate records); checkpoint
frequency is a network-reliability budget, not the 2 s sampling frequency.

SDK gaps found (`@arms/rum-electron` 0.0.3): `sendCustom` returns void; the Electron reporter's request
returns fetch without checking HTTP status; the base reporter relies on request rejection for configured
retries, so try/catch around `sendCustom` or beforeReport/E2E capture cannot assert network success and an
HTTP 500 is not assumed to retry (facts: `node_modules/@arms/rum-electron/dist/index.mjs` electron-reporter/request,
`@arms/rum-core/lib/model/reporter.js` tryRequest, `desktopArmsCustomEvent.ts` pre-send capture).

- [x] Send-result contract at the unified telemetry exit: distinguishes queued in SDK, HTTP receive success, ARMS backend queryable; HTTP non-success and explicit network errors use bounded backoff retry; when the SDK cannot cancel, a timeout only marks unconfirmed, does not duplicate an in-flight request and does not change startup business timeouts.
- [x] Prefer SDK capabilities; if the SDK lacks send confirmation / reliable retry, list the minimum SDK fix in the spec; no bare HTTP from the Host bypassing common filters.
- [x] Key terminal states use a stable `event_id` for dedupe, with memory/count/time-bounded re-reporting and an `event_time`, so a next-start re-report does not mix into a new attempt.
- [ ] Optional cross-restart re-reporting: persist only a tiny pending-terminal summary (suggest 64 KiB total, 7-day TTL, no per-sample writes); on write failure keep sending from memory and never block the failure page; replaces the earlier absolute "no persistent retry queue" limit without becoming a general telemetry store; remove on receipt, dedupe by `event_id`.
- [x] If the database volume is full and the summary cannot be persisted either, rely on the living process memory and available network; no claim that persistence or upload must succeed (power loss, long offline, SDK disabled and ARMS rejection cannot be guaranteed; no unbounded resource use or blocking user exit).
- [ ] Fault injection: existing peak retained after FULL, executor/Host exit, missing first sample, SDK not ready, HTTP non-success, network drop and re-report dedupe; the confirmation path must actually check the response, not just that a mock `sendCustom` was called.
- [ ] Release acceptance with allowed isolated events checks actual ARMS ingestion and query and quantifies loss/re-report; this round sends no production telemetry and runs no migration performance test.

Delivery promise: recoverable failures keep observed metrics, with confirmation and bounded retry when the
network is available, and cross-restart re-reporting when conditions allow; no promise of capturing the
true peak in all scenarios or 100% delivery.

## 10. Landed and pending acceptance (2026-09-14)

- Implemented: two Host-owned Workers, startup shell before the business Root, standalone status/control channel, manual retry, safe errors, bounded 2 s sampling, ARMS HTTP receive confirmation.
- Service assembly failure offers exit-and-reopen only (the Worker has exited and services cannot be assembled twice inside a Host with partly created services). No cross-database rollback.
- This version uses summaries in the living Main's memory and bounded network retry; the optional cross-restart outbox / periodic checkpoint is not implemented. Timed-out requests do not stack. No guaranteed delivery on kill/offline.
- Phone keeps the existing shared-host connect/reconnect UI, attachment deferred during preparation; no phone-specific database stage UI. Phone/remote regression is pending a runnable environment.
- The new E2E is in manual-review/pending, not promoted; Electron crashed (SIGTRAP) before creating the window, so unit tests and Node Worker probes are not GUI acceptance.
- Check results, review fixes and log entries are in the implementation review; unticked items are not replaced by old-scheme passes.

## 11. 2026-09-15 review fixes

- [x] Host rebuild revokes old startup listeners; no ready replay after exit; status and first/reload port binding carry the same-generation startup ID.
- [x] When the historical project is unavailable it shares the ordinary Agent's async cwd fallback; real database errors stay failures.
- [x] Added unit tests, ID propagation tests and GLOBALDB-27/28 pending E2E; typecheck/lint/architecture and build pass.
- [ ] Commit after desktop E2E passes: in this environment even a minimal Electron app SIGTRAPs (recorded in the implementation review).
