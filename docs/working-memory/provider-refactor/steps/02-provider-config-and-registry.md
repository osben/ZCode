# M2: Provider Config and Registry Implementation

> Status: Implementation, retirement cleanup, and final branch verification completed; awaiting release
>
> Last updated: 2026-08-21

Target design is at [`../design/registry/registry.md`](../design/registry/registry.md). This document records M2's implementation goals and slices. The main production chain and retirement cleanup for normal long-term Providers have been completed; cleanup results, retained narrow compatibility boundaries, and final verification are in [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md), new code scale and transition boundary review are in [`02-provider-config-and-registry-review.md`](./02-provider-config-and-registry-review.md). The Merge Request static review and its fix evidence are saved in [`02-provider-config-and-registry-mr-review.md`](./02-provider-config-and-registry-mr-review.md); all release-blocking items have been resolved.

## Highest Priority Migration Principles

Official, Personal, and Account three-layer Provider Config are the unique fact source for the Provider Registry. Repeated static facts in existing Catalog/Preset branches, Builtin hardcode, Provider Family resolver, old CLI Provider Config, and Runtime Snapshot must all be migrated into these three layers or deleted.

```text
Old static facts that are still valid
└─ Migrate into Official / Personal Config

Old account and plan judgments that are still valid
└─ Converge into Account ProviderConfigMap

Old dynamic credential logic that is still valid
└─ Converge into request-phase auth Service

Old branches that cannot be proven still necessary
└─ Delete
```

No long-term compatibility layer of "old Snapshot + new Registry" is established during the migration period. One-time format migration at the physical storage boundary is allowed, but the post-migration execution chain can only read the new unique fact source. This principle takes priority over migrating old module boundaries one by one; M2 should let the production path begin consuming the formal Config and Access Source as soon as possible.

## Implementation Goals

M2 unifies "how Models are produced from the current Environment's Provider facts." Before M2 starts, the Host Provider Service, Worker Workspace Catalog, CLI Config Parser, and Runtime Overlay each interpret Provider static information separately, causing the model selected by the Host and the model truly executed by the Worker to need to maintain consistency through complete snapshots and compatible Overlays.

The target chain is:

```text
ProviderConfigService
├─ Official ProviderConfigMap
├─ Personal ProviderConfigMap
└─ Official / Personal ModelConfigRules ──┐
                                            ├─> Registry input aggregation
AccountProviderService                      │
└─ Account ProviderConfigMap ───────────────┘
                             |
                             v
            ProviderRegistryService
                     ├─ Provider[] / { modelId, config: ModelConfig }[]
                     └─ createModel(selection)
                                  |
                                  v
                             ModelFactory
                                  |
                                  v
                                Model
```

Host, Core Worker, Prompt CLI, and TUI reuse the same Config and Registry domain implementations, each holding instances within their process.

## Completed Design Preparations

Currently determined:

- Config uses unified ConfigOverlay semantics; sparse layers and final results use the same type; keys are ordered; when overwriting an existing key, the position is retained; new keys are appended in the order of the later layer.
- ProviderConfig and ModelConfigRules both have Official and Personal sets of ordered inputs.
- Account Source directly produces the third-layer sparse `ProviderConfigMap`, overlaying with Official and Personal using the same type. Account Provider's `accessId` and current `models` are kind-specific Config fields; the Registry does not additionally verify account entitlements; request auth is ultimately determined by the Account Service. The adjudication background is documented at [`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md#1-account-access-reuse-provider-config-overlay).
- The Registry forms ProviderConfig and ModelConfig in two rounds.
- Providers and models maintain order externally; internal indexes support query, Selection validation, and Model creation.
- The settings page and model selection page use respective Facade, not copying parsing logic in the Renderer.
- The settings page only drags Personal-only Providers and Personal Provider-internal models; when saving, the Personal Overlay is rearranged by Effective order, without establishing an independent sorting Preference.
- Each process has an independent Registry instance; after the process Registry is enabled, the Host Snapshot no longer participates in the members, attributes, execution, or display of normal long-term Providers.
- Off-peak tasks select Official Builtin Providers from the process-level Registry; the execution phase only supplements Request Auth and Ticket, not establishing temporary Provider static fact sources.

Specific design drills down layer by layer from [`../design/registry/registry.md`](../design/registry/registry.md).

## First Implementation Slice Boundary

M2's first batch of code establishes a domain chain that does not depend on files, network, React, Electron, Services, or Provider SDK:

```text
Normal Object / RPC data
          |
          v
Config Schema + ConfigOverlay
          |
          v
ProviderConfigResolver
├─ Settings-available complete parsing results and issues
└─ Valid Provider View publishable by the Registry
          |
          v
Memory ProviderRegistry
├─ Ordered View
├─ provider/model index
├─ ModelSelection validation
└─ Change notifications
```

This slice is built within the new pure domain package `@zcode/provider`. Subsequent slices have already let Host, Worker, Prompt CLI, and TUI reuse this code; file listening, remote config management, and account interfaces continue to be handled by their respective Source Services.

This section only records the boundary of the first domain slice at that time, not M2's final delivery scope. Subsequent slices have integrated Host, Worker, settings page, model selection, and model execution; Adapter reasoning mapping still maintains the original execution semantics.

