# Todo104 Impact Boundaries and Cases

## B5 Final Migration Evidence Correction

Cross-platform acceptance supplement: cache directories are built and asserted with `node:path` segmented assertions; tests must not treat POSIX `/` as a Windows path separator. Keep assertions for environment, platform, version, Endpoint hash, and filename. This fixes test portability only, not proof of a Windows run.

After rebuilding all CLI dependencies, App/Protocol cold-recovery tests failed because the new `saveSessionEntry` seeds the old identity: this interface now writes `data.modelSelection`, so an old ID must not be re-migrated. Old branches must seed the SQLite-flat `providerId/modelId/thoughtLevel` directly and then verify complete App/Protocol recovery; current-selection branches keep going through the official writer, with their invalidation/clearing/message non-regression assertions unchanged. Plain default-selection override tests use the new `options.reasoningLevel`; do not feed old tier fields into the new logic interface. This fixes test data sources, not an unshipped compatibility layer.

## B4 Paths and Source Identifiers (2026-09-10, pre-implementation supplement)

Shares the final build and Pro regression with B2/B3. Download/refresh paths unify to environment `runtime/provider/<platform>/<version>/<endpoint-key>/`; distribution records go to `runtime/provider/provisioning.json`; the package release entry reuses the Node materializer, taking the environment config root and writing fixed `runtime/provider/bundled/zcode-builtin.json`. Old programs exit normally before upgrade; do not migrate unshipped caches, delete old directories, or redo the refresh lease.

Source identifiers keep using the already-injected Active file path: the path contains an isolation key with the normalized Endpoint. The Node Source hashes the absolute normalized path combined with the numeric release revision to form the runtime revision; Host and Workers reading the same Active file use the same algorithm — no second account field, no transport protocol. Direct file Sources likewise scope by path. Release revisions inside files stay original safe integers, not renumbered by path.

```text
Endpoint → Platform/Version/Normalized Source Path → Host Source revision
                                      |
                             existing path injected into Worker
                                      |
                             same path → same revision
Endpoint A/B same release number → different path scope → Config/Account/Registry correctly distinguished
```

| Case  | Verification contract                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B4-01 | Three-layer path isolation and Origin normalization retained; filename/distribution record paths match the final decision                                                            |
| B4-02 | Fixed bundled file identical → no write; changed → atomic replace; concurrent readers always see a complete old-or-new file; write failure keeps the old file and cleans temp files  |
| B4-03 | Two Endpoints, same release number, different models: Config and Registry cannot reuse old results; Account follows its identifier; a Worker reading the same file gets the same one |
| B4-04 | CLI SEA and Server reuse the same materializer interface, no duplicated hash-file logic; fresh-directory startup, refresh control, and all five schemaVersion=1 variants supported   |

The GLM integrity old-test correction follows §6.3.1: account tests use the Provider's actual Endpoint; do not substitute `/api/coding/paas/v4`, which is outside its declared scope. The model itself and site coverage are separate assertions. A plain API Key on the same Endpoint hitting media coverage is approved behavior, not a test-added capability.

## B2/B3 Complete Rule Read/Write Batch (2026-09-10, pre-implementation supplement)

This batch wires the rule sets for Todo104 §6.1–6.9, name/template ownership, and Personal files. The new strict data schema gets targeted tests first, then replaces the existing codec, behavior rules, Resolver, settings writes, and import/distribution consumers in the same batch — adding an unused new schema alone is not completion. The old broad Match schema, field-guessed grouping, fixed-mode booleans, and nested identity fields are removed at the final read/write entry point.

```text
Source file → belonging collection strict schema → rule/index keeping hierarchy
                                 → original priority Resolver → Settings View/Registry
Settings save/import → same source rule schema → Personal file locked atomic update
                                      └─ name dedup / default selection / other configs retained
```

