# M2 Implementation Log

> Status: completed historical implementation timeline with appended audit evidence.
>
> Start date: 2026-08-17.
>
> Implementation target: [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)
>
> Full history: git show aac4755666d09fdcd70272fcf063c077a639015f:docs/working-memory/provider-refactor/steps/02-provider-config-and-registry-implementation-log.md

This file keeps, in chronological order, the self-directed decisions made during M2 implementation that went beyond the original plan but did not warrant blocking development, plus audit evidence. Entries preserve the context at decision time; early entries may be superseded by later rulings or implementation and must not be used alone as the current source of fact. The recurring constraint behind most entries: Official Config, Personal Config and Account Access are the only Provider fact sources; everything else is an explicitly bounded migration or execution-scoped compatibility path.

Current target design: [`../design/registry/registry.md`](../design/registry/registry.md). Current implementation status: [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md). Final human rulings: [`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md). Remaining retirement items: [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md).

## 1. Registry Service consumes Source snapshots

The pure-domain resolver takes Config and Account Access values; runtime assembly keeps two narrow sources, `ProviderConfigSource` and `AccountProviderAccessSource`, feeding `ProviderRegistryService`. Sources own files, RPC, remote interfaces, caching and watchers; the Registry Service only reads immutable snapshots, listens for invalidation and publishes an in-memory View. Each snapshot carries a revision, so proactive and watcher notifications for the same fact dedupe naturally.

## 2. Concurrent refresh uses a generation guard

No time-based debounce: each invalidation increments a request generation and only one refresh loop runs at a time; if new invalidations arrive during a read, the older generation's result is not published and the loop re-reads the latest Sources.

## 3. Refresh failure keeps last-known-good

A complete Registry View needs Config plus Account Access together. On any Source read, schema parse or resolver failure, the previous successful View is kept and a refresh error event is emitted; recovery waits for the next invalidation or explicit refresh. Partial views without the failed Source are never published — a transient error could mass-remove Account Providers and expose non-business facts. First start with no successful View stays empty with the error exposed. A Source allowed to degrade later must form its own explicit fallback snapshot, not have the Registry stitch failed data.

## 4. Facade starts as a read-only projection

The first Facade only projects the same Registry Service snapshot into serializable plain objects: Settings sees Personal explicit config, Effective config and issues; Selection sees only published selectable options. It owns no Renderer draft and writes no files; Personal save, delete and reorder wait for the Host integration slice.

## 5. Personal persistence concurrency is owned by the Repository

`ProviderConfigService` implements no file locks, CAS or network retries. The Personal Repository provides an atomic `update(transform)` owning the persistence boundary (read latest snapshot, apply, save); the Service provides domain transforms and Source aggregation only. A local Repository may use an in-process write queue plus file lock, a remote one a server-side version — no separate Registry branches. Successful writes notify through Repository change events only; no second in-memory state from write callbacks.

## 6. No legacy Registry Snapshot adapter

M2 implements no `ZCodeProviderRegistrySnapshot -> ProviderConfigSnapshot` adapter, and the new Registry never consumes the old `ModelProviderService` mixed execution snapshot. Valid static definitions from Catalog/Preset/hardcode migrate into Official Config, user configuration into Personal Config, login and plan judgments into Account Access; API Key, JWT, Team Plan Runtime Key and one-shot security headers stay in request-time auth. Each migration deletes its old branch; no dual fact sources.

## 7. Exact model config rules escape regex characters

`providerMatch`/`modelMatch` are full-match regexes while the settings page saves exact IDs, so Config Service escapes `. * + ?` etc. when writing exact rules; reads and deletes use the same conversion. Hand-written pattern rules stay as-is. Otherwise `model.1` would also match `modelA1` and one edit could change another model's Effective Config.

## 8. Personal Config as a separate versioned file (superseded)

Superseded by [Human in the Loop #10](./02-provider-config-and-registry-human-in-the-loop.md#10-personal-config-keeps-the-original-path-and-ships-as-schema-version-1): Personal Config keeps the original `config.json` path with a pre-migration backup and first ships as `schemaVersion: 1`. The recorded decision was a one-way migration to a dedicated `provider-config.json` with an integer `schemaVersion`, adjacent-version upgrades only, refusal to overwrite higher versions, and field-by-field diffing against Official (Custom Providers without a baseline migrate whole) so historical Builtin/Preset Effective values are never copied wholesale.

## 9. Personal Repository uses a whole read-modify-write file lock

`update(transform)` does read, transform and atomic replacement inside one cross-process file lock; locking only the final rename cannot prevent two Hosts overwriting each other. Local saves and the directory watcher both emit invalidation with no debounce; upper layers dedupe by content revision, so behavior depends on neither filesystem event timing nor delay windows. The injectable Legacy Importer runs only once the Official Config Source is available for diffing; before that, a missing file yields an empty Personal Config rather than freezing the old Effective Config.

## 10. API Key integrity for Official API Providers

Official may declare unconnected API Provider presets, but the Registry publishes only Providers that can currently create Models. Provider types are `ApiProviderConfig | AccountProviderConfig` discriminated by `kind`. An API Provider always needs a non-empty API Key (Personal Config can supply it on an Official preset); no unauthenticated Provider kind exists — tests and fakes use dummy keys. Account Provider dynamic credentials stay with Account Access and request-time auth. API Providers missing a Key appear in the settings Facade resolution with validation issues but not in selection or the execution Registry.

## 11. Mechanical migration scope for the first Official Model Configs

The first Official file expands the old China LLM Catalog's static model facts into the new schema: duplicate models keep one shared Properties and Option Specs, Anthropic/OpenAI-compatible differences split into later `apiFormatMatch` rules, old `set/unset` patches expand into full per-level `ReasoningParameters`, and models without `maxOutputTokens` keep the 32K adapter fallback (an explicit cap is both limit and default). Production switchover and old Catalog/Preset deletion are later slices.

## 12. Provider Config fields fixed before Personal import

Common fields: `kind`, `label`, `logoUrl`, `apiFormat`, `baseURL`, `headers`, `models`, `enabled`; API Providers add `apiKey` and `apiKeyManagementUrl`. Identity is the outer `providerId`; `label` is display-only. Dynamic JWT, Runtime Key and one-shot headers never enter Config; old `source`, Catalog tracking IDs, timestamps, `modified/deleted` flags and system disabled reasons do not migrate (covered by config-layer provenance, the `models` array and Account Access). Provider Config Rules and Base URL inference stay out of the design — overlay by providerId, rules only from a real cross-Provider case.

## 13. Legacy Personal Import migrates only user differences

The importer takes the current Official Snapshot plus the old provider list, converts, diffs field by field and writes only differences: Official-declared providers save diffs, Personal-only providers save the full API config; old source, timestamps, system disabled reasons and Provider Mapping never migrate. Model level handles only `modified: true` models or models absent from Official, then diffs Properties, Option Specs and reasoning mapping so one `contextWindow` edit does not freeze the whole Catalog model; old reasoning patches expand into stateless per-level parameters. Old `source: builtin` providers without an Official baseline are not imported (they may carry JWT/Runtime Key; once Official `kind: account` definitions land, the importer migrates allowed static overrides and ignores old API Keys).

## 14. Official Config ships as an explicit installed resource

The Desktop production package publishes `config/provider/official.json` at `resources/config/provider/official.json`, outside `app.asar` and independent of the working directory; Desktop Main resolves the path and injects it into Local Host. Resource shipping and the production Registry switchover are separate verifiable slices.

## 15. Config Runtime enters Local Host first, consumers switch later

Desktop Main injects the dev/installed Official Config path via `InitLocal`; Services assemble Official Source, Personal Repository and `ProviderConfigService` from it, and the shared domain package depends on neither Electron nor install directories. The legacy provider read function is injectable for the first Personal migration; the production Local Host does not inject it yet, because the settings page still writes old config and an early new Personal file would block the one-time migration. Production migration shares a commit sequence with the settings write switch: lock the old writes, run the final diff migration, then make the new Personal Config the only write target. The new runtime is held and disposed by the Local Host lifecycle; init failure logs a production error while keeping the existing chain.

## 16. Settings Facade forms a serializable write barrier

Write methods accept `ProviderConfigInput` / `ModelConfigObject`, parsed with the same schema as the versioned documents; the Renderer never constructs Config classes or duplicates validation. One write runs Config Service mutation, Registry `refresh()` and Settings View projection in order; the explicit refresh is only a commit barrier reusing Source notifications, revision dedupe and the generation guard — no second in-memory state. On RPC return the caller sees the same Registry View as the persisted result.

## 17. Account Providers keep dynamic credentials out of the Registry

The Account Source publishes only allowed Providers, models, and the non-sensitive account access identity fixed at Model creation; JWT, copied Personal/Team API Keys and one-shot headers stay in request-time auth. The identity is named `accessId`: Personal and Team may share a providerId, so reading the global "current connection" per request would silently swap credentials mid-Loop — the Account Source must provide it, the Registry's execution record keeps it, the Model Selection View does not project it, and ModelFactory fixes it at creation while allowing token refresh within it. Account Provider endpoints never branch on `process.env` in Registry or Factory — environments are expressed by the injected complete Official Config. Whether a Family publishes one connection or several remains a product-level ruling. Details: [`../research/account-provider-facts-and-auth.md`](../research/account-provider-facts-and-auth.md).

## 18. ProviderRuntime owns only in-process assembly

`ProviderConfigRuntime` keeps Official/Personal IO, one-time migration and the Config Service; `ProviderRuntime` assembles the injectable Account Source, Registry Service, Settings Facade and Selection Facade on top, is held and disposed by the Local Host with the ServiceCollection. Until the Account Source exists, an explicitly empty Source is used — Account Providers never fall back into the Registry from the old Snapshot. RPC/UI consumers are not switched yet to avoid double writes; the next slice must put the final legacy migration and the settings write switch in one commit sequence.

## 19. Settings and Selection use separate RPC services

Local Host registers `provider-settings` (Personal Provider/Model save, delete, reorder) and `model-selection` (selectable View, Selection validation), both created by the same ProviderRuntime; the RPC layer re-parses no config. The contract is established and verified before UI migration, and the new View is never converted back into old `ModelProviderConfig[]` for surface compatibility. Old service call map: [`../research/legacy-model-provider-service-call-map.md`](../research/legacy-model-provider-service-call-map.md).

## 20. Client proxies are optional during migration only

`IServiceAccessor` marks the `provider-settings`/`model-selection` proxies optional for cross-entry gradual migration, not runtime feature detection — `RemoteServiceAccess` unconditionally creates the channel proxy, so the field is never `undefined`. Once Host, Remote Server, Prompt CLI/TUI are all assembled, the markers are removed and a missing channel becomes an explicit assembly error; cross-version remote compatibility needs explicit capability negotiation instead.

## 21. Settings page field and responsibility audit

The settings page mixes config editing, Account/Plan connection, connectivity help and Host→Worker Registry sync; the new `ProviderSettingsService` takes over only config editing, the rest migrate along their own domain boundaries, never through old `ModelProviderConfig[]`. The page has converged to a single `apiFormat` (custom full paths stay in `baseURL`); new Provider Config has no paths field, and ModelFactory uses the protocol default operation path per `apiFormat`.

## 22. Draft Preview stays in the Settings Facade

`ProviderSettingsService` Provider/Model preview methods place an input-schema-valid unsaved Draft temporarily as the last Personal Config layer, reuse `ProviderConfigResolver` for the full View, and write no Repository, replace no Registry and emit no change events. The Renderer gets Effective placeholders and domain validation without duplicating ConfigOverlay or ModelConfigRules. Preview is not a raw form parser — it runs only after a legal `ProviderConfigInput` / `ModelConfigObject` exists, so the domain needs no UI draft string types.

## 23. Video Property completed before Model Factory integration

`supportsVideo` was missing from the actual Model contract when the Registry began creating M1 Models; it was filled into the M1 public contract, Adapter request validation and Core media projection (old factory defaults to unsupported). A pre-integration contract completion, not a new M2 config concept.

## 24. The existing AI SDK Registry is demoted to an execution projection

The M2.5a API Provider Model Runtime one-way generates the existing `AiSdkModelRegistryConfig` from the new Registry View and creates M1 Models from the same ProviderConfig/ModelConfig. The old `AiSdkModelRegistry` keeps only SDK factory, network, request security validation and the internal execution projection — no Catalog, CLI Config or Host Snapshot reads, no Selection validation. Registry updates replace the projection for later Models; created Models keep their resolved SDK Model. Reasoning Mapping is placed at Model creation by `apiFormat` (Anthropic Messages → `anthropic`, OpenAI-compatible Chat → `openaiCompatible`, OpenAI Responses keeps the canonical entry). Account Providers are rejected on this path pending request-time auth; they never fall back to the old Registry Snapshot.

## 25. Node Config Source converges into a shared companion package

The Node file implementation lives in the companion package `@zcode/provider-node` (Official file source, Personal file repository, Node config runtime, process registry runtime) depending on `@zcode/provider` and `@zcode/shared/node` persistence; the pure domain package keeps only Config/Overlay, Resolver/Registry and Facade, and the old `ModelProviderConfig` → Personal Overlay converter stays in Services behind migration entry points. Physical location stays with the Entry: Desktop Main resolves paths; Local Host passes Official/Personal paths as paired environment variables to Workers, which read and watch the files themselves rather than receiving Host-serialized Registry data. Standalone CLI/TUI builds and SEA carry the same `config/provider/official.json` into the same Source boundary — no embedded constants, which would recreate a second fact source.

## 26. Registry and execution Adapter use different lifecycles

The Adapter holds Session/App-level Model IO, state and telemetry; a process singleton would share execution state across Sessions and per-Session creation would duplicate watchers. The Registry is a process-level fact view; the Adapter and Model Runtime are App/Session assemblies. Each `createZCodeApp` borrows the process Registry for its own Model Runtime and disposes it symmetrically; the Registry is released only at Worker exit.

## 27. Worker Registry starts as a shadow runtime

Workers with injected Official/Personal paths start a process-level Registry with automatic refresh; injecting only one of the two paths is an explicit startup failure. The production ModelFactory is not replaced yet (the settings page still writes old config, so executing on the new Registry could see an empty Personal Config). M2.5c advances as one commit sequence: lock the old Provider write entry → final migration to Personal Config → switch settings and selection to the new Facade → each App creates Models from the Worker Registry → delete old fact reads for ordinary API Providers.

## 28. Apps can use the Provider Runtime exclusively for the execution projection

`createZCodeApp` gains an injectable process Registry; with it, each App creates its own `ApiProviderModelRuntime` (own Adapter and ModelFactory, released at App close). The Workspace/Turn Model Overlay may keep migration-period Session state but no longer calls `replaceRegistryConfig()`; `createModelAdapter` accepts an externally managed empty initial execution Registry, so Provider facts are never built from old Runtime Model Config first. The protocol entry is not switched yet: the Turn Overlay still carries off-peak execution-scoped providers, and enabling it early would break them — the production switch needs temporary Providers via unified execution-scoped ModelFactory input or a clearly bounded temporary branch.

## 29. The old settings write entry bridges one-way to Personal Config

Until the settings page migrates, Local Host converts the user Provider static list to a Personal Overlay and atomically replaces the new Personal Config after each successful old `save/delete`, then explicitly refreshes the Registry so the old call returns with new facts and Worker reads consistent. The bridge handles only explicit user saves/deletes and subscribes to no old Snapshot — account refresh, plan changes, one-shot material, temporary headers and copied Runtime Keys never persist. It sits inside the old write queue: a failed new Personal write fails the old settings call, and a later save converges from the full static list. Exit condition: all writes use the new Settings Facade, then the callback and Legacy types are deleted.

## 30. execution-scoped Providers are merged by the Model Runtime

`ExecutionScopedModelSource` serves only temporary Providers executing in the current App; combined with the process Registry it forms the Adapter execution config, winning providerId/modelId conflicts but never writing the process Registry, Settings View, Selection View or disk. The off-peak per-turn Runtime Model Overlay is wrapped as such a Source; temporary Providers join at Turn start (atomic projection replacement) and leave at Turn end, and executing Models keep their SDK Model across refreshes. M4 replaces the old-format conversion with formal Config/ModelFactory input but keeps the Source's lifecycle and priority semantics. (Regression noted: GLM-5.3 production fixes default reasoning to `max` by model identity while `offpeak-turn-model-overlay` asserted incoming `high`; the capability branch was left unchanged.)

## 31. Worker production Apps start using the process Registry

Model construction priority: turn execution-scoped Provider > process Provider Registry > workspace compatibility Provider. The compatibility layer holds only the Host-delivered workspace Overlay and may create a Model only when the Registry lacks the whole providerId (Plan Providers pending Account Access); once the Registry has the providerId, old config, API Keys and model entries cannot override new facts. Exit condition: after M2.7, the Overlay has no Provider the Registry lacks and `fallbackSource` is deleted; the layer never joins Settings/Selection Views. Worker startup may race the first Personal migration — compatibility keeps the session executable until the watcher refresh switches later Models; created Models are not rewritten.

## 32. Model selection surfaces switch ordinary API Providers first

The Renderer gains a standalone `ModelSelectionView` snapshot with subscribe-before-read ordering and a revision guard against late values; it is never converted to old `ModelProviderConfig[]`. The Composer menu projects `kind = api` Providers as model groups in Registry order filtered by the Agent's supported `apiFormat`, excluding same-providerId old snapshot entries; current selection, trigger names and restore eligibility also recognize Registry Providers. Account/Plan Providers stay on the old projection until M2.7 (Family grouping, Personal/Team connection and entitlement state are not yet in `AccountProviderAccess`); that boundary is deleted once they join the unified Registry. Automations (including the shared OffPeak form), Subagent and Repo Wiki menus follow; peripheral reads (switch toasts, timeline names, telemetry Base URL) prefer the View and fall back only for unpublished Account/Plan Providers.
