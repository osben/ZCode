# M2: Provider Config and Registry Human-in-the-Loop

> Status: Continuously maintained
>
> Last updated: 2026-08-20

This document records the architecture, product, and public contract decisions submitted to human review during M2 implementation. It differs from the implementation log: the latter saves reversible decisions the Agent made autonomously to keep moving forward; this document saves decisions that change target abstractions or implementation boundaries and must be confirmed by a human.

Each entry describes the background when the question was raised, the human's decision, target design, and implementation impact. Confirmed conclusions are synchronized to the corresponding Design node; this document retains the decision background and the distance between current implementation and the target.

## 1. Account Access Reuses Provider Config Overlay

> Decision Status: Confirmed and implemented; normal long-term Provider has exited the old Snapshot source

### Background

A Provider's access method and public API are two independent dimensions: `access.type = "api-key"` uses a static API Key, `access.type = "zhipu-account"` uses the current login, plan, or team connection; `api.type` describes Anthropic Messages, OpenAI Responses, or OpenAI Chat Completions. Different access methods can use the same API.

The initial new Registry still placed account state in a separate `AccountProviderAccessEntry[]`, which the Resolver then拼接 by `providerId` to construct `modelIds` and `accessId`. The first adjustment renamed it to Runtime Overlay, yet it established `AccountProviderOverlay`, `AccountProviderAccess`, and `allowedModelIds`, which is essentially a second Provider data structure.

This conflicts with the Config Overlay goal: Official, Personal, and account state are all supplementing fields for the same Provider; there is no need for three shapes and a special filtering algorithm.

### Decision

Account state directly outputs a sparse third-layer `ProviderConfigMap`, using the exact same Provider Config Overlay data structure and algorithm as Official and Personal:

```text
Official ProviderConfigMap
        |
        | overlay
        v
Personal ProviderConfigMap
        |
        | overlay
        v
Account ProviderConfigMap
        |
        v
Final ProviderConfigMap
```

Ownership of the three layers remains different: Official is managed by the platform, Personal by the user, and Account is generated in real time from account and plan state. The Account layer is not persisted and is not edited by the settings page; these differences are expressed by Source and lifecycle, not by another set of domain types.

### Access Config

Account Access is a discriminant branch of `ProviderConfig.access`:

```ts
class ProviderConfig extends ConfigOverlay {
  access?: ProviderAccessConfig | null;
  api?: ProviderApiConfig | null;
  models?: readonly ModelId[] | null;
}

class ApiKeyAccessConfig extends ConfigOverlay {
  readonly type = "api-key";
  apiKey?: string | null;
}

class ZhipuAccountAccessConfig extends ConfigOverlay {
  readonly type = "zhipu-account";
  accessId?: AccountAccessId | null;
}
```

`accessId` is a non-sensitive account connection identity, used to distinguish Start Plan, Personal Coding Plan, and specific Team Plan. It is not JWT, API Key, or Header.

### Account Layer Provides Model Members

Official Account Provider is responsible for `api.type`, `api.baseURL`, static Headers, and other managed definitions; it does not need to list the current account's ultimately available models in advance. The Account layer also provides the current connection's account-level `accessId` and `models`:

```text
Official
A -> {
  access: { type: zhipu-account },
  api: { type: anthropic-messages, baseURL: ... }
}

Personal
A -> {
  label: "My Coding Plan"
}

Account
A -> {
  access: { type: zhipu-account, accessId: account-team-plan:... },
  models: [A, B]
}

Final
A -> {
  label: "My Coding Plan",
  access: { type: zhipu-account, accessId: account-team-plan:... },
  api: { type: anthropic-messages, baseURL: ... },
  models: [A, B]
}
```

`models` follows standard field Overlay rules: when the Account layer provides this field, it completely overrides the preceding layer, directly determining final members and order. There is no longer `allowedModelIds`, and no "intersection of configured models and allowed models" computation. Model Properties, Option Specs, and Reasoning Mapping continue to be resolved by ModelConfigRules, which is a separate concern from the Provider's model member list.

### Registry and Authentication Boundaries

The Registry only handles Config:

```text
Three-layer ProviderConfigMap
        |
        | overlay + validateComplete
        v
Provider Registry
```

The final `ProviderConfig` has complete `access.type`, account-level `accessId`, and `models`; it can then enter the Registry. The Registry does not verify whether `accessId` corresponds to actual entitlement, nor does it establish an additional `accessAllowed` gate based on the Account Source's member relationships.

Even if someone manually writes an invalid `accessId`, it will not obtain actual credentials. The final authority for request authentication is the Account Request Auth Service:

```text
Provider.config.access.accessId
        |
        | Fixed when Model is created
        v
Model internal execution identity
        |
        | Per-request attempt
        v
Account Request Auth Service
        |
        ├─ Found current JWT / API Key / Header -> Request proceeds
        └─ Cannot resolve or no permission        -> Request fails
```

The Registry and Model do not store account Secrets. Tokens or Runtime Keys inside account identity can be refreshed, but already-created Models do not follow global current connection switches to another Personal or Team Plan.

### Final Provider

The final Provider no longer nests another Account Access object:

```ts
interface Provider {
  readonly providerId: ProviderId;
  readonly config: ProviderConfig;
  readonly models: readonly ProviderModel[];
}
```

When `provider.config.access.type === "zhipu-account"`, TypeScript narrows the Access Config to `ZhipuAccountAccessConfig`, and the ModelFactory directly reads `provider.config.access.accessId`. `ProviderRegistryProvider` is renamed to the domain name `Provider`.

### Impact on Current Implementation

- Account Source's output is changed to sparse `ProviderConfigMap`, no longer outputting `AccountProviderAccessEntry[]` or `AccountProviderOverlay[]`.
- Provider Config Snapshot adds Account Provider Config layer; the Resolver calls the same Overlay in the order: Official, Personal, Account.
- Delete `AccountProviderAccess`, `allowedModelIds`, `accessAllowed`, and flattened `accountAccessId` from the Registry. The request protocol still uses `accountAccessId` to pass the Model's fixed identity to the dynamic authentication Service.
- `ZhipuAccountAccessConfig` includes `accessId`; the final completeness check requires that Account Providers have the Config fields needed for execution.
- The ModelFactory fixes `accessId` from the final `ProviderConfig.access`; the existing request-period dynamic authentication chain remains unchanged.
- Early in this decision's implementation, the old Snapshot was temporarily allowed to project the formal Account `ProviderConfigMap`. M2.8 subsequently deleted this production compatibility chain; the current Account Source directly produces formal Config, and this document no longer considers Snapshot projection as a viable implementation path.

