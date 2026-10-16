# M2 Retirement Cleanup

> Status: Implementation and final branch verification completed, ready for launch review
>
> Latest review: 2026-08-21

This cleanup round completed M2's last goal: ordinary long-term Provider configuration, display, selection, and execution all return to a single fact chain.

```text
Official Provider Config
        +
Personal Provider Config
        +
Account Provider Config
        |
        v
Process Provider Registry
        |
        v
Model
```

Physical migration modules can still read old files, and background tasks can still provide single-execution input through `turnRuntimeModel`; both are within clear boundaries and do not participate in the steady-state facts of ordinary long-term Providers.

The generic `RuntimeConfigPatch` has also exited old model fields. Old CLI file `provider`, `model`, and `modelCatalog` fields are only read by explicitly named migration projections; ordinary file configs, environment variable configs, and Config Merger no longer generate, merge, or expose model facts. Old `ZCODE_MODEL` / `ZCODE_BASE_URL` therefore no longer form a hidden runtime configuration path.

Ordinary CLI file runtime configuration schemas no longer declare `provider`, `model`, `modelCatalog`, or `small_model`. These fields, even if residual or malformed, do not cause formal configs such as MCP, permissions, and network in the same file to fail loading overall; only the one-time Personal Importer's Legacy Schema reads and strictly validates them.

## Completed Cleanup

### Repo Wiki

Repo Wiki directly consumes `ModelSelectionView` and initiates requests through unified `Model`. The intermediate `ZCodeProviderRegistrySnapshot` projection, reverse parser, old readiness resolver, and their tests have been deleted.

### Settings Connectivity and Security Validation

Connectivity tests receive formal Provider/Model Config drafts. Security validation chains read API formats and addresses from the formal Provider Settings View. Both paths no longer re-interpret old endpoint/defaultKind structures.

### Model Selection and Auxiliary Code

No production consumers remain in model menus, Bot selection, Workspace Prepare, plan displays, and model sorting. Old helpers, wrapper modules, re-exports, and specialty tests have been deleted; still-used files only retain half the new Registry/View requirements.

### Old Services Provider Storage Draft

Full repository reference audits further deleted five files with no remaining consumers: plan entry state file cache, GLM workspace Provider config repository, atomic file drafts not yet integrated into formal Repository, and old Provider settings JSONC parser. These once carried old plan availability, Workspace Provider configs, and another set of physical Config read methods; retaining them would make code appear able to bypass Official, Personal, and Account Sources to establish Provider facts.

Also deleted were old model override header constants not read by any entry. Only a single isolated file remained, with no request injection, protocol, or config consumers; retaining it would imply another model override entry point still exists.

Services now have structural tests fixing these files as having exited. This gate will not prohibit subsequent general IO tools, but old file names and responsibilities cannot be restored without new architecture rulings.

### Process Registry

Production protocol Entries must now successfully start the process-level Registry. Missing Official or Personal Config paths directly expose assembly errors, without silently creating a second set of Provider facts.

```text
Protocol Entry
    |
    | required
    v
Process Provider Registry
    |
    +-- create / resume / switch
    +-- workspace model view
    +-- context window
    +-- model fallback
    +-- execution
```

`hasProcessProviderRegistry` branching and Workspace Provider Catalog fallback have exited. Test Harness also explicitly assembles Registry, so tests no longer mask production dependency omissions.

### Workspace Model State

The original `workspaceModelCatalogs` has been shrunk and renamed to `workspaceModelPreferences`. It only saves interaction and persistence selections:

```text
Workspace Model Preferences
├─ defaultMode
├─ defaultModel
├─ defaultThoughtLevel
├─ lastUsedModel
└─ revision
```

Provider lists, model Properties, Option Specs, credentials, and Provider revision are all provided by the process Registry. Workspace state no longer承担s Provider Catalog responsibilities.

The leftover `workspaceModelMirror` queue in the Renderer has also been deleted. It once asynchronously mirrored model selection to the old `setWorkspacePreferredModel` entry, but all consumers have migrated to session-aware Selection control chains; retaining a queue with no callers would imply Workspace still has another pending model fact to reconcile.

The final closure also deleted `workspace/readState.modelCatalog`, `ZCodeWorkspaceModelCatalogState`, Worker-side Provider projections, and App Config→Protocol Provider conversions with no remaining production callers. Model lists and current selection uniformly return from `settings.model`; Workspace `state.updated` also sends the same Settings shape, with old `{ modelCatalog }` Patches no longer existing. First background dispatch directly inherits `settings.model.current` and validates selections remain valid using the same `settings.model.available`.

