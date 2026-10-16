# Todo104 Impact Boundaries and Cases

## B5 Final Migration Evidence Correction

Cross-platform acceptance supplement: cache directory uses `node:path` for construction and segmented assertions; you cannot treat POSIX `/` as a Windows file path separator in tests. Retain assertions for environment, platform, version, Endpoint hash, and filename; this only fixes test portability, not proof of having run on Windows.

After rebuilding all CLI dependencies, App/Protocol cold recovery tests fail because the new `saveSessionEntry` seeds the old identity: this interface now writes `data.modelSelection`, so the old ID should no longer be re-migrated. Old branches must seed SQLite flat `providerId/modelId/thoughtLevel` directly, then verify complete App/Protocol recovery; current selection branches continue through the official writer, without changing their invalidation/clearing/message non-regression assertions. Plain default selection override tests use the new `options.reasoningLevel`, without feeding old tier fields to the new logic interface. This fixes test data sources, not adding unshipped compatibility.

## B4 Paths and Source Identifiers (2026-09-10, pre-implementation supplement)

Shares final build and Pro regression with B2/B3. Download/refresh paths unify to environment `runtime/provider/<platform>/<version>/<endpoint-key>/`, distribution records as `runtime/provider/provisioning.json`; package release entry uniformly reuses Node materializer, receiving environment config root directory, fixed write to `runtime/provider/bundled/zcode-builtin.json`. Normal exit from old program before upgrade; do not migrate unshipped caches, do not delete old directories, do not redo refresh lease.

Source identifiers continue using the already-injected Active file path: this path contains an isolation key with normalized Endpoint. Node Source hashes the absolute normalized path, combined with numeric release revision to form runtime revision; Host and Workers reading the same Active file use the same algorithm, without adding a second account field or transport protocol. Direct file Source similarly determines scope by its path. File-internal release revisions remain original safe integers, not renumbered by path.

```text
Endpoint → Platform/Version/Normalized Source Path → Host Source revision
                                      |
                             Existing Path Injected into Worker
                                      |
                             Same Path → Same Revision
Endpoint A/B Same Release Number → Different Path Scope → Config/Account/Registry Correctly Distinguish
```

| Case  | Verification Contract                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B4-01 | Three-layer path isolation and Origin normalization retained; filename/distribution record path conforms to final decision                                                   |
| B4-02 | Fixed bundled file content identical → no write; changed → atomic replace; concurrent reads see complete old/new files; write failure retains old file and cleans temp files |
| B4-03 | Two Endpoints same release number, different models: Config and Registry cannot reuse old results; Account follows identifier, Worker reading same file gets same identifier |
| B4-04 | CLI SEA and Server reuse same materialized interface, no longer duplicate hash file logic; new directory startup, refresh control, and final five schemaVersion=1 support    |

GLM integrity old test correction based on §6.3.1: account tests use the Provider's actual Endpoint, cannot substitute `/api/coding/paas/v4` which is outside its declared scope; model itself and site coverage are separate assertions. Same Endpoint plain API Key hitting media coverage is an approved behavior, not a test-added capability.

## B2/B3 Complete Rule Read/Write Batch (2026-09-10, pre-implementation supplement)

This batch connects the rule sets for Todo104 §6.1–6.9, name/template ownership, and Personal files. New strict data schema uses targeted tests first, then replaces existing codec, behavior rules, Resolver, settings writes, and import/distribution consumers in the same batch; cannot simply add an unused new schema and declare completion. Old broad Match schema, field-guessed grouping, fixed-mode boolean values, and nested identity fields are removed at the final read/write entry point.

```text
Source File → Belonging Collection Strict Schema → Rule/Index with Retained Hierarchy
                                 → Original Priority Resolver → Settings View/Registry
Settings Save/Import → Same Source Rule Schema → Personal File Lock Atomic Update
                                      └─ Name Deduplication/Default Selection/Other Configurations Retained
```