## 2. Last-known-good View Retained on Source Refresh Failure

> Decision Status: Confirmed; human reviewed and approved the implementation strategy the Agent had already autonomously adopted

### Background

The Registry aggregates Official, Personal, and Account three-channel Provider Config into a single complete View. When any channel changes, the Registry re-reads, parses, and validates all inputs on the side, then atomically publishes the new View.

```text
Current complete View v1
        |
        Source changes
        |
        v
Read Official / Personal / Account
        |
        v
Build and validate View v2
        |
        | All succeed
        v
Atomically publish v2
```

Source refresh may fail due to temporarily unreadable files, JSON or Schema parsing failures, abnormal Official sources, or account and plan service timeouts. At this point, the system can only confirm "unable to obtain the latest facts"; it cannot infer that the user deleted Personal Config, the platform removed the Provider, or the account has logged out.

Each Overlay layer typically only saves the fields it is responsible for. Publishing partial results that remove the failing Source would incorrectly interpret read exceptions as business deletions: Personal failure might cause API Keys and user Providers to disappear; Official failure might cause sparse Personal Config to fail to form a complete Provider; Account failure might cause all Plan models to instantly vanish.

During implementation, `ProviderRegistryService` had already autonomously adopted Last-known-good: on read or parsing failure, do not replace the current Snapshot, reject the current explicit refresh, and emit a refresh error event; the next successful refresh can still publish a new View normally. Corresponding tests already cover the old View remaining available after failure and subsequent recovery. The Design at that time still marked "retain old View vs. publish partial results" as pending; therefore, human review of this implementation choice as a formal design was required.

### Decision

Human agrees to retain the Last-known-good strategy adopted by the current implementation and elevates it to formal design: after the Registry already has a successful View, read, parse, or refresh failure for any Source retains the previous complete View, without publishing partial results missing that Source.

```text
Refresh succeeds
└─ Atomically publish new complete View

Refresh fails
├─ Retain previous successful View
├─ Report specific Source and error
└─ Wait for watcher, explicit refresh, or subsequent state changes to recover
```

"Refresh failure" and "successfully obtained empty state" must be strictly distinguished. When a Source successfully returns deletion, disable, empty Config Map, or account invalidation state, these are all clear new facts; the Registry must construct and publish a new View normally; Last-known-good cannot block valid state changes.

On first startup with no successful View to retain. When the first build fails, the Registry startup fails and exposes the error; it cannot disguise unknown state as a determined empty View.

### Relationship with Request Authentication

The Last-known-good View may briefly retain an Account Provider that is still displayed in the model list, but it does not extend account permissions. The Account Request Auth Service still obtains current credentials for each request by the Model's fixed `accessId`, and is the final authority on account permissions:

```text
Old Registry View still has Account Provider
        |
        v
Model initiates request
        |
        v
Account Request Auth Service
├─ Current identity still valid -> Return credentials
└─ Logged out or no permission  -> Request fails
```

The Registry's Last-known-good is responsible for avoiding剧烈的 jitter in the projection caused by transient faults; it does not cache, restore, or forge JWT, Runtime Key, one-time security verification Headers, or other request authentication materials.

### Impact on Current Implementation

- The Registry only publishes complete Views built and validated by all Sources together.
- Refresh failure retains the current revision and View, while exposing the failure reason through error events and logs.
- Explicit refresh, file watchers, and Account Source updates continue to enter the same refresh chain; revision deduplication avoids publishing the same change repeatedly.
- Successful empty states, deletions, disables, and account invalidations must be published and cannot be classified as refresh failures.
- The pending decision wording in the Design "retain old View vs. publish partial results" should be updated to this conclusion.

## 3. No Longer Supporting Arbitrary Model Options

> Decision Status: Confirmed; Agent autonomous compatibility plan has been withdrawn

### Background

Both the old CLI configuration and Desktop Provider configuration use the same underlying format (`provider` → `models` nested), so both allow writing arbitrary `options` in model configuration:

```json
{
  "models": {
    "model-id": {
      "options": {
        "arbitrary_field": "value"
      }
    }
  }
}
```

This common underlying format can easily cause misjudgment: it is not a CLI-exclusive format, nor does it represent CLI or Desktop having established arbitrary Model Options as a formal product capability.

The old CLI passes some `model.options` as Provider parameters into model requests. Desktop's physical configuration Schema also accepts and preserves `model.options`, but the formal `ModelProviderModelConfig` and settings page do not provide arbitrary Options capability; Desktop currently explicitly interprets the compatible field primarily as `options.max_tokens`, converging it to the formal `maxOutputTokens`. Current internal evaluation configurations only use Provider-level `apiKey`, `baseURL`, and model capacity fields, with no dependency on arbitrary `model.options`.

Therefore, arbitrary Model Options belong to an extension port left by the underlying format, not a public contract that the new Provider architecture needs to inherit.

### Agent Autonomous Plan

To avoid losing arbitrary `model.options` after old CLI configuration migration, the Agent added during implementation:

```ts
ModelConfig.requestParameters?: Record<string, unknown>;
```

This field passes through Config Overlay, Personal Config projection, and Model creation chains, ultimately forming another arbitrary Provider request parameter channel. This solution increases the degree of old configuration compatibility, but bypasses the strongly-typed boundaries already established by `ModelOptionSpecs`, `ModelOptions`, and `reasoningMapping`, and also solidifies historical extension capabilities that have not yet formed product commitments into the new architecture.

### Decision

Human rejects the above compatibility plan. The new Provider architecture no longer supports arbitrary Model Options, nor does it retain the generic `requestParameters`.

The new model configuration only carries formally defined common options:

```text
reasoningLevel
maxOutputTokens
```

They respectively complete capability declaration, user selection, request-level override, and Provider protocol conversion through `ModelOptionSpecs`, `ModelOptions`, and `reasoningMapping`. Fields with clear formal semantics in old configurations can be migrated:

```text
options.max_tokens
        |
        v
maxOutputTokens
```

Other arbitrary `model.options` are not migrated, not passed through, and do not enter the new Model Config. Internal evaluation users can adjust CLI configurations that are not yet publicly released; there is no need to design lossless migration for this historical extension channel.

### Impact on Current Implementation

