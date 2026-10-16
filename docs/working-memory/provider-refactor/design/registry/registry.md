# Provider Registry

> Status: Current effective design
>
> Last updated: 2026-09-08

Provider Registry maintains the Provider View for the belonging Environment in a single process. Callers can always read a consistent current view; after ZCode Built-in, Account Built-in, or Personal Provider Config changes, Registry publishes a new view, and already-created Models remain unchanged.

```text
Config / Account Sources
          |
          | change
          v
       Registry
       ├─ rebuild View
       ├─ replace indexes
       └─ notify consumers
          |
          v
New queries and Model creations use the new View
Old Models continue using the config at creation time
```

## Registry View

The Registry View is an ordered collection of Providers:

```ts
interface Provider {
  config: RegistryProviderConfig;
  models: readonly {
    modelId: ModelId;
    config: RegistryModelConfig;
  }[];
}
```

This is the executable Registry View, containing only complete and enabled models, including models under hidden Providers and Built-in Models that continue to take effect when conflicting with Personal. Disabled and incomplete members remain in Settings Resolution; duplicate members are deterministicized at the Inventory stage by "keep the first, Built-in-wins," and do not mix optional Config or `status` into Registry. The serialization return value of complete types must also remain complete and cannot re-expose optional fields of the sparse base class to protocol consumers.

Settings and model selections are displayed by array order. Registry also establishes lightweight query indexes:

```text
Provider[]
├─ External ordered View
└─ providerById
   └─ modelById
      ├─ lookup
      └─ validate selection
```

Indexes reference `RegistryProviderConfig` and `RegistryModelConfig` in the View and do not copy a separate set of config facts. Registry does not place HTTP Clients, connection pools, dynamic credentials, or Provider SDK runtime states into the View.

When ModelFactory creates Active Models, it freezes the complete `properties` of Effective Model Config as-is into `Model.properties`. Core, Compact, Memory, Child Agents, and Adapters directly read `input_format` / `output_format` from it; Runtime Config, Turns, and Adapter Registries do not maintain parallel capability maps. When async boundaries cannot pass Active Models, only the same-structure immutable Properties snapshots can be passed. See
[`../model/input-output-format.md`](../model/input-output-format.md).

Registry does not create Models. ModelFactory first uses Registry to complete lookup/validate, then passes the complete Provider/Model Config as private input to Adapters to create Active Models; public Models do not expose these two Registry Configs.

## Active Model in Execution Steps

`ModelSelection` only expresses Session or Submission's selection intent for "which Model to create next." It can be persisted, but cannot be used to retroactively infer a model step that has already started execution. Each model step creates an immutable Active Model through ModelFactory, and passes the same Model to all execution consumers of that step:

```text
Session / Submission ModelSelection
                 |
                 v
             ModelFactory
                 |
                 v
        immutable Active Model
          |        |        |
          v        v        v
       Context    Tools    Adapter request
```

Context Sources only save working directory, platform, Shell, Git, Instructions, and other environmental facts; they do not save execution model snapshots. Model descriptions, model-related tool projections, and request Options in the Context must be generated from this Active Model at the start of the model step; Builders directly receive this Model, no longer passing through the `envInfo.currentModel` field;
Core does not maintain a synchronization mechanism that copies Session Selection to Context and repeatedly refreshes it.

- Normal Submissions first create Active Models during admission, then use them to initialize Context, run SessionStart Hooks, and initiate requests;
- execution-scoped Off-Peak uses its own Active Model but does not rewrite Session Selection;
- Guides create new Models at legal next model-step boundaries and replace both request Context and subsequent requests with them;
- When Subagents inherit from parent models, child Selection, Context, and ModelFactory are all derived from the actual parent Active Model passed in;
- Session Selection or Registry changes occurring during active steps only affect later-created Models and cannot pollute the current step.

See [`../../steps/todo-68-active-model-context-single-source.md`](../../steps/todo-68-active-model-context-single-source.md) for details.

## Publishing New Views

After ZCode Built-in, Account, or Personal ProviderConfigMap changes, Registry re-executes the two-round Provider and Model resolution:

```text
Old View v1
      |
Source change
      |
      v
Construct and validate View v2
      |
      v
One-time replacement of View and indexes
      |
      v
onDidChange(revision)
```

Consumers observe only one complete View at any time. Intermediate states under construction are not published externally. Existing Models reference the ProviderConfig, ModelConfig, and Options at creation time; View replacements do not silently change active Agent Loops.

When a single Source reads, parses, or refreshes fail, Registry retains the previous successful complete View and reports the specific Source and error; it does not publish partial Views missing that Source. When Sources successfully return deletions, disables, empty Config Maps, or account failures, these are definite new facts and should still be normally constructed and published.