The impact面和 test contract when the first slice began work are saved in
[`02-provider-config-and-registry-impact.md`](./02-provider-config-and-registry-impact.md); it is historical implementation evidence and does not describe the current completion status.

## Implementation Slices and Results

```text
M2.1  @zcode/provider package                                      [Completed]
      + ConfigOverlay, ProviderConfig, ModelConfigRules, and parsing tests

M2.2  ProviderConfigResolver
      + Two-round parsing, ordering, three-layer Provider Config Overlay, and integrity gate
      + IO-free memory ProviderRegistry, index, Selection validation, and change notifications [Completed]
      + Selection unified validation Provider/Model, reasoningLevel, and maxOutputTokens;
        Configured Default and Facade reuse the same Option rules [Completed]

M2.2b ProviderRegistryService
      + Inject Official, Personal, and Account Config Source
      + Revision deduplication, concurrent refresh generation guard, and last-known-good failure boundary [Completed]

M2.3a Provider Settings / Model Selection pure projection
      + Settings view Personal / Effective / Issues
      + Selection only projects Registry-selectable models [Completed]

M2.3b ProviderConfigService and Personal persistence boundary
      + ProviderConfigService injectable with Official Source and Personal Repository
      + Personal Provider / Model save and ordering [Completed]

M2.3c  Production Official / Personal Config Source                         [Completed]
      + During development, established a standalone provider-config.json with schemaVersion and physical Repository
        [Completed; final path ruling replaced the standalone filename]
      + ModelConfigRules supports apiFormatMatch and stateless reasoningMapping [Completed]
      + Read-only, injectable single-file OfficialProviderConfigSource [Completed]
      + Initial batch of API / Account Providers and model static facts written to config/provider/official.json [Completed]
      + One-way import of sparse Personal Config from old config.json, with backup, migration, and atomic replacement at the original path
        [Completed]
      + Old files only participate in the first import when Personal Config does not exist; the runtime old Provider Store
        no longer syncs the complete list back to Personal Config; the formal Schema detects version through the same path
        [Completed]
      + Provider Config schemaVersion 4 and adjacent version migration [Not published development history, Completed]
      + Express access method as `access.type`, public API as `api.type`; Model Config uses
        `apiMatch + reasoningMapping` to express model/API combination behavior [Completed]
      + Personal Config uses the existing `~/.zcode/v2/config.json` path; full backup of the original file before migration,
        backup failure does not overwrite, atomic replacement at the same path after successful conversion [Completed]
      + Final complete Schema published for the first time as `schemaVersion: 1`; unpublished development-period
        v1–v5 migration branches do not enter the long-term compatibility chain [Completed]
      + OpenAI-compatible always requests Usage; Config no longer provides a disable switch [Completed]
      + Settings page adds new models via Settings Facade to preview Official / Personal ModelConfigRules,
        deleted Catalog query, discontinued Catalog Provider new entry, and old public Catalog API [Completed]
      + Old Provider Store reading and migration no longer inject Catalog metadata by Model ID; deleted old Catalog
        Loader, repository JSON, and Electron packaging resources; model default facts are only provided by ModelConfigRules [Completed]
      + Old Builtin Preset first migration only retains user API Key and modified model overrides; Preset-generated
        label, endpoint, model list, and account status no longer solidify into Personal Config [Completed]
      + Settings page, Shared factory, old Store, and protocol projection stop interpreting `[1m]` model suffix; the general 200K
        default and `[1m]`'s 1M context are provided by Official ModelConfigRules [Completed]
      + Deleted the deprecated Endpoint suggestions and endpoint-based model detection interface from the settings page; Add Provider
        only edits explicit Provider Config, no longer importing another set of config candidates from `client/configs` [Completed]
      + Deleted the Start Plan free model whitelist and placeholder Provider from the Renderer and old Store; Official
        Config declares static models; Account Overlay determines the current account's available members; offline fallback no longer fakes
        Account Provider [Completed]
      + The settings page model connectivity test only uses the reasoningMapping in Model Config,
        exiting the old hardcoding of completing thinking/effort by GLM model name [Completed]
      + Migrate existing valid static facts into formal Config; the production Registry no longer supplements Provider/Model facts from Catalog, Preset, or old
        Provider Store [Completed]
      + Deleted unused consumers' old Preset builder, remote config fetch, and Store steady-state sync; old Store only retains
        Personal/Account one-time physical migration; all historical correction rules are private implementation of migration files [Completed]
      + Deleted the duplicate `modelCatalog` from Workspace Snapshot, old Provider group projection, and the App Config→Provider conversion with no production callers; model status is uniformly expressed by `settings.model` [Completed]
      + Deleted the App's Workspace Provider/Model Overlay write entry, state, and listeners; only retained
        execution-scoped Turn Overlay [Completed]

M2.3d Account Provider Config Source                             [Completed]
      + Current login and plan judgment project sparse Account ProviderConfigMap
      + Official, Personal, Account use the same Provider Config Overlay [Completed]
      + Each Access Entry carries a non-sensitive accessId fixed at Model creation time
        [Domain type, Host/Worker migration Source, and Official Account Config completed]
      + Account Model's Properties, Option Specs, and reasoning mapping use the new Registry [Completed]
      + Account Model's fixed accessId is passed to the Host at each request attempt [Completed]
      + Host Request Auth Service resolves Start / Personal / Team credentials by fixed accessId [Completed]
      + Account Request Auth elevated from the old ModelProviderService internal Resolver to a narrow service contract,
        held within the Local Host process; Agents and Off-Peak only depend on this contract; cross-Host routing before adjudication
        is not exposed through generic RPC [Completed]
      + Local Host independently assembles Account Request Auth at the composition root; the old
        ModelProviderService no longer creates or exposes the Resolver; the one-time
        old Store reading of Personal Coding Plan Keys converges to a narrow migration function [Completed]
      + Team Plan request-phase Key organization/project validation, creation, and Secret copying moved into a standalone Account Runtime
        module; the new Request Auth and old Snapshot compatible calls share the implementation, no longer defined by the old Provider Service [Completed]
      + Account Models no longer need old Workspace Secrets to be created from the new Registry [Completed]
      + Account entitlement judgment exits old ModelProviderConfig, narrowed to providerId, auth input, and
        Account context [Completed]
      + IO-free AccountProviderService manages Config dependencies, ready barrier, refresh notifications, and
        last-known-good Account ProviderConfigMap [Completed]
      + Local Host triggers refresh through account connection Setting updates and explicit Account Facts events, exiting
        the old Provider Registry full change event [Completed]
      + Account Connection Result uniformly parses available / unavailable / unknown, preserving known results by Provider to form an accessId/models Overlay [Completed]
      + Services adapt to the current account domain, Family connection mode, Personal/Team selection, and
        Start/Coding entitlement results, uniformly producing Account Connection Result [Completed]
      + Start Plan extracts the remote model set from the same billing/balance entitlement query,
        entering Account Config when it exists alongside the Connection Result [Completed]
      + Local Host directly produces the third layer of Account Config using AccountProviderService and the Connection Resolver; the old complete Registry Snapshot no longer participates in local account Provider parsing [Completed]
      + Personal Coding Plan Keys migrated to the Credential Service by accessId; the Connection Resolver
        and Request Auth share the same read entry; old Provider Keys are only retained for one-time migration [Completed]
      + OAuth logout deletes Personal Coding Plan Keys from the Account Credential Store, and refreshes
        the Account Source; exiting the cleanup of derived keys from the old Provider Store [Completed]
      + Old `refreshCodingPlanApiKey` / `clearCodingPlanApiKey` public APIs and Store rewrite chains exit;
        Start/Coding mutual exclusion, Team Project, and temporary error semantics are protected by independent Availability tests [Completed]
      + Account Secret projection deleted from the Local Host → Worker Registry [Completed]
      + Deleted the bypass Account Access/allowedModelIds, directly overlaying accessId/models [Completed]
      + The Host synchronizes the Account ProviderConfigMap through an independent process-level protocol; Workers no longer extract Account Config from the complete `workspace/updateProviderRegistry` snapshot [Completed]
      + Desktop-attached remotes do not establish cross-Host Auth routing; Remote Environments use their own
        Config, Credential, Account Source, and Registry [Decision reached, implementation in M2.8]
      + Upgrading account identity semantics on the existing accessId passing chain: Personal, Start, and Team accessId
        identify specific account connections; stable when refreshing credentials for the same account, changing when switching accounts [Completed]
      + Request Auth checks the accessId against the credentials' current account, refusing the combination of old Model identity and new account credentials; Team also checks account, organization, and project [Completed]
      + The Account Credential Store switches to account-level accessId. The currently provider-level stable key has not yet been published;
        this intermediate key is not migrated; Personal/Team Keys are directly obtained by new identity [Completed]
      + Usage Source and caches uniformly use the account-level accessId; Team requests complement the required accessId, continuing to carry
        organization/project context, without adding a parallel accountCacheIdentity [Completed]

M2.4  Host Settings / Selection Facade Uses Unique Registry
      + ProviderRuntime assembles Config, injectable Account Source, Registry, and Facade [Completed]
      + ProviderRuntime supports explicitly injecting a previously created Config Runtime, for the Account Source
        to depend on the same Config Service to establish the formal assembly order [Completed]
      + Host RPC channel and Client proxy [Completed]
      + Facade shares the Runtime ready barrier, eliminating the Host async startup race condition [Completed]
      + The main Composer's normal API Provider selection switches to ModelSelectionView [Completed]
      + Account Provider model candidates and current connection are now directly expressed by ModelSelectionView;
        The Renderer only displays Start/Individual/Team badges based on the fixed accessId [Completed]
      + Settings page API Provider static display facts switch to ProviderSettingsView [Completed]
      + Settings page Account Provider's name, Endpoint, model properties, and Option Specs switch to
        ProviderSettingsView; persistent setting projections no longer carry old runtime credentials or status fields [Completed]
      + Settings page connectivity testing submits the current unsaved draft through Provider Settings RPC; the Host uses the latest
        Settings View to identify Account Providers, and obtains dynamic credentials from the request-phase auth boundary, not reading old
        Provider Snapshot [Completed]
      + When the new Settings Service is assembled, cold start waits for the ProviderSettingsView; manual refresh
        directly refreshes the Account Source and Registry; does not subscribe to, read, or refresh the old Provider Snapshot [Completed]
      + Provider display order and Personal-only dragging writing switch to the Personal Overlay [Completed]
      + Page order only comes from the Effective Provider View, no longer reads/writes the old display-order Preference [Completed]
      + Personal Provider-internal model order and dragging writing switch to the Personal Overlay [Completed]
      + Personal-only Provider deletion switches to the first write of the Personal Overlay [Completed]
      + Personal-only API Provider creation/editing switches to the first write of the Personal Overlay [Completed]
      + Welcome API Key login only writes the sparse Personal Override of the Official API Provider [Completed]
      + Welcome API Key login confirms the Provider from the Settings View on a new Host, and selects the default model from
        the Selection View after saving; no longer writes the old Provider mirror [Completed]
      + Provider Settings Service becomes a required service for all production Entries; API Key reading, writing, and
        Management URL only use the Settings View; failure no longer falls back to the old ModelProviderService [Completed]
      + Custom Model recovery prioritizes using the Registry Selection View [Completed]
      + Draft startup gate prioritizes using the Model Selection Service [Completed]
      + V4 draft startup gate deletes the old Provider Registry Snapshot fallback, only using
        Model Selection View as the selectable fact source [Completed]
      + The ZCode Agent's recent selection/current callback Provider availability adjudication reads the Model Selection View,
        no longer reading the old ModelProviderConfig global snapshot [Completed]
      + Family Selection after OAuth login and startup recovery deletes the old
        ModelProviderConfig reading that does not participate in adjudication, only using entitlement, Team Products, and the current selection state [Completed]
      + Deletes the refresh of old Provider Snapshot from Settings Sync; Provider imports are not currently provided;
        future imports must explicitly write to Personal Config [Completed]
      + The startup Provider availability and login gate of the production Root only reads Model Selection View; deleted
        the Renderer old Provider Snapshot state, subscription, and refresh modules [Completed]
      + OAuth login, session recovery, and logout uniformly refresh the Account Source and
        Registry after converging the account selection state, no longer calling the old refreshCodingPlanApiKey by Provider in the Renderer [Completed]
      + Model switching prompts, timeline, and send telemetry only read the Provider label/baseURL from the Model Selection View, no longer using the old Provider snapshot as fallback [Completed]
      + Workspace model preference adjudication directly consumes the Model Selection View, deleting non-ZCode Agent
        branches' optional judgments of the old ModelProviderConfig Snapshot [Completed]
      + Workspace reload deletes the old multi-Agent Provider config adjudicator; historical provider identifiers are unified to the current unique ZCode Agent at the boundary; model echo only uses the prepare callback, App Recent, and
        Model Selection View, no longer reading the old GLM Provider Config under workspace [Completed]
      + V4 custom provider recovery deletes the old ModelProviderConfig fallback, only selecting the first model from
        Model Selection View [Completed]
      + The local Host's Bot `/model` Provider/Model candidates now read Model Selection Service; the workspace runtime configOptions cache remains independent; the Bot Service no longer accepts the old
        ModelProviderService as a candidate fact source [Completed]
      + The Bot `/status` custom Provider label now reads the Model Selection Service of the belonging Environment,
        no longer obtaining the display facts from the old ModelProviderConfig [Completed]
      + Bot startup migration uses the Provider/Model index of the belonging Environment's Model Selection View,
        and stops the old Provider Config cache warm-up and persistent menu fallback [Completed]
      + The Provider Family Domain's one-time startup migration infers the current unique selectable Family from Model Selection View, no longer re-performing availability judgment from the old Provider Config [Completed]
      + Root logout and settings page Plan unbinding read the Model Selection View at the time of the operation,
        only judging whether to retain the current Family Domain based on selectable API Providers [Completed]
      + The reasoning tier for Composer, Automation, Subagent, and Repo Wiki model thinking now reads the ModelConfig Option Specs in Model Selection View; production Entries no longer supplement Registry static facts from old Provider
        metadata or GLM naming rules [Completed]
      + The model menu only projects Registry candidates after the Model Selection View is published; old Providers filtered by the Registry are no longer appended by ID gaps; confirming an empty View does not fall back [Completed]
      + The Subagent settings page deletes the useModelProviders subscription and the always-empty Legacy Provider parameter;
        model candidates, loading state, and reasoning Option Specs without Workspace only use the process-level
        Model Selection View [Completed]
      + Repo Wiki generation settings delete the always-empty Legacy Provider parameter; the model menu only projects
        the Model Selection View; reasoning remains unknown when the View is not published, without inferring facts by model name [Completed]
      + Composer model menu, Provider existence, label, and API Provider recovery eligibility only use
        Model Selection View; the View remains empty when not published, no longer subscribing to the old Provider Snapshot [Completed]
      + Composer draft reasoning defaults only read Model Selection View; when the View is not published or the model has no
        Option Spec, remain unknown, no longer using old Provider metadata and GLM naming rules [Completed]
      + The UI unified reasoning helper deletes the old ModelProviderConfig parser and GLM name hardcoding; public inputs are narrowed to the published Model Selection View [Completed]
      + The settings page only projects Providers in the Provider Settings View after the View is published; the old snapshot neither supplements Account runtime fields, nor appends Providers not recorded by new fact sources [Completed]
      + The Coding Plan entitlement Hook now uses the accessId judgment of the Account Overlay to connect and construct refresh identity;
        The Renderer no longer reads the API Key to judge plan availability; the disabled model entry still retains Account Access [Completed]
      + The Plan Identity Snapshot at session submission now uses the accessId of the Account Overlay; plan identity,
        Entitlement Cache, and submission telemetry no longer subscribe to old Provider snapshots or read API Keys [Completed]
      + The settings page Usage plan source, query gate, and cache identity now use the accessId of the Account Overlay;
        SettingsPage no longer subscribes to the old Provider list for Usage; the Usage panel only consumes the final source [Completed]
      + The sidebar Usage's connection gate, cache identity, and Team Products detection now use the Account Overlay;
        the public balance/upgrade state resolver only receives providerId/label, no longer depending on ModelProviderConfig [Completed]
      + Composer Context Usage's personal plan candidates, loading state, and Team Products gate now use
        the Account Overlay; the model menu only consumes the Model Selection View [Completed]
      + Automation directly projects the Registry menu and reads the Registry Provider label after the Model Selection View is published, no longer using the old Provider to re-perform entitlement filtering or override static display [Completed]
      + The Automation edit form deletes the ModelProviderConfig input; the model label and reasoning Option Specs
        only read the Model Selection View, no longer falling back to old metadata when the View is not published [Completed]
      + The Automation main page deletes old Provider and Entitlement subscriptions; the model menu remains empty when the Registry View
        is not published; creation/runtime telemetry reads the Personal API static fields from the Provider Settings View [Completed]
      + Off-peak task home page and purchase funnel judge the current
        Start/Coding Plan from the Account accessId of the Provider Settings View, no longer inferring from old Provider enabled, systemDisabledReason, or Team ID [Completed]
      + The settings page Coding/Start/Team Plan connection status, login completion wait, and auto-sync
        now use the Account Overlay accessId; production UI no longer retains branches reading old Provider API Keys when the Provider Settings Service is not assembled [Completed]
      + Explicitly wait for the Account Source and Registry refresh after the global Coding Plan purchase is completed;
        deleted the old Provider Hook subscriptions, Snapshot refresh, and refreshCodingPlanApiKey branches [Completed]
      + Root startup, OAuth recovery/login/logout, and Provider Family migration refresh entry points,
        a new Host directly refreshes the Provider Settings / Account Source / Registry, no longer warming up old Snapshot [Completed]
      + The Local Host must assemble the Provider Runtime; Official / Personal / Account Source become startup facts,
        no longer existing old Preset compatibility warm-up branches [Completed]
      + Deleted the public service surface, RPC registration, Host proxy, and old Preset Sync of the old ModelProviderService; the old physical
        Store is only retained for one-time Personal/Account migration reading, no longer forming a runtime service or refresh fact source [Completed]
      + Settings page explicit connectivity testing obtains static model facts from the Host Registry, and obtains dynamic credentials through the request-phase auth boundary; unsaved static edit drafts are submitted with this Settings RPC; the Start Plan is supplemented only by
        the Renderer with this interaction producing a one-time security verification Header. The existing Probe currently only handles network detection,
        no longer parsing Provider facts or Account identity [Completed]
      + Settings connectivity testing elevates the authenticated single-network detection to a narrow dependency, no longer callbacking the old
        ModelProviderService or bypassing old Snapshot logic through `requestAuthResolved` [Completed]
      + Deleted the old ModelProviderService's public `testModelConnectivity`; connectivity testing has migrated to
        an independent Probe test; the old Service and remote Host no longer retain this compatibility entry [Completed]
      + Deleted the old ModelProviderService's `getProviderRegistrySnapshot`, snapshot cache, and dedicated testing;
        Repo Wiki also directly uses Model Selection View and the unified Model [Completed]
      + Cleaned up the mocks, initialization, and assertions for the deleted Snapshot API in UI tests; the first migration of Personal Config
        directly reads the old physical Store, no longer passing through the old ModelProviderService View [Completed]
      + The remaining Selection consumers and Settings configuration reads/writes switched [Completed]
      + Settings save entry receives structured complete Effective Provider/Model Config; the Facade
        calculates the sparse Personal Overlay relative to the Official Config, and writes it through one atomic replacement to
        Personal Config. The Renderer uses a private form state, no longer reusing the shared old Store type [Completed]
      + The Renderer edit state directly carries `ProviderConfigObject` and `ModelConfigObject`, only additionally saving
        `providerId/modelId` and the Registry projection state. Deleted the复刻 old Store's endpoints, kind,
        modalities, ProviderOptionsPatch, and timestamp fields; drafts are still held by the Renderer; saving continues to call
        `saveEffectiveProvider()` to calculate the sparse Personal Overlay [Completed]

M2.5  Host Settings / Selection Facade Uses Unique Registry
      + M2.5a New Registry -> AI SDK execution projection and ModelFactory boundary [Completed]
      + M2.5b Shared Node Config boundary; Worker process startup and holding Registry [Completed]
      + M2.5c Each App assembles Model Runtime, switches normal API Provider production calls,
              synchronously switches the final Personal migration/write entry and deletes the corresponding old fact reading [Completed]
              - New Settings entry only writes Personal Config; deleted old Store mirror writing and
                old Store -> Personal Config's steady-state reverse sync [Completed]
              - Expert Workflow and Script Workflow child Runtimes reuse the process Registry's
                ModelFactory, no longer falling back to old ModelAdapter / Catalog execution chain [Completed]
              - Core compatible runtime configuration's context, output, media capabilities, and reasoning parameters,
                for Providers that have entered the Registry, uniformly project from the Registry Model Config; old
                Catalog only remains in the first migration and current Turn's temporary execution input [Completed]
              - Explicit initialization and `setModel` observe the Provider-level migration boundary: when the Registry already owns a
                Provider, missing Models directly error, no longer concatenating from the old Runtime Overlay;
                Session recovery still retains historical Selection; state reading also does not borrow from old Catalog to explain deleted
                Models, only reporting unavailable explicitly at execution time [Completed]
              - The Bootstrap's explicit Registry Selection validates common Options through the Registry `validateSelection()`, no longer creating execution Selection based solely on the Provider/Model index [Completed]

M2.6  Prompt CLI / TUI Switches to Shared Provider Domain Implementation                 [Completed]
      + Start a process-level Registry when Official / Personal paths are injected
      + Prompt CLI borrows and releases the Registry within a single App lifecycle
      + TUI reuses the same Registry across /new, resume; only releases at Entry end
      + Prompt CLI / TUI explicitly uses registry-only when creating Apps; no longer assembles
        Workspace Legacy Compatibility Source after completing the old config import [Completed]
      + CLI/TUI assembles with package Official Config location and Personal path [Completed]
      + One-time difference import of explicit Providers from old CLI user files [Completed]
      + Standalone Selection View and Session model switching now read the Registry [Completed]
      + Independent, versioned Environment Configured Default storage [Completed]
      + New Session's Configured Default / Registry Fallback exits old Runtime Model Config [Completed]
      + Existing Sessions prioritize recovering Session Selection [Completed]

M2.7  Existing Account Provider and Off-Peak Task Execution Models Integrate into Unified ModelFactory [Completed]
      + Account Providers and off-peak task models uniformly enter the M1 ModelFactory [Completed]
      + Off-peak task editors only read the reasoning tier from execution-scoped `allowedModelConfigs`; exiting the Renderer inferring static facts by GLM model name [Completed]

M2.8  Exit the Host -> Worker Complete Registry Snapshot and Old Provider Fact Chain [Completed]
      + The Local Worker's ModelFactory exits the Workspace Compatibility Source; old Snapshot
        no longer participates in Worker Model creation [Completed]
      + The Local Host stops distributing the complete Snapshot in Session, Workspace Read, Generate, and V4 entries;
        these entries only establish the Account Config order barrier [Completed]
      + The runtime sync target after settings save only collects connected remote workspaces; local tabs no longer
        trigger workspace/updateProviderRegistry [Completed]
      + The Local Bot switches custom models by submitting modelRef only, no longer applying Providers or distributing the old complete
        Registry Snapshot; desktop-attached remotes temporarily retain the compatible sync [Completed]
      + Repo Wiki directly consumes the ModelSelectionView of the belonging Environment; the old
        ZCodeProviderRegistrySnapshot projection, reverse parser, and readiness resolver have been deleted [Completed]
      + Off-peak task plan judgment and dispatch credential parsing exit the old Provider list and complete Registry Snapshot;
        The Account Overlay provides the fixed accessId/baseURL; credentials are obtained at request time by the Account Request Auth Resolver
        [Completed]
      + The Local Host's startup gate now reads ModelSelectionView; normal Session create/resume/set/send
        only submits ModelSelection, no longer deriving runtimeModel from the old Snapshot to override the Worker Registry;
        explicit execution-scoped runtimeModel continues to serve as one execution's input [Completed]
      + When the V4 local model switch receives provider.notInRegistry, it directly retains the Worker Registry's rejection result,
        no longer repushing old Snapshot or retrying with the Host runtimeModel; remotes follow the same rule [Completed]
      + Both V4 local and remote drafts only carry the initial ModelSelection/Options for warm-up; no longer parsing
        runtimeModel from the Host [Completed]
      + Start Plan request-phase Runtime Headers now read the
        apiFormat/baseURL static facts from the Provider Settings View; official version security verification judgment no longer has the old Provider Snapshot fallback [Completed]
      + The official version security verification material acquisition and request-scoped Header preparation delete the old Registry Snapshot contract dependency;
        dynamic materials, request-level Headers, retry, and receipts are still handled by the original runtime auth chain [Completed]
      + Deleted the old `setProviderRuntimeHeaders` globally mutable Headers and UI compatibility entry; one-time Headers
        only enter the corresponding model requests through request/response; the static Registry always strips historical one-time Headers [Completed]
      + Services replayable/Bot's local and remote V4 createSession only submit ModelSelection [Completed]
      + Automation's local and remote V4 switchModelConfig both submit ModelSelection/Options [Completed]
      + Deleted the Host `session/updateRuntimeModelConfig` hot-sync protocol; cold recovery is created by the Worker Registry's
        Model creation; request-level credentials and Headers are obtained by the Adapter at request time [Completed]
      + The Bot injects the Remote Model Selection Service for the Remote Workspace; the Bot model menu,
        status display, and old state migration no longer read the Desktop Local Host's Provider facts [Completed]
      + The Remote Host's ProviderRuntime becomes the Remote Worker's unique long-term Model source;
        desktop-attached remotes no longer disable their own Registry [Completed]
      + Remote model readiness, settings, and selection reading now read the Remote Settings / Selection View, no longer reading
        the Desktop base Host's model facts [Completed]
      + Deleted the Desktop -> Remote injection of workspace/updateProviderRegistry, runtimeModel,
        Account Config, and Secret Snapshot into the main chain [Completed]
      + Remote Account Request Auth only reads the Remote Credential Store; does not establish a Renderer
        Auth relay or Local Host -> Remote Host Auth Broker [Completed]
      + Session model preflight in process Registry mode only uses the Registry-backed
        `app.listModels()` to judge members and selection fallback items; Workspace Model Preferences still exist when the process Registry is not assembled, only saving interactions and persistent selections
      + Registry App creation, Workspace State, V4 model switching, and cold recovery usage all exit the old Workspace
        Catalog Provider: no longer generating bootstrap config, syncing overlays/limits, mixing Provider Views, or
        publishing old providerRevision; the current model's attributes are taken from the App Runtime's fixed Registry Model [Completed]
      + The Registry process no longer writes Workspace Provider state when receiving old Host `runtimeModel`; long-term models
        are still parsed by the Registry; execution-scoped temporary models only go through independent Turn Sources [Completed]
      + `workspace/readState` converges to a pure projection protocol, deleting the `runtimeModel` input and Active Session
        thought writing; draft preparation and Repo Wiki no longer retain the `preferredRuntimeModel` entry [Completed]
      + `workspace/setDefaultModel` only saves ModelSelection; the protocol, Services, and Worker delete
        the `runtimeModel` input, no longer supplementing Providers through Workspace preferences [Completed]
      + V4 create/switch commands delete the normal `runtimeModel` fallback, only validated by the Worker Registry's
        ModelSelection; the Repo Snapshot bypass no longer guesses the Provider from the Workspace State [Completed]
      + The old Session create/resume/send/compact/setModel/setThoughtLevel protocols delete the complete
        `runtimeModel` and derived revision; normal Sessions only pass Selection; Workers no longer cache or apply
        the Host Runtime Snapshot [Completed]
      + Subsequent independent Provisioning Sync writes local Config/Credential to the Remote Store; it does not participate in
        Registry construction or request execution. This step only retains the integration boundary, not implementing the sync function [Subsequent topic]
      + More subsequently, Apps can operate remote configurations and login through Remote Settings / OAuth Service [Subsequent topic]
```

