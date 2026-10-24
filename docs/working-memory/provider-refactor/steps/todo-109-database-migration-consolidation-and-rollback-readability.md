# Todo 109: Database-Wide Migration Consolidation and Rollback Content Readability

> Later finding (2026-09-11): the 0020 message backfill without an entry misses the thinking level recorded on an old
> user message while the assistant has none. Reproduced; the fix is owned by
> [Todo121](./todo-121-repair-backfilled-session-reasoning-level.md) and is pending. This record is kept but does not
> count that gap as fixed. The fix is an appended migration only; the frozen 0020 is not changed.
>
> Status (2026-09-10): implemented, with storage, protocol and Pro local-desktop key acceptance done. Phone / real remote
> joint on-device runs are not covered and external coordination is unconfirmed ([ledger](../research/todo109-database-implementation-ledger.md)).
> Not claimed green on all platforms; no real user database was modified; no automatic push.
>
> Fixed old baseline: `staging_backup @ 790884b1ce4b990583ab40625b5f283e2169eb36` (pin the branch HEAD before
> implementing; do not use main or a moving staging). Staging merged before implementation:
> `aaa486ed47ed08e522b7554d5e7d265c2475e2f1` (branch before merge `db5dfb7d401d1c8698d246cc04ed85e520cc7547`). Upstream
> already uses `0019_dwf_journal`; its number, content and checksum are kept as-is. Session-DB migrations of this round
> start at `0020`, never renumber or edit upstream migrations, and the number is re-checked before commit. The App DB has
> its own numbering.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-109-database-migration-consolidation-and-rollback-readability.md`

## 1. Goal, Priority and Non-Goals

2026-09-10 review follow-up (done): highest acceptance criterion is that rolling back, or rolling back and upgrading
again, may lose model selection but sessions/tasks must open and read/display must not raise errors because config is
missing or invalid. Two gaps were fixed: invalid User Selection leaking through the protocol, and the restore plugin
bypassing the minimal-compatibility write; the same class (Timeline/Subtask structure validation) was covered. Old values
are not touched, migrations are not rewritten or re-run, and old-field reads are not restored. Real SQL / Reader /
protocol and frozen-old-Reader batches (106 cases) passed; the Pro cold-start rerun passed; the pre-first-send failure and
uncovered platforms are recorded honestly in ledger section E (a successful disk write alone is not acceptance).

Move all database structure and content migration of the Provider refactor into formal versioned migrations, with an
audit conclusion for every owned database and table. Migrations keep old fields and values; after upgrade, rollback and
re-upgrade, task content, session history and messages must not become unopenable because the model config format changed.

**Primary constraint:** moving into migrations is not a redesign of migration semantics. The already ruled Provider
identity, Selection and reasoning-level conversion rules stay; adjust only where the old implementation violates this
round's principles (dropped fields, unopenable content, repeated runtime re-migration), recording the reason. New product
ambiguity is isolated for a ruling and never silently mapped to personal, Team, inherit or another model.

Not done:

- No full two-way sync between versions; losing model selection (needing reselection) during a rollback is acceptable.
- No blanket ban on or blanket use of dual-write; need is decided by the old version's content-read contract (section 4).
- No merging of physical databases, no cross-DB distributed transaction, no coupling of App services to the Agent's concrete storage.
- No change to Account/Provider architecture, effective Selection, running-model binding, permissions or Ticket policy.
- No change to external software databases (for example browser Cookie DBs). Non-database migrations (Provider JSON, Bot
  files, Wiki files, Subagent Markdown) are out of scope; database import boundaries are still checked.
- No cleanup of unrelated old data, unrelated bug fixes, upgrade/downgrade drills on real user directories, or automatic publish/push.

Within database scope this Todo supplements/supersedes conflicting old migration and rollback requirements of Todo69 and
Todo104 (their history stays). "A single new-version message/task failing to open is fine" is no longer accepted; what may
degrade is rebuildable config, not content accessibility.

## 2. Confirmed Facts and Whole-Database Audit List

Method: current code, fixed-baseline diff, raw database/real Reader tests, producer/consumer searches. Final per-table
conclusions and verification are in the implementation ledger. Codegraph was unavailable.

### 2.1 Agent Session Database

Default `~/.zcode/cli/db/db.sqlite` (actual configured path governs). Migrations 0001-0018 and the `schema_migration`
records had no SQL or executor difference from the baseline. The executor uses an IMMEDIATE transaction, checksum,
record-after-success and rollback on error. Unchanged table structure does not mean unchanged JSON content.

Baseline: 18 business tables plus the migration record table; after the 2026-09-10 staging merge four more business tables
(`dwf_run`, `dwf_actor`, `dwf_node`, `dwf_event`) make 22 (SQLite's `sqlite_sequence` excluded). The new tables are audited
too, keeping upstream's durable journal design without implementing dynamic workflow or running its internal-preview-DB
drop mentioned in comments. Each row needs a conclusion of migrate / keep unchanged / pending ruling, with evidence.

| Table               | Must check                                                                   |
| ------------------- | ---------------------------------------------------------------------------- |
| session             | metadata, summary, recovery structure; content and identity association kept |
| session_entry       | all types including runtime/model_selection, not only the current selection  |
| message             | user selection, assistant actual source, input intent, nested metadata       |
| part                | all Part types, especially model switch, Subtask and tool-result association |
| session_input       | input payload, queued/Guide persisted input facts; missing model/mode not guessed |
| session_target      | target, run association, recovery info                                       |
| session_task_link   | parent/child relation and model fields                                       |
| workflow_definition | definition and `meta_json`                                                   |
| workflow_run        | `args_json`, `stats_json`, `failure_json` and associations                   |
| workflow_activity   | `opts_json`, `result_json`, `error_json`, child-session association          |
| workflow_event      | event type, `payload_json`, order                                            |
| model_usage         | model source, level, raw usage / vendor metadata                             |
| turn_usage          | usage and Turn association                                                   |
| tool_usage          | tool usage and call association                                             |
| local_setting       | namespace/key/value, obsolete records keep original values                   |
| permission          | whether the old permission structure is affected; no unrelated deletion      |
| input_history       | input and attachment structure                                               |
| todo                | content, state, ordering                                                     |
| schema_migration    | history ID/checksum/records unchanged; only append                           |

Known seeds: `codecs.ts` converts User/Assistant/Timeline/Subtask on read; `repositories/model-selection-migration.ts`
migrates the selection on restore; `session-entries.ts` already has the new-member wrapper and old-field preservation.
`usage.ts` only has TS name changes, which does not justify renaming SQL columns or historical facts.

### 2.2 App Task Database and Others

Default `~/.zcode/v2/tasks-index.sqlite`, shared by TaskIndexRepo, AutomationRepo and OffPeakTaskRepo (one database, not
three, so no per-Repo migration versions).

| Table / scope                                       | Known state and audit requirement                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| tasks                                               | columns, `meta_json`, search content, workspace identity; conclusion needed even if unchanged |
| task_groups, task_group_members                     | groups and membership; migration must not lose list entries                              |
| task_group_view_node_orders, task_group_workspace_bootstraps | order and workspace association                                                 |
| automations                                         | new `model_selection` vs old model/provider/thought_level; scattered import entries      |
| automation_runs                                     | new `model_selection`; historical execution source not reinterpreted by current account  |
| off_peak_tasks                                      | new `model_selection`; old model/level and Ticket association; repair path on read       |
| new migration record table                          | the library's single ledger; name/implementation per final design                        |
| other owned databases                               | search DB creation, drivers, paths and write entries; exclude unrelated ones with reasons |

Repos each had their own CREATE TABLE / `ensureColumn`; Automation imported old selections in its init chain; Off-Peak
repaired old selections in list/get. These are consolidated without losing other needed create/add-column behavior.

### 2.3 Audit Method and Ledger Fields

Per database: real path source, owner, open entry, driver, existing migrations, version/lock, all tables, test entries.
Per table/field: old producer -> disk format -> existing conversion -> new consumer, source commit, target new field,
preserved fields, source of the conversion rule, whether minimal-compatibility write, test evidence, status. Producers
and restore/copy/import/ordinary-update entries are checked, not only Repository diffs (an unchanged JSON repository can
still write new shapes). Application-layer repair is limited to format closure and content readability; the UI never accesses a Repo.

## 3. Formal Migration Execution Contract

```text
open the owning database -> database-level migration entry takes the transaction lock
  -> for each migration ID: recorded -> verify checksum -> do not re-run;  unrecorded -> structure/data conversion -> record success
  -> data and migration record commit in one transaction -> expose the migrated database to Repo / business