| Case   | Contract to Prove                                                                                                                                                                            | Evidence                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| B2R-01 | Match three-layer strict isolation; API/URL regex illegal, old fields/type all rejected; original valid match scope retained                                                                 | schema + Resolver targeted tests                |
| B2R-02 | Complete Manual only relaxes enabled; per-leaf default/null, illegal values/Map rejected; sparse smart allowed; same model across two groups rejected                                        | schema + save/restart tests                     |
| B2R-03 | Provider/Template identity outside rules, duplicate at same layer rejected; Template keys, Builtin personal members, Personal Account access cannot cross authority                          | Data entry tests                                |
| B2R-04 | Each collection order preserved round-trip, no guessing layers by fields; Manual does not inherit parameters, only inherits enabled; switching collection leaves no residue from another     | codec + Resolver + ConfigService                |
| B2R-05 | Template current language/en-US/ID name fallback, case/whitespace deduplication, concurrent creation in lock without name collision; subsequent language changes do not alter existing names | Real Repository updates and settings acceptance |
| B2R-06 | Four providerMatch converted to precise Endpoint, plain API Key can hit media; Off-Peak and Start searches not unexpectedly expanded                                                         | Actual Builtin parsing comparison               |
| B2R-07 | Final empty array/file wrapper strict; Provider modification retains default selection, clearing default retains other configs; old shipped import output final structure                    | File/distribution/concurrency tests             |

This batch's consumers supplement: Settings form distinguishes display name from current rename patch; saving only API does not save inherited name, renaming only does not materialize connection fields or lose headers. Template creation passes locale, service determines current template naming; Account synchronization still uses original Provider dictionary protocol, not disk rule arrays. CLI startup and login share Personal file, first import reads old Provider and default model once; Protocol does not self-import old CLI configuration. Cases fall under `providerRuleForm`, `providerRuleFileIntegration`, `personal-config-default-integration`; original `process-provider-registry-runtime`, `account-config-delivery`, `auth-login` regression承接旧生命周期. Existing SC90/F98/W89 E2E still need batch execution after synchronizing final structure, not replaced by pure function tests.

B3 distribution closing: Source reads complete snapshot from unique Personal Repository, then compares disk content hash; bad files/changes during reads must not override remote with in-memory degraded values. Target reuses the same Repository's locked update; forward replace and failure rollback both compare entire Personal content within lock, default selection no longer read/written separately. Rollback restores complete configuration semantics (formatted by codec same as normal writes), does not alter shipped old inputs; if user has already written different C, skip rollback for that domain, explicitly report `rollback_failed`, cannot roll back C's new default selection or Provider back to A. Status/credentials maintain original domain boundaries, no global transaction system added.

```text
Complete Personal A → Source validates content → Envelope Personal B (containing default selection)
                                      ↓
Target same file lock: confirm current is still A → full replace B → refresh/verify
                                               ↓ failure
Same file lock: current is B → restore A; current is already C → retain C, report rollback conflict
```

Distribution cases: envelope has no old sourceRevision/outer configuredDefault, result configRevision corresponds to actual Config source; single and repeated syncId applications; default clearing; failure recovery Provider and defaults; failure concurrency writes to Provider/default separately protected; same file notification reaches default consumer; two real processes separately modify Provider/default without overwriting each other.

Graph boundaries follow this file's existing Surface Matrix; no new UI owner, message timing, or account sync mechanism. codegraph tool still unavailable, exact symbol search retrieves ConfigService / Facade / Resolver / Node codec and Repository; depth 2, cross-layer save and distribution extended to disk sink. No full-cargo regression runs mid-process, no Pro build; after all chains connect, share final verification.

## Feature Summary

| Field             | Content                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Intent/Capability | Retain existing Provider and Selection product semantics, implement final persistence Schema                                              |
| Layers/Mode       | persistence, validation, draft-default, option-source; planning                                                                           |
| Main Entry        | ProviderSettingsFacade / ProviderConfigResolver / createNodeModelSelectionFacade / OffPeakTaskRepo / RepoWikiStorage / SessionRepository  |
| Not Doing         | Multi-account simultaneous connection, CLI account assembly refactor, send sync gate, Subagent Markdown reformatting, old budget features |