The Account Config cross-process synchronization within the same Environment first splits out from the Workspace Snapshot. The Host reads the current third-layer Overlay from its own Account Provider Source, sending normal objects through `provider/updateAccountConfig`;
Workers parse into `ProviderConfigMap` at the Provider domain boundary, replacing the process-level Account Source and refreshing the
Registry. This protocol does not carry JWT, API Key, one-time security materials, or request Headers, nor is it bound to a Workspace.

```text
Host Account Provider Source
        |
        | revision + Account ProviderConfigMap JSON
        v
provider/updateAccountConfig
        |
        v
Worker MutableAccountProviderConfigSource
        |
        v
ProviderRegistryService.refresh()
```

The Account Config is initially split out from the old complete Snapshot; subsequently, M2.8 exited the Workspace Snapshot by execution, display, and remote source. The currently `provider/updateAccountConfig` is still the narrow sync boundary retained.

The `provider/updateAccountConfig` is not used across Environments. The Remote Host forms an Account Config from its own account status, then synchronizes it to the Remote Workers it manages. The Desktop Local Host does not send this Overlay to Remote Hosts or Remote Workers.

Both local and remote production Workers have Official, Personal, and Account three-layer Registries. The normal production path's
ModelFactory queries the belonging process's Registry; protocol Entries must assemble the Process Registry, failing startup directly when missing Official or
Personal Config paths, no longer falling back to the Workspace Provider Catalog.