| Case   | Contract to prove                                                                                                                                                               | Evidence                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| B2R-01 | Match three-layer strict isolation; illegal API/URL regex, old fields/types all rejected; original valid match scope retained                                                   | schema + Resolver targeted tests    |
| B2R-02 | Complete Manual relaxes only `enabled`; per-leaf default/null allowed, illegal values/Maps rejected; sparse smart allowed; the same model in two groups rejected                | schema + save/restart tests         |
| B2R-03 | Provider/Template identity outside rules, duplicates at the same layer rejected; Template keys, Builtin personal members, Personal Account access cannot cross authority        | data-entry tests                    |
| B2R-04 | Each collection's order round-trips; no layer guessing from fields; Manual inherits only `enabled`, not parameters; switching collections leaves no residue from the other      | codec + Resolver + ConfigService    |
| B2R-05 | Template current-language/en-US/ID name fallback; case/whitespace dedup; concurrent creation inside the lock without name collision; later language changes keep existing names | real repository updates + settings  |
| B2R-06 | Four providerMatch converted to precise Endpoint; plain API Key can hit media; Off-Peak and Start searches not unexpectedly widened                                             | actual Builtin parse comparison     |
| B2R-07 | Final empty array/file wrapper strict; Provider edits keep the default selection, clearing the default keeps other configs; old shipped imports output the final structure      | file/distribution/concurrency tests |

Consumer supplements for this batch: the Settings form distinguishes display name from the current rename patch — saving only the API does not save an inherited name, renaming alone does not materialize connection fields or lose headers. Template creation passes locale; the service determines the current template name. Account sync keeps the original Provider dictionary protocol, not on-disk rule arrays. CLI startup and login share the Personal file; first import reads old Provider + default model once; the Protocol does not self-import old CLI config. Cases live under `providerRuleForm`, `providerRuleFileIntegration`, `personal-config-default-integration`; the original `process-provider-registry-runtime`, `account-config-delivery`, `auth-login` regressions carry the old lifecycle. Existing SC90/F98/W89 E2E still need a batch run after the final structure sync — pure function tests do not replace them.

B3 distribution close-out: the Source reads the complete snapshot from the single Personal Repository, then compares the on-disk content hash; bad files or mid-read changes must not override remote with in-memory degraded values. The Target reuses the same Repository's locked update; forward replace and failure rollback both compare entire Personal content inside the lock; the default selection is no longer read/written separately. Rollback restores complete config semantics (codec-formatted like a normal write) and does not alter shipped old inputs; if the user already wrote a different C, skip the rollback for that domain and report `rollback_failed` explicitly — never roll C's new default selection or Provider back to A. Status/credentials keep their original domain boundaries; no global transaction system.

```text
Complete Personal A → Source validates content → envelope Personal B (default selection included)
                                      ↓
Target same-file lock: confirm current is still A → full replace B → refresh/verify
                                               ↓ failure
Same-file lock: current is B → restore A; current is already C → keep C, report rollback conflict
```

Distribution cases: the envelope has no old sourceRevision/outer configuredDefault and the result configRevision maps to the actual Config source; single and repeated syncId applications; default clearing; failure recovery of Provider and defaults; failure concurrency writing Provider/default separately protected; same-file notification reaching the default consumer; two real processes modifying Provider/default separately without overwriting each other.

Graph boundaries follow this file's existing Surface Matrix: no new UI owner, message timing, or account sync mechanism. codegraph still unavailable; exact symbol search retrieves ConfigService / Facade / Resolver / Node codec and Repository, depth 2, cross-layer save and distribution extended to the disk sink. No full-repo regression runs mid-process and no Pro build; share the final verification once all chains connect.

## Feature Summary

| Field             | Content                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Intent/Capability | Keep existing Provider and Selection product semantics; implement the final persistence schema                                            |
| Layers/Mode       | persistence, validation, draft-default, option-source; planning                                                                           |
| Main entry        | ProviderSettingsFacade / ProviderConfigResolver / createNodeModelSelectionFacade / OffPeakTaskRepo / RepoWikiStorage / SessionRepository  |
| Not doing         | Multi-account simultaneous connection, CLI account assembly refactor, send-sync gate, Subagent Markdown reformatting, old budget features |

