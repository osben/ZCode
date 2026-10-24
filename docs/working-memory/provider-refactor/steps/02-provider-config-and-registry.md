# M2: Provider Config and Registry Implementation

> Status: Implementation, retirement cleanup and final branch verification completed; awaiting release
>
> Last updated: 2026-08-21
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/02-provider-config-and-registry.md`

Target design: [`../design/registry/registry.md`](../design/registry/registry.md). Cleanup results, retained narrow
compatibility boundaries and final verification: [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md).
New-code scale and transition boundary review: [`02-provider-config-and-registry-review.md`](./02-provider-config-and-registry-review.md).
Merge Request static review and fix evidence: [`02-provider-config-and-registry-mr-review.md`](./02-provider-config-and-registry-mr-review.md)
(all release-blocking items resolved).

## Highest Priority Migration Principle

Official, Personal and Account three-layer Provider Config are the only fact source of the Provider Registry. Repeated
static facts in Catalog/Preset branches, Builtin hardcode, Provider Family resolver, old CLI Provider Config and
Runtime Snapshot are migrated into these layers or deleted:

```text
Still-valid old static facts               -> Official / Personal Config
Still-valid old account and plan judgments -> Account ProviderConfigMap
Still-valid old dynamic credential logic   -> request-phase auth Service
Old branches not provably needed           -> deleted
```

No "old Snapshot + new Registry" compatibility layer is kept. One-time format migration at the physical storage
boundary is allowed; the post-migration execution chain reads only the new fact source.

## Goal and Target Chain

M2 unifies how Models are produced from the current Environment's Provider facts. Before M2 the Host Provider
Service, Worker Workspace Catalog, CLI Config Parser and Runtime Overlay each interpreted static Provider
information, so Host selection and Worker execution had to be kept consistent through complete snapshots.

```text
ProviderConfigService
|- Official ProviderConfigMap
|- Personal ProviderConfigMap
`- Official / Personal ModelConfigRules --+
                                           +-> Registry input aggregation
AccountProviderService                     |
`- Account ProviderConfigMap --------------+
                       |
                       v
            ProviderRegistryService
               |- Provider[] / { modelId, config: ModelConfig }[]
               `- createModel(selection) -> ModelFactory -> Model
```

Host, Core Worker, Prompt CLI and TUI reuse the same Config and Registry domain implementations, each holding its
own instance per process.

## Settled Design Rules

1. Config uses unified ConfigOverlay semantics: sparse layers and final results share one type; keys are ordered; an
   overwritten key keeps its position; new keys append in the later layer's order.