The Local Host judges whether at least one selectable model exists through its own `ModelSelectionView`, and wakes waiting-to-start Workers when the empty Registry becomes available. This View does not carry execution credentials, nor is it used to construct normal `runtimeModel`.
Local entries for Session create/resume/set/send only pass `providerId/modelId/reasoningLevel`; Workers create Models based on their own
latest Registry. The Worker's Official and Personal come from their own Config Source; Account is synchronized through an independent process protocol. The execution-scoped `runtimeModel` retained in M2's implementation only serves off-peak tasks, which is a migration-period
compatible input; the latest ruling requires subsequently narrowing it to ModelSelection + Request Auth + Ticket, deleting the Provider and Model static configuration within it. It never expresses the long-term Provider facts of a Workspace or another Environment.

Desktop-attached remotes no longer establish dynamic auth cross-Host routing. Requests from Remote Workers only reach the Remote Host,
parsed by the Remote Account Request Auth reading the Remote Credential Store. Subsequent local-to-remote continuous sync functions can update
the Remote Config and Credential Store, but after the sync is complete, the Remote Source still rebuilds the Registry, and the Remote Request
Auth still parses the request credentials. It will not restore the Desktop Snapshot or cross-Host request auth.

```text
Local Host ModelSelectionView
        |
        +-- Startup gate / model selection
        |
        +-- Submission(ModelSelection)
                    |
                    v
             Local Core Worker
                    |
                    v
          Process Provider Registry
                    |
                    v
                  Model

Migration-period execution-scoped runtimeModel
        |
        v
Off-peak task compatible input
```

