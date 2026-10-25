# Registry Runtime Boundary

Provider Registry maintains the Provider View for one Environment inside a single process. Callers always read a consistent current view; after ZCode Built-in, Account Built-in, or Personal Provider Config changes, Registry publishes a new view, and already-created Models keep the config they were created with.

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

This is the executable view: only complete and enabled models, including models under hidden Providers and Built-in Models when Built-in and Personal share an ID. Disabled and incomplete members stay in Settings Resolution; duplicates are deterministicized at the Inventory stage ("keep the first, Built-in-wins"). Registry mixes in no optional Config or `status`, and serialized complete types stay complete — they never re-expose optional fields of the sparse base class to protocol consumers.

Settings and model selections display by array order. Registry keeps lightweight query indexes (`providerById` → `modelById`, used for lookup and selection validation) that reference `RegistryProviderConfig` / `RegistryModelConfig` in the View and copy no separate config facts. The View never holds HTTP Clients, connection pools, dynamic credentials, or Provider SDK runtime state.

ModelFactory freezes the complete `properties` of Effective Model Config into `Model.properties`. Core, Compact, Memory, Child Agents, and Adapters read `input_format` / `output_format` from it; Runtime Config, Turns, and Adapter Registries keep no parallel capability maps. Where async boundaries cannot pass Active Models, only same-structure immutable Properties snapshots cross. See [`../model/input-output-format.md`](../model/input-output-format.md).

Registry does not create Models. ModelFactory uses Registry for lookup/validate, then passes the complete Provider/Model Config as private input to Adapters; public Models do not expose these Registry Configs.

## Active Model in Execution Steps

`ModelSelection` expresses only Session or Submission intent for "which Model to create next." It can be persisted but cannot retroactively infer a model step already executing. Each model step creates an immutable Active Model through ModelFactory and passes the same Model to all execution consumers of that step.

Context Sources store only environmental facts (working directory, platform, Shell, Git, Instructions), not execution model snapshots. Model descriptions, model-related tool projections, and request Options in the Context are generated from the Active Model at step start; Builders receive the Model directly instead of the `envInfo.currentModel` field, and Core keeps no mechanism that copies Session Selection into Context and repeatedly refreshes it.

- Normal Submissions create the Active Model during admission, then use it to initialize Context, run SessionStart Hooks, and initiate requests.
- Execution-scoped Off-Peak uses its own Active Model and does not rewrite Session Selection.
- Guides create new Models at legal next model-step boundaries and replace both request Context and subsequent requests.
- Subagents inheriting from a parent model derive child Selection, Context, and ModelFactory from the actual parent Active Model passed in.
- Selection or Registry changes during an active step affect only later-created Models; they cannot pollute the current step.

See [`../../steps/todo-68-active-model-context-single-source.md`](../../steps/todo-68-active-model-context-single-source.md).

## Publishing New Views

After ZCode Built-in, Account, or Personal ProviderConfigMap changes, Registry re-runs the two-round Provider and Model resolution, constructs and validates View v2, replaces View and indexes in one step, then emits `onDidChange(revision)`.

Consumers observe only complete Views; intermediate states are never published. Existing Models reference the ProviderConfig, ModelConfig, and Options of their creation time; View replacements never silently change active Agent Loops.

When a single Source fails to read, parse, or refresh, Registry keeps the previous complete View and reports the Source and error; it never publishes a partial View missing that Source. Successful deletions, disables, empty Config Maps, and account failures are definite new facts and are constructed and published normally.

First startup uses layered recovery instead of treating all inputs as equal ready barriers:

```text
Bundled invalid ----------------------------> Startup failure
Active/LKG invalid or unwritable ------------> Discard/skip, use Bundled
Personal invalid ----------------------------> Preserve recovery backup, use empty Personal Overlay
Account first parse failure -----------------> Account Provider access.entitled=false
Configured Default invalid ------------------> Discard preference, use Registry fallback
Resolver/Registry internal completeness invariant violated --> Startup failure
```