- Delete `ModelConfig.requestParameters` and its Schema, Overlay, projection, tests, and runtime passing logic.
- Delete the old CLI Personal Config importer's migration for arbitrary `model.options`.
- Retain the semantic migration from `options.max_tokens` to the formal `maxOutputTokens`.
- Desktop old storage can temporarily preserve unknown `model.options` as-is, but the new Config, Registry, and Model execution chain do not read them.
- Provider-level `options` that historically stored `apiKey` and `baseURL` are unrelated to this decision; they should be migrated to formal Provider Config fields.
- When adding new model options in the future, first define fixed fields, Option Specs, validation rules, and Adapter mapping, then enter the new architecture as a public capability.

## 4. Static Headers Belong Only to Provider Config

> Decision Status: Confirmed; Agent autonomous compatibility plan has been withdrawn

### Background

Both the old CLI and Desktop use the same underlying Provider configuration format, thus simultaneously allowing Provider-level Headers and Model-level Headers:

```text
Provider-level Header
├─ provider.headers
└─ provider.options.headers

Model-level Header
└─ provider.models.<modelId>.headers
```

The old CLI merges these Headers by layer and uses them for model requests. Desktop's physical configuration format also accepts model-level Headers, but the formal model types and settings page have not established this as a product capability. The current Official Config, internal evaluation configurations, and main product paths do not use model-level Headers.

Provider-level Headers have clear connection semantics: fixed HTTP Headers that must be carried with every request when accessing a specific Provider. They can express enterprise proxy tenant and project routing, additional organization identity, client source and protocol version. This is a constrained `Record<string, string>`, distinct from arbitrary Provider Options without public semantics.

Dynamic account authentication Headers belong to a separate category of data. JWT, one-time security verification materials, and dynamic Runtime Headers are obtained by the Account Request Auth Service for each request, and do not enter persistent Provider Config.

### Agent Autonomous Plan

To maintain compatibility with the old CLI's `model.headers`, the Agent added during implementation:

```ts
class ModelConfig {
  headers?: Record<string, string>;
}
```

The Registry creates Models by fixing these Headers within the Adapter, overriding same-name Provider Headers. The public `Model` and `ModelRequest` do not expose Headers. This solution does not leak request details in its abstraction encapsulation, but it brings model-level connection differences, which have not yet formed a formal product use case, into the new Model Config.

### Decision

Human confirmed to retain Provider-level static Headers and delete Model-level Headers:

```text
ProviderConfig.headers
└─ static Headers fixed when accessing that Provider

Account Request Auth Service
└─ dynamic authentication Headers obtained per request

ModelConfig
└─ does not contain Headers
```

Old configuration's `provider.headers` and `provider.options.headers` are unifiedly migrated to `ProviderConfig.headers`. Old configuration's `provider.models.<modelId>.headers` are not migrated, and do not enter the new Config, Registry, or Model execution chain.

If two models truly need different fixed connection Headers, they should be configured as two separate Providers. When genuine model-level routing requirements emerge in the future that cannot be expressed through Provider boundaries, redesign based on specific use cases.

During request execution, dynamic authentication materials can override same-name static fields:

```text
ProviderConfig.headers
        |
        |  Dynamic authentication materials override same-name fields
        v
Account Request Auth Service headers
        |
        v
Final HTTP Request Headers
```

### Impact on Current Implementation

- Retain `ProviderConfig.headers` and its Schema, Overlay, migration, and Adapter projection.
- Migrate old `provider.headers` and `provider.options.headers` together to `ProviderConfig.headers`.
- Delete `ModelConfig.headers` and its Schema, Overlay, projection, and tests.
- Delete old CLI Personal Config importer's migration for `model.headers`.
- Delete settings page migration bridge's implicit retention of model-level Headers.
- Retain Account Request Auth Service's request-period dynamic Header mechanism.
- Provider static Headers can temporarily be provided only through config files; the settings page does not need an advanced Header editor immediately.

## 5. OpenAI Compatible Fixed Request Streaming Usage

> Decision Status: Confirmed and implemented; Config close switch has been withdrawn

### Background

OpenAI Compatible streaming protocol requires carrying in the request:

```json
{
  "stream_options": {
    "include_usage": true
  }
}
```

For the Provider to return accurate Token Usage at the end of the stream. Usage is part of the model execution result and will be used for usage statistics, Trace, and context budget system capabilities.

Historical code considered that some compatible services may not accept `stream_options.include_usage`, so the Provider configuration added:

```ts
includeUsage?: boolean;
```

When set to `false`, the Adapter does not send this field. No specific Provider, formal product use case, or user configuration depending on this close capability was found in the repository.

### Agent Autonomous Plan

During M2 implementation, the Agent included the old `includeUsage` as a compatibility field in the new `ProviderConfig` and continued to pass it through configuration migration, Overlay, Registry, and Model creation chains.

This solution preserves the old configuration's expressiveness, but simultaneously makes "whether to request Usage" into a user-closeable Provider config. When closed, the system may not obtain accurate actual usage, which is inconsistent with Usage's fundamental semantics in the execution chain.

### Decision

Human confirms that OpenAI Compatible requests always explicitly enable `includeUsage: true`. Usage is part of the execution result and does not belong to user-closeable Provider config. The new Provider Config does not contain `includeUsage`; the old config's field is not migrated. Compatible services that do not support `stream_options.include_usage` are not within the formal support scope, and no fallback path is provided to retry after removing this field.

## 6. Plan Entitlement Cache Requires Account-level Non-sensitive Identity

> Decision Status: Confirmed; `accessId` identifies specific account connection

### Background

Usage / Entitlement already uses Account Provider's non-sensitive `accessId` to construct cache identity, no longer projecting API Key or JWT to the Renderer. Current Personal and Start Plan `accessId` only express connection type:

```text
start-plan:<providerId>
coding-plan:<providerId>
```

It does not contain specific account identity. When two accounts log in sequentially on the same machine, both get the same cache key. The Usage page first displays a ten-second short TTL cache, then silently refreshes; if the new account refresh fails, to avoid network jitter clearing the page, the current Hook continues to retain the already-displayed old cache. Therefore, relying solely on background refresh cannot guarantee account isolation.

### Decision

`accessId` identifies a specific account connection, not just Start Plan, Personal Coding Plan, or Team Plan connection types. When the specific logged-in account changes, `accessId` must change; JWT, API Key, Runtime Key, or OAuth Token refresh within the same account does not change `accessId`.

```text
Account A's connection
└─ accessId A
   ├─ Account Provider Config
   ├─ Usage Cache
   ├─ Credential Store
   └─ Created Model's request identity

Account B's connection
└─ accessId B
   ├─ Account Provider Config
   ├─ Usage Cache
   ├─ Credential Store
   └─ New created Model's request identity
```