## UI Surface Matrix

| Scenario/Entry          | Shared implementation                | Draft/Default                   | Validation                        | Submission/authority point                | Mode and isolation                                                       |
| ----------------------- | ------------------------------------ | ------------------------------- | --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| Provider settings       | SettingsFacade/ConfigService         | Form draft, recommended rules   | Source schema/integrity           | PersonalRepository single update          | Local/remote injected services; cannot write Session                     |
| Composer                | SelectionFacade                      | Draft/Recent/default            | Valid selection/final Factory     | Session selection after successful submit | Not persisted early; does not change frozen runtime                      |
| Automation/Bot/Subagent | Shared selection data                | Own inheritance rules unchanged | Own existing submit boundaries    | Task/bound Session/user MD                | Shared fields do not imply shared save timing                            |
| Wiki/draft              | RepoWikiStorage                      | Generation setting draft        | New selection authority           | Existing file-lock save                   | No restore of the manual output limit                                    |
| Off-Peak edit view      | OffPeakTaskService.updateTask → Repo | Form draft                      | queued/paused, complete selection | off_peak_tasks.model_selection            | Keeps only the old column; does not change Ticket, Session, or workspace |

## Shared and Divergent Behavior

Shared model identity, capability, and option schema; each feature independently owns draft, submit, and save boundaries. The default-selection point changes; the distinction between default selection and Session persistence does not. Plain Account valid selection keeps current rules; an Off-Peak bound Ticket is not re-resolved across accounts.

## Feature Relationships / State Owners and Commit Sinks

| Priority       | Relation                                      | Owner/Sink                            | Evidence and reason                                                                                            |
| -------------- | --------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| must-inspect   | Off-Peak edit → single repo save              | OffPeakTaskRepo / SQLite              | updateEditableFields currently actively clears the old column; the Service only normalizes submitted fields    |
| must-inspect   | Wiki save → file atomic update                | RepoWikiStorage                       | The runtime object must not carry old values as a second authority; the save layer keeps original values       |
| must-inspect   | Session selection → entry.data                | Agent SessionRepository               | Recovery/update/fork must consistently recognize the new packaging                                             |
| must-inspect   | Config source → Resolver → Registry           | Provider layer; Node layer handles IO | One-way schema dependency, complete config admission, same-source snapshot                                     |
| must-inspect   | Default selection/Provider update → same file | PersonalRepository                    | No mutual overwrite; distribution failure rolls back only this round's result, not a concurrently replaced one |
| conditional    | New path → packaging/Host startup             | Each host injects the Node path       | Desktop/CLI/Server each need real artifact verification                                                        |
| invariant-only | Mobile/desktop message delivery               | Same Session owner                    | Does not change continuous/replayable and workspaceIdentity isolation                                          |

## Must-Preserve Invariants

- Shipped old values serve only as rollback snapshots; once a new selection exists, old fields are not re-read as invalid/cleared.
- Read/write through existing owners: UI does not touch a Repo directly, Services do not reference a concrete Runtime, IO does not enter the Provider domain.
- The Off-Peak old/new column difference is not a re-migration trigger; Ticket, queue claim, and remote disable are unchanged.

```text
Form submit → Service existing validation → Repo updates new selection/business fields → SQLite
                              └─ old model/thought_level original values unchanged
New read ───────────────────────→ model_selection
Old rollback read ──────────────────────→ old column snapshot
```

## Codegraph Evidence / Graph Drift / Graph Delta

codegraph is unavailable (no entry point, no repo package script); exact symbol search is the substitute, and text hits are not semantic dependencies. First-group expansion depth 2: OffPeakTaskService.updateTask is the only caller of Repo.updateEditableFields; the Repo row conversion reads only the new selection; old columns are read only by migration-issue diagnostics. The complete schema group gets actual call evidence later.

