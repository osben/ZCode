# Global database startup: implementation review

Date: 2026-09-14 (updates through 2026-09-15). Branch: `codex/fix-database-migration-startup`. Scope and
recovery rules: [spec](./database-migration-startup-gate-plan.md); execution checklist:
[Todo 145](../working-memory/provider-refactor/steps/todo-145-global-database-startup-loading.md).

## Implemented

- Host single-attempt coordinator; standalone Main/preload control and snapshot channels; the Renderer shows
  real stages, duration, errors, copy-diagnostics and quit outside the business Root. No automatic migration
  retry.
- The Host-owned Worker serially prepares tasks-index (original migration / original Repo post-repair), then the
  session database through the matching CLI bundle's storage-specific entry. Both end with the Host; no full
  Provider/MCP/business Agent is started.
- ready is published only after services are assembled; the Main scheduler is deferred and attachment requests
  queue during preparation. A new business Repo connection still verifies the real ledger and cannot rely on the
  in-process "prepared path" alone.
- Original SQL, migration IDs, checksum inputs and single-database transaction boundaries are kept; the original
  exception is not overwritten by a second rollback/close exception.
- Host async statfs every 2 seconds, at most one query in flight, aggregating the observed available-space drop
  peak; on failure the cache is used, a missing baseline does not report 0, and scopes are not summed.
- ARMS stage/terminal durations, safe errors and disk summary; HTTP results are checked on the SDK reporter's
  original request, explicit failures try at most 3 times, and an unacknowledged request after 15 seconds is not
  duplicated while in flight.

## Review fixes

1. A standalone CLI child could linger after an abnormal Host exit; it became a Host-owned Worker (real bundle
   verifies virtual stdio and relative sessionDbPath).
2. Main's startup relay import must come after the early data directory, Chromium config and ARMS bootstrap, so
   it does not read an old path.
3. Service assembly failure forbids re-creating services in place and prompts quit-and-reopen; database failure
   can still be retried manually and reads the actual ledger.
4. A Host exit before any first state also yields a failure snapshot; reload fills in the snapshot; old
   sequences and concurrent/old-attempt retries are rejected.
5. The Worker closes the SQLite connection before publishing completion; the preparation-result handoff still
   verifies the ledger, so swapping in an empty file cannot fake ready.
6. Node SQLite is loaded in the Worker bundle via the existing createRequire approach, so the bundler does not
   rewrite it to a non-existent npm sqlite.
7. (2026-09-15) Old-Host ready replay: Main's startup ID goes into InitLocal, the Host snapshot and the local
   ServicePort, and the Renderer passes only when both are the same generation; binding a new Host revokes the
   old listener; after exit the old snapshot becomes a lost-connection failure and late old-generation messages
   do not update the window; a live Host reload reuses the same ID.
8. (2026-09-15) A historical-project exception widened into a global failure: the normal Agent and the
   preparation entry share an async cwd selection function; ENOENT, ENOTDIR, EACCES and plain files follow the
   existing fallback directory rules; with no fallback or a custom command.cwd not eligible, the original path
   is kept. Real database errors still fail, with no SQL/checksum change and no empty-database fallback. The
   async cwd preflight sits before the final admission / destruction / generation check so no Agent is spawned
   after exit during directory probing. Only the desktop local startup port gains the ID; mobile scoped
   attachment, remote workspaceIdentity and continuous/replayable semantics are unchanged.

## Verification record

- Root `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` pass (lint has warnings but no errors;
  no new architecture violations). The CLI sub-workspace `pnpm typecheck` could not start for lack of turbo; tsc
  checks of adapters, bootstrap and cli were used instead and pass. tsup (including the tasks Worker), CLI
  `build.mjs --desktop-agent` and the Vite renderer build pass.
- Original-migration differential/rollback/lock/crash/Reader suites 7 files / 56 cases passed; the first-cause
  preservation increment 3 files / 12 cases passed. Final full run: 1710 files passed / 2 failed / 2 skipped;
  14996 cases passed / 2 failed / 26 skipped. The two failures are unmodified provider-node file-watch and CUA
  socket timing assertions and passed on isolated re-run (2 files / 38 cases); the occasional failures are
  recorded and the full-run command is not claimed green. All new startup cases passed.
