# M2 Retirement Cleanup

> Status: Completed; implementation and final branch verification done (last review 2026-08-21).
>
> Full history: git show 45f808f7:docs/working-memory/provider-refactor/steps/02-provider-config-and-registry-cleanup.md

M2's last goal is closed: ordinary long-term Provider configuration, display, selection, and execution all come from a single fact chain.

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

Physical migration modules may still read old files, and background tasks may still supply single-execution input through `turnRuntimeModel`; both stay inside explicit boundaries and do not participate in the steady-state facts of ordinary long-term Providers.

Generic `RuntimeConfigPatch` has left the old model fields. Old CLI file `provider`, `model`, and `modelCatalog` fields are read only by explicitly named migration projections; ordinary file configs, environment variable configs, and Config Merger no longer generate, merge, or expose model facts. Old `ZCODE_MODEL` / `ZCODE_BASE_URL` no longer form a hidden runtime configuration path.

Ordinary CLI file runtime configuration schemas no longer declare `provider`, `model`, `modelCatalog`, or `small_model`. Residual or malformed values of these fields do not prevent formal configs such as MCP, permissions, and network in the same file from loading; only the one-time Personal Importer's Legacy Schema reads and strictly validates them.

## Cleanup Outcome

### Repo Wiki

Repo Wiki consumes `ModelSelectionView` directly and issues requests through unified `Model`. The intermediate `ZCodeProviderRegistrySnapshot` projection, reverse parser, old readiness resolver, and their tests are deleted.

### Settings Connectivity and Security Validation

Connectivity tests receive formal Provider/Model Config drafts. Security validation chains read API format and address from the formal Provider Settings View. Neither path re-interprets old endpoint/defaultKind structures.

### Model Selection and Auxiliary Code

No production consumers remain in model menus, Bot selection, Workspace Prepare, plan displays, or model sorting. Old helpers, wrapper modules, re-exports, and specialty tests are deleted; files still in use satisfy only the new Registry/View requirements.

### Old Services Provider Storage Drafts

Reference audits deleted five consumer-less files: the plan entry state file cache, the GLM workspace Provider config repository, atomic file drafts never integrated into the formal Repository, and the old Provider settings JSONC parser. They carried old plan availability, Workspace Provider configs, and a parallel physical Config read path; keeping them would make it appear that code can bypass Official, Personal, and Account Sources to establish Provider facts.

Also deleted: old model override header constants with no readers. The file was isolated, with no request, protocol, or config consumers; keeping it would imply another model override entry point still exists.

Services structural tests pin these files as gone. The gate does not forbid later general IO tools, but the old file names and responsibilities cannot return without a new architecture ruling.

### Process Registry

Production protocol Entries must start the process-level Registry successfully. Missing Official or Personal Config paths surface assembly errors directly, without silently creating a second set of Provider facts.

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

`hasProcessProviderRegistry` branching and the Workspace Provider Catalog fallback are gone. The Test Harness assembles the Registry explicitly, so tests no longer mask production dependency omissions.

### Workspace Model State

`workspaceModelCatalogs` shrank and was renamed to `workspaceModelPreferences`. It stores only interaction and persistence selections:

```text
Workspace Model Preferences
├─ defaultMode
├─ defaultModel
├─ defaultThoughtLevel
├─ lastUsedModel
└─ revision
```

Provider lists, model properties, Option Specs, credentials, and Provider revision come from the process Registry. Workspace state no longer carries Provider Catalog responsibility.

The Renderer's `workspaceModelMirror` queue is deleted; it once asynchronously mirrored model selection into the old `setWorkspacePreferredModel` entry, but all consumers have migrated to the session-aware Selection control chain, and a caller-less queue would imply Workspace still has another pending model fact to reconcile.

Also deleted with no remaining production callers: `workspace/readState.modelCatalog`, `ZCodeWorkspaceModelCatalogState`, Worker-side Provider projections, and App Config→Protocol Provider conversions. Model lists and current selection return from `settings.model`; Workspace `state.updated` sends the same Settings shape, and old `{ modelCatalog }` Patches no longer exist. First background dispatch inherits `settings.model.current` directly and validates the selection against the same `settings.model.available`.