Several Provider fields and old layering descriptions in the graph will be updated after the B2 change; future fields are not written as implemented facts now. B1a adds only the keep-old-columns invariant; all other product boundaries unchanged.

## Unresolved Questions / Clarification Log

The user explicitly authorized implementing the final decision this round. B1a raises no new product questions; B1b/B1c close-out must follow existing upper-layer constraints — surveyed and recorded, no independent universal null schema added. Other scopes needing new decisions pause only the related items.

## Planning Handoff / Domain Scope / Dimensions

This file and the Todo104 step doc are the spec/case entry points. The first group only stores and migrates, changing no interaction; database integration tests cover real writes and restarts. The Settings UI group adds its own E2E handoff separately — this group's pass is not full-end verification.

Dimensions: with/without old columns, title/new-selection editing, queued/paused/other states, pre/post restart; do not expand network and theme combinations (this group changes no requests or display). Ticket fields are verified against invariants.

## Candidate Combinations / Pruning Decisions / Accepted Cases

| ID     | Status and action                                        | Assertion/evidence                                                                                   | Decision                              |
| ------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| B1a-01 | Legacy dual-format record; title-only change             | Original old-column values unchanged; new selection/Ticket unchanged                                 | accepted, SQLite integration          |
| B1a-02 | Same record: modify new selection and tier, then restart | New reader uses the new selection; frozen staging column shape still reads old values                | accepted, SQLite integration          |
| B1a-03 | Create, then modify selection                            | Old column stays NULL; no fabricated old format                                                      | accepted, SQLite integration          |
| B1a-04 | null selection/runtime editing                           | Follows existing rejection; no new clear semantics added                                             | accepted, existing service/Repo tests |
| B1a-P1 | Model request, quota, network, theme combinations        | Save-layer changes do not touch these states; existing evidence stands, old features not re-accepted | pruned                                |

## Matrix Backfill / E2E Handoff Notes

B1b supplement: Wiki already has Todo97's on-disk migration and the null empty marker; Todo104's original "convert in memory on each read" is outdated. Following the marker satisfies close-out no-respawn; no new universal schema decision needed. Migration, normal save, and deletion keep sharing the file lock; the official reader filters old fields.

| ID     | Scenario                                                              | Assertion                                                                                                       | Decision                          |
| ------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| B1b-01 | Wiki/draft first migration and later modification                     | Old model/tier/budget original values retained; body/charts/new selection updated; reader returns no old fields | accepted, real temp files         |
| B1b-02 | Dual-format document clear / illegal new selection after save+restart | Empty marker keeps authority; old selection does not respawn                                                    | accepted, real files              |
| B1b-03 | New folder with old fields                                            | No fabricated old values written; no budget restored                                                            | accepted                          |
| B1b-04 | Save-rename failure; migration/save/deletion concurrency              | Original text undamaged; in-lock re-read obeys latest facts                                                     | accepted, barrier/fault injection |

No new UI interaction or generation rules; B1b adds no E2E. Existing Service model-limit assertions ride the group regression. Private storage types involved do not leak to protocol or UI.

B1a tests live in `services/test/offPeakTaskRepo.test.ts`; no UI behavior change and no new E2E. They use temp SQLite, touch no real data, need no model fixtures, and use no time waits. Other groups add cases and required E2E matrices before implementation.

## B1c Session Storage Boundaries (pre-implementation confirmation)

The sole persistence owner is the SQLite SessionStore adapter. `SessionEntryInfo.data` is the port's logical payload: model selection stays the public ModelSelection (fork without a selection uses null); on disk, `session_entry.data` is the wrapper retaining old snapshots. Wrap/unwrap follows the existing codec boundary — core/bootstrap must not write separate handling for SQLite rollback fields. Normal saves, runtime saves, and atomic fork bundles all use `saveSessionEntry`; recovery goes uniformly through `decodeSessionEntryRow`. Table/schema, submit timing, protocol, and message lines are unchanged.