2. ProviderConfig and ModelConfigRules each have ordered Official and Personal inputs.
3. Account Source directly produces the third sparse `ProviderConfigMap`, overlaid with the same type. An Account
   Provider's `accessId` and current `models` are kind-specific Config fields; the Registry does not verify account
   entitlements; request auth is ultimately decided by the Account Service (background:
   [`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md#1-account-access-reuse-provider-config-overlay)).
4. The Registry forms ProviderConfig and ModelConfig in two rounds; providers and models keep order externally;
   internal indexes serve query, Selection validation and Model creation.
5. Settings and model selection pages use their own Facades; the Renderer does not copy parsing logic.
6. The settings page drags only Personal-only Providers and models inside Personal Providers; saving rearranges the
   Personal Overlay by Effective order, with no independent sort Preference.
7. Each process has its own Registry instance; with the process Registry on, the Host Snapshot no longer takes part in
   membership, attributes, execution or display of normal long-term Providers.
8. Off-peak tasks select Official Builtin Providers from the process Registry; the execution phase adds only Request
   Auth and Ticket, never a temporary Provider static fact source.

## Slices and Results (all Completed unless noted)

The first slice was the pure domain package `@zcode/provider` (no files, network, React, Electron, Services or SDK):
Config Schema + ConfigOverlay -> `ProviderConfigResolver` (complete parse results and issues; valid Provider View) ->
memory `ProviderRegistry` (ordered View, provider/model index, ModelSelection validation, change notifications).
Impact/test contract at its start: [`02-provider-config-and-registry-impact.md`](./02-provider-config-and-registry-impact.md)
(historical evidence, not current status).

- **M2.1** `@zcode/provider` package: ConfigOverlay, ProviderConfig, ModelConfigRules, parsing tests.
- **M2.2** `ProviderConfigResolver`: two-round parsing, ordering, three-layer overlay, integrity gate; IO-free memory
  Registry; Selection validates Provider/Model, `reasoningLevel`, `maxOutputTokens` with shared Option rules
  (Configured Default and Facade reuse them).
- **M2.2b** `ProviderRegistryService`: injected Official/Personal/Account Config Sources; revision deduplication,
  concurrent refresh generation guard, last-known-good failure boundary.
- **M2.3a** Settings / Selection pure projections: Personal / Effective / Issues; Selection projects only
  Registry-selectable models.
- **M2.3b** `ProviderConfigService` with injectable Official Source and Personal Repository; Personal Provider/Model
  save and ordering.
- **M2.3c** Production Official / Personal Config Source:
  - Official data in `config/provider/official.json`; Personal Config at the existing `~/.zcode/v2/config.json`.
    Final Schema published as `schemaVersion: 1`; unpublished development v1-v5 migration branches are not part of
    the compatibility chain.
  - Access method is `access.type`, public API `api.type`; Model Config expresses model/API behavior with
    `apiMatch + reasoningMapping`; ModelConfigRules support `apiFormatMatch` and stateless `reasoningMapping`.
    OpenAI-compatible always requests Usage (no disable switch).
  - One-way import of sparse Personal Config from old `config.json`: only when Personal Config does not exist; full
    backup first (backup failure aborts); atomic replacement at the same path. Old Builtin Preset import keeps only
    user API Key and modified model overrides (no Preset label, endpoint, model list or account status). The runtime
    old Provider Store no longer syncs back to Personal Config; old Store is read only for Personal/Account one-time
    migration, and historical correction rules are private to migration files.
  - Deleted: Catalog query/Loader/JSON/Electron packaging resources and public Catalog API; model default facts come
    only from ModelConfigRules (`[1m]` suffix interpretation removed; 200K default and `[1m]` 1M context come from
    Official ModelConfigRules); endpoint suggestions and endpoint-based model detection on the settings page; the
    Start Plan free-model whitelist and placeholder Provider in Renderer/old Store (Official Config declares static
    models, Account Overlay decides available members, offline fallback fakes no Account Provider); the unused Preset
    builder, remote config fetch and Store steady-state sync; Workspace Snapshot `modelCatalog`, old Provider group
    projection, App Config -> Provider conversion; the App's Workspace Provider/Model Overlay write entry (only the
    execution-scoped Turn Overlay remains). Model status is expressed by `settings.model`.
  - Settings connectivity test uses only the Model Config `reasoningMapping` (no GLM-name hardcoding); adding models
    previews Official/Personal ModelConfigRules via the Settings Facade; Add Provider edits explicit Provider Config
    only.
- **M2.3d** Account Provider Config Source:
  - Current login and plan judgment project a sparse Account `ProviderConfigMap`; Official/Personal/Account share one
    overlay. Each Access Entry carries a non-sensitive `accessId` fixed at Model creation and passed to the Host at
    each request attempt; Account Model Properties, Option Specs and reasoning mapping come from the new Registry.
  - Host Request Auth Service resolves Start / Personal / Team credentials by fixed `accessId`. It was lifted from
    the old `ModelProviderService` internal Resolver to a narrow service contract held in the Local Host process and
    assembled at the composition root; Agents and Off-Peak depend only on this contract (no generic RPC cross-Host
    routing). Team Plan request-phase Key organization/project validation, creation and Secret copying live in a
    standalone Account Runtime module shared with old-Snapshot-compatible calls. Account Models need no old Workspace
    Secrets; entitlement judgment narrowed to providerId, auth input and Account context.
  - IO-free `AccountProviderService` manages Config dependencies, ready barrier, refresh notifications and
    last-known-good Account `ProviderConfigMap`. Local Host refreshes on account connection Setting updates and
    explicit Account Facts events. Account Connection Result parses available / unavailable / unknown, preserving
    known results per Provider; Services adapt account domain, Family connection mode, Personal/Team selection and
    Start/Coding entitlement. Start Plan extracts the remote model set from the same billing/balance entitlement query.
  - Personal Coding Plan Keys moved to the Credential Service by `accessId` (Connection Resolver and Request Auth
    share one read entry; old Provider Keys remain only for one-time migration). OAuth logout deletes them and
    refreshes the Account Source. Old `refreshCodingPlanApiKey` / `clearCodingPlanApiKey` public APIs and Store
    rewrite chains are gone; Start/Coding mutual exclusion, Team Project and temporary-error semantics are protected by
    independent Availability tests.
  - Deleted: Account Secret projection Local Host -> Worker Registry; bypass Account Access/allowedModelIds (overlay
    `accessId`/`models` directly).
  - The Host sends Account Config through the independent process protocol; Workers no longer extract it from
    `workspace/updateProviderRegistry`.
  - Account identity semantics: Personal, Start and Team `accessId` identify a specific account connection (stable on
    credential refresh for the same account, changes on account switch). Request Auth checks `accessId` against the
    credentials' current account (Team also account, organization, project) and refuses old-Model-identity + new-account
    credentials. The Credential Store switched to account-level `accessId` (the earlier provider-level key was never
    published and is not migrated). Usage Source and caches use account-level `accessId`; Team requests add the
    required `accessId` and keep organization/project context (no parallel `accountCacheIdentity`).
- **M2.4** Host Settings / Selection Facade uses the only Registry:
  - `ProviderRuntime` assembles Config, injectable Account Source, Registry and Facade (can take a pre-created Config
    Runtime so Account Source depends on the same Config Service); Host RPC channel and Client proxy; the Facade
    shares the Runtime ready barrier (removes the Host async startup race).
  - Composer API Provider selection, Account Provider candidates and current connection come from
    `ModelSelectionView` (Renderer shows Start/Individual/Team badges from the fixed `accessId`); settings page API and
    Account Provider display (name, Endpoint, model properties, Option Specs) come from `ProviderSettingsView`.
  - Settings connectivity test submits the unsaved draft through Provider Settings RPC; the Host identifies Account
    Providers from the latest Settings View and obtains dynamic credentials from the request-phase auth boundary, never
    the old Provider Snapshot. Cold start waits for the Settings View; manual refresh refreshes Account Source and
    Registry directly.
  - Provider order, Personal-only drag, Personal Provider-internal model order, Personal-only create/edit/delete all
    write the Personal Overlay; page order comes only from the Effective Provider View (no old display-order
    Preference). Welcome API Key login writes only a sparse Personal override of the Official API Provider, confirms
    the Provider from the Settings View and selects the default model from the Selection View.
  - Provider Settings Service is required for all production entries; API Key read/write and Management URL use only
    the Settings View with no fallback to old `ModelProviderService`.
  - Settings save takes the structured complete Effective Provider/Model Config; the Facade computes the sparse
    Personal Overlay relative to Official and writes it by one atomic replacement. The Renderer edit state carries
    `ProviderConfigObject` and `ModelConfigObject` plus `providerId/modelId` and Registry projection state (the old
    Store's endpoints, kind, modalities, ProviderOptionsPatch and timestamps are gone); saving calls
    `saveEffectiveProvider()`.
  - Consumers moved to `ModelSelectionView` / Settings View with no old `ModelProviderConfig` or Snapshot fallback:
    custom model recovery, draft startup gate, ZCode Agent recent selection/current callback, Family selection after
    OAuth and startup recovery, model switching prompts/timeline/telemetry, workspace model preference adjudication
    and reload (historical provider identifiers unify to the single ZCode Agent), V4 custom provider recovery, Bot
    `/model`, `/status` and startup migration (per belonging Environment), Provider Family one-time migration, Root
    logout and Plan unbinding, root startup gate, Composer/Automation/Subagent/Repo Wiki model menus and reasoning
    tiers (reasoning stays unknown when the View is unpublished or the model has no Option Spec; no GLM-name
    inference; a confirmed empty View does not fall back; the model menu does not append Registry-filtered Providers),
    UI reasoning helper, and the settings page Provider list.
  - Plan/Usage consumers use the Account Overlay `accessId`: Coding Plan entitlement Hook, Plan Identity Snapshot at
    session submission, settings Usage plan source / query gate / cache identity, sidebar Usage gate and Team Products
    detection, Composer Context Usage, off-peak home and purchase funnel, Coding/Start/Team Plan connection status,
    login completion wait and auto-sync. The Renderer no longer reads API Keys to judge plan availability; after a
    global Coding Plan purchase it waits for Account Source and Registry refresh. OAuth login, session recovery and
    logout refresh Account Source and Registry after converging the account selection state.
  - Deleted: Renderer old Provider Snapshot state/subscription/refresh modules; Settings Sync Provider Snapshot refresh
    (future imports must write Personal Config explicitly); old `ModelProviderService` public service surface, RPC
    registration, Host proxy and Preset Sync (the old physical Store remains only for one-time Personal/Account
    migration); `testModelConnectivity` and `getProviderRegistrySnapshot` with cache and tests (Repo Wiki uses
    Model Selection View directly). The Local Host must assemble the Provider Runtime; Official/Personal/Account
    Sources are startup facts.
  - Connectivity test: static model facts from the Host Registry, dynamic credentials via the request-phase auth
    boundary, unsaved drafts submitted with the Settings RPC; Start Plan is supplemented only by the Renderer with a
    one-time security verification Header from this interaction. The Probe only does authenticated single-network
    detection (narrow dependency); it parses no Provider facts or Account identity.
- **M2.5** Execution:
  - M2.5a new Registry -> AI SDK execution projection and ModelFactory boundary. M2.5b shared Node Config boundary;
    Worker startup and holding the Registry. M2.5c each App assembles Model Runtime and switches normal API Provider
    production calls, synchronously switching the final Personal migration/write entry and deleting old fact reading.
  - The Settings entry writes only Personal Config (no old Store mirror writing or reverse steady-state sync).
    Expert Workflow and Script Workflow child Runtimes reuse the process Registry `ModelFactory`. Core compatible
    runtime config (context, output, media capability, reasoning parameters) for Providers in the Registry projects
    from Registry Model Config; old Catalog remains only for first migration and the current Turn's temporary
    execution input.
  - Explicit initialization and `setModel` observe the Provider-level migration boundary: when the Registry owns a
    Provider, a missing Model errors and is not concatenated from the old Runtime Overlay; Session recovery keeps the
    historical Selection; state reading does not borrow old Catalog to explain deleted Models (execution reports
    unavailable). Bootstrap's explicit Registry Selection validates common Options through Registry
    `validateSelection()`.
- **M2.6** Prompt CLI / TUI use the shared domain: process-level Registry when Official/Personal paths are injected;
  Prompt CLI borrows and releases it within one App lifecycle; TUI reuses it across `/new` and resume and releases at
  Entry end; both use registry-only (no Workspace Legacy Compatibility Source); assemble with package Official Config
  location and Personal path; one-time difference import of explicit Providers from old CLI user files; Selection
  View and Session model switching read the Registry; independent versioned Environment Configured Default storage;
  new Session Configured Default / Registry Fallback exits old Runtime Model Config; existing Sessions recover Session
  Selection first.
- **M2.7** Account Providers and off-peak task models enter the unified M1 ModelFactory; off-peak editors read the
  reasoning tier only from execution-scoped `allowedModelConfigs` (no GLM-name inference in the Renderer).
- **M2.8** Exit of the Host -> Worker complete Registry Snapshot and old Provider fact chain:
  - Local Worker `ModelFactory` exits the Workspace Compatibility Source. The Local Host no longer distributes the
    complete Snapshot in Session, Workspace Read, Generate and V4 entries (they only establish the Account Config
    order barrier). Settings save syncs runtime only to connected remote workspaces; local tabs no longer trigger
    `workspace/updateProviderRegistry`. The Local Bot switches custom models by submitting `modelRef` only.
  - Local Host startup gate reads `ModelSelectionView`; Session create/resume/set/send only submit `ModelSelection`
    (no `runtimeModel` derived from the old Snapshot to override the Worker Registry); explicit execution-scoped
    `runtimeModel` remains one execution's input. V4 local model switch on `provider.notInRegistry` keeps the Worker
    Registry's rejection (no re-push, no retry with Host `runtimeModel`); V4 drafts carry only initial
    ModelSelection/Options; Services replayable/Bot and Automation V4 create/switch submit ModelSelection/Options.
  - Deleted: `setProviderRuntimeHeaders` global mutable Headers and the UI compatibility entry (one-time Headers go
    only into the corresponding request/response; the static Registry strips historical one-time Headers);
    `session/updateRuntimeModelConfig` hot sync (cold recovery creates Models from the Worker Registry; request-level
    credentials/Headers fetched by the Adapter at request time); `runtimeModel` and derived revision from Session
    create/resume/send/compact/setModel/setThoughtLevel protocols, `workspace/readState` (now a pure projection with
    no Active Session thought writing), `workspace/setDefaultModel` (saves only ModelSelection), draft preparation and
    Repo Wiki `preferredRuntimeModel`; the old Workspace Catalog Provider in Registry App creation,
    Workspace State, V4 model switching and cold recovery (current model attributes come from the App Runtime's fixed
    Registry Model); the old `ZCodeProviderRegistrySnapshot` projection, reverse parser and readiness resolver. The
    Registry process no longer writes Workspace Provider state on receiving Host `runtimeModel`; execution-scoped
    temporary models go only through independent Turn Sources.
  - Off-peak plan judgment and dispatch credential parsing exit the old Provider list and Snapshot: Account Overlay
    provides fixed `accessId`/baseURL; credentials come at request time from Account Request Auth Resolver.
    Start Plan request-phase Runtime Headers read `apiFormat`/`baseURL` from the Provider Settings View; official-version
    security verification (material acquisition, request-scoped Header preparation, dynamic materials, retry,
    receipts) has no old Snapshot contract dependency or fallback.
  - Remote: the Bot injects a Remote Model Selection Service for Remote Workspaces (menu, status, old-state migration
    no longer read the Desktop Local Host's Provider facts); the Remote Host's `ProviderRuntime` is the Remote
    Worker's only long-term Model source (desktop-attached remotes no longer disable their own Registry); remote
    readiness, settings and selection read the Remote Settings / Selection View; the Desktop -> Remote injection of
    `workspace/updateProviderRegistry`, `runtimeModel`, Account Config and Secret Snapshot is gone; Remote Account
    Request Auth reads only the Remote Credential Store (no Renderer Auth relay, no Local Host -> Remote Host Auth
    Broker).
  - Session model preflight in process-Registry mode uses only Registry-backed `app.listModels()` for membership and
    fallback; Workspace Model Preferences still exist when no process Registry is assembled (interactions and
    persisted selections only).
  - Subsequent topics (not implemented): independent Provisioning Sync writing local Config/Credential to the Remote
    Store (not part of Registry construction or request execution); Apps operating remote configuration and login via
    Remote Settings / OAuth Service.

## Process Boundaries

**Account Config sync.** The Host reads the current third-layer Overlay from its Account Provider Source and sends
plain objects through `provider/updateAccountConfig`; Workers parse into `ProviderConfigMap` at the Provider domain
boundary, replace the process Account Source and refresh the Registry. The protocol carries no JWT, API Key,
one-time security material or request Headers and is not bound to a Workspace. It is not used across Environments:
a Remote Host forms its own Account Config and syncs to its Remote Workers; the Desktop Local Host never sends this
Overlay to Remote Hosts or Workers.

```text
Host Account Provider Source -- revision + Account ProviderConfigMap JSON --> provider/updateAccountConfig
  -> Worker MutableAccountProviderConfigSource -> ProviderRegistryService.refresh()
```

**Registry per process.** Local and remote production Workers each hold Official, Personal and Account three-layer
Registries. The production `ModelFactory` queries the belonging process's Registry; protocol Entries must assemble the
Process Registry and fail startup if Official or Personal Config paths are missing (no fallback to the Workspace
Provider Catalog).

**Local Host.** It judges whether any selectable model exists through its own `ModelSelectionView` (no execution
credentials, not used to construct normal `runtimeModel`) and wakes waiting Workers when an empty Registry becomes
available. Session create/resume/set/send pass only `providerId/modelId/reasoningLevel`; Workers create Models from
their own latest Registry. Official and Personal come from the Worker's own Config Source; Account is synchronized
through the independent process protocol. The execution-scoped `runtimeModel` kept in M2 serves only off-peak tasks
as a migration-period input; the latest ruling narrows it to ModelSelection + Request Auth + Ticket, deleting the
Provider/Model static configuration in it. It never expresses long-term Provider facts of a Workspace or another
Environment.

**Remote.** Desktop-attached remotes do not establish cross-Host dynamic auth routing: Remote Worker requests reach
only the Remote Host, resolved by Remote Account Request Auth from the Remote Credential Store. A future local-to-remote
sync function may update the Remote Config and Credential Store, but the Remote Source still rebuilds the Registry and
Remote Request Auth still resolves request credentials; the Desktop Snapshot and cross-Host request auth are not
restored.

**M2.8 source exit order.** Workers still keep two Model sources (delivered migration status, not final design):

```text
One Agent Loop creates a Model
        |
        v
Turn Execution Source (current execution only; off-peak compatible runtimeModel; overrides a same-named Registry model on hit)
        |  not hit
        v
Process Provider Registry (Official + Personal + Account ProviderConfigMap; only source of normal long-term Providers)
```

The Turn Source and Process Registry each judge their own target; the same `providerId/modelId` in both does not let
one borrow the other's membership judgment. M2.8 removed the Workspace Compatibility Source from the main path; the
post-release cleanup deleted its Bootstrap fallback and old protocol types. M4 deletes the Turn Source's Provider
static configuration: off-peak tasks select Builtin Models from the Process Registry and retain only turn-scoped
Request Auth and Ticket.

Slice numbers are planning labels; update this document before changing them and never create parallel architectures
in the implementation.

## Continuation Boundaries

- M3 wraps model selection and Prompt atomically as Submission, unifying Session, Draft, Recent and Loop-internal
  switching.
- M4 deletes the general execution-scoped Provider; off-peak tasks use Registry ModelSelection and carry only this
  Turn's Request Auth and Ticket.
- M6 organizes the identity, entitlement, credential refresh and request-phase auth internals of Account Providers.
- M7 implements Remote Environment Provisioning Sync and remote settings operations; the remote Registry always reads
  its own fact source.

Deleting old Store readers is predicated on ending support for one-time Personal Config and Account Key migration;
they take no part in any runtime design. Status evidence: [`../research/m2-registry-aggregation-and-refresh.md`](../research/m2-registry-aggregation-and-refresh.md).
Autonomous implementation decisions: [`02-provider-config-and-registry-implementation-log.md`](./02-provider-config-and-registry-implementation-log.md);
issues needing human adjudication: [`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md).
Historical records may be superseded; current facts follow this document, Design and M2 Cleanup. Rule of thumb:
questions the design answers are implemented directly; boundary-neutral details are decided and recorded; questions
that would change target boundaries return to design discussion first.

## Completion Criteria

- Official/Personal/Account ProviderConfigMap has one Overlay logic; Official/Personal ModelConfigRules one parsing
  logic.
- Catalog, Preset, Builtin hardcode, Family resolver and old Runtime Snapshot are no longer additional Provider/Model
  fact sources.
- Host, Core Worker, Prompt CLI and TUI reuse the same Provider domain implementation.
- The Registry maintains the ordered Provider View, query index and Selection validation.
- Normal API Provider Submission carries only ModelSelection; Workers create Models from their own Registry.
- Settings and Selection Facades use the Registry; the Renderer does not interpret the config source.
- Official Provider order is stable; drag results of Personal-only Providers and their models are expressed by the
  Personal Config's own order.
- Registry updates affect only new Models; current Agent Loops stay stable.
- Official/Personal Config Sources publish invalidation only on content revision change; Personal self-writes are not
  repeatedly notified by the file watcher; external edits take effect immediately.
- Migration compatibility logic has exited production authority; residual interfaces, types and fallbacks are deleted
  per [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md).

M2 is completed only when all of the above and the M2 Cleanup retirement gates hold. M2 established the unified
boundary for Provider/Model Config, account-level `accessId`, Usage/Entitlement fact sources, request-phase auth
account verification and Credential isolation. It does not redefine product entitlement rules, the Token refresh
protocol, Usage API behavior or off-peak task status; M4 and M6 handle execution-scoped semantics and a fuller Account
Provider state model.