## UI Surface Matrix

| Scenario/Entry          | Shared Implementation                | Draft/Default                   | Validation                        | Submission/Authority Point                | Mode and Isolation                                                     |
| ----------------------- | ------------------------------------ | ------------------------------- | --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| Provider Settings       | SettingsFacade/ConfigService         | Form draft, recommended rules   | Source schema/integrity           | PersonalRepository single update          | Local/remote injected services; cannot write Session                   |
| Composer                | SelectionFacade                      | Draft/Recent/default            | Valid selection/final Factory     | Session selection after successful submit | Not persisted early, does not change frozen runtime                    |
| Automation/Bot/Subagent | Shared Selection data                | Own inheritance rules unchanged | Own existing submit boundaries    | Task/bound Session/user MD                | Not shared save timing due to shared fields                            |
| Wiki/Draft              | RepoWikiStorage                      | Generation setting draft        | New selection authority           | Existing file lock save                   | No restore of manual output limit                                      |
| Off-Peak Edit View      | OffPeakTaskService.updateTask → Repo | Form draft                      | queued/paused, complete selection | off_peak_tasks.model_selection            | Only retains old column, does not change Ticket, Session, or workspace |

## Shared And Divergent Behavior

Shared model identity, capability, and option schema; each business independently owns draft, submit, and save boundaries. Default selection point changed, does not alter distinction between default selection and session persistence. Plain Account valid selection still uses current rules; Off-Peak bound ticket not cross-account re-parsed.

## Feature Relationships / State Owners And Commit Sinks

| Priority       | Relation                                      | Owner/Sink                            | Evidence and Reason                                                                                            |
| -------------- | --------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| must-inspect   | Off-Peak Edit → Unique Repo Save              | OffPeakTaskRepo / SQLite              | updateEditableFields currently actively clears old column; Service only normalizes submitted fields            |
| must-inspect   | Wiki Save → File Atomic Update                | RepoWikiStorage                       | Runtime object cannot carry old values as second authority; save layer retains original values                 |
| must-inspect   | Session Selection → entry.data                | Agent SessionRepository               | Recovery/update/fork must consistently identify new packaging                                                  |
| must-inspect   | Config Source → Resolver → Registry           | Provider layer; Node layer handles IO | One-way schema dependency, complete config admission, same source snapshot                                     |
| must-inspect   | Default Selection/Provider Update → Same File | PersonalRepository                    | Cannot overwrite each other, distribution failure only rolls back this time's result not concurrently replaced |
| conditional    | New Path → Packaging/Host Startup             | Each host injects Node path           | Desktop/CLI/Server all need actual artifact verification                                                       |
| invariant-only | Mobile/Desktop Message Delivery               | Same Session owner                    | Does not alter continuous/replayable and workspaceIdentity isolation                                           |

## Must-Preserve Invariants

- Shipped old values only serve as rollback snapshots; after new selection exists, old fields are not re-read as invalid/cleared.
- Read/write through existing owners; UI does not directly access Repo, Service does not reference concrete Runtime; IO does not enter Provider domain.
- Off-Peak old/new column difference does not mean re-migration; Ticket, queue claim, remote disable all unchanged.

```text
Form Submit → Service existing validation → Repo updates new selection/business fields → SQLite
                              └─ Old model/thought_level original values unchanged
New Read ───────────────────────→ model_selection
Old Rollback Read ──────────────────────→ Old column snapshot
```

## Codegraph Evidence / Graph Drift / Graph Delta

Current tools do not provide codegraph entry; repository package scripts also not configured; using exact symbol search as replacement, not treating text hits as semantic dependencies. First group expansion depth 2: OffPeakTaskService.updateTask unique call Repo.updateEditableFields, Repo row conversion only reads new selection, old columns read by migration issue diagnostics. Complete Schema group to be supplemented with actual call evidence later.