Provider Runtime may block startup only when no trusted Built-in baseline can be established or internal completeness proofs fail. Discardable caches, user preferences, Personal Overlays, and partial dynamic-Account failures degrade and report; they never escalate to the whole application or Agent being unavailable.

## Queries and Change Notifications

Long-lived consumers read, subscribe to invalidation, and re-read. Change notifications mean only "the old View is invalid"; complete data still comes from query interfaces, so event payloads and queries never form two authoritative sources. Events may carry revision, reason, or affected scope; final granularity is decided at implementation time from settings-page and model-selector refresh needs.

## Each Process Owns Its Own Instance

Every process needing Provider capabilities in an Environment holds its own Registry (Host Registry for settings and model selection; Worker Registry for creation and execution; Prompt CLI / TUI use the same implementation in-process). Registry objects and memory Views are not shared across processes; Config, Account, and Registry domain implementations are shared. Hosts read their own Registry when selecting models; Submissions carry only ModelSelection; Core Workers create execution Models from their own Environment's Registry.

The per-process assembly object is `ProviderRuntime`. It adds no new facts or state models; it only wires the components this process needs:

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

Account Built-in Config Sources are injected by Entries. Entries without Account Providers use empty Sources: ordinary API Providers run completely, and account-constrained Built-in Providers get an initial fail-closed `access.entitled=false` Overlay (this default only means "this Entry has no account entitlement"; it falls back to old Snapshots).

File reading, atomic writing, file locks, Built-in watchers, and Personal revision polling belong to Node.js runtimes and stay out of pure domain packages:

```text
@zcode/provider
└─ Config / Resolver / Registry / Facade

@zcode/provider-node
├─ ZCode Built-in file source
├─ Personal file repository
├─ Config runtime
└─ process registry runtime
```

Entries locate physical files and inject paths explicitly; `@zcode/provider-node` assumes nothing about Desktop, Worker, CLI, or TUI installation directories. Hosts and Workers each read the same Environment's files; Registry objects and Views are never transmitted across processes.

Remote sync of ZCode Built-in is owned by Environment composition roots: Local Hosts, Remote Hosts, Standalone Servers, and Host-less Prompt CLIs/TUIs each establish a sync owner for their Environment. Ordinary Core Workers only read the same `active.json` injected by Hosts and never request `/client/configs` themselves:

```text
Bundled Release ──┐
Active/LKG ───────┼─> Select max revision ─> active.json ─> Host Registry
Remote Release ───┘                              └──────> Worker Registry
```

Local valid candidates complete ready first; remote refreshes run afterwards in the background. Multiple processes merge requests through `refresh-control.json`, file locks, and short-term leases next to Active; Active and refresh control are physically isolated by normalized ZCode control plane Endpoint. Success uses hour-scale TTLs, failures exponential backoff, and Endpoint changes inherit no old TTLs. Explicit refreshes bypass TTLs but never a still-valid lease. Remote accepts only `/api/v1/client/configs.data.configs.zcodeBuiltin`; after successful parsing and a higher revision, Active is atomically replaced first, then the existing Source change chain triggers Account and Registry refreshes. Responses whose endpoint changed mid-request, and responses arriving after disposal, are never written to disk or published.

Registry updates affect only later-created Models; already-created Active Models keep their frozen facts. Other Client Config consumers, Sessions, queues, Continuous/Replayable, and remote Provisioning are outside this sync chain.

A single Prompt CLI execution has one App, so Registry shares that Entry's lifetime. TUI replaces Apps on `/new`, resume, and fork; all Apps borrow the same process Registry (no per-session file-observation loops). Closing one App does not release the Registry; TUI Entries release it only at termination.

Hosts expose two independent Facade channels: `provider-settings` (view and modify Personal Config) and `model-selection` (candidate model Views and Selection validation). Channels carry only serializable objects; Config Classes, Sources, and Registry instances stay in the Host process.