Account Source generates `accessId` using non-sensitive stable identity provided by the account service. It cannot contain JWT, API Key, dynamic Headers, and does not use Secret hashing as Renderer identity. Team Plan continues to include specific organization and project connections; if the same organization/project under different accounts should not share connection identity, simultaneously incorporate account scope.

Login, logout, and connection switching can still proactively clear old Usage cache, but clearing is only an auxiliary measure to reduce stale data and storage usage, and does not bear identity isolation correctness.

### Implementation Impact

- Account Source must obtain non-sensitive account identity when generating Personal, Start, and Team `accessId`.
- Usage / Entitlement cache continues to use `providerId + accessId`, without adding parallel `accountCacheIdentity`.
- Account Credential Store isolates credentials by new account-level `accessId`. The current provider-level stable key is an intermediate M2 implementation not yet released; no migration is designed for it; Personal Coding Plan Key is obtained for the current account, Team Key is obtained or cached by account and organization/project.
- Created Models fix old `accessId`. After account switching, it cannot silently use new account credentials; new Agent Loop creates new Model from the latest Account Config.
- Account Provider Config, Usage Source, Credential Store, and Request Auth share the same connection identity.
- Request Auth not only looks up credentials by `accessId` but also verifies the current credentials' belonging account. Old Model's `accessId(account-A)` cannot be combined with post-switching `credential(account-B)` to initiate requests.

## 7. desktop-attached remote Uses Remote Provider Authority

> Decision Status: Confirmed; step one incorporated into M2.8, continuous sync and remote settings operations as subsequent features

### Background

Online `desktop-attached-remote` is read by Desktop from the local complete Provider Registry Snapshot, then sent to Remote Host/Worker via `workspace/updateProviderRegistry`. The Snapshot can carry API Key, JWT, Team Plan Key, and Header; the remote Agent's startup gate also reads the Desktop base Host's model View.

M2 once expressed the remaining issue as "how does Remote Worker cross-host request Desktop Account Request Auth", with candidates being Renderer relay or Local Host to Remote Host's Auth Broker. Both solutions default to Remote Worker belonging to Desktop Provider Environment.

### Decision

Remote Environment is an independent Provider Environment. It has its own Config, Credential, Account Source, Registry, and ModelFactory. Desktop only remotely controls Session, displays Remote View, and submits ModelSelection; it does not provide Remote Worker's Provider facts or request credentials.

```text
Desktop Entry
└─ remote control
        |
        v
Remote Host
├─ Remote Provider Config
├─ Remote Credential Store
├─ Remote Account Source
├─ Remote Registry
└─ Remote Worker
```

### Phased Migration

Step one first switches runtime authority and deletes Desktop -> Remote's complete Registry, runtimeModel, Account Config, and Secret Snapshot injection. If Remote Environment has no available configuration, the product should clearly report that the remote has not yet configured Provider, and cannot fall back to Desktop facts.

Step two uses independent sync functionality to continuously write local Config and Credential to Remote Store. The sync function is only responsible for Provisioning; Remote Source listens to its own Store, publishes new revision, and rebuilds Remote Registry. Registry objects, Account Overlay, Model, and request Headers are not transmitted through this sync link.

Step three allows the App to directly call Remote Settings / OAuth Service, remotely editing Remote Personal Config, initiating remote login, and viewing Remote Settings / Selection View. Credential exchange and persistence occur in the Remote Environment.

### Implementation Impact

- Delete `desktop-attached-remote` disabling its own Provider Registry authority special case.
- Remote Workspace's readiness, model menu, and settings read Remote Facade.
- Remote Worker only creates long-term Model from Remote Registry.
- Remote Request Auth only reads Remote Credential Store.
- Delete Renderer Auth relay and Host-to-Host Auth Broker topics.
- `provider/updateAccountConfig` is only used between Host and Worker within the same Environment.
- Local-to-remote continuous sync and App remote settings capability does not block step one's authority switch.

## 8. Usage / Entitlement Exits Old Provider Config and Provider Service

> Decision Status: Confirmed and implemented; Usage has exited old Provider Service, internal abstraction to be organized subsequently

### Current Behavior

Settings page Usage lists Personal Coding Plan and all subscribed Team Projects that the current account can query, allowing separate viewing; the sidebar and Composer only display quota corresponding to the current model connection. This product behavior remains unchanged.

The source list is already primarily produced by Account Config, Entitlement, and Team Products in `ProviderSettingsView`, but Host's `BigModelUsageQuotaProvider` still reads old `ModelProviderService.getAllCached()`, then re-finds Provider from `ModelProviderConfig[]`, determines enabled state, reads API Key, infers request address, and refreshes Coding Plan Key. It causes the old Provider large object, which has already exited the UI main chain, to continue being the execution fact source for Usage, and also blocks deletion of old Config and old Provider Service.

```text
Current UI Selected Usage Source
├─ providerId
├─ accessId
├─ organizationId?
└─ projectId?
        |
        |  Identity is lost or incomplete in the existing chain
        v
BigModelUsageQuotaProvider
        |
        v
Old ModelProviderService / ModelProviderConfig
└─ Re-guessing query source and request credentials
```

### Decision

Usage / Entitlement must exit old `ModelProviderService`, old `ModelProviderConfig`, and old Config. This migration's first goal is to flatten the fact source: as long as the call chain fully uses new Provider Config, Account Config, and Credential facts, do not retain old dependencies waiting for final Usage domain abstraction; internal responsibility issues discovered after migration can continue as independent refactoring.

When UI has already selected Usage Source, the request should carry complete, non-sensitive source identity:

```text
Usage Source
├─ providerId
├─ accessId
├─ organizationId?
└─ projectId?
        |
        v
UsageStatsService
        |
        v
Request Period Authentication
├─ Personal Coding Plan -> Account Credential Store
├─ Team Plan            -> Team Plan Request Key Resolver
└─ Start Plan           -> OAuth / ZCode JWT Store
        |
        v
Usage / Entitlement API
```

Host no longer selects sources based on old Provider arrays. Whether a Provider is used for model selection, whether it is selectable in Registry, and which model the current Session is using, are not used as filtering conditions for settings page Usage Source. When Account Provider disables model entry for the user, Usage can still query as long as the account connection still exists.

Regular API Provider if still needing to participate in monitor/usage queries, only reads the new Effective API Provider Config; Account Provider's Secret is always obtained by request-period Credential/Account service. Any migration adapter can only project narrow input from the new Config, Account, and Credential facts, cannot read old Config or old Provider Snapshot.