In-app Workspace Overlay write entries are deleted. `setModelCatalogOverlay`, Workspace Overlay state, and listeners had no production callers but could still inject full Provider/Model snapshots into model lists and the old Adapter Registry; keeping them would let old Host Snapshots re-emerge as a second fact source. Single-turn `setTurnModelCatalogOverlay` remains, serving only execution-scoped temporary models and cleared on completion.

### Ordinary and Temporary Execution

Ordinary Session commands carry only `ModelSelection`; Workers create Models via the Registry of their own Environment. Host-supplied ordinary `runtimeModel`, old revision CAS, and Workspace Provider write-backs are gone.

`createModelAdapter()` accepts only explicitly named AI SDK Registry containers; there is no public branch for building ordinary execution Registries from old `RuntimeModelConfig`. The formal Provider Runtime manages that container after app startup; old Runtime Config transformations are internal to Turn Execution Sources.

Background task `turnRuntimeModel` is retained temporarily. It forms only a temporary Model Overlay for the current Turn, writes nothing to the Registry, and does not modify Workspace Preferences; its formal Provider and request-period authentication design belongs to M4.

### Model and Request Authentication

Model creation fixes the Provider's static execution configuration. Account API Keys or header refresh supply only the current request attempt's dynamic authentication material and never send an already-created Model back to the current Adapter Registry to re-resolve a full Provider:

```text
Model creation
└─ Fix Provider static execution config

Request attempt
├─ Read latest dynamic auth material
└─ Overlay API Key / header on fixed config
```

Registry hot updates therefore affect only subsequently created Models. The current Loop never silently switches Endpoint, API Format, Provider Factory, Provider Options, or static headers during request retries or one-time security header refreshes. Physical routing, proxies, and request security checks stay with the Adapter's request facilities, not written into Models as Provider static facts.

The dead Bootstrap chain that mutated Active Session capacity in place after Registry hot updates and then re-broadcast ModelSelected is deleted. Active Sessions hold their own Models; new properties and Option Specs reach only subsequently created Models.

Account logout captures the account identity before OAuth main session cleanup, deletes account-scoped Personal Coding Plan Keys, and deletes old unscoped keys during the compatibility window. Re-login forces re-acquisition and key override with the new OAuth Token. Account Provider disappearance from the Registry, request authentication failure, and derived credential cleanup thus follow the same account lifecycle.

## Settings Page Form Boundaries

The settings page keeps a Renderer-private edit session state whose config fields use formal Config types directly:

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

This projection layer only edits and saves forms. It does not read Provider files, build a Registry, decide model selectability, create Models, or serve as an execution fact source.

When the settings page needs to judge whether a Provider is selectable, it uses the `selectable` flag published by the Registry in the Settings View. Saves return freshly refreshed Settings Views, so Provider family corrections and Plan sync compensations after saving use the same latest Registry conclusions; the Renderer no longer copies a startup availability algorithm based on API Key, Endpoint, and model fields.

Plan connection status reads only the `accessId` published by the Account Overlay. Old API Keys, Endpoints, and model lists in Provider forms no longer re-judge Coding/Start/Team Plans as connected when Account Access is missing; navigation status points use Registry `selectable` directly. The settings page no longer keeps an implicit "fall back to old forms when new Services are unassembled" mode.

Edit sessions no longer replicate the old Store's endpoints, kind, modalities, ProviderOptionsPatch, and timestamp fields. Beyond formal Config the Renderer adds only `providerId/modelId`, Registry projection state, and Personal source markers; undisplayed Model Config fields are retained with edit state. Old `ModelProviderConfig` survives only in one-time physical migration reads. The settings experience can keep adjusting controls without changing formal Config, Registry, or execution facts.

API types belong only to Provider Config. The settings page edits Provider connections with `ProviderApiType`; model-level API kinds, Endpoint Paths, and multi-protocol selection side paths no longer exist. Repo Wiki and connectivity probes consume this formal type directly, without reverse-translating current Config into old Provider Store kinds.

E2E seeding follows the same boundary:

- Desktop E2E Direct Seed and WDIO global Provider fixtures write only versioned Personal Config (DeepSeek, Output Budget, Repo Wiki, Context Window, and Provider filtering cases); environment default models write to an independent `model-selection.json`. CLI Config keeps only non-Provider-Harness settings such as `modelStream` timeouts, without copying Provider, Model, or default Selection. Coding Plan fixtures no longer write Builtin Provider copies; construction goes through Official and Account Sources.
- Restart E2E: Replay Providers write only Personal Config; environment cold-start default models write only versioned Model Selection Config. Tests no longer copy Providers or reasoning parameters through Project/CLI Config and no longer artificially create the old Host Snapshot vs Worker CLI Catalog race.
- Team Plan Usage E2E writes only Personal Config; Personal/Team account identities come from Account Sources in the scenarios; available Providers form through the formal Overlay sequence, without writing old CLI Provider Config or old Provider Store.
- Reasoning manual-review E2E replay endpoint discovery uses explicit replay runtime information or unified Personal Config test projections; old physical formats remain only in centralized migration boundaries.
- The quota reset service's Account Access scope from settings details is closed: the Renderer passes through only the non-sensitive `accessId` from the Registry View and never reads API Keys back; Personal/Team same-Provider requests keep dynamic authentication resolved server-side from connection identity.

Generic `RuntimeModelOverlayManager` in Bootstrap is gone. The single retained Overlay object is the explicitly named `TurnModelOverlayState`, carrying only execution-scoped temporary models for the current Turn; it exposes no APIs implying Workspace, Session, or ordinary Runtime Provider layers.

## Explicitly Retained Legacy Boundaries

The remaining compatible code, each with a single deletable responsibility:

- Personal Config first import: read old physical files only when new Personal Config does not yet exist.
- Account Key one-time migration: move old Personal Coding Plan Keys into the Account Credential Store.
- Renderer edit session state: carry formal Config directly, isolating drafts from Registry runtime state.
- `turnRuntimeModel`: execution-scoped input for background tasks until M4.

None of these is called in reverse by the Registry steady-state path.

M2's completion boundary is enforced mechanically by cross-package structural tests. In production source code, old `ModelProviderConfig` is permitted only in Shared's historical DTO definitions, Personal first import, Account Key one-time migration, and their assembly entries; old `model-providers.json` may be read only by `legacyModelProviderStoreReader`. Old complete Registry Snapshots, `workspace/updateProviderRegistry`, generic Runtime Overlays, and old settings projection names must remain at zero occurrences in production source code. New compatibility points must first update this document and state explicit exit conditions; filename changes cannot bypass the boundary.

Bare `createZCodeApp()` model assembly paths for tests and internal tools are gone. The formal Prompt CLI, TUI, and Protocol Entry share the same required Registry dependency; Bootstrap Session Persistence, MCP, Hook, and Workflow tests build actually executable Models through the Registry-backed Harness; Compact/Memory E2E and Prompt Trajectory tools create their test Registries explicitly. `ZCodeAppOptions.providerRegistry` is required, exposing assembly errors immediately when missing. `bootstrapModelConfig`, `includeLegacyProviderModels`, and Registry-less App Factory branching are deleted.

Adapter Factories no longer carry old Runtime Model Config branches. `createModelAdapter()` must explicitly receive AI SDK Registry containers managed by its caller; Prompt Trajectory and WebSearch Probe provide execution models explicitly; old CLI Config model selection write entries are deleted. Old Config Parsers are retained only for Personal first import and non-Provider Harness settings and cannot supply facts for steady-state model execution. Turn execution-scoped Runtime Model Config is transformed only inside `TurnExecutionModelSource` and never enters public Adapter Factories.

Generic `RuntimeConfig` and `ConfigPort` have dropped `model`, `modelCatalog`, and the corresponding Config Keys. Compatibility parsing of old files and `ZCODE_MODEL` remains as deprecated-marked migration input, but Config Factories no longer project these fields into runtime configs, and `hasModel` source metadata is deleted. Formal app initialization obtains models only from the Process Registry and explicit Session/Submission Selection.

