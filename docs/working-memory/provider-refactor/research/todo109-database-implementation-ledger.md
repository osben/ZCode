# Todo109 Database Implementation Ledger

> Implementation baseline: `dfce309227`; old-format baseline: `staging_backup@790884b1ce`. 2026-09-10: implementation, storage regression, and Pro desktop critical acceptances complete; remote/mobile joint real-machine restrictions in Section D — full-platform acceptance not claimed.
> Full history: `git show 8d54b233:docs/working-memory/provider-refactor/research/todo109-database-implementation-ledger.md`

## A. Agent Storage Contracts And Per-Table Conclusions

Existing SQL 0001–0019 retained as-is; new `0020_provider_model_selection` uses fixed SQL data transformations (no runtime account dependencies, no historical checksum changes). Migrations first fix old sessions' current selections, then supplement history messages/Parts' new members — message transformations must not change current selection source judgments.

| Table                                                     | Conclusions                                                                                                                                                  | Verification Status                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| session_entry                                             | `runtime/model_selection` adds modelSelection; all old data members and metadata retained; other entry types unchanged                                       | Original library assertions, recovery, Pro passed                |
| message                                                   | `user.model` → modelSelection; `assistant providerID/modelID/variant` → providerId/modelId/reasoningLevel; historical sources keep identities; old members retained | Original libraries, frozen old Readers, updated/forked passed    |
| part                                                      | timeline separately saves fromModelSelection/toModelSelection; subtask separately saves modelSelection; old objects not overwritten                          | Same as above                                                    |
| session_input                                             | Old payloads' missing modelSelection/mode stay missing; no old fields to convert                                                                             | Full-table protection, protocol recovery passed                  |
| model_usage                                               | TS name adjustments only; SQL `provider_id`/`model_id`/`variant` unchanged; historical sources and statistics unchanged                                      | Original full-row protection passed                              |
| turn_usage, tool_usage                                    | Unchanged by the Provider refactoring                                                                                                                        | Original full-rows and foreign-key protection passed             |
| local_setting                                             | Deprecated global reasoningLevel old rows retained, not migrated to explicit Session selections                                                             | Original full-row protection passed                              |
| session, todo, permission, input_history                  | Persistence contracts unchanged; contents, IDs, relations, times, order unchanged                                                                            | Original full-rows and foreign-key protection passed             |
| session_target                                            | Target storage formats and runtime statuses unchanged                                                                                                        | Original full-row protection passed                              |
| workflow_definition/run/activity/event, session_task_link | opts/results JSON saved as-is; `link.model` is existing execution records, no batch renames                                                                 | Original full-rows/foreign-key protection passed                  |
| dwf_run/actor/node/event                                  | 0019 independent journals, resolved_model, and bindings retained; no early engine implementation                                                            | Original full-rows and foreign-key protection passed             |
| schema_migration                                          | 0020 appended; 0019 and earlier SQL ledgers/checksums unchanged                                                                                              | Full tables, duplicate opening, and fault tests passed           |

### Reader / Writer Contracts

```text
Database opening -> migration 0020 -> current Reader -> normal history/runtime interfaces
Old fields     -> only migration and rollback Readers
New config missing -> normal content readable, execution-required configs checked by existing entries
```

- The SQLite adapter unwraps new Part members into the existing logical Ports' fromModel/toModel/model; runtime layers do not touch old fields. Readability tolerates a missing toModel and never fabricates empty-string Providers.
- New User/Assistant readers consume only new members; old config fields are not read fallbacks. Saving old rows retains their original old members without continuously updating old snapshots.
- `SessionStorePort`'s per-session `migrateLegacyModelSelection` and bootstrap recovery calls were removed. Migrations are gated by library versions, not by every recovery.
- Migration SQL targets records with clear old sources; unknown builtin identities are not bound, original sources retained. Plain history model sources require no Registry/Account queries.
- Updated databases do not touch task activity times, accepted input's modes/orders/execution bindings. Old messages' already-shipped `modelSelection` representations must be source-distinguished — never mistake shipped fields for un-shipped intermediate states.

## B. App Libraries