Several Provider fields and old stratification descriptions in the graph will be updated after B2 modification; currently not writing future fields as implemented facts. B1a only supplements invariant of retaining old columns; all other existing product boundaries unchanged.

## Unresolved Questions / Clarification Log

User this time explicitly authorized implementation of final decision. B1a has no new product issues; B1b/B1c clearance must follow existing upper-layer constraints, surveyed and recorded, not independently adding universal null schema. Other scopes requiring new decisions only pause related items.

## Planning Handoff / Domain Scope / Dimensions

This file and Todo104 are spec/case entry points. First group only stores and migrates, does not alter interaction; database integration tests cover real writes and restarts. Settings UI group to independently supplement E2E handoff, cannot use this group's pass as full-end verification.

Dimensions: with/without old columns, title/new selection editing, queued/paused/other states, pre/post restart; do not expand network and theme combinations, as this group does not alter requests or display. Ticket fields verified against invariants.

## Candidate Combinations / Pruning Decisions / Accepted Cases

| ID     | Status and Action                                     | Assertion/Evidence                                                                                       | Decision                              |
| ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| B1a-01 | Legacy dual-format records; title only change         | Original old column values unchanged, new selection/Ticket unchanged                                     | accepted, SQLite integration          |
| B1a-02 | Same record modified new selection, tier, and restart | New reader uses new selection; frozen staging column shape still readable old values                     | accepted, SQLite integration          |
| B1a-03 | Create then modify selection                          | Old column remains NULL, no fabricated old format                                                        | accepted, SQLite integration          |
| B1a-04 | null selection/runtime editing                        | Follows existing rejection, no new clear semantics added                                                 | accepted, existing service/Repo tests |
| B1a-P1 | Model request, quota, network, theme combinations     | Save layer changes do not touch these states; follows existing evidence, does not re-accept old features | pruned                                |

## Matrix Backfill / E2E Handoff Notes

B1b supplement: current Wiki already has Todo97's one-disk migration and null empty marker, Todo104 original "read memory conversion each time" is outdated. Following this marker satisfies clearance no-respawn, no need for new universal schema decision. Migration, normal save, and deletion continue sharing file lock, official reader filters old fields.

| ID     | Scenario                                                            | Assertion                                                                                                            | Decision                          |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| B1b-01 | Wiki/Draft first migration and subsequent modification              | Old model/tier/budget original values retained, body/charts/new selection updated, reader does not return old fields | accepted, real temp files         |
| B1b-02 | Dual-format document clear/illegal new selection after save restart | Empty marker retains authority, old selection does not respawn                                                       | accepted, real files              |
| B1b-03 | New folder with old fields                                          | No writes fabricated old values, no restores budget                                                                  | accepted                          |
| B1b-04 | Save rename failure, migration/save/deletion concurrency            | Original text undamaged, lock internal re-read obeys latest facts                                                    | accepted, barrier/fault injection |

No new UI interaction or generation rules, B1b does not add E2E; existing Service model Limit assertions follow group regression. Private storage types involved do not leak to protocol and UI.

B1a tests reside in `services/test/offPeakTaskRepo.test.ts`; no UI behavior changes, no new E2E created. Uses temp SQLite, touches no real data, requires no model fixtures, uses no time waits. Other groups to add cases and required E2E matrices before implementation.

## B1c Session Storage Boundaries (Pre-implementation confirmation)

The sole persistence owner is SQLite SessionStore adapter. `SessionEntryInfo.data` is the port's logical payload: model selection still the public ModelSelection (fork has no selection, uses null); disk `session_entry.data` is the wrapper that retains old snapshots. Following existing codec boundaries for wrap/unwrap, do not let core/bootstrap write separate processing for SQLite rollback fields. Normal saves, runtime saves, and atomic fork bundles all use `saveSessionEntry`; recovery unified through `decodeSessionEntryRow`. Table/schema, submission timing, protocol, and message lines all unchanged.