Known Account Plan's Usage routing can continue using existing providerId/family and service address construction logic in this round, but no longer guesses account plan type through model Endpoint. Whether Usage routing further enters Official Config is left for Usage domain's subsequent refactoring and does not block old Provider fact source exit.

### This Round Implementation Boundaries

- Add `accessId` for Coding Plan Usage / Entitlement request, preserve existing Team organization/project context.
- Delete `IModelProviderService` dependency from `BigModelUsageQuotaProvider`, as well as `getAllCached()`, `refreshCodingPlanApiKey()`, and `ModelProviderConfig[]` reading.
- Personal, Team, Start Plan respectively reuse existing Credential Store, Team Key Resolver, and OAuth Token Store; do not copy new Secret cache.
- Maintain settings page, sidebar, Composer, plan reset, and existing cache refresh behavior.
- This round does not require forming a perfect, general Usage Source/Authorization framework. After flattening, if `BigModelUsageQuotaProvider` still mixes too many responsibilities, split it separately.

Completion criterion: when deleting old Provider Config and Provider Service, Usage / Entitlement no longer constitutes a blockage, nor does it re-introduce old fact source through compatibility fallback.

## 9. Provider Access, API, and Model API Adapter Layering

> Decision Status: Partially replaced; Provider `access/api` layering remains valid, `ModelConfig.apiAdapter` withdrawn by decision item 11

### Background

Previously, Provider Config used a `kind` to simultaneously express API Key or account access method, while `apiFormat` and `baseURL` were flattened on the Provider; the model side placed `reasoningMapping` directly on ModelConfig. This mixes "how to obtain calling qualification", "which public API to use", and "what fixed adapter behaviors does that model have on that API" into one layer.

### Decision

Provider Config is split into two orthogonal sub-configurations:

```text
ProviderConfig
├─ access.type
│  ├─ api-key
│  └─ zhipu-account
└─ api.type
   ├─ anthropic-messages
   ├─ openai-responses
   └─ openai-chat-completions
```

The discriminant field uniformly uses `type`. `access` expresses calling qualification source, `api` expresses public request protocol; internal Adapter type is still execution implementation and does not enter external Config.

This item further decided at the time to converge the fixed behaviors related to model and API combination into `ModelConfig.apiAdapter`. Subsequent audits of AI SDK, GLM real interfaces, and various vendors' official Anthropic compatible interfaces showed that this layer mixes inherent protocol behaviors, vendor reasoning parameter mapping, and message replay, and ultimately only `reasoningMapping` remains as a configurable field. This decision has been withdrawn; the following structure is retained only as decision evolution history, with the current design subject to item 11:

```ts
interface ModelConfigRule {
  providerMatch?: string;
  modelMatch: string;
  apiMatch?: string;
  config: ModelConfig;
}

class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  apiAdapter?: ModelApiAdapterConfig | null;
}

class ModelApiAdapterConfig extends ConfigOverlay {
  reasoningMapping?: ReasoningMappingConfig | null;
  preserveThinking?: boolean | null;
  reasoningContentField?: string | null;
}
```

`apiMatch` and `providerMatch`, `modelMatch` use the same pattern matching semantics; rules execute in order, with later matching items continuing to override previous results. `preserveThinking` and `reasoningContentField` are fixed API adapter behaviors, not user-selectable Model Options.

Provider Config converges the old `kind/apiFormat/baseURL` structure into `access/api`, and converges `apiFormatMatch/reasoningMapping` into `apiMatch/apiAdapter`. Official, Personal, and Account still use the same ProviderConfig Overlay; the Account layer only supplements account connection and current model members, without persisting request credentials. The Schema version used in the development branch does not constitute a release contract; the final version number is uniformly handled by the next decision item.

GLM-5.2 and GLM-5.3's Anthropic API use standard `adaptive thinking + effort` expression, not sending budget. GLM-5-Turbo temporarily retains the existing 1024 fixed-budget compatibility behavior. OpenAI Chat under reasoning dialect and reasoning replay are written into `apiAdapter` through precise `apiMatch` rules; Anthropic Messages and OpenAI Responses prioritize following their respective official protocols.

## 10. Personal Config Maintains Original Path, Released as Schema Version 1

> Decision Status: Confirmed; supersedes the independent file path and version migration chain from the development phase

### Background

The M2 development phase once wrote the new Personal Provider Config to an independent `provider-config.json`, and consecutively used v1, v2, v3, v4 with internal Schema adjustments, preparing to use v5 for the next round of structure changes. This allows validating adjacent version migrations during development, but these formats were never officially released and do not need to become historical versions the product maintains long-term.

Meanwhile, the Desktop's formal user's existing model Provider configuration is already at:

```text
~/.zcode/v2/config.json
```

Creating a new `provider-config.json` would change the user's familiar physical path and produce the problem of switching authority between two files. The final architecture does not need to express domain boundaries by changing the file name.

### Decision

Personal Provider/Model Config continues to use the original `config.json` file name and path, without introducing a formal `provider-config.json`:

```text
Old format ~/.zcode/v2/config.json
        |
        | Full backup before migration
        v
Same path ~/.zcode/v2/config.json
└─ New ProviderConfigDocument
```

Before migration begins, the user's original configuration must be completely copied as a backup in the same directory. Successful backup is a prerequisite for modifying the original file; backup failure stops the migration without overwriting the original configuration. The backup file must not silently overwrite existing backups; specific suffixes and conflict naming can be determined by the Repository in implementation.

When completing M2 and preparing the first release, the new Provider Config document uses:

```json
{
  "schemaVersion": 1
}
```

The v1-v5 that appeared during development are all unpublished intermediate formats. At M2 closeout, delete the long-term compatibility branches and public version narratives reserved for these internal versions, using the final complete Schema as the formal v1. Subsequent real post-release format changes then migrate from v1 to v2.

This decision does not require designing lossless compatibility for the Standalone CLI history format that is not yet officially open. Internal evaluation users can adjust configurations; if Entry performs migration on existing files, it must also comply with the data safety order of "backup first, then atomic replacement."

## 11. Withdraw Model API Adapter Config Layer, Reasoning Mapping Directly Belongs to ModelConfig

> Decision Status: Partially supplemented by items 12 and 13; the conclusion to withdraw `ModelConfig.apiAdapter` remains valid, the required conditions and semantics of `reasoningMapping` are subject to item 12, GLM-5-Turbo's specific tiers are subject to item 13

### Background