Workspace Overlay write entries remaining inside the app have also been deleted. `setModelCatalogOverlay`, Workspace Overlay state, and listeners have no production callers, yet can still inject full Provider/Model snapshots into model lists and old Adapter Registry; retaining it would let old Host Snapshots always re-emerge as a second fact source. Single-round `setTurnModelCatalogOverlay` continues to be retained, serving only execution-scoped temporary models, cleared after completion.

### Ordinary and Temporary Execution

Ordinary Session commands only carry `ModelSelection`; Workers create Models using the Registry of their所属 Environment. Host-derived ordinary `runtimeModel`, old revision CAS, and Workspace Provider write-backs have exited.

`createModelAdapter()` only accepts explicitly named AI SDK Registry containers, with no public branch for creating ordinary execution Registries from old `RuntimeModelConfig`. Formal Provider Runtime manages that container after app startup; old Runtime Config transformations are only used internally by Turn Execution Sources.

Background task `turnRuntimeModel` is temporarily retained. It only forms a temporary Model Overlay for the current Turn, without writing to Registry or modifying Workspace Preferences; its formal Provider and request-period authentication design belongs to M4.

### Model and Request Authentication

Model creation fixes the Provider's static execution configuration. Account API Keys or header refresh only cover the current request attempt's dynamic authentication material, without letting already-created Models return to the current Adapter Registry to re-resolve full Providers:

```text
Model creation
└─ Fix Provider static execution config

Request attempt
├─ Read latest dynamic auth material
└─ Overlay API Key / header on fixed config
```

Therefore Registry hot updates only affect subsequently created Models; the current Loop will not silently switch Endpoint, API Format, Provider Factory, Provider Options, or static headers during request retries or one-time security header refreshes. Physical routing, proxies, and request security checks are still managed by the Adapter's request facilities, not written to Models as Provider static facts.

Dead chains originally used in Bootstrap to modify Active Session capacity in-place after Registry hot updates, then re-broadcast ModelSelected, have been deleted. Active Sessions hold their own Models; new Properties and Option Specs only enter subsequently created Models.

Account logout captures account identity before OAuth main session cleanup and deletes account-scoped Personal Coding Plan Keys; the compatibility window simultaneously deletes old unscoped keys. Re-login forces re-acquisition and key override using new OAuth Tokens. Account Provider disappearance from Registry, request authentication failure, and derived credential cleanup thus follow the same account lifecycle.

## Settings Page Form Boundaries

The settings page retains a Renderer-private edit session state. Its config fields directly use formal Config types:

```text
ProviderSettingsView
        |
        v
ProviderSettingsFormProvider
├─ config: ProviderConfigObject
└─ models[].config: ModelConfigObject
        |
        | saveEffectiveProvider()
        v
Personal Config Overlay
```

This projection layer only handles form editing and saving:

- Does not read Provider files;
- Does not construct Registry;
- Does not decide whether models are selectable;
- Does not create Models;
- Does not serve as an execution fact source.

When the settings page needs to judge whether a Provider is selectable, it directly uses the `selectable` published by the Registry in the Settings View. Save operations return freshly refreshed new Settings Views after writing, so Provider family corrections and Plan sync compensations after saving also use the same latest Registry conclusions; the Renderer no longer copies a startup availability algorithm based on API Key, Endpoint, and model fields.

Plan connection status only reads the `accessId` published by the Account Overlay. Old API Keys, Endpoints, and model lists in Provider forms no longer re-judge Coding/Start/Team Plans as connected when Account Access is missing; navigation status points directly use Registry `selectable`. The settings page therefore no longer retains an implicit "fall back to old forms when unassembled new Services" mode.

Edit sessions no longer replicate old Store's endpoints, kind, modalities, ProviderOptionsPatch, and timestamp fields. The Renderer only adds `providerId/modelId`, Registry projection state, and Personal source markers beyond formal Config; un-displayed Model Config fields are retained with edit state. Old `ModelProviderConfig` stays only in one-time physical migration reads. The settings experience can continue adjusting controls, but will not change formal Config, Registry, or execution facts.

API types belong only to Provider Config. The settings page edits Provider connections using `ProviderApiType`; there are no longer model-level API kinds, Endpoint Paths, or multi-protocol selection side paths. Repo Wiki and connectivity probes also directly consume this formal type, without reverse-translating current Config to old Provider Store kinds.