## M2.8 Source Exit Order

When M2.8 completes, Workers still retain the following two Model sources. This diagram records the delivered migration status, not the final design:

```text
One Agent Loop creates a Model
        |
        v
Turn Execution Source
├─ Only exists for the current execution
├─ Currently used for off-peak task compatible runtimeModel
└─ When hit, overrides the same-named Registry model
        |
        |  Not hit
        v
Process Provider Registry
├─ Official ProviderConfigMap
├─ Personal ProviderConfigMap
├─ Account ProviderConfigMap
└─ The unique fact source for normal long-term Providers
```

The Turn Source and Process Registry each judge their own target. Even if they contain the same `providerId/modelId`,
they cannot claim to be able to create a Model by borrowing the other layer's membership judgment. M2.8 has already let the main production path exit the Workspace
Compatibility Source; the post-release cleanup subsequently deleted its Bootstrap fallback and old protocol types. The subsequent M4 will then delete
the Turn Source's Provider static configuration: off-peak tasks now select Builtin Models from the Process Registry, retaining only
turn-scoped Request Auth and Ticket.

Slice numbers are for the current planning and can be adjusted based on code dependencies. When adjusting, update this document first, without creating parallel architectures in the implementation.

## Boundaries for Subsequent Phase Continuation

Config, Registry, main production assembly, and old fact source retirement have been completed, and are continuously protected by the M2 cleanup gate. Subsequent phases continue on this boundary:

- M3 atomic封装s model selection and Prompt as Submission, unifying the semantics of Session, Draft, Recent, and Loop-internal switching.
- M4 deletes the general execution-scoped Provider; off-peak tasks now use the Registry ModelSelection, carrying only this Turn's Request Auth and Ticket.
- M6 continues to organize the identity, entitlement, credential refresh, and request-phase auth internal structure of Account Providers.
- M7 implements the Remote Environment's Provisioning Sync and remote settings operations; the remote Registry always reads its own fact source.

The deletion of old Store readers is predicated on the cessation of support for one-time Personal Config and Account Key migration, and no longer participates in any runtime design.

Current status evidence is at [`../research/m2-registry-aggregation-and-refresh.md`](../research/m2-registry-aggregation-and-refresh.md). Autonomous decisions made during implementation beyond the original plan are at [`02-provider-config-and-registry-implementation-log.md`](./02-provider-config-and-registry-implementation-log.md).

## Implementation Records and Decision Destinations

This document maintains the current status of M2 slices. Autonomous decisions made during implementation that exceed the original plan are saved chronologically in
[`02-provider-config-and-registry-implementation-log.md`](./02-provider-config-and-registry-implementation-log.md); architectural, product, and public contract issues requiring human adjudication are saved in
[`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md). Historical records may be superseded by subsequent adjudications or implementations; current facts are based on this document, Design, and M2 Cleanup.

```text
Questions answered by the design
└─ Implement directly according to the design

Implementation details that do not change the boundary
└─ Autonomous decisions and record

Questions that would change target boundaries
└─ Return to design discussion first
```

## Completion Criteria

- Official/Personal/Account ProviderConfigMap has only one Overlay logic; Official/Personal ModelConfigRules has only one parsing logic.
- Catalog, Preset, Builtin hardcode, Family resolver, and old Runtime Snapshot no longer serve as additional Provider/Model fact sources.
- Host, Core Worker, Prompt CLI, and TUI reuse the same Provider domain implementation.
- The Registry maintains the current ordered Provider View, query index, and Selection validation.
- Normal API Provider's Submission only carries ModelSelection; Workers use their own Registry to create Models.
- Settings and Selection Facades use the Registry; the Renderer does not interpret the config source.
- Official Provider order is stable; the result of dragging Personal-only Providers and their models is expressed by the Personal Config's own order.
- Registry updates only affect new Models; current Agent Loops remain stable.
- Official/Personal Config Sources only publish invalidation when the content revision changes;
  Personal self-write will not be repeatedly notified by the file watcher; external edits still take effect immediately.
- Migration compatibility logic has exited production authority, and residual interfaces, types, and fallbacks have been deleted according to
  [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md).

M2 is only marked as completed when all the above conditions and M2 Cleanup's retirement gates are met. M2 has established the unified boundary for Provider/Model Config, account-level accessId, Usage/Entitlement fact sources, request-phase auth account verification, and Credential isolation. It does not redefine product entitlement rules, does not redo the Token refresh protocol, Usage API behavior, or off-peak task status; M4 and M6 will separately handle execution-scoped execution semantics and more complete Account Provider state models.