```text
core/bootstrap current selection → SessionStore.saveSessionEntry
                        → single UPSERT: old JSON + new modelSelection
Cold recovery/fork read ← codec unwraps only modelSelection ← SQLite
First old-data migration → transaction re-reads old candidate → same UPSERT
```

The UPSERT replaces only the new members inside the database, avoiding application-layer read-modify-write windows, and retains every other member of the on-disk object. New records write only the new members. Migration reads only the published flat `providerId/modelId/thoughtLevel` (including custom Providers without thoughtLevel); the unshipped options format is not a compatibility contract. A present new member (including null or illegal values) blocks old-field/old-message rollback. The codec does not expose old snapshots to business code; unmigrated old records are not formal selections. Fork child records carry only their own current selection, never copied parent rollback fields.

| ID     | Scenario                                                 | Assertion                                                                                                       | Decision                                          |
| ------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| B1c-01 | Old account/custom entry, with or without thoughtLevel   | Original id/type/old fields/unknown members each preserved; new member correct; migration idempotent            | accepted, real SQLite                             |
| B1c-02 | Post-migration normal save, clear, restart               | Only new members change; new null/bad values do not respawn old ones; session activity time untouched           | accepted                                          |
| B1c-03 | Migration from old messages                              | New entry has only new members; old message bytes unchanged                                                     | accepted                                          |
| B1c-04 | Runtime switch, cold recovery, fork bundle               | Existing ModelSelection port contract round-trips unchanged; child selections isolated from parent              | accepted, adapter/core/bootstrap joint regression |
| B1c-05 | Migration/subsequent write concurrency and write failure | Single transaction/single UPSERT; no old-read overwrite; failure leaves old data complete                       | accepted, transaction/fault injection             |
| B1c-P1 | UI/network/theme/queue permutations                      | Changes no interaction, continuous/replayable, or input admission; existing runtime-layer regression represents | pruned                                            |

Architecture tool facts: `architecture:check --changed` reports no violations; `cli-adapters` is not yet an architecture-policy managed module (context command returns unknown module). Use the existing SessionStorePort and CLI AGENTS as the boundary basis; do not expand governance modules for this.

B1c E2E contract sync: the existing `unbound-resume` seeds the current selection via raw SQL, and Off-Peak existing-session cases check selection via raw SQL — both must read/write the disk `data.modelSelection`, not the logical port. Case semantics unchanged; only fixture/assertion paths are fixed. Still pending: a static contract update is not a machine pass; re-verify after the final shared Pro build merge.

## B2a Model Data Schema Single Source

Extract Model data constraints from the codec with class-transform. The complete data schema declares leaves; sparse coverage derives from it (defaults/null allowed; nested stays sparse). Construction-input and serialization types derive from their schemas; behavior classes keep overlay/freeze; `validateComplete` calls only the complete schema and translates existing problem paths. Registry complete types reuse the same derivation. No new IO, state owner, subscription, execution selection, or UI interaction.

```text
Pure data schema → derived types + complete/sparse validation
       ↑                  ↑
Behavior class overlay/freeze    codec parse → behavior class
       └──── complete admission → Registry
```

This step publishes no format change on its own; later B2 field renames/grouping edit the same schema and consumers directly, with no compatible interim format. The current complete config includes `enabled`; the Manual-mode `enabled` exception derives from the later manual-rule schema. Parse allows sparse but never illegal values; complete admission must reject missing nested leaves, non-positive/non-safe integers, blank/duplicate tiers, and invalid maps. Error classification distinguishes missing fields, illegal options, and other illegal configs, keeping existing paths; network-failure and other business strategies unchanged.