real execution/write failure -> roll back, no half-migrated success record
roll back to old version and upgrade again -> completed migrations do not re-run; missing new config is treated as missing
```

1. Reuse the session DB mechanism; other databases get the same guarantees. History migrations are never edited or
   renumbered; new IDs are checked for conflicts before implementation; checksum mismatch fails explicitly.
2. Each physical database has its own version and transaction; any Repo initialization order on one database is safe.
   Multi-window/process coordination uses database locks and in-transaction version recheck, not in-memory flags or guessed waits.
3. New databases, full old databases, and databases where only some Repos had initialized tables all attach safely. A
   missing migration record does not imply tables/columns are missing: the initial migration checks the real structure,
   does not swallow all SQL errors as success, and does not write a fake "all done" version.
4. Table creation, column addition and this round's historical-format conversion move into migrations; Repos stop
   re-upgrading. Earlier-version upgrade behavior is preserved or proven equivalent.
5. The executor owns the transaction; no nesting of old conversion entries that BEGIN/COMMIT themselves. Prefer clear,
   testable SQL; local code steps only as a minimal extension with fixed step validation/version, not depending on online
   Resolvers whose semantics change.
6. No OAuth, entitlement, Provider Registry or remote lookup inside a transaction. Large databases use bounded
   traversal/batching while keeping needed atomicity, never loading everything into memory.
7. Normal business Readers no longer re-migrate this round's old fields. Explicit legacy import entries may reuse
   deterministic conversion but are marked as import boundaries; no per-start/read "import" wrapper and no downgrade
   detection or auto re-migration machinery.
8. Completed migrations do not re-run because a new field is missing; a selection cleared in the new version is not
   resurrected from old values.

## 4. Old-Data Preservation and Minimal Compatibility Writes

### 4.1 Migration Only Adds the New Expression

- All original columns, old fields and values stay: no in-place rename or delete, no overwriting old Provider values with
  new Provider IDs; unknown extra fields are kept.
- Never overwrite a whole row with a business Decoder output that drops old fields. When old and new formats share an
  object name, storage uses a non-conflicting new member (for example Timeline `fromModelSelection`/`toModelSelection`,
  Subtask `modelSelection`; final names are decided in the storage spec and do not require changing protocol field names).
- The logical Port may keep the current shape and the adapter maps to disk; no second business Selection authority.
- IDs, foreign keys, order and time are not changed gratuitously; derived records, where existing semantics require them,
  follow ruled rules with a stated source and never alter old records.
- "Preserve" means field presence and value/content, not byte-identical column text after adding JSON members; unmodified
  rows stay unchanged, array order, body and attachment references do not change.
- When this migration has not run, records with a clear old source may be rebuilt and overwrite this round's new target
  fields; unshipped erroneous intermediate states are not supported and new records lacking an old source are not
  rewritten indiscriminately. The migration version decides whether it runs; "skip whenever the new field exists" is not a general rule.

### 4.2 Avoid Dual-Write; Content Accessibility First

```text
new-version migrated/added/modified record -> staging_backup's real Reader
  content opens, only model config lost -> no dual-write
  content cannot open for a missing old field -> add the minimal necessary compatibility field, dual-write if necessary