The old Provider Store converged to a pure read adapter renamed `legacyModelProviderStoreReader`. Production calls are only Personal first import and Account Key one-time migration; old paths no longer write back to `config.json`, no longer restore backups, and no longer keep old-format reverse serialization and atomic write code. Old Store Schema and migration functions have left ZCode Protocol re-exports and remain only in Shared Provider migration types and Services one-time Readers.

Additional closures pinned by the same gates:

- Provider initial and final ordering comes solely from ordered Effective Views; user drag-and-drop keeps writing Personal Overlays. The old Display Order Preference's `updatedAt` shell and Shared DTOs are gone; the UI keeps only `ProviderOrderView` projected from the current View. The last Builtin Provider ID hardcoded in settings page sorting is deleted.
- Stale Provider revision fields left Session Settings and request-period authentication callbacks; complete Snapshot revision CAS is gone, and these fields have no production writes or behavioral consumers. Current shared protocols, Bootstrap Session Mappers, Core Invocation Context, and Adapter Request Auth keep only actually effective request authentication material. Core source code is inside the M2 cross-package structural gates, preventing old revision names from re-entering from inner layers.
- `@zcode/provider`, `@zcode/provider-node`, Prompt CLI, and TUI are under the same structural gate; extended scanning confirmed these entries have no old Provider Snapshots, Workspace Catalog, or Runtime Overlay fallbacks. Workspace interaction state terminology is unified to Model Preferences; one zero-caller legacy reasoning migration function is deleted.
- Provider migration/Registry helpers in Bootstrap and Prompt CLI used only file-internally are no longer exported; formal cross-module entries are unchanged, and Knip confirmed zero uncalled Provider/Model/Registry exports in both packages.
- Two zero-caller Services helpers that inferred Coding Plan disable state from old `enabled/systemDisabledReason` are deleted; file-internal implementations of Account/Request Auth/Connectivity modules are no longer public extension points. Account Sources form Account Overlay results from available/unavailable/unknown states only.
- Workspace key and external Agent configuration isolation helpers in Services path modules are file-internal again; external Agent skills, plugin, and runtime status path behavior is unchanged.

## Verification and Known Debt

Closeout rounds ran root `pnpm typecheck`, root `pnpm lint` (0 errors, 33–36 current staging baseline warnings), Bootstrap and Prompt Trajectory independent typechecks, and the targeted Provider, Provider Node, Registry, Runtime Config, Session, MCP, Hook, Workflow, Telemetry, Overlay, migration-boundary, and Desktop E2E suites, all passing. Pre-existing debt that this cleanup did not cause and that launch verification must keep reporting:

- Bootstrap full tests: Session Persistence test mocks miss new methods; Native Boundary has existing cross-domain imports; several historical timeouts; pre-existing `v4-native-boundary`, oversize V4 Gateway timing, and Session Resident Pool failures remain.
- Verification ran on Node 22 while the repository declares Node 24; Node 22 cannot load Bootstrap builds that reference root `@zcode/shared` source in the latest staging. Compact fake suites and formal pipelines still need re-verification on the declared Node 24 / CI runtime.

## Completion Conclusion

M2's formal Entries and internal Harness have single fact sources and mandatory Registry assembly. Renderer edit sessions carry formal Config types directly; one-time Legacy imports and background task Overlays stay inside explicit boundaries and do not participate in ordinary production Registries. Shared old Store DTOs have left production UI. Known exit items after M2 launch are limited to one-time physical migrations, M4's execution-scoped task semantics, and M6-internal account and plan status organization.

Old `RuntimeModelConfig` serves only one-time imports of old CLI files and M4's not-yet-refactored execution-scoped Turn Overlays. Cross-package structural tests enumerate these files; ordinary Sessions, Registries, Settings, Selection, and ModelFactory fail directly if they reference this type again. Old `ZCODE_MODEL`, `ZCODE_BASE_URL`, and `ZCODE_API_KEY` do not enter ordinary Runtime Config; remaining `ZCODE_API_KEY` reads belong only to one-time imports of old CLI Providers.

When an execution-scoped Turn Overlay and the process Registry produce the same `providerId/modelId`, the Overlay holds execution priority for that Turn. ModelFactory, Session Facade model metadata, and transient model switching must all obey this order together; the Registry keeps handling ordinary long-term models, and Overlays never enter settings, selection lists, or persistence.