First startup uses layered recovery, rather than treating all inputs as equal ready barriers:

```text
Bundled invalid ----------------------------> Startup failure
Active/LKG invalid or unwritable ------------> Discard/skip, use Bundled
Personal invalid ----------------------------> Preserve recovery backup, use empty Personal Overlay
Account first parse failure -----------------> Account Provider access.entitled=false
Configured Default invalid ------------------> Discard preference, use Registry fallback
Resolver/Registry internal completeness invariant violated --> Startup failure
```

Therefore, Provider Runtime can only block startup when a trusted Built-in baseline cannot be established or code internal completeness proofs fail. Discardable caches, user preferences, Personal Overlays, or partial failures of dynamic Account facts must be degraded and reported, and cannot be amplified to the entire application or Agent being unavailable.

## Queries and Change Notifications

Long-lived consumers adopt "read, subscribe to invalidation, re-read":

```text
Consumer startup
    |
    +--> registry.list...() reads View v1
    |
    `--> registry.onDidChange
                    |
                    v
              Re-read View v2
```

Change notifications indicate that the old View has become invalid. Complete data is still provided by query interfaces, avoiding event payloads and query results forming two authoritative sources. Events can contain revisions, reasons, or affected scopes; final granularity is determined at the implementation stage based on the refresh needs of settings pages and model selectors.

## Each Process Owns Its Own Instance

Processes requiring Provider capabilities in the same Environment each hold Registry instances:

```text
Provider Facts in the same Environment
               |
       +-------+--------+
       |                |
       v                v
 Host Registry     Worker Registry
       |                |
       v                v
  Settings, model selection   Creation, execution

Prompt CLI / TUI
└─ Uses the same Registry implementation within its own process
```

Registry objects and memory Views are not shared across processes; Config, Account, and Registry domain implementations are shared. Hosts read their own Registry when selecting models; Submissions only carry ModelSelection; Core Workers use Registries belonging to their own Environments to create execution Models.

The assembly object for each process is called `ProviderRuntime`. It does not add new facts or state models; it simply connects the components needed by this process:

```text
ProviderRuntime
├─ ProviderConfigRuntime
│  ├─ ZCode Built-in Config Source
│  └─ Personal Config Repository
├─ injected Account Built-in Config Source
├─ ProviderRegistryService
├─ ProviderSettingsFacade
└─ ModelSelectionFacade
```

Account Built-in Config Sources are injected by Entries. Entries that do not yet provide Account Providers can use empty Sources; ordinary API Providers can still run completely; Built-in Providers requiring further Account constraints are set to `access.entitled=false` by the initial fail-closed Overlay. This default only expresses that the current Entry has no account entitlement; it falls back to old Snapshots.

File reading, atomic writing, file locks, Built-in watchers, and Personal revision polling belong to Node.js runtime environments and do not enter pure domain packages. They are centralized in `@zcode/provider-node`:

```text
@zcode/provider
└─ Config / Resolver / Registry / Facade