| ID     | Settings/action                                                         | Assertion                                                                                    | Decision                           |
| ------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| B2a-01 | Sparse parse and complete-instance admission pass the same illegal leaf | Both reject; cannot pass on type assertions alone                                            | accepted, unit tests               |
| B2a-02 | Complete data per-leaf deleted/null                                     | Complete admission rejects; sparse overlay allows and applies with original clear semantics  | accepted, schema/overlay           |
| B2a-03 | Legal complete config, arrays, maps                                     | class/toJSON/parse round-trip; freeze; Registry results unchanged                            | accepted, existing rule regression |
| B2a-04 | Module dependencies and derived types                                   | Base schema imports no behavior classes; codec/classes/Registry keep no parallel field types | accepted, type check + review      |

Provider context note: the current module is unmanaged with no independent contract; keep the existing config public entry, expand no governance modules. New schema files are Provider-internal; no IO in the domain layer.

## B2b Provider Data Schema Single Source

Continuing B2a's one-way dependency: Provider/API/Access fields and enums live in a pure data schema; behavior-class input/JSON/Registry types derive from it.

Provider integrity keeps the existing required scope: group, api.type/baseURL, and the Access branch's execution fields; label/logo/members/headers/management URLs add no new required fields.

`entitled=false` means complete-but-without-rights; an integrity check must not disguise it as entitled. `hidden` does not exempt checks. Access type switching replaces entirely — two credentials never mix.

Provider source write permissions are limited by the same schema's pick/omit/extend: Account-only members/rights, Template without real keys, Personal without fixed-account Access constraints.

A Personal endpoint may still temporarily hold text not yet correctly filled and be finally rejected by the Registry; one bad endpoint must not block the whole Personal file through the unified schema.

Account services/sync, Provider status, and message timing unchanged; this basic batch renames no release fields.

| ID     | Scenario                                                           | Assertion                                                                                             | Decision                           |
| ------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| B2b-01 | Unknown API type/group outside type bounds; illegal management URL | Complete check rejects; not just non-null-checked into the Registry                                   | accepted, red test first           |
| B2b-02 | Two Access types complete/sparse/clear/switch                      | Only this branch's required fields required; optional stays default/null-able; false rights unchanged | accepted                           |
| B2b-03 | Personal invalid endpoint + same-file legal Provider               | Bad item stays editable, blocks only its own Registry admission; valid items still execute            | accepted, keep existing regression |
| B2b-04 | Source config permissions and serialization                        | Shared schema derived; authority-crossing fields rejected; class/JSON/freeze behavior unchanged       | accepted                           |

## B2c Delete OptionSpec Redundant `type`

Executes §5.5: `reasoningLevel` is fixed by member name to values/map and `maxOutputTokens` to max/map; their `type` is deleted. Provider API/Access and outer rules that still use a discriminator are untouched.

Single-field definitions follow the B2a data schema; behavior classes no longer keep/write back redundant fields. Shipped old Provider imports still convert through the original entry; unshipped Config old types get no compatibility.

CLI ModelOptionSpecs contracts stay structurally consistent with Providers; settings forms no longer create the field; the default Built-in upgraded content revision moves in the same batch; real-request `reasoning/max token` map behavior unchanged.

```text
Settings draft / Built-in / old-format import
              → redundancy-free OptionSpec
              → same integrity validation → Registry → original map → original request fields
```

| ID     | Scenario                                                 | Assertion                                                                                              | Decision                                       |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| B2c-01 | New complete OptionSpec has no `type`                    | parse/class/serialize/Registry usable; map request values unchanged                                    | accepted, red test + config/request regression |
| B2c-02 | Old unshipped `type` still in Config                     | strict parse rejects; no silent stripping; shipped migration input contract unchanged                  | accepted                                       |
| B2c-03 | SC90-01 adds manual config, edits back to smart config   | Both saved options have no type; original failed-draft/disabled-kept/recommended assertions unchanged  | accepted, existing pending E2E + assertion     |
| B2c-P1 | Redo all client UI, theme, request-protocol permutations | Changes no layout, events, or message timing; reuse shared forms and the existing request-layer matrix | pruned                                         |