Desktop E2E Direct Seed and WDIO global Provider fixtures have both exited old physical Store and CLI Provider Config. DeepSeek, Output Budget, Repo Wiki, Context Window, and Provider filtering cases only write versioned Personal Config; environment default models write to independent `model-selection.json`. CLI Config only retains non-Provider-Harness settings such as `modelStream` timeouts, without copying Provider, Model, or default Selection. Coding Plan fixtures also no longer write Builtin Provider copies; construction continues through Official and Account Sources.

Restart E2E uses the same boundary: Replay Providers only write Personal Config, and environment cold-start default models only write versioned Model Selection Config. Tests no longer copy Providers or reasoning parameters through Project/CLI Config, and no longer artificially create the old race between Host Snapshot and Worker CLI Catalog.

Team Plan Usage E2E also only writes Personal Config; Personal/Team account identities are provided by Account Sources in the scenarios. Tests form available Providers through the formal Overlay sequence, without writing old CLI Provider Config or old Provider Store.

Reasoning manual-review E2E's replay endpoint discovery has also exited old Store/CLI Config fallbacks unique to each case. They use explicit replay runtime information or unified Personal Config test projections; old physical formats remain only in centralized migration boundaries.

Account Access scope for the quota reset service from settings details has also been closed: the Renderer only passes through non-sensitive `accessId` from the Registry View, without reading API Keys back; Personal/Team same-Provider requests still have dynamic authentication resolved by the server based on connection identity.

The generic `RuntimeModelOverlayManager` inside Bootstrap has also exited. The single retained Overlay object is explicitly named `TurnModelOverlayState`, carrying only execution-scoped temporary models for the current Turn; it no longer provides APIs that imply Workspace, Session, or ordinary Runtime Provider layers.

## Explicitly Retained Legacy Boundaries

The following compatible code still has single, deletable responsibilities:

- Personal Config first import: read old physical files when new Personal Config does not yet exist;
- Account Key one-time migration: move old Personal Coding Plan Keys into Account Credential Store;
- Renderer edit session state: directly carry formal Config, isolating drafts and Registry runtime state;
- `turnRuntimeModel`: execution-scoped input for background tasks before M4.

None of these are called in reverse by the Registry steady-state path.

M2's completion boundary is mechanically protected by cross-package structural tests. In production source code, old `ModelProviderConfig` is only permitted in Shared's historical DTO definitions, Personal first import, Account Key one-time migration, and their assembly entries; old `model-providers.json` is only permitted to be read by `legacyModelProviderStoreReader`. Old complete Registry Snapshots, `workspace/updateProviderRegistry`, generic Runtime Overlays, and old settings projection names must remain zero in production source code. New compatible points must first update this document and explain explicit exit conditions; filename changes cannot bypass boundaries.

Tests and internal tool old model assembly paths for bare `createZCodeApp()` have exited. Formal Prompt CLI, TUI, and Protocol Entry use the same required Registry dependency. Bootstrap Session Persistence, MCP, Hook, and Workflow tests construct actual executable Models through Registry-backed Harness. Compact/Memory E2E and Prompt Trajectory tools also explicitly create their test Registries. `ZCodeAppOptions.providerRegistry` is now required, exposing assembly errors immediately when missing. Old `bootstrapModelConfig`, `includeLegacyProviderModels`, and Registry-less App Factory branching have been deleted.

Further audits also deleted old Runtime Model Config branches from Adapter Factories: `createModelAdapter()` must explicitly receive AI SDK Registry containers managed by callers. Prompt Trajectory and WebSearch Probe have been changed to explicitly provide execution models; old CLI Config model selection write entries have been deleted. Old Config Parsers are retained only for Personal first import and non-Provider Harness settings, and cannot provide facts for steady-state model execution. Turn execution-scoped Runtime Model Config is only transformed internally by `TurnExecutionModelSource`, without entering public Adapter Factories.

Generic `RuntimeConfig` and `ConfigPort` then deleted `model`, `modelCatalog`, and corresponding Config Keys. Compatibility parsing of old files and `ZCODE_MODEL` is still retained as deprecated-marked migration input, but Config Factories no longer project these fields into runtime configs; `hasModel` source metadata has also been deleted. Formal app initialization can only obtain models from Process Registry and explicit Session/Submission Selection.

## Verification

This round completed:

- Root directory `pnpm typecheck`;
- Root directory `pnpm lint`, 0 errors;
- Post-rebase Services/UI and new MCP/Usage targeted tests: 15 files, 258 passed;
- Bootstrap targeted tests: 6 files, 219 passed;
- Bootstrap independent typecheck passed;
- `git diff --check` passed.

After Workspace Snapshot final closure, a new round of Shared, Services, Bootstrap, and UI targeted verification ran: 299 total passed; root typecheck and lint passed again, with lint at 0 errors.