Item 9's decision once added `apiAdapter` to `ModelConfig`, with plans for it to carry `reasoningMapping`, `preserveThinking`, and `reasoningContentField`. Subsequent audits confirmed that the three actually belong to different concerns:

- `reasoningMapping` describes how the user's selected Reasoning tier forms request parameters required by specific Provider/Model/API;
- Anthropic Thinking Block, Signature, and OpenAI Responses Reasoning Item saving and replay are inherent behaviors of the respective protocols;
- GLM OpenAI Chat's `clear_thinking` is a specific request parameter that can directly become the output of `reasoningMapping`.

AI SDK can already convert `reasoning_content` between OpenAI Compatible messages and standard Reasoning Parts, and the Anthropic Adapter is also responsible for protocol replay of Thinking Blocks and Signatures. Therefore, the config layer no longer needs to declare response field names or repeatedly express message replay strategies.

Audits of vendors' official Anthropic interfaces simultaneously show that the base Messages structure is already relatively unified, but Reasoning control is not unified: DeepSeek, Kimi, MiniMax, Qwen, and MiMo each use different switches, tiers, or budget semantics. `reasoningMapping` therefore still has value, but it is a protocol parameter mapping selected by Model Config Rules, not an independent Model API Adapter config object.

### Decision

Withdraw the unpublished `ModelConfig.apiAdapter` and `ModelApiAdapterConfig`. `ModelConfig` remains flattened, with optional `reasoningMapping` placed directly within it:

```ts
class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  reasoningMapping?: ReasoningMappingConfig | null;
}
```

`ModelConfigRule.apiMatch` continues to be retained. Together with `providerMatch` and `modelMatch`, it determines which Provider, model, and public API a particular `reasoningMapping` applies to:

```text
providerMatch + modelMatch + apiMatch
                    |
                    v
            ModelConfig Overlay
                    |
                    v
             reasoningMapping
```

The runtime Provider Adapter continues to exist. This withdrawal is of the `apiAdapter` wrapper layer in the config Schema, not changing the execution boundaries of Anthropic, OpenAI Responses, and OpenAI Compatible Adapters.

Item 12 further confirms: the Reasoning parameter mapping for standard OpenAI Responses, Anthropic Messages, and OpenAI Compatible should also be explicitly provided by Official Config. The runtime Adapter continues to be responsible for protocol execution and message replay, without hiding a default strategy for generating request parameters from `reasoningLevel`.

`preserveThinking` and `reasoningContentField` exit the target Config:

- The `clear_thinking` needed by GLM OpenAI Chat is directly written into the corresponding tier's `reasoningMapping`;
- Reasoning content parsing and replay are completed by the message model and Adapter, not by the Config specifying field names;
- Historical DeepSeek/MiMo empty `reasoning_content` compatibility patches continue to be audited separately, not expressed through the above fields.

GLM-5.2 and GLM-5.3's Anthropic API use modern `adaptive thinking + effort`. GLM-5-Turbo also uses adaptive thinking, but does not publicly commit to effort tiers; specific basis and mapping see item 13. All three do not send fixed budget. GLM-5-Turbo has been verified through the BigModel Coding Plan real interface, covering single-request, current AI SDK parsing, Tool Call, Thinking Block, Signature, and second-round replay after Tool Result. Therefore, the temporary conclusion to retain `1024 fixed budget` for GLM-5-Turbo in item 9 is withdrawn.

## 12. Reasoning Mapping is a Required AI SDK Provider Options Mapping

> Decision Status: Confirmed; when a model declares `reasoningLevel`, complete `reasoningMapping` must be provided

ZCode internally uses AI SDK to call models. OpenAI Responses, Anthropic Messages, and OpenAI Compatible are each executed by their corresponding AI SDK Provider. Users select a unified `reasoningLevel`; `reasoningMapping` is responsible for converting this tier into the Options received by the current AI SDK Provider:

```text
reasoningLevel
        |
        | reasoningMapping
        v
AI SDK Provider Options
        |
        v
AI SDK Provider
        |
        v
Model API
```

When `ModelConfig.optionSpecs.reasoningLevel` declares optional tiers, the ultimately effective `ModelConfig` must simultaneously provide `reasoningMapping`, covering all optional tiers. The default mapping for standard APIs is also written into Official Config, not hidden in Adapter code.

For example:

```jsonc
// OpenAI Responses
"reasoningMapping": {
  "high": {
    "reasoningEffort": "high"
  }
}
```

```jsonc
// Anthropic Messages
"reasoningMapping": {
  "high": {
    "thinking": {
      "type": "adaptive"
    },
    "effort": "high"
  }
}
```

```jsonc
// GLM OpenAI Compatible
"reasoningMapping": {
  "high": {
    "reasoningEffort": "high",
    "clear_thinking": false
  }
}
```

`reasoningMapping[level]` is the inner object of AI SDK Provider Options related to Reasoning, passed to the current runtime Provider Adapter. It does not contain `openai`, `anthropic` and other AI SDK namespaces, nor is it the final HTTP Request Body. The runtime Adapter places it in the correct Provider Options namespace based on the current API type, and the AI SDK Provider encodes it into actual protocol fields.

`reasoningMapping` directly belongs to `ModelConfig`:

```ts
class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  reasoningMapping?: ReasoningMappingConfig | null;
}
```

This mapping only carries Reasoning-related Provider Options, such as `reasoningEffort`, `effort`, `thinking`, `enable_thinking`, and `clear_thinking`. API Keys, Headers, Base URLs, and other model request parameters do not belong to this mapping.

## 13. GLM-5-Turbo Only Provides Thinking Switch

> Decision Status: Confirmed; supersedes the "GLM-5-Turbo uses effort" portion of item 11

Zhi's official documentation explicitly states that GLM-5-Turbo supports `thinking.type = enabled | disabled`, with default enabled; when enabled, the model dynamically determines whether thinking is needed. The formal support range for `reasoning_effort` starts from GLM-5.2 and does not include GLM-5-Turbo. A real interface being able to accept a parameter does not mean that parameter has become the model's public contract.

Therefore GLM-5-Turbo's `reasoningLevel` only includes:

```text
enabled
disabled
```

OpenAI Compatible API's mapping uses `thinking.type`. ZCode, as a long-chain Coding Agent, simultaneously uses `clear_thinking: false` when thinking is enabled, and the message model and Adapter fully and verbatim replay historical `reasoning_content` in order. This behavior is a fixed protocol configuration, not exposed as a user Option.