Selection validation covers the full general semantics: Providers and Models must exist; explicit `reasoningLevel` must belong to the model's Option Spec; explicit `maxOutputTokens` must be a positive integer within the model's declared upper limit. Validation only reports errors — it never modifies or truncates caller values. Configured Default and Facade calls reuse the same Option validations, so initialization, settings pages, and execution entries cannot disagree.

`ProviderRuntime` startup is a shared ready barrier for both Facades: Hosts may register RPC channels first and start the Runtime asynchronously, but `getView`, previews, writes, and Selection validations wait for the first Config / Account Source parse. Concurrent calls share the same startup link; Renderers do not retry "not yet started" internal initialization states.

The Host composition root creates the Config Runtime, then `AccountProviderService` from its Config Service, then assembles Config Services and Account Sources into Registries. `ProviderRuntime` accepts already-created Config Runtimes and hides no second construction. Account Sources use ZCode Built-in Provider Config only as the static boundary for account Providers, constrain from account facts, never read or absorb Personal Provider Config; Personal always overlays after Account.

```text
ProviderConfigRuntime
└─ ProviderConfigService ─────┬──────────────> ProviderRegistry
                              │                         ^
                              v                         │
                 AccountProviderService                │
                 └─ Account Built-in ProviderConfigMap ─┘
```

Clients establish independent proxies for the two channels, declaring both as required capabilities through shared `IServiceAccessor`. Local Hosts, Remote Workspace Service Collections, and Web home-only composition roots provide explicit implementations; Web home-only uses empty View services to express "no attached Environment currently" and never `undefined` as capability negotiation. Cross-version remotes needing capability judgment use explicit protocol capabilities.

History: Hosts once pushed complete Registry Snapshots to Workers, which maintained Workspace Catalogs; M2 exited that chain and forces Process Registries. Old subscription and cross-process refresh facts are saved at [`../../research/m2-registry-aggregation-and-refresh.md`](../../research/m2-registry-aggregation-and-refresh.md).

Account Built-in Provider Config syncs across processes on its own boundary. Hosts pass the Account Built-in Config Source formed from account states — not the whole Registry View:

```text
Host Account Built-in Provider Source
        | revision + ProviderConfigMap JSON
        v
provider/updateAccountConfig
        v
Worker Account Built-in Provider Source -> Worker Registry
```

The protocol connects only Hosts and Workers within one Environment. Desktop Local Hosts and desktop-attached Remote Hosts are two Environments and cannot share Account Built-in Config through it; Remote Hosts produce Account Built-in Provider Config from their own Config, Credentials, and Account Sources and sync it to their Remote Workers.

```text
Desktop Environment                  Remote Environment
Local Host -> Local Worker           Remote Host -> Remote Worker
     account config                       account config

Provisioning Sync between the two Environments
└─ Only writes Remote Config / Credential Store
   Does not directly call provider/updateAccountConfig
```

That diagram defines ownership boundaries only: remote Provisioning, remote settings operations, logins, and config sync are independent product capabilities outside Provider Refactor / M4 scope.

Provider Configs in messages are plain serializable objects, re-validated by the same `@zcode/provider` Schema at the Worker. Account Sources accept only `builtinModelIds` and only override `entitled` for fixed `zhipu-account` Access; Provider top-level `enabled`, Access identities, API Keys, Secrets, and request-time auth materials cannot enter Registry through this entry. The same revision is never republished, and new processes must obtain the current Account Built-in Config before starting model execution.

Off-Peak dynamic credentials are injected per Model request attempt and are not part of Account Built-in Config sync. When Request Auth is missing, Models fail with an explicit missing-credential error before any network request; Registry stores no temporary Secrets for them.