TaskIndexRepo/AutomationRepo/OffPeakTaskRepo share `tasks-index.sqlite`. Table creation/column supplements are unified to library-level versioned migrations (existing necessary initialization kept). Unified entry points are owned by services/session's task library modules; all three Repos call them before opening reads/writes; Agents' concrete adapters are not cross-domain reused. Table creation, column supplements, and indexes belong to migration 0001 (taking over existing/partial tables); Provider data transformations belong to 0002. IMMEDIATE transactions with library-level ledger verification, rolling back on failure. Declarative SQL/column lists participate in checksums; TS data transformations use frozen semantic version identifiers — `function.toString()` cannot be a checksum (packaging rewrites function texts), and shipped transformation implementations cannot be edited in place.

Automation's old default selections are written as JSON null during migrations; existing-but-undetermined old selections stay SQL NULL and executions require re-selection. Normal dispatch no longer checks old model columns. Off-Peak old data has no Provider identities and cannot be supplemented from current accounts; Tickets/old columns retained; current valid new selections are the only availability source.

Old ACP ID cleanups predate this round and are not re-decided; idle markings/grouping and deleted-reference cleanups are reproducible association projection maintenance, not Provider data transformations. TaskIndex's `model` is list-display fact — not an old-Selection read bypass to delete.

Minimal compatible writes: old-version model-switching Readers unconditionally read `toModel.providerID`, so timeline adds preserve one old toModel object; protocol mappers' `modelRefFromInternal` unconditionally reads `user.model`, so Users preserve a minimal old model object. Assistant old protocol mappers construct source objects that remain readable with missing fields — no universal dual-writes.

Copy boundaries: logical Readers carry no old model fields, so forks cannot regenerate old snapshots from them. Storage writes accept optional original record coordinates (`sessionID`/id); adapters retain original records' old fields during copies; Core only passes original/target IDs. Atomic fork bundles carry messages/Parts' coordinate maps inside existing transactions; no separate migration services or read fallbacks.

App eight-table conclusions: `automations`' old model/provider/thought_level generate model_selection; `automation_runs` old versions have no reliable complete identities — no guessing of historical execution selections; `off_peak_tasks` retains all old model fields and Tickets, missing identities not bound; `tasks` and the four grouping/order/workspace-association tables keep original records. New unique ledger: `tasks_schema_migration`.

## C. Call Chains, Integrity Reviews, And Scopes

- Owners: Agent — `sqlite-session-store.ts` opens, then `migration-runner.ts` applies 0020, then Repo reads/writes; App — the three Repos' initializations call `tasksDatabase/migrations.ts`. The two physical libraries account independently with independent transactions and never import each other's concrete adapters.
- Transformation sources were compared item-by-item with the old-baseline library formats and the implementation baseline's `model-selection-migration.ts` / `automationSelectionMigration.ts`; those two files and the SessionStorePort per-session migration APIs were deleted. Frozen SQL/TS transformations never reference mutable Provider/Account rules at runtime.
- Normal entries: Agent codecs consume only new members; bootstrap's create-app, message-mappers, and transcript-hydrations no longer restore old selections. Apps' Automations distinguish JSON null vs SQL NULL with no old-column fallbacks; OffPeak `projectModelSelectionIssues` only projects errors — list/get never writes migrations.
- Producers: Core's message persistences still go through Ports; SQLite adapters define physical compatibility fields. `session-fork.ts` atomic bundles and `workspace-checkpoints.ts` copies pass original record coordinates. Shared sessions' explicit imports keep independent import boundaries — no plain read fallbacks.
- Workflows: `repositories/script-workflow-runs.ts`, `script-workflow-activities.ts`, and `session-inputs.ts` unchanged from old baselines; workflow scheduler/expert models are event/execution facts, not persisted state to re-interpret.
- Full-repo search for database drivers/table creation/path entries: the two libraries above are the only Provider-refactor SQLite owners. Chrome cookie reading and stability telemetry only diagnose SQLite errors — no third owner. JSON/Markdown configs, external caches, and third-party libraries are not in DB migrations.
- Dual review: old fields and values protected by original SQL assertions; current protocols/executions never restore from old fields; missing configs block only model-needing executions; Provider mappings do no account queries or entitlement judgments; historical provenances not mapped; owners/workspace identities, continuous/replayable, and Ticket policies unchanged.