- Node running the final tasks Worker and the CLI bundle Worker: 3 task ledger entries; the session relative
  path lands on the passed real cwd and the completion frame follows close, both exit 0 (probes touch only
  isolated temp directories).
- Extra per-project main/preload/renderer tsc still fails (rootDir/shared imports, browser types, Window.zcode,
  CSS declarations); not counted as passing, and the new coordination/sampling/telemetry/ID/admission/cwd files
  produced no diagnostics.
- After the 2026-09-15 fixes: 8 files / 87 cases pass; root typecheck, desktop typecheck:e2e, lint (45
  warnings / 0 errors), architecture (0 violations), tsup and Vite builds pass.

Test entries: desktop databaseStartup / databaseStartupDisk / databaseStartupRelay / databaseStartupTelemetry /
hostDatabaseStartup / storagePreparationProtocol / storagePreparationWorker / startupTelemetryDelivery;
services tasksStartupPreparation / zcodeStorageStartupGate; UI globalDatabaseStartupLoading.

## Release acceptance not yet passed

- **Electron GUI:** even an isolated minimal BrowserWindow exits 133 (Trace/breakpoint trap) before creating the
  window; WDIO returns `session not created: Chrome instance exited`. The new cases (including GLOBALDB-27/28)
  stay manual-review/pending and are not claimed as GUI-passed.
- Windows/macOS packaged Worker, theme/window interaction, mobile shared-host and real remote regression are
  not run; Node Worker tests cannot replace those platform results. Mobile keeps the existing connection state
  during preparation; no mobile database-stage page is added.
- ARMS backend ingestion is not verified with production events; an HTTP receipt is not equal to being
  backend-queryable. There is no cross-restart outbox / periodic checkpoint; a whole-app kill, offline state or
  a disabled SDK can lose the terminal state.
- No 20 GB performance promise; the original migration peak resource demand is not reduced; no test on real
  user databases. The codegraph tool was unavailable: no automatic impact scan, only controlled context and
  manual source review.
- Known unhandled edges (found by a 2026-09-15 read-only re-review): a quit button before the Host is bound has
  no listener to receive it, and the early startup window before the Host is created likewise has no quit
  receiver; closing the window during migration removes the Host terminal telemetry listener, missing the
  interruption and the cached disk summary. Actual fork-creation failure was not reproduced, so the
  button-reception probe is not evidence of a process-creation fault.
- Repo rule: interaction changes are committed only after E2E passes. The GUI environment blocked this, so on
  2026-09-14/15 fixes stayed in the working tree; on 2026-09-15 the user explicitly asked to commit, push and
  provide an MR link based on the current code, and delivery followed that authorization while keeping the edge
  issues above and without widening scope. The MR stays Draft; hooks were run normally. GUI environment block,
  target-system packaging and mobile-remote real tests, and ARMS backend ingestion are not marked as passed.
- Merge/release still needs the GUI and target-platform acceptance above.

## 2026-09-15 Todo 146: silent startup by real migration need

Execution details: [Todo 146](../working-memory/provider-refactor/steps/todo-146-silent-database-startup.md).
The executor does a read-only pre-check of the ledger and reports kind / executedCount / committedCount; the
Host aggregates per database and clears on retry; the Renderer derives display from facts, and a stage name does
not directly trigger upgrade text.

- No pending item (or not yet confirmed): only the Logo throughout; no body timer is mounted, and entering the
  original maintenance/service assembly does not show text. Errors still show the hint and the existing manual
  recovery entry.
- After a need is confirmed, the initializing/upgrading hint stays; intermediate database commits and
  maintenance do not announce a global saved/done; "saving" may show when the last database really commits, and
  final ready/service assembly shows completing startup. Stages that are too fast are skipped naturally; no
  artificial delay or percentage.
- One Host preparation reuses real session-database paths that closed successfully; retries / new Hosts do not
  reuse, and the same-generation ready + port rule of the old Host is kept.
- ARMS adds the migration-need kind and executed/committed counts, keeping known facts on failure; no extra
  sampling or periodic network task. No migration does not mean zero IO or no lock waiting.
- Frozen SQL, checksum inputs, migration IDs and single-database transaction boundaries are unchanged. Code
  review and test runs are done; the GUI environment still fails before entering cases, so target-platform, GUI
  and mobile-link verification remain before release.