```text
core/bootstrap current selection → SessionStore.saveSessionEntry
                        → single UPSERT: old JSON + new modelSelection
Cold recovery/fork read ← codec only unwraps modelSelection ← SQLite
First old data migration → transaction re-reads old candidate → same UPSERT
```

UPSERT only replaces new members inside the database, avoiding application-layer read-modify-write windows; retains all other members of the disk object. New records only write new members. Migration only reads published flat `providerId/modelId/thoughtLevel`, including custom Providers without thoughtLevel; does not make unshipped options format a compatibility contract. New member exists (including null, illegal values) blocks old field/message rollback. codec does not expose old snapshots to business; unmigrated old records cannot be treated as formal selections. Fork child records only carry their own current selection, not copy parent rollback fields.

| ID     | Scenario                                                 | Assertion                                                                                                           | Decision                                          |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| B1c-01 | Old Account/custom entry, with or without thoughtLevel   | Original id/type/old fields/unknown members each value retained, new member correct, migration idempotent           | accepted, real SQLite                             |
| B1c-02 | Post-migration normal save, clear, restart               | Only new members changed; new null/bad values do not respawn old values; does not touch session activity time       | accepted                                          |
| B1c-03 | Migration from old messages                              | New entry only new members, old message bytes unchanged                                                             | accepted                                          |
| B1c-04 | Runtime switch, cold recovery, fork bundle               | Existing ModelSelection port contract unchanged round-trip, child selections isolated from parent                   | accepted, adapter/core/bootstrap joint regression |
| B1c-05 | Migration/subsequent write concurrency and write failure | Single transaction/single UPSERT, no old read overwrite, failure old data still complete                            | accepted, transaction/fault injection             |
| B1c-P1 | UI/network/theme/queue full permutations                 | Does not alter interaction, continuous/replayable, or input admission; existing runtime layer regression represents | pruned                                            |

Supplementary architecture tool facts: `architecture:check --changed` shows no violations; `cli-adapters` is not yet an architecture-policy managed module, context command returns unknown module, using existing SessionStorePort and CLI AGENTS as boundary basis, not expanding governance modules for this.

B1c E2E contract synchronization: existing `unbound-resume` seeds current selection via raw SQL, OffPeak existing session cases check selection via raw SQL; both must read/write disk `data.modelSelection`, not via logical port. Case semantics unchanged, only fix fixture/assertion paths. Still pending, not treating static contract update as machine-pass; merged re-verification after final shared Pro build.

## B2a Model Data Schema Single Source

First extract Model data constraints from codec with class transform. Complete data schema declares leaves; sparse coverage derived from it (can be default/null, nested also remains sparse). Construction input/serialization types derived from respective schemas; behavior classes retain overlay/freeze, `validateComplete` only calls complete schema, and translates existing problem paths. Registry complete types reuse same derivation results. No new IO, state owner, subscription, execution selection, or UI interaction.

```text
Pure data schema → Derived types + Complete/sparse validation
       ↑                  ↑
Behavior class overlay/freeze    codec parse → Behavior class
       └──── Complete admission → Registry
```

This step does not independently publish format changes; subsequent B2 field renames/grouping directly modify the same schema and consumers, no compatible temporary format. Current complete configuration includes `enabled`; Manual mode's `enabled` exception derived from subsequent manual rule schema. Parse allows sparse, but cannot accept illegal values; complete admission must reject missing nested leaves, non-positive/non-safe integers, blank/duplicate tiers, and invalid maps. Error classification distinguishes missing fields, illegal options, and other illegal configs, retaining existing paths; does not alter network failure or other business strategies.