@zcode/provider-node
├─ ZCode Built-in file source
├─ Personal file repository
├─ Config runtime
└─ process registry runtime
```

Entries are responsible for locating physical files and explicitly injecting paths; `@zcode/provider-node` does not assume Desktop, Worker, CLI, or TUI installation directories. Hosts and Workers each read files of the same Environment; Registry objects and Views are not transmitted across processes.

The remote synchronization of ZCode Built-in is owned by Environment composition roots. Local Hosts, Remote Hosts, Standalone Servers, and Prompt CLIs/TUIs without Hosts each establish a sync owner for their belonging Environments; ordinary Core Workers only read, listening to the same `active.json` injected by Hosts, and do not independently request `/client/configs`:

```text
Bundled Release ──┐
Active/LKG ───────┼─> Select max revision ─> active.json ─> Host Registry
Remote Release ───┘                              └──────> Worker Registry
```

Local valid candidates complete ready first; remote refreshes subsequently execute in the background. Multiple processes merge requests through `refresh-control.json`, file locks, and short-term leases next to Active; Active and refresh control are physically isolated by normalized ZCode control plane Endpoints; successful uses hour-scale TTLs; failures use exponential backoff; Endpoint changes do not inherit old TTLs. Explicit refreshes can bypass TTLs but cannot bypass still-valid leases. Remote only accepts `/api/v1/client/configs.data.configs.zcodeBuiltin`; after successful parsing and higher revision, the Active is atomically replaced first, then the existing Source change chain triggers Account and Registry refreshes. Old responses whose endpoints have already changed during requests, and responses arriving after disposal, cannot be written to disk or published.

Registry updates still only affect later-created Models; already-created Active Models retain frozen facts at creation time. Other Client Config consumers, Sessions, queues, Continuous/Replayable, and remote Provisioning do not belong to this sync chain.

A single Execution of Prompt CLI has only one App; therefore, Registry and that Entry share the same lifetime. TUI can replace Apps during `/new`, resume, and fork; these Apps all borrow the same process Registry, avoiding recreating file observation loops each time a Session is switched. Closing one App does not release the Registry; TUI Entries only release uniformly when terminating.

Hosts expose Facades through two independent channels: `provider-settings` is responsible for viewing and modifying Personal Config; `model-selection` is responsible for candidate model Views and Selection validation. Channels only transmit ordinary serializable objects; Config Classes, Sources, and Registry instances remain in the Host process.

Selection validation covers the complete general selection semantics: Providers and Models must exist; explicit
`reasoningLevel` must belong to the model's Option Spec; explicit `maxOutputTokens` must be a positive integer and not exceed the model's declared upper limit. Validation only reports errors and does not modify or truncate values submitted by callers. Configured Default and Facade calls reuse the same set of Option validations, avoiding different conclusions between initialization, settings pages, and execution entries.

The startup of `ProviderRuntime` is a shared ready barrier for the two Facades. Hosts can first register RPC channels and then asynchronously start the Runtime, but `getView`, previews, writes, and Selection validations must all wait for the first Config / Account Source parsing to complete. Multiple concurrent calls share the same Registry startup link; they are not retried by Renderers for "not yet start" internal initialization states.

The Host's composition root first creates Config Runtime, then creates Account Provider Services using its Config Service, and finally assembles Config Services and Account Sources into Registries. `ProviderRuntime` accepts already-created Config Runtimes and does not hide a second construction internally. Account Sources only use ZCode Built-in Provider Config as the static boundary for account Providers, then form constraints based on account facts; they do not read or absorb Personal Provider Config; Personal always overlays after Account.

```text
ProviderConfigRuntime
└─ ProviderConfigService ─────┬──────────────> ProviderRegistry
                              │                         ^
                              v                         │
                 AccountProviderService                │
                 └─ Account Built-in ProviderConfigMap ─┘
```

Clients establish independent proxies for these two channels, sharing `IServiceAccessor` to declare them as required capabilities. Local Hosts, Remote Workspace Service Collections, and Web home-only composition roots must all provide explicit implementations; Web home-only uses empty View services to express "no attached Environment currently"; it does not use `undefined` as capability negotiation. Cross-version remotes needing capability judgment should use explicit protocol capabilities.

Historical implementations once pushed complete Registry Snapshots from Hosts to Workers, then had Workers maintain Workspace Catalogs. M2 has already let official Entries and internal Harnesses exit this fact chain and forced assembly of Process Registries. Subscriptions and cross-process refresh facts of old implementations are saved at
[`../../research/m2-registry-aggregation-and-refresh.md`](../../research/m2-registry-aggregation-and-refresh.md).

Account Built-in Provider Config uses independent process-level sync boundaries. Hosts and Workers each hold Registries; Hosts only pass the Account Built-in Config Source formed by account states to Workers, not the entire Registry View:

```text
Host Account Built-in Provider Source
        |
        | revision + ProviderConfigMap JSON
        v
provider/updateAccountConfig
        |
        v
Worker Account Built-in Provider Source
        |
        v
Worker Registry
```

This protocol only connects Hosts and Workers within the same Environment. Desktop Local Hosts and
desktop-attached Remote Hosts belong to two Environments and cannot share Account Built-in Config through this protocol.
Remote Hosts must produce Account Built-in Provider Config from their own Config, Credentials, and Account Sources, then sync to their managed Remote Workers.

```text
Desktop Environment                  Remote Environment
Local Host -> Local Worker           Remote Host -> Remote Worker
     account config                       account config

Two Environment之间的 Provisioning Sync
└─ Only writes Remote Config / Credential Store
   Does not directly call provider/updateAccountConfig
```

The above diagram only defines Environment ownership boundaries. Remote Provisioning, remote settings operations, logins, and config sync are independent product capabilities and do not belong to the Provider Refactor or M4 implementation scope.

Provider Configs in messages are ordinary serializable objects, parsed and resolved by the same Schema validation of `@zcode/provider` upon reaching Workers. Account Sources only accept `builtinModelIds` and only allow overriding `entitled` for fixed `zhipu-account` Access; Provider top-level `enabled`, Access identities, API Keys, Secrets, and request-time auth materials cannot enter Registry through this entry. The same revision is not published repeatedly; new processes must first obtain the current Account Built-in Config before starting model execution.

Off-Peak Provider dynamic credentials are only injected on Model request attempts and do not belong to Account Built-in Config sync. When Request Auth is missing, Models return explicit missing-credential errors before sending network requests; Registry does not save temporary Secrets for them.

`AccountProviderService` within Hosts is also Registry's Account Source. It reads the current ZCode Built-in Provider Config from Config Services, parsing accounts, plans, and team connections into Account Built-in Provider Config. Account's responsibility is to further constrain Built-in account-related Providers; it does not participate in Personal Overlays. Remote requests are completed through injected Account Resolvers; Services in `@zcode/provider` itself do not depend on networks, file systems, or OAuth implementations.

Account Sources record `basedOnZCodeBuiltinRevision` with each publish. When Registry receives Built-in changes, it continues to retain the previous complete Registry until the corresponding Account refresh completes; it cannot publish new Built-in with old Account combinations; even when overlay content has not changed, source revision changes must form new Account Snapshots. Personal changes do not trigger this wait.

```text
ZCode Built-in Provider Config
          |
          | Account Resolver applies account constraints
          v