Anthropic Messages API's mapping is `adaptive` and `disabled`. When enabled, do not send `effort`; the server adopts the default reasoning strategy; simultaneously do not send fixed budget. The `budgetTokens: 1024` previously used to compatibly handle old AI SDK does not enter the new Official Config.

GLM-5.2 and GLM-5.3 continue to provide effort tiers according to their respective official support scope, unaffected by this decision.

## 14. Idle Tasks Use Builtin Provider and Per-Turn Authentication Materials

> Decision Status: Confirmed; normal Account authentication and idle task authentication use different source boundaries

### Background

Current idle tasks are assembled by the Host before each dispatch as a `turnRuntimeModel`. It contains both static configuration of the Provider and Model, as well as the API Key, Ticket, and Headers used by the current execution. The Core Worker temporarily adds it to the Registry Overlay, creates an execution Model for the current Turn, then restores the previous Runtime Model and cleans up the Overlay when the Turn ends.

This chain already has the running semantics of "each Turn uses a fixed authentication snapshot," but it assembles and transmits static Provider facts together with dynamic authentication materials, and relies on temporary `setModel`/restore logic.

### Decision

Normal Account Provider authentication takes its fact source from the Core Worker / CLI process's own Account Request Auth Service. The Host or other Entries only submit `ModelSelection`, not passing or overriding normal Account Provider's API Key, Headers, Provider Config, or Model Config along with the Submission. The CLI creates Models based on its own Registry, and when the real request occurs, obtains the current connection's dynamic credentials through its own authentication Service.

```text
Host / Entry
└─ ModelSelection
        |
        v
CLI Registry
        |
        v
CLI Account Request Auth Service
        |
        v
Model Request
```

The current Desktop Worker obtains normal Account authentication materials through protocol callbacks to the Host, which is a migration chain that needs to be exited; it does not constitute a second fact source in the target architecture.

The idle task's Provider is changed to a Builtin Provider managed by Official Config. Its Provider identity, API type, Base URL, model list, Model Properties, and Option Specs and other static facts enter the formal Registry. This Provider is used for idle task execution and does not appear in normal model selection and settings interactions.

When the Host dispatches each idle Turn, it only additionally passes the dynamic authentication materials needed for the current execution:

```text
Builtin Provider (Official Config / Worker Registry)
├─ Provider and Model static config
└─ Does not contain current execution's Secrets

Host dispatches Turn
├─ ModelSelection
├─ API Key
└─ Headers
   ├─ Coding Plan API Key
   ├─ Off-Peak Ticket ID
   └─ Other Headers needed for this execution
```

The Core Worker creates a normal `Model` using the Builtin Provider from the Registry, the current `ModelSelection`, and the passed authentication materials. This Model is explicitly given to the current Agent Loop, and the Loop's Model Steps and auto-Compact continue to use the same Model and authentication materials.

```text
Builtin Provider in Worker Registry
        +
ModelSelection
        +
Current Turn's API Key / Headers
        |
        v
      Model
        |
        v
   Agent Loop
```

Authentication materials are not written to Official Config, Personal Config, Registry View, or Session persistence state. They are only valid for the current Turn and must not be used by subsequent executions after the Turn ends. The idle Model also does not modify the user's Session Model Selection or App Recent.

### Ticket Expiry and Continuation

Current `3102` Ticket expiry semantics are retained:

```text
Current Turn receives 3102
        |
        v
Current Turn ends
        |
        v
Same Off-Peak Task returns to queued
        |
        v
Host re-obtains Ticket
        |
        v
Submit Resume Turn in the same Session
        |
        v
New Turn creates new Model with newly passed API Key / Headers
```

This is a new Turn / Agent Loop for the same idle task and same Session, not replacing the Ticket within a running Model. Normal JWT or API Key authentication failure does not automatically equal `3102`; whether it needs automatic continuation is not within this decision's scope.

### Execution Model Switch Banner

The model switch banner is determined by the Model actually used by adjacent execution segments. Each Agent Loop holds its own Execution Model; the Guide switching Models within the Loop forms a new execution segment. When a new execution segment begins, the system compares its `providerId/modelId` with the previous execution segment: if the identity differs, display the model switch banner; if the identity is the same, do not display it. Changes to the reasoning tier alone are not treated as model identity changes.

```text
Previous segment's Execution Model
              |
              |  Compare providerId / modelId
              v
Current segment's Execution Model
              |
              +-- Same: do not display banner
              `-- Different: display model switch banner
```

Idle models enter the execution model sequence by the same rule and do not require idle-task-specific banner state:

```text
Normal Turn A
    |
    v
Idle Turn Idle       -> A vs Idle differ, display A -> Idle
    |
    v