Bootstrap full tests also exposed pre-existing debt unrelated to this round: Session Persistence test mocks missing new methods, Native Boundary had existing cross-domain imports, and several historical timeouts. These do not constitute targeted regressions for this round, and should not be misreported as full passes; launch verification should continue preserving this note. The current verification uses Node 22, while the repository declares Node 24; formal pipelines still need to re-verify on standard runtimes.

The final branch has been rebased to `staging`'s `cf009a3b19`. Bootstrap regressions after Workspace Overlay deletion: 51 total passed; root TypeScript, Bootstrap independent TypeScript, and lint passed again, with lint at 0 errors and 36 baseline warnings. Human in the Loop review had no unconfirmed rulings. The current branch is 0 behind relative to the latest `staging`.

After bare App Factory closure, Bootstrap Registry, Runtime Config, Session, MCP, Hook, Workflow, Telemetry, and Overlay targeted regressions: 12 files, 160 passed; ZCode Protocol specialty: 109 passed. Root typecheck, Bootstrap independent typecheck, Prompt Trajectory typecheck, and root lint passed, with lint still at 0 errors and 36 baseline warnings. Compact E2E dry-run and Memory evidence tests passed; the current Node 22 cannot directly load Bootstrap builds in the latest staging that reference root `@zcode/shared` source code; actual Compact fake suites are left for the repository's declared Node 24 / CI runtime verification.

During Bootstrap full execution, this round's relevant Runtime Config and Telemetry Harness failures have been fixed; remaining failures are in pre-existing `v4-native-boundary`, oversize V4 Gateway timing, and Session Resident Pool cases. This round did not modify these independent semantics through Provider closure changes.

The final pre-launch cleanup round also completed Desktop E2E Provider seed/read boundary migration, Provider and Provider Node Knip audits, and Account Access quota reset scope completion. Root `pnpm typecheck` passed again; root `pnpm lint` stays at 0 errors and 35 baseline warnings unrelated to M2; targeted Coding Plan and Model Selection tests: 205 passed, Desktop E2E TypeScript and changed file Lint passed. Human in the Loop's 16 rulings were all confirmed; the branch remains 0 behind relative to the latest `origin/staging`.

After Turn Overlay narrowing, root `pnpm typecheck` and `pnpm lint` were executed again: TypeScript passed, Lint at 0 errors and 33 current `staging` baseline warnings; Turn Overlay, Runtime Model Factory, Session Facade, and M2 structural gates: 16 total tests passed, Bootstrap independent typecheck passed. The branch remains 0 behind relative to the latest `origin/staging`, with no uncommitted content in Working Memory or the code workspace.

E2E Provider diagnostics have also exited old Store and old CLI Config read fallbacks. Ordinary E2E only uses versioned Personal Config; historical physical formats are only read by one-time migrators and their specialty tests, and can no longer help ordinary scenarios pass incorrectly.

Final branch verification again passed root `pnpm typecheck` and `pnpm lint`; Lint at 0 errors and 33 current `staging` baseline warnings. Provider, Provider Node, and M2 structural gates: 19 files, 96 tests passed; Shared Protocol and old physical migration boundaries: 3 files, 53 tests passed. Old Store Schema and migration functions simultaneously exited ZCode Protocol re-exports, retained only in Shared Provider migration types and Services one-time Readers. The branch is 0 behind relative to the latest `origin/staging`.

The old Provider Store has finally converged to a pure read adapter, renamed to `legacyModelProviderStoreReader`. Production calls remain only Personal first import and Account Key one-time migration; old paths no longer write back to `config.json`, no longer restore backups, and no longer retain old format reverse serialization and atomic write code. Three migration test groups: 7 total tests passed; root typecheck and lint passed again, with lint at 0 errors and 33 current staging baseline warnings.

The last E2E infrastructure audit changed ordinary WDIO seeds to directly write formal Personal Config, and replaced old Store top-level DTOs with explicit `E2EModelProviderSnapshot` observations. Desktop E2E structural gates recursively scan all test source code, preventing fixtures from re-introducing `ModelProviderConfig`. Provider, Provider Node, Services migration boundaries, and Desktop Config boundaries: 24 files, 114 tests passed; root `pnpm typecheck` passed, root `pnpm lint` at 0 errors and 33 current `staging` baseline warnings, changed files at 0 warnings. The current branch is 0 behind relative to `origin/staging`.