| ID     | Settings/Action                                                     | Assertion                                                                                                 | Decision                           |
| ------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| B2a-01 | Sparse parse and complete instance admission pass same illegal leaf | Both rejected; cannot pass relying on type assertions                                                     | accepted, unit tests               |
| B2a-02 | Complete data per-leaf deleted/null                                 | Complete admission rejected; sparse overlay allowed and applied with original clear semantics             | accepted, schema/overlay           |
| B2a-03 | Legal complete config, arrays, maps                                 | class/toJSON/parse round-trip, freeze, Registry results unchanged                                         | accepted, existing rule regression |
| B2a-04 | Module dependencies and derived types                               | Base schema does not import behavior classes; codec/classes/Registry do not maintain parallel field types | accepted, type check + review      |

Provider context generated: current module unmanaged/no independent contract, continue using existing config public entry, do not expand governance modules. New schema files only for Provider internal use, no IO in domain layer.

## B2b Provider Data Schema Single Source

Continuing B2a one-way dependency, Provider/API/Access fields and enums defined in pure data schema, behavior class input/JSON/Registry types derived.

Provider integrity retains existing required scope: group, api.type/baseURL, Access corresponding branch execution fields; label/logo/members/headers/management URLs add no new required fields.

`entitled=false` is complete but without rights, not disguised as having rights by integrity check; `hidden` still does not exempt checks. Access type switching replaces entirely, does not mix two credentials.

Provider source write permissions limited by same schema's pick/omit/extend, retaining Account only members/rights, Template no real Keys, Personal no fixed account Access constraints.

Personal endpoints can still temporarily store text not yet correctly filled, ultimately rejected by Registry; cannot let a single bad endpoint block entire Personal file due to unified schema.

Does not alter account services/synchronization, Provider status, or message timing; current basic batch does not change release field names.

| ID     | Scenario                                                               | Assertion                                                                                               | Decision                             |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| B2b-01 | Unknown API type/group outside type boundaries, illegal management URL | Complete check rejected, cannot just check non-null and accept into Registry                            | accepted, red-test first             |
| B2b-02 | Two Access types complete/sparse/clear/switch                          | Only requires this branch's required fields, optional can still be default/null, false rights unchanged | accepted                             |
| B2b-03 | Personal invalid endpoint + same-file legal Provider                   | Bad items retained editable, only blocks own Registry admission; valid items still executable           | accepted, retain existing regression |
| B2b-04 | Source config permissions and serialization                            | Shared schema derived, rejects authority-crossing fields, class/JSON/freeze behavior unchanged          | accepted                             |

## B2c Delete OptionSpec Redundant type

Execute §5.5: `reasoningLevel` fixed by member name as values/map, `maxOutputTokens` fixed as max/map, delete their `type`, do not delete Provider API/Access or outer rule still using discriminator.

Single field definition follows B2a data schema; behavior classes no longer retain/write back redundant fields. Shipped old Provider imports still converted via original entry point, unshipped Config old types not treated as compatibility.

CLI ModelOptionSpecs contracts structurally consistent with Providers, settings forms no longer create this field, default Built-in upgraded content revision in same batch; real request `reasoning/max token` map behavior unchanged.

```text
Settings Draft / Built-in / Old Format Import
              → Redundancy-free OptionSpec
              → Same Integrity Validation → Registry → Original Map → Original Request Fields
```

| ID     | Scenario                                                      | Assertion                                                                                                | Decision                                              |
| ------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| B2c-01 | New complete OptionSpec has no type                           | parse/class/serialize/Registry usable, map request values unchanged                                      | accepted, red-test + config/request regression        |
| B2c-02 | Old unshipped type still in Config                            | strict parse rejects, does not secretly strip, does not alter shipped migration input contract           | accepted                                              |
| B2c-03 | SC90-01 adds manual config, edit back to smart config         | Both saved options have no type, original failed draft/disabled retained/recommended assertion unchanged | accepted, existing pending E2E supplemented assertion |
| B2c-P1 | Redo all client UI, theme, request protocol Cartesian product | Does not alter layout, events, message timing; reuses shared forms and existing request layer matrix     | pruned                                                |