Next normal Turn B   -> Idle vs B differ, display Idle -> B
```

If no new execution segment begins after the idle task ends, the system does not preemptively display "restore to A." At this point, no Model is executing; after the next round truly creates A or B, generate the banner based on the actual Execution Model. This way, when users change the Session Selection from A to B during the idle task, the timeline naturally shows `Idle -> B`, without passing through an A that was never truly executed.

Session Model Selection is only responsible for creating Models for subsequent execution, not serving as the banner's fact source. Each Turn needs to persist the actual Execution Model identity; real-time projection and cold recovery both derive banners from the same execution sequence. `lastExecutionModel` only represents the previous actual execution model and does not bear Session Selection's persistence state.

The banner uses an explicit public entry:

```ts
recordExecutionModelChangeMarker({
  modelRef: activeModel.modelRef,
  traceContext,
});
```

This entry only compares the current Execution Model of this Session with `lastExecutionModel`, and persists a `model_change` Marker when `providerId/modelId` changes. It is called when the normal main Agent Loop starts, idle main Agent Loop starts, and the Guide's new Model truly takes effect from the next Model Step. If Subagents reuse this entry, it only writes to their own Child Session. Title, Memory, Wiki, Verifier, and other independent model tasks do not call it.

This entry does not create or switch Models, nor does it modify Session Selection, Provider Config, or Registry.

The Execution Model takes effect when the Model is successfully created and formally enters the main Agent Loop, or when the Guide formally enters a new Model Step. At this point, call `recordExecutionModelChangeMarker()`. If Model creation fails, or Submission is prevented by admission, hooks, or other boundaries before entering the Agent Loop, no new execution model baseline is established. After entering the Loop, even if canceled before the first Model Request is sent, this Model is still the Execution Model that has taken effect in this execution segment and can produce a banner.

`3102` resumption is a new Turn for the same idle task. If the new Turn continues to use the same Idle Model, the execution model identity does not change, and no intermediate banner is added; the next execution segment that truly starts after the entire idle task is compared with Idle.

### Authentication Boundaries

Idle tasks do not extend the normal Account Request Auth Service's responsibilities. It first reuses the static facts of the Builtin Provider in the CLI Registry; if it is difficult for the CLI to naturally obtain the full set of dynamic materials required by the idle service at this stage, the Host can pass execution-scoped Request Auth along with the current Turn. This input only expresses the authentication materials and Ticket for this idle execution, not Provider or Model static config.

If the CLI can naturally obtain JWT, Coding Plan Key, and other materials in the future, the Host's input can continue to be narrowed; this optimization does not change the already confirmed boundaries and does not block the current migration. Off-Peak Tickets are obtained by the Host scheduling service and continue to be passed along with the current Turn.

Execution-period authentication must satisfy:

- Normal Account Providers always use the CLI Account Request Auth Service and do not accept external authentication overrides;
- Idle tasks allow the Host to pass API Key, Headers, and Tickets along with the current Turn;
- Authentication materials between different Turns and concurrent executions must be isolated;
- A Model uses fixed authentication materials within one Agent Loop;
- After the Turn ends, fails, or is cancelled, the current authentication materials must exit the available state;
- Providers and Models continue to be executed through the unified ModelFactory and Adapter chain, without establishing idle-task-specific model request protocols.

## 15. After Process Registry is Enabled, Old Workspace Catalog Exits Provider Authority

> Decision Status: Confirmed and completed

The process Registry has already constructed Providers and Models from Official, Personal, and Account Config. At this point, the old Workspace Catalog continuing to participate in member judgment, property synchronization, or projection merging would cause the Host Snapshot to once again become a second fact source. This issue cannot be postponed simply because the code resides in the old protocol compatibility layer; anything that affects normal long-term Providers falls within the current high-priority closeout scope of M2.

The confirmed boundary is:

```text
Process Registry is enabled
├─ Provider / Model members        -> Registry View
├─ Model Properties / Options     -> Registry Model
├─ Model switch availability      -> App Registry View
├─ Context window of current exec -> Current App Runtime / Model
└─ Provider revision              -> No longer use old Workspace Catalog revision

Workspace Settings
└─ Workspace default / last-used / mode and other interactive states
```

The `runtimeModel` carried by the old protocol along with the Host is no longer written to the Workspace Catalog in the Registry process, nor is it used to supplement normal long-term Providers. The migration-period idle `runtimeModel` is narrowed by subsequent slices to ModelSelection, Request Auth, and Tickets; it does not constitute a reason to retain normal Workspace Provider Snapshots.

This item simultaneously confirms the following implementation principles:

- `syncAppWorkspaceModelCatalog()` no longer installs old Overlays or overwrites Runtime in process Registry mode;
- App initialization no longer generates `bootstrapModelConfig` from the old Workspace Catalog;
- Session preflight and cross-Provider switches determine current members from Registry-backed `app.listModels()`;
- `workspace/readState` only returns `settings.model`; old `modelCatalog` protocol fields, Provider projections, and revision have been deleted;
- The App no longer exposes `setModelCatalogOverlay`, nor does it save Workspace-level Provider/Model Overlays; idle and other single executions still enter through independent Turn Overlays and do not restore long-term Workspace Catalogs;
- `createZCodeApp` must inject the process Registry; tests and internal tools use explicit test Registries, without entering old Runtime Model Config assembly by omitting optional parameters;
- Cold recovery usage's context window uses the model properties already fixed by the current App Runtime;
- `workspace/readState` is a pure projection interface, does not accept `runtimeModel`, and does not modify the Active Session;
- `workspace/setDefaultModel` only writes ModelSelection, does not accept Provider runtime snapshots;
- V4 `createSession` and `switchModelConfig` only submit ModelSelection; the target Provider is validated by the Worker Registry, without accepting Host `runtimeModel` fallback;
- The Repo Snapshot bypass only uses the Selection or execution-scoped Model explicitly carried by the current command; when missing, allow model metadata to be empty, without guessing the Provider by reading `workspace/readState`;
- default, last-used, mode, and other selection/interactive states can still remain in Workspace Settings, subsequently converged by Interaction design, and not mixed with Provider static facts.

Cleansing unrelated to the current Registry Authority can be deferred, such as deleting old hot-update helper functions with no callers, refactoring idle authentication, atomic Submission, and Guide/Loop-switch semantics. The criterion is whether it can reduce the current dual-track, not which phase it was originally marked in.

## 16. Product Semantic Retrospective for M1/M2 Autonomous Decisions

> Decision Status: Confirmed

Five autonomous decisions that emerged during implementation and review are now formally retrospectively recognized according to product semantics.

### Model Properties are a Unified Check before Request Sending

Callers can read Properties in advance to select execution strategies; the Model still checks the actual Request before sending. When the model explicitly declared as unsupporting is used for images, PDFs, videos, Tool Calls, or Structured Output, the Model returns a clear error.

The target Registry's ModelConfig must be complete, with `unknown` no longer retained. The current image, PDF, and video fields allow `undefined`, simply because default configurations and user-provided settings capabilities are not yet complete: during the transition, only explicit `false` blocks requests, and default values temporarily pass through. After the corresponding configuration migration is complete, the fields become required and this compatibility semantics is deleted.

### Independent Model Tasks Continue Existing Reasoning Behavior

Title, Git Commit Message, and Memory Selector had already closed reasoning before refactoring, so they continue to use the derived Model with reasoning closed. This refactoring does not change these tasks' product strategies, nor does it allow them to bypass Models to directly modify Provider parameters.

### Account Queries Per-Provider Retain Last-known-good

Remote queries for Start Plan, Personal Coding Plan, and Team Plan each produce `available`, `unavailable`, or `unknown`. When one channel is `unknown`, only retain the previous successful result for that Provider; other Providers' already-obtained definite results continue to be published. Explicit `unavailable` deletes the corresponding Provider.

### Target Design Does Not Retain Temporary Providers

Idle tasks select Official Builtin Providers from the CLI Registry and receive necessary Request Auth and Off-Peak Tickets along with Turns. Submissions do not carry complete ProviderConfig or ModelConfig. The idle `runtimeModel` still present in M2 is a compatibly narrowed input and does not constitute a new fact source.

### Account Provider's User-visible Behavior Remains the Same

This refactoring maintains the current number of Providers, Personal/Team connection switching, and model visibility, without introducing new product forms such as multiple Teams and Personal simultaneously appearing in the model selector. Internal convergence of Config, Registry, and Request Auth must not change this behavior.