## D. Verification Evidence And Restrictions (2026-09-10)

- Agent batch 10 files 195/195 passed (migration, session-store, physical codecs, App/Protocol unbound resumption, shared context imports, forks); `provider-migration-unrelated-tables.ts` provides legal fixtures for 22 business tables, validating full rows, foreign keys, old ledgers, times, and contents. App batch 9 files 137/137 passed, including eight-table protections, fault rollbacks, partial-column takings, checksums, two-thread single conversion, offline modes, and Ticket retention.
- Frozen Readers (both sides' `tests/fixtures/staging-backup-*-readers.mjs`, from fixed `790884b1ce`) prove new-version data is processable by old content-reading chains — not a complete old Electron version declaration.
- Root typecheck/lint (42 existing warnings / 0 errors), architecture check 0 violations, Agent package type checks, and builds passed. Agent's own stricter lints keep 8 existing over-length files — root passes are not Agent full-green. Full-repo `pnpm knip` keeps large existing prompts — not claimed passed.
- Known existing failure: `runtime-unbound-resume.test.ts` expects `Select a model before continuing`, actually `Model creation failed`; reproduces on fixed baseline Core. Executions still reject missing configs before model creation — not expanded this round.
- Pro: isolated directory run `desktop-e2e-20260910130906791-p75075-7e14793053e6f24c`, 1 spec / 1 test PASS chaining four cold-start scenarios: first startup migrates old selections and retains original fields; missing tiers/illegal Providers do not hinder history display; rollback-written missing new fields do not re-run 0020; re-selection then same-Session submit and replay replies succeed. No real model services called.
- DB109-01~13 covered; **DB109-14 partially verified**: desktop local real machines, two protocol clientModes, and workspace identity unit tests passed; mobile shared-host + real SSH/WSL joint E2E and Windows not run — protocol unit tests are not joint real machines. CLI coordinator synchronization unconfirmed; pre-releases still require team confirmation.

## E. Review Gap Remediation (2026-09-10)

Highest principle: **rollbacks, or upgrades after rollbacks, may cause model selection failures and user re-selections; but this round's selection format changes must never make sessions/tasks unopenable, lose content, or throw during reads. Pre-execution config validation is retained with no secret replacement; this does not swallow real exceptions such as database corruption or IO failures.**

Two fixes and boundaries:

1. `0020` produced `modelSelection: null` for old Users with undeterminable model identities; original Readers passthrough caused protocol `info.model` validation failures. Fix: SQLite Readers parse and project illegal new configs as missing using the common Selection structure. Timeline/Subtasks' incomplete identities are validated the same way; legal historical identities, tiers, and Timeline labels retained; no Registry/account queries. No modifying submitted migrations' SQL/checksums, no disk old-value patching, no old-field fallback restoration.
2. restore plugins wrote SQL directly, bypassing Writers' old User minimal objects; frozen old Readers failed on missing overall `model`. Import scripts add `model: {}` — old-version models may fail but contents stay readable; current readers still use only `modelSelection`; no Assistant dual-writes, no ACP source-identity re-decision.

```text
Old library first upgrade -> existing 0020 -> SQLite Reader structure validation -> content/protocol normal reads
Rollback writing old formats -> re-upgrading (ledgers not re-run) -> missing/illegal new selections not blocking content
Explicit restore imports -> new selections + minimal old objects -> new/old Readers both readable
```

Added proofs: `database-rollback-readability.test.ts` executes real migrations, SessionStores, protocol mappers/schemas, and frozen `790884b1ce` Readers (empty old objects, half-incomplete identities, nulls, missing new fields, error-type tiers); real restore CLI subprocesses import Users/Assistants then read in old Readers and re-upgraded protocols. Agent 6 files 96/96, App 2 files 10/10 passed; red-then-green, legal-but-unknown-Provider selections retained. Pro re-verification `desktop-e2e-20260910150113615-p79512-7b913cccfacc70a8` passed the same four scenarios; one earlier failed run never entered migration fixtures and passed after adding "expand details" diagnostics without product changes — not counted as a pass, not claimed as first-run stability. Complete old-version Electron binaries, mobile shared-host/real SSH joint, and Windows GUIs remain unverified.