The current Model settings entry still submits sparse or complete personal configs via ProviderModelMetadata; no new UI state, subscriptions, or async requests. This batch does not take over default-selection persistence or change Session submit boundaries. Existing SC90/F98 case-local `none-provider` fixtures are reused as-is, not auto-promoted; Pro builds current code in an isolated directory for verification.

## B2d Model Final Fields and the Cross-Layer Single Data Contract

Executes the remaining §5 fields: `inputFormat`/`outputFormat`, `supportsText`/`Image`/`Video`/`Audio`/`Pdf`; `requiresMfjsToolSchema` moves to properties. Complete/sparse meanings unchanged; unshipped old names are not accepted; no dual reads. All current configs, UI forms, CLI model attributes, and protocol media projections sync together; SDK raw request bodies, tool schemas, and external command same-name strings are not rename targets.

Data contract ownership: the Model pure data schema is needed jointly by Provider, CLI contracts, and the shared protocol, so B2a's single schema moves to a shared `model-config` sub-path (no Provider behavior classes). Shared adds a dependency only on the pure expression-compilation library `model-option-map`, which itself has no Provider/shared dependencies and no IO. The original Provider-internal definitions are deleted with no parallel schema or transit compatibility. Provider behavior classes stay the sole owner of overlay/freeze/Registry admission; CLI Model data types and protocol format projections derive from the same schema.

```text
shared/model-config (pure schema + content validation; depends on the IO-free expression compilation library)
       ├─ Provider behavior classes / Config codec / Registry
       ├─ shared protocol media field projections
       └─ CLI contracts (type derivation) → core / adapters
```

This direction avoids shared reverse-importing Provider implementations and package cycles; it changes no state owners, subscriptions, effective selection, sync frequency, or task dispatch/persistence timing. `ModelRequest.maxOutputTokens` is a real request option, not part of Selection migration.

| ID     | Scenario                                                                    | Assertion                                                                                           | Decision                                |
| ------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- |
| B2d-01 | Final ModelConfig complete/sparse input and per-leaf default/null           | New structure complete admission; null keeps clearing; old names/top-level MFJS strictly rejected   | accepted, red test/node configs         |
| B2d-02 | Explicit MFJS true/false override; manual/smart save                        | Writes only to properties; boolean controls/personal override markers and re-open values unchanged  | accepted, form unit tests + SC90        |
| B2d-03 | CLI media filtering/PDF/generation/stream and protocol model candidates     | Same capabilities read from new attributes; request maps and message content unchanged              | accepted, contracts/adapters/core tests |
| B2d-04 | New Builtin on disk and content comparison                                  | Only field renames/moves plus revision change; map/limits/capability values each retained           | accepted, semantic JSON comparison      |
| B2d-P1 | Redo UI, account connections, remote sync, shipped old-config compatibility | Not this item's semantic changes; keep current boundaries; unshipped old Config not made compatible | pruned                                  |

Implementation splits into two verifiable steps: **B2d-contract** first moves the pure schema and eliminates CLI/protocol duplicate definitions with fields and values completely unchanged; **B2d-fields** then updates all consumers and Built-in. The first step does not declare final fields complete and does not bump the Built-in revision. Public sub-path tests verify the real protocol uses the same field-schema object, sparse/complete constraints, expression validation, and Provider round-trip; CLI types are constrained by bidirectional type-equality assertions. No new business state or UI interaction, no extra desktop cases; the fields step keeps updating and running SC90.

The common `sparseShape` primitive moves to a shared `config-schema` sub-path referenced by both Model and Provider schemas; it only derives nullish fields and contains no source permissions or business rules. The shared layer exports derived Model data types; the CLI keeps original public type names via type-only aliases. CLI contracts on Zod 3 need no local re-derivation of Zod 4 schemas.

The actual lock file has `shared=Zod4.3.6` and `provider/provider-node=4.4.3`; identical `^4.3.6` declarations do not guarantee composable Schema types — type checking proved the two internal versions' types incompatible. Fix only these three directly-combining config Schema packages to shared's already-used 4.3.6; no full-repo dependency upgrade, no changes to the CLI's Zod 3, and no `any`/cast or second schema to bypass. Complete-configuration and error-classification regressions re-run on the final lock file.