Account Built-in ProviderConfigMap
```

The first `read()` is the first resolution attempt of account facts; subsequent Config changes or account events call `refresh()`. After successful refreshes, Account Snapshots are atomically replaced and Registry is notified. When refreshes fail, the previous successful Snapshot is retained and errors are reported through error events; on first refresh when no successful Snapshot yet exists, an explicit `access.entitled=false` fail-closed Account Overlay is published based on the same ZCode Built-in revision, allowing ordinary API Providers and Personal Providers to continue starting. This degradation does not fabricate account availability, model members, or Access; subsequent successful refreshes atomically replace afterward.

## Source Refresh Boundaries

Registry only receives unified signals that Sources have changed:

```text
Settings save ───────────────┐
External config changes ───────┤
ZCode Built-in Config updates  ┼─> Source invalidate ─> Registry rebuild
Account Built-in Config updates ─┘
```

Account Connection Resolvers on the Services side are responsible for translating existing product states into domain-layer Connection Results. They read the current account domain, connection modes for each Provider Family, currently selected Individual/Team connections, current account identity, and entitlement query results; on success, they output complete Provider result sets, with available Providers carrying availability status and optional model collections. Raw Settings selection states do not enter Provider Config; for non-current account domains, account Providers' `entitled` is still independently resolved by account product facts; network or remote service failures fail the entire resolution round, with the Account Provider Service retaining the entire previous successful Snapshot and not publishing partial results.

```text
Account Settings + Credential Port + Plan API
                    |
                    v
      Account Connection Resolver
                    |
                    | status + models?
                    v
        AccountProviderService
                    |
                    v
        Account Built-in ProviderConfigMap
```

Individual, Team, and Start each correspond to independently typed Built-in Providers, explicitly expressed by Built-in Access's `mode` and `family`. Resolvers only project `access.entitled` and Start account model collections; account identity, Team scope, Tokens, Runtime Keys, and Headers remain in Account Connection/Request Auth. Models without dedicated remote results follow the current Built-in Config order by domain parsers; when authoritative model collections can be obtained from entitlement interfaces, they should be provided together with Connection Results.

The local Host's production composition root directly creates `AccountProviderService`. Config changes are subscribed by the Service itself; account connection settings and account facts respectively trigger the same `refresh()` link through narrow events:

```text
ObservableSettingService.onDidUpdate
└─ providerFamilyDomain / providerFamilyConnectionSelections / endpoint origin
                                                        │
ModelProviderServiceRuntime.onDidInvalidateAccountFacts │
└─ Login presets, plan entries, Coding Plan Keys, and availability changes ─────┤
                                                        v
                                      AccountProviderService.refresh()
```

Ordinary Provider saves, deletions, and runtime header updates do not trigger account refreshes. Old
`onDidChangeProviderRegistry` no longer bears local Account invalidation; refresh content is always recalculated by Connection Resolvers based on Config, account settings, credential ports, and entitlement interfaces.

The historical Snapshot compatibility link for `desktop-attached-remote` has exited the production path. Production Entries must assemble Process Registries; missing Registries are composition root errors and are no longer recovered through old protocol types or runtime fallbacks. Provider data ownership for Remote Environments always resides on the remote side itself.

File watchers, Personal revision polling, mtime, remote Plan interfaces, caching, and concurrency deduplication belong to the implementations of each Source or Config Service. Registry callers do not perceive these mechanisms.

The current implementation has already adopted active notifications, Source file observation, and revision deduplication: saves wait for Repositories to complete, then use Registry `refresh()` as a commit barrier; Personal Repository's cross-process changes are self-healed by low-frequency async revision polling; the same revision does not publish Views repeatedly. Connection tests explicitly refresh the current Worker Registry before finding Providers/Models, therefore not waiting for the next round of polling, nor creating Models from Host Snapshots through side-channels. Ordinary query callers are not responsible for manually checking mtimes.