`AccountProviderService` in the Host is also Registry's Account Source: it reads the current ZCode Built-in Provider Config from Config Services and parses accounts, plans, and team connections into Account Built-in Provider Config. It constrains only Built-in account Providers and never participates in Personal Overlays. Remote requests go through injected Account Resolvers; `@zcode/provider` itself depends on no network, file system, or OAuth implementation.

Account Sources record `basedOnZCodeBuiltinRevision` with each publish. When Registry receives Built-in changes it keeps the previous complete Registry until the corresponding Account refresh completes — never new Built-in combined with old Account — and a source revision change alone forms a new Account Snapshot even when overlay content is unchanged. Personal changes do not trigger this wait.

The first `read()` is the first account-fact resolution attempt; later Config changes or account events call `refresh()`. Successful refreshes atomically replace the Account Snapshot and notify Registry. Failed refreshes keep the previous successful Snapshot and report via error events; on first refresh with no successful Snapshot yet, an explicit `access.entitled=false` fail-closed Account Overlay is published on the same ZCode Built-in revision so ordinary API and Personal Providers still start. This degradation fabricates no account availability, model members, or Access; later successes atomically replace it.

## Source Refresh Boundaries

Registry receives only unified "Source changed" signals (settings save, external config change, ZCode Built-in update, Account Built-in update → invalidate → rebuild).

Services-side Account Connection Resolvers translate existing product state into domain-layer Connection Results: the current account domain, per-Family connection modes, the selected Individual/Team connection, current account identity, and entitlement results. On success they output a complete Provider result set, available Providers carrying availability status and optional model collections. Raw Settings selection state never enters Provider Config; for non-current account domains, `entitled` is still resolved independently from account product facts; network or remote service failures fail the entire resolution round, and the Account Provider Service keeps the whole previous successful Snapshot — no partial results.

```text
Account Settings + Credential Port + Plan API
        v
  Account Connection Resolver  --(status + models?)-->  AccountProviderService
        v
  Account Built-in ProviderConfigMap
```

Individual, Team, and Start are independently typed Built-in Providers, expressed by Built-in Access `mode` and `family`. Resolvers project only `access.entitled` and Start account model collections; account identity, Team scope, Tokens, Runtime Keys, and Headers stay in Account Connection / Request Auth. Models without dedicated remote results follow current Built-in Config order in domain parsers; authoritative model collections from entitlement interfaces should be provided with Connection Results.

The local Host's production composition root creates `AccountProviderService` directly. The Service subscribes to Config changes itself; account connection settings and account facts trigger the same `refresh()` link through narrow events:

```text
ObservableSettingService.onDidUpdate
└─ providerFamilyDomain / providerFamilyConnectionSelections / endpoint origin
                                                        │
ModelProviderServiceRuntime.onDidInvalidateAccountFacts │
└─ Login presets, plan entries, Coding Plan Keys, availability changes ──┤
                                                        v
                                      AccountProviderService.refresh()
```

Ordinary Provider saves, deletions, and runtime header updates do not trigger account refreshes. The old `onDidChangeProviderRegistry` no longer carries local Account invalidation; refresh content is always recalculated by Connection Resolvers from Config, account settings, credential ports, and entitlement interfaces.

The `desktop-attached-remote` historical Snapshot compatibility link has exited the production path. Production Entries must assemble Process Registries; a missing Registry is a composition root error, not recoverable through old protocol types or runtime fallbacks. Remote Environment Provider data ownership always stays on the remote side.

File watchers, Personal revision polling, mtime, remote Plan interfaces, caching, and concurrency deduplication belong to Source or Config Service implementations; Registry callers do not perceive them.

The current implementation uses active notifications, Source file watching, and revision deduplication: saves wait for Repositories to complete and use Registry `refresh()` as the commit barrier; cross-process Personal changes self-heal through low-frequency async revision polling; the same revision never republishes a View. Connection tests explicitly refresh the current Worker Registry before finding Providers/Models — no waiting for the next polling round, no Model creation from Host Snapshots via side channels. Ordinary query callers never check mtimes manually.