B2d fields close by contract granularity: first replace the seven old media format fields with final naming (Builtin revision 14→15), updating every end and current fixture in the same batch; the MFJS structure move is handled separately for its boolean override semantics — no simple text replacement mixed into this batch. Shipped migration inputs unchanged; only current Model fixtures in scripts update. Old unshipped formats are strictly rejected with explicit negative examples. UI input/output draft types also reference the shared derived types instead of re-declaring synonymous interfaces; layout and control copy unchanged.

A Pro rebuild found B2d-contract's two new shared sub-paths missing from CLI `esbuild` exact aliases; a generic prefix would splice wrongly as `index.ts/model-config`. This round fills the existing build entries and alias contract tests — no build-system redo. The real Agent build must succeed before E2E continues; a desktop Renderer build pass is not Agent close-out verification.

The shared pure expression library's new dependency also affects shaven Docker build contexts: every Dockerfile with an explicit `COPY shared` must also `COPY` the `model-option-map` manifest and source. v4 has it; the Share and old remote templates were missing. This round only adds the new dependency, fixing no other old template gaps. Share does not import Provider behaviors, so its generic shared alias does not yet consume the new sub-path — its config is not changed without basis; actual local Share builds and static dependency-boundary tests verified; a real Docker image build is not substituted as a pass.

### B2d-MFJS: Single Property Ownership

`requiresMfjsToolSchema` moves from the ModelConfig top level into properties: complete `ModelProperties` requires the boolean; sparse `properties` still allows default/null. Built-in only moves original values (revision 15→16) and adds no capabilities. ModelConfig no longer overlays/serializes the field itself — `ModelPropertiesConfig` handles it uniformly. CLI adapters no longer copy a second MFJS value into `ResolvedAiSdkModel`; both `generate`/`stream` tool projections read from the fixed execution model's properties; the tool-transform private option keeps its original boolean parameter; the actual MFJS schema content is unchanged.

The UI adds MFJS to the property-group source markers and sparse writes; an untouched smart-mode `false` must not spawn overrides; explicit `true`/`false` and `null` each keep their semantics. Closing smart config still materializes complete properties and does not enable models by relocation; switching back to smart, cleaning up, and re-editing follow the existing draft flows. Tests cover first false/true/null, complete-missing rejection, old top-level rejection, and smart/manual save, re-open, highlight, and request tool-schema true/false branches. Pro SC90 adds a real MFJS switch and re-open assertion; F98's existing border/layout behavior is retained.

### B2e: Provider Members and Endpoint Naming

New configs uniformly use `personalModelIds` and `api.baseUrl`; Built-in/Personal/Account/Registry/settings pages consume the same data contract. Member ownership unchanged: `builtinModelIds` are non-deletable source members, `personalModelIds` are user-added members only, and `modelOrder` is their display order. The SDK creation parameter `baseURL`, shipped old Provider `endpoints.baseURL`/`options.baseURL`, and the business-local sort parameter `modelIds` are not rename targets; old migration inputs read as-is, and converted new ProviderConfigs use the new fields. Model rule query parameters/Match structures are left for the rule group to re-unify, not mixed into this change.

Test new-field complete/sparse round-trips and null clearing first, strictly rejecting old unshipped fields, then modify all consumers. Reuse member add/delete/dynamic account members/sort/form-header-retention and migration tests; add a real SDK outbound URL assertion proving the new `api.baseUrl` still maps to the SDK-required `baseURL`. The settings page keeps its existing interactions and Pro cases; the config contract rename changes no page copy or layout. The Builtin content comparison only moves fields plus revision 16→17 and must not change model lists, maps, or endpoint values; labels/template ownership and rule arrays belong to other groups — this does not declare the Provider final structure complete.