Current Model settings entry still submits sparse or complete personal configs via ProviderModelMetadata; no need to add new UI state, subscriptions, or async requests. This batch does not take over default selection persistence, does not change Session submit boundaries. Existing SC90/F98 case-local `none-provider` fixtures continue to be reused, not automatically promoted; Pro uses isolated directory to build current code for verification.

## B2d Model Final Fields And Cross-Layer Single Data Contract

Execute §5 remaining fields: `inputFormat`/`outputFormat`, `supportsText`/`Image`/`Video`/`Audio`/`Pdf`; `requiresMfjsToolSchema` moved to properties. Complete/sparse meanings unchanged, unshipped old names not accepted, no dual-read. All current configs, UI forms, CLI model attributes, and protocol media projections all synchronized; SDK raw request body, tool Schema, and external command same-name strings are not rename targets.

Data contract ownership: Model pure data schema needs to be used jointly by Provider, CLI contracts, and shared protocol, moving B2a's single schema to shared's independent `model-config` sub-path (without introducing Provider behavior classes). Shared only adds dependency on pure expression compilation library `model-option-map`; this library has no Provider/shared dependencies, no IO. Original Provider internal definitions deleted, no parallel schema or transit compatibility left. Provider behavior classes continue as sole responsibility for overlay/freeze/Registry admission, CLI Model data types and protocol format projections derived from same schema.

```text
shared/model-config (pure schema + content validation; depends on IO-free expression compilation library)
       ├─ Provider behavior classes / Config codec / Registry
       ├─ shared protocol media field projections
       └─ CLI contracts (type derivation) → core / adapters
```

This dependency direction avoids shared reverse-import of Provider implementations and package-level cycles; does not change state owners, subscriptions, effective selection, sync frequency, task dispatch/persistence timing. `ModelRequest.maxOutputTokens` still a real request option, not belonging to Selection migration.

| ID     | Scenario                                                                            | Assertion                                                                                           | Decision                                |
| ------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- |
| B2d-01 | Final ModelConfig complete/sparse input and per-leaf default/null                   | New structure complete admission; null retains clearing, old names/top-level MFJS strictly rejected | accepted, red-test/node configs         |
| B2d-02 | Explicit MFJS true/false override, manual/smart save                                | Only writes to properties; boolean controls/personal override markers and re-open values unchanged  | accepted, form unit tests + SC90        |
| B2d-03 | CLI media filtering/PDF/generation/stream and protocol model candidates             | Same capabilities read from new attributes, request maps and message content unchanged              | accepted, contracts/adapters/core tests |
| B2d-04 | New Builtin disk落盘 and content comparison                                         | Only field renames/moves and revision changes, map/limits/capability values each value retained     | accepted, semantic JSON comparison      |
| B2d-P1 | Redo UI, account connections, remote control sync, shipped old config compatibility | Not this item's semantic changes, retain current boundaries; unshipped old Config not compatible    | pruned                                  |

Implementation split into two verifiable steps: B2d-contract first moves pure schema and eliminates CLI/protocol duplicate definitions, keeping fields and values completely unchanged; B2d-fields simultaneously updates all consumers and Built-in. First step does not declare final fields complete, does not upgrade Built-in revision. Public sub-path tests verify real protocol uses same field schema object, sparse/complete constraints, expression validation, Provider round-trip; CLI types constrained by bidirectional type equality assertions. No new business state or UI interaction, no additional desktop cases; field step continues updating and running SC90.

Common `sparseShape` primitive moved to shared `config-schema` sub-path, Model and Provider schemas both reference it; this module only derives nullish fields, does not contain source permissions or business rules. Shared layer exports derived Model data types, CLI uses type-only aliases to keep original public type names; CLI contracts using Zod 3 need not re-derive Zod 4 schemas locally.