old version used then upgrade again -> completed migrations do not re-run; missing new config -> content opens; reselect/complete config before execution
```

- Not all old/new fields must stay consistent, and model config edits made during rollback need not be restored; mere
  model mismatch does not justify dual-write.
- If the old version cannot open a single task, message or session because a required field is missing, that must be
  fixed, not only whole-library/list failures.
- Verify each item with the frozen old Reader and the follow-on display path; JSON.parse success or field presence is not
  enough, and new-version added/modified records are covered, not only pre-migration old records.
- Ordinary save and copy/fork whole-object replacement must not erase preserved old snapshots. Preserving the original old
  value is different from continuously reverse-updating; any necessary dual-write records its trigger path, fields and why
  it cannot shrink; no general dual-write framework.
- New-version business reads only the new structure; compatibility fields serve migration and old-version reads only, with
  no runtime old-field fallback. No misleading historical identity is fabricated just to fill a field; if the minimal
  compatible value cannot be determined by existing rulings, isolate and ask.

## 5. Conversion Semantics and Missing Config

1. Existing deterministic Provider ID / level mappings may be used; changing the representation does not change business
   facts. Ruled rules are not redesigned for the migration move.
2. "Saved next-execution selection" (migrated by its domain's rules) differs from "historical actual execution source"
   (never rewritten by the currently logged-in account, Team or executable list).
3. A record without model/mode is not guessed; rebuildable config that cannot be restored reliably may stay missing, with
   the old source kept and an explicit result, and the migration still completes (complete = processed per the rules, not
   every model config restored).
4. Missing config must not make the whole message/task/session fail to parse, nor swallow content into a fake empty
   record. Display/browse is separate from execution validation: when execution needs missing required config, prompt to
   complete it, never silently pick a model. Existing legitimate default/inherit semantics are not redesigned.
5. Real database execution failures and conversions that would damage content or structure roll back and are never
   blanket-caught and skipped. Malformed JSON is classified by affected content and prior behavior; it does not become a
   rebuild of an empty database, and normal missing model config does not become a whole-library startup failure.
6. Off-peak's existing repair depends on account resolution: existing rulings and Ticket binding come first; the
   determinable part moves into migration; config with no recoverable fact stays missing; Tickets are not rebound and
   repair does not hide back in list/get. If a valid ruling requires another automatic recovery, that conflict is
   raised for a ruling rather than undone.
7. Migration checks no execution eligibility; Provider/entitlement/model/Ticket checks stay at the execution boundary.

## 6. Impact Brief (owners and abstraction protection)

Mode planning; change level persistence / recovery, not UI redesign. Migration is owned by the storage layer of the owning
process; UI/Host projections are not a second content authority.

| User entry / state                | Shared implementation and authoritative owner         | Draft / default and commit boundary                                         | Must keep                                          |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| Task list, search, groups         | TaskIndexRepo / `tasks-index.sqlite` list metadata    | browsing does not start all Agents, no user-draft change                    | workspaceIdentity and path not mixed               |
| Open session, history, subtasks, goals | Agent SessionStore; UI consumes protocol projection | reading does not require an executable model; execution uses existing selection/binding | local/SSH/WSL/Docker databases migrate at the actual owner |
| Automation list, edit, run records | AutomationRepo / `tasks-index.sqlite`                | edits write automation config, not Session drafts; missing config handled at existing execution entries | auto-run, schedule and enable state unchanged |
| Off-peak list, edit, Ticket       | OffPeakTaskRepo with existing Service / `tasks-index.sqlite` | ordinary reads never swap account or Ticket                          | bound Ticket execution semantics kept              |
| Phone opens the above             | same shared-host and owning SessionStore/Repo         | no phone-specific migration or runtime                                      | desktop-continuous and web-remote-replayable do not leak into each other |

Shared: migration guarantees and storage conversion. Different: each database's owner, table contract, Selection meaning
and business commit/execution timing. Public API/Model validation, candidate generation and default/inherit sources are
unchanged; storage compatibility is not turned into a runtime fallback.

Impact tiers (repository-root paths): must-inspect
`apps/zcode-cli/packages/adapters/src/storage/session-store/{migrations,migration-runner,codecs,sqlite-session-store}.ts`,
`repositories/{session-entries,model-selection-migration,messages,usage}.ts`;
`packages/services/src/session/{taskIndexRepo,automationRepo,automationSelectionMigration,offPeakTaskRepo,offPeakTaskService}.ts`;
Session message/Part/input producers, restore, fork and import consumers (symbols listed in the ledger). Should-inspect:
task projection, session history hydration, automation and off-peak dispatch (missing config does not block content and
execution semantics are unchanged). Conditional: desktop/mobile shared-host, remote workspace, OS file locks (representative
verification). Invariant-only: Main/relay carry no migration or business state; storage does not depend on Runtime
implementations; model selection draft commit timing unchanged. Evidence-only: existing Session migration, Repo and
rollback-reader tests.

Graph: add this Todo's planning entry to `capability.task-persistence`, keeping the original owner relations. The graph's
old `defaultModelRef`/old queue owner notes may be stale (graph-drift-candidate) and are not a basis for redesign; no
codegraph was available.

## 7. Rulings, Scenarios and Test Plan

### 7.1 Confirmed Boundaries

| Ruling              | Final requirement                                                          | Rejected option                                   |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| D01 scope           | all relevant databases / all tables against the fixed `staging_backup`     | only four session tables or SQL diff only         |
| D02 migration semantics | consolidate the mechanism, do not redesign ruled mappings              | auto-pick personal/Team/other Provider            |
| D03 preservation    | old fields and values kept, new format stored separately                   | in-place rename, whole-object Decoder overwrite   |
| D04 intermediate state | unshipped intermediate states unsupported; unrun migration may rebuild target new fields | forbid conversion whenever the new field exists |
| D05 rollback round trip | content readable, config may be reselected, completed migrations do not re-run | auto re-migration system for post-rollback edits |
| D06 dual-write      | avoid it; minimal necessary when content cannot open                       | forbid entirely / reverse-sync everything         |
| D07 missing config  | migration may complete, browsing works, execution handled separately       | one missing model config blocks the library or drops a whole item |

Test dimensions: database/Repo init order; new / full old / partially initialized old databases; migration unrun / run /
failed-retry; old record / new-version added / new-version modified; config complete / missing / undeterminable;
single/multi process; local/remote content owner. No full model x account Cartesian product: conversion does not depend
on current entitlement, so representative offline / empty-Provider scenarios prove it.

### 7.2 Accepted Scenarios

Acceptance definitions; actual 2026-09-10 results are in ledger section D. DB109-01 to 13 have their key assertions done;
DB109-14 is partially verified (phone / real remote joint on-device runs are not counted as passed). IDs are stable.

| ID       | Setup -> Action                                                    | Core assertions                                                                                | Evidence layer                    |
| -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| DB109-01 | seed all tables of every DB from the fixed old baseline -> upgrade | every table has a conclusion; new fields correct; old/unknown fields, body, attachment refs kept; unrelated rows unchanged | raw SQL/JSON + current Reader |
| DB109-02 | fresh DB; DB with tables/columns but no ledger -> initialize       | converges to the correct structure and records; no content overwritten; real SQL errors not ignored | SQLite integration            |
| DB109-03 | migrated DB, reselect/clear -> reopen repeatedly                   | no re-run, no old-selection resurrection, version not decided by the new field's presence     | ledger + Reader                   |
| DB109-04 | unrun migration with an old source and an unshipped target value -> upgrade | target new field rebuilt from the old source by deterministic rules; old values untouched; no forcing without an old source | conversion unit tests + raw data |
| DB109-05 | atomic migration with an injected mid-write error -> reopen/retry  | data and record roll back together; a successful retry runs once                               | SQLite fault injection            |
| DB109-06 | several processes open at once, Repo init order varies             | applied once per database, no half-migrated state exposed, lock wait/errors within existing bounds | multi-connection/process integration |
| DB109-07 | applied migration with a changed checksum -> open                  | explicit refusal, no silent re-run or ledger change                                            | executor tests                    |
| DB109-08 | offline/logged-out/empty Provider, convertible and undeterminable selections -> upgrade/browse | deterministic conversion unchanged; missing config does not block content; no account network calls | storage + Service            |
| DB109-09 | representative new-version migrated/added/modified records -> old-version real read and display | every task/message/session opens; model config may be lost; dual-write or not backed by concrete evidence | frozen Reader + content projection + focused E2E |
| DB109-10 | upgrade, add/modify data on rolled-back old version -> upgrade again | completed migrations do not re-run; missing new config does not fail content; reselect and continue | two-version temp DB + UI/protocol |
| DB109-11 | historical Timeline/Subtask/input/goal/Workflow/Usage -> migrate and restore/copy | relations/order/actual execution source kept; not reinterpreted by the current account        | raw DB + restore consumers        |
| DB109-12 | update/copy/fork a new-version selection; import old backup -> read normally | old snapshots not erased; normal Reader never reads old fields as fallback; explicit import boundary does not spread | Writer/Reader + import integration |
| DB109-13 | off-peak old record with Ticket, insufficient identity -> migrate/list/execution check | no rebind, no migration write in list/get; missing config per existing rulings; no real task started | Service/Repo fixture      |
| DB109-14 | desktop local and remote same path different identity, phone attachment -> open history | identity isolation; phone reuses the owner; continuous/replayable semantics unchanged       | focused end to end                |

Pruned: no requirement of model-config round-trip equality, no real model requests to verify the database, no
cross-database atomic upgrade, no coverage of every unrelated old format. Legitimate product default/inherit behavior is
not rewritten as a bug.

### 7.3 Pre-Implementation Material and E2E Handoff

- Update the corresponding specs first for actual structure changes: `apps/zcode-cli/docs/design/v2/local-setting-migrations.md`,
  `apps/zcode-cli/docs/design/v2/session-persistence.md`, `docs/task/task-sqlite-index.md`; candidate field names are not stated as fact.
- The CLI-owner sync for database structure changes required by the Agent instructions was prepared; no message was sent externally.
- Before writing interactive E2E read the conversation declarations, case catalog, coverage matrix and E2E workflow, add
  requirement/coverage rows for DB109 scenarios with `e2e-case-lifecycle`; reuse and extend existing pending cold-history
  cases without automatic promotion.
- File fixtures: temp databases generated from the fixed old baseline, frozen old Readers keep their source SHA; no real
  accounts/user databases. Providers use offline fixtures; where post-reselect execution is needed use controllable
  replay/test models.
- Timing uses transaction fault injection, process handshakes and explicit barriers, not sleeps. Core whole-batch storage
  tests first, then shared build for desktop/remote representative runs; phone environment limits recorded.
- Reusable: `apps/zcode-cli/packages/adapters/tests/session-model-selection-migration.test.ts` etc.; specific executor,
  Repo and old-Reader files and results are in the ledger.

## 8. Execution Batches and Completion

Batches (all done): A fixed old/new baselines, full database/table/field/producer/consumer ledger, spec and tests first,
minimal-compatibility-write list; B per-database versioned migration entries, handling no-ledger / partially initialized /
concurrent databases, moving this round's structure and data conversions in with unchanged rule semantics; C unified
Reader/Writer/restore/copy/import boundary, deleting replaced old logic, minimal compatibility writes, separating missing
config from content reading; D whole-batch frozen two-version Reader, typecheck, lint, architecture, Pro focused E2E,
whole-table two-way review and commit closure.

Overall product principles are ruled and not re-asked. Items settled by code audit: missed databases, new storage names
for same-name fields, which old Readers truly need minimal dual-write, whether off-peak identity conflicts with current
rulings. Anything needing new product semantics or irreversible real-data operations is isolated; "pending migration" is
not an excuse for endless read bypasses.

Completion (all met except the last): all relevant databases, tables and persisted content changes have traceable
conclusions; formal migrations cover required structure/data conversion and old entries are deleted or kept with a stated
import/unrelated reason; old fields/values and content preserved and normal new-version reads no longer use this round's
old fields as a data source; upgrade, rollback and re-upgrade keep content accessible including new-version added/modified
data (config may be reselected, but an empty list/message must never mask a content failure); every dual-write is minimal
and backed by old-Reader evidence, and non-dual-write items also have readability evidence; single execution, failure
rollback, checksum, concurrency, missing config and offline scenarios pass with execution eligibility separate from
migration; full review of ruled conversion semantics, Provider/Selection/owner abstractions and cross-end isolation with
untested and genuinely pending items recorded.

- [ ] Before release confirm CLI-owner coordination and DB109-14 phone shared-host / real remote joint on-device runs.
      This does not affect the code-implementation claim but means full-platform verification is not complete.

## 9. Implementation Record

2026-09-10 start: fixed staging `aaa486ed47` merged normally into the separate integration branch (no explicit conflict,
no file changed by both sides), the seven document-only commits kept. Upstream mostly brought 0019 DWF journal, share
attachments/preflight, Start quota reminder dedup, workspace styles and dev-startup/architecture tooling; upstream commits
were not re-ported. Whole-batch 22 files / 328 App unit tests, 3 files / 68 Agent storage / selection-migration /
attachment unit tests, root typecheck, lint (42 warnings / 0 errors) and the architecture check passed. A real runner on
an in-memory database verified fixed old baseline 18 migrations -> 19: the original 18 SQL / ledger / old table structure
and sample data unchanged, four new tables present, ledger unchanged on repeated open, foreign-key check passed. No
desktop/phone on-device run; these merge checks are not claimed as Todo109 acceptance.

2026-09-10 closure: Agent 0020 and App 0001/0002 added; whole-table protection covers Agent 22 tables and App 8 tables.
Per-read/restore old conversions and the off-peak repair writes were removed; the minimal-compatibility User/timeline
objects backed by frozen old-Reader evidence and fork snapshot protection were added. Agent whole batch 195 cases, App
whole batch 123 and 14 supplementary cases passed; Pro isolated desktop chained four cold-start/reselect scenarios.
Command scopes, old error-text assertions, existing Agent lint/knip failures and remote/phone limits are in the ledger;
counts are not merged and untested items are not hidden.