Non-migration test fixtures also exited old Provider top-level DTOs; M2 structural gates now simultaneously constrain production and test source code. Usage, Repo Wiki, Bots, and Provider Runtime targeted regressions: 6 files, 135 passed; Provider and Provider Node full unit tests: 14 files, 89 total and 2 files, 13 total passed. Root `pnpm typecheck` and `pnpm lint` passed again, with Lint at 0 errors and 33 current `staging` baseline warnings. Final counter-evidence audits confirmed remaining old top-level DTOs belong only to one-time physical migrations; old model DTOs additionally serve only pre-M4 execution-scoped inputs. The branch is based on `origin/staging` `6b4f6fc636f5`, 0 behind relative to that baseline.

Requirement-level audits then deleted stale Provider revision fields in Session Settings and request-period authentication callbacks. Complete Snapshot revision CAS has exited; these fields have no production writes or behavioral consumers; current shared protocols, Bootstrap Session Mappers, Core Invocation Context, and Adapter Request Auth now retain only actually effective request authentication material. Core source code has also been added to M2 cross-package structural gates, preventing old revision names from re-appearing from more inner layers.

The final Entry coverage audit brought `@zcode/provider`, `@zcode/provider-node`, Prompt CLI, and TUI into the same structural gate. Extended scanning confirmed these entries have no old Provider Snapshots, Workspace Catalog, or Runtime Overlay fallbacks. Workspace interaction state implementation terminology has been unified to Model Preferences; one zero-callers legacy reasoning migration function has also been deleted. M2 gates, Runtime Model Metadata, and ZCode Protocol targeted regressions: 151 total passed, Bootstrap independent typecheck and root typecheck passed.

The last Builtin Provider ID hardcoded entry in settings page sorting has also been deleted. Provider initial and final ordering comes solely from ordered Effective Views; user drag-and-drop continues writing Personal Overlays. Old Display Order Preference's `updatedAt` shell and Shared DTOs have exited; UI only retains `ProviderOrderView` projected from the current View.

Provider migration/Registry auxiliary types and functions in Bootstrap and Prompt CLI used only internally within files are no longer exported. Formal cross-module entries remain unchanged; post-Knip review found zero uncalled exports related to Providers, Models, and Registries in these two packages.

Two zero-caller helpers in Services that inferred Coding Plan disable sources from old `enabled/systemDisabledReason` have been deleted; file-internal implementations of Account/Request Auth/Connectivity and other modules are no longer exported as public extension points. Account Sources currently form Account Overlay results using only available/unavailable/unknown states.

Workspace key and external Agent configuration isolation directory helpers in Services path modules used only for internal reuse have also been收回ed as exports; external Agent skills, plugin, and runtime status path behaviors remain unchanged.

The pre-launch final counter-evidence reviewed each of M2's completion conditions. 21 key test files, 181 tests, and root typecheck passed; root lint is 0 errors and 33 current staging baseline warnings. The branch is 0 behind relative to `origin/staging`, not re-bringing historical commits deleted before staging.

After Public Adapter Factory and settings form DTO closure: Provider full 14 files, 110 tests; Provider Node full 2 files, 13 tests; Services Registry/Config/Request Auth targeted 4 files, 19 tests; Bootstrap Registry Runtime targeted 4 files, 45 tests passed; M2 cross-package structural gates: 37 tests passed. Root typecheck passed, root lint at 0 errors and 33 staging baseline warnings. The branch is 0 behind relative to `origin/staging` `6b4f6fc636`.

## Completion Conclusion

M2's formal Entries and internal Harness now have single fact sources and mandatory Registry assembly. Renderer edit sessions directly carry formal Config types; one-time Legacy imports and background task Overlays are within clear boundaries, not participating in ordinary production Registries. Shared old Store DTOs have exited production UI. Known exit items after M2 launch are limited to one-time physical migrations, M4's execution-scoped task semantics, and M6-internal account and plan status organization.

The last pre-launch type audit further fixed the allowed locations for old `RuntimeModelConfig`: it only serves one-time imports of old CLI files, and M4's yet-to-be-refactored execution-scoped Turn Overlays. Cross-package structural tests enumerate these files; ordinary Sessions, Registries, Settings, Selection, and ModelFactory will directly fail if they re-reference this type. Old `ZCODE_MODEL`, `ZCODE_BASE_URL`, and `ZCODE_API_KEY` also do not enter ordinary Runtime Config; remaining reads of `ZCODE_API_KEY` belong only to one-time imports of old CLI Providers.

When Execution-scoped Turn Overlays and process Registries produce the same `providerId/modelId`, Overlays for this Turn hold execution priority. ModelFactory, Session Facade model metadata, and transient model switching must all jointly obey this ordering; Registries continue to handle ordinary long-term models, and Overlays do not enter settings, selection lists, or persistence.