Actual lock file has `shared=Zod4.3.6`, `provider/provider-node=4.4.3`, same `^4.3.6` declarations do not guarantee composable Schema types. Type checking has proven the two internal version types are incompatible. Only fix these three directly-combining config Schema packages to shared's already-used 4.3.6; not upgrading full-cargo dependencies, not modifying CLI's Zod3, not using any/cast or second schema to bypass. Complete configuration and error classification regression must re-run on final lock file.

B2d fields continue closing by contract granularity: first replace seven old media format fields with final naming (Builtin revision 14→15), each end/current fixture updated in same batch; MFJS structure move then handled separately for boolean override semantics, cannot use simple text replacement mixed into this batch. Shipped migration inputs unchanged, current Model fixtures in scripts only updated. Old unshipped formats strictly rejected with explicit negative examples. UI input/output Draft types also reference shared derived types, avoiding re-handwriting synonymous interfaces; does not alter layout or control copy.

Pro rebuild found B2d-contract's two new shared sub-path omissions for CLI `esbuild` exact aliases; generic prefix would incorrectly splice as `index.ts/model-config`. This round fills existing build entries and alias contract tests, does not redo build system; real Agent build must succeed before continuing E2E, cannot use desktop Renderer build pass as Agent closure verification.

Shared pure expression library new dependencies also affect shaven Docker build contexts: all explicit `COPY shared` Dockerfiles must simultaneously `COPY` `model-option-map` manifest and source code. v4 has it, Share and old remote templates missing; this round only supplements new dependencies, does not fix other old template deficiencies. Share does not import Provider behaviors, so its generic shared alias does not yet consume new sub-path, not modifying configurations without basis; actual local Share builds and static dependency boundary tests verified, Docker image real builds not substituted as passes.

### B2d-MFJS: Unique Property Ownership

`requiresMfjsToolSchema` moved from ModelConfig top-level to properties, complete `ModelProperties` required boolean, sparse `properties` still allows default/null. Built-in only moves original values (revision 15→16), does not add capabilities. ModelConfig no longer separately overlays/serializes this field, handled uniformly by `ModelPropertiesConfig`. CLI Adapters no longer copy second MFJS value in `ResolvedAiSdkModel`; `generate/stream` two tool projections both read from fixed execution Model's properties; tool transform private options still retain original boolean parameters, does not alter true MFJS schema content.

UI adds MFJS to property group source markers and sparse writes; smart mode untouched `false` must not spawn overrides, explicit `true`/`false` and `null` each retain their semantics. Closing smart config still materializes complete properties, does not enable models by repositioning; switching back to smart post-cleanup and re-edit still follow existing draft flows. Tests first prove false/true/null, complete missing, old top-level rejected, and smart/manual save, re-open, highlight, and request tool schema true/false branches. Pro SC90 adds real MFJS switch and re-open assertions, F98 existing border/layout behaviors retained.

### B2e: Provider Members And Endpoint Naming

New configs uniformly use `personalModelIds`、`api.baseUrl`; Built-in/Personal/Account/Registry/settings page consume same data contract. Member ownership unchanged: `builtinModelIds` is non-deletable source members, `personalModelIds` only user-added members, `modelOrder` is their display order. SDK creation parameters `baseURL`, shipped old Provider `endpoints.baseURL`/`options.baseURL`, and business local sort parameter `modelIds` are not rename targets; old migration inputs read as-is, converted new ProviderConfig uses new fields. Model rule query parameters/Match structures left for rule group to re-unify, not mixed into this change.

Test new fields complete/sparse round-trip, null clearing, old unshipped fields strictly rejected first, then modify all consumers. Reuse member add/delete/dynamic account members/sort/form headers retained and migration tests; add real SDK outbound URL assertions, proving new `api.baseUrl` still maps to SDK-required `baseURL`. Settings page follows existing interactions and Pro cases, config contract renames do not alter page copy and layout. Builtin content comparison only moves fields and revision 16→17, cannot change model lists, Maps, or endpoint values; labels/template ownership and rule arrays handled by other groups, does not declare Provider final structure complete.
