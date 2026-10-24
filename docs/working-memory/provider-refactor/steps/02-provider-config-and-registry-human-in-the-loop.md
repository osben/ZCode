# M2: Provider Config and Registry Human-in-the-Loop

> Status: Continuously maintained
>
> Last updated: 2026-08-20

This file records the architecture, product, and public contract decisions submitted to human review during M2. Unlike the implementation log, which saves reversible decisions the Agent made autonomously, this file saves decisions that change target abstractions or implementation boundaries and require human confirmation. Confirmed conclusions are synced to the corresponding Design node; this file keeps the decision background and the gap between current implementation and target.

## 1. Account Access Reuses Provider Config Overlay

> Decision Status: Confirmed and implemented; normal long-term Provider has exited the old Snapshot source

### Background

A Provider's access method and public API are two independent dimensions: `access.type = "api-key"` uses a static API Key; `access.type = "zhipu-account"` uses the current login, plan, or team connection. `api.type` describes Anthropic Messages, OpenAI Responses, or OpenAI Chat Completions; different access methods can use the same API.

Early Registry designs placed account state in a separate `AccountProviderAccessEntry[]`, later renamed to a Runtime Overlay with `AccountProviderOverlay`, `AccountProviderAccess`, and `allowedModelIds` — in effect a second Provider data structure. This conflicts with the Config Overlay goal: Official, Personal, and account state all supplement fields of the same Provider, so three shapes and a special filtering algorithm are unnecessary.

### Decision

Account state directly outputs a sparse third-layer `ProviderConfigMap`, using the same Provider Config Overlay data structure and algorithm as Official and Personal:

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

Ownership of the three layers stays different: Official is platform-managed, Personal is user-managed, Account is generated in real time from account and plan state. The Account layer is not persisted and not edited by the settings page; these differences are expressed by Source and lifecycle, not by another set of domain types.

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

`accessId` is a non-sensitive account connection identity used to distinguish Start Plan, Personal Coding Plan, and a specific Team Plan. It is not a JWT, API Key, or Header.

### Account Layer Provides Model Members

The Official Account Provider manages `api.type`, `api.baseURL`, static Headers, and other definitions; it does not pre-list the current account's finally available models. The Account layer supplies the current connection's account-level `accessId` and `models`:

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

`models` follows standard field Overlay rules: when the Account layer provides this field, it completely overrides the preceding layer and directly determines final members and order. There is no `allowedModelIds` and no "intersection of configured models and allowed models" computation. Model Properties, Option Specs, and Reasoning Mapping continue to be resolved by ModelConfigRules, a separate concern from the Provider's model member list.

### Registry and Authentication Boundaries

The Registry only handles Config: the three-layer `ProviderConfigMap` enters it after `overlay + validateComplete`. The final `ProviderConfig` has complete `access.type`, account-level `accessId`, and `models`. The Registry does not verify whether `accessId` corresponds to actual entitlement and does not establish an `accessAllowed` gate based on the Account Source's member relationships.

A manually written invalid `accessId` obtains no actual credentials. The final authority for request authentication is the Account Request Auth Service:

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

The Registry and Model store no account Secrets. Tokens or Runtime Keys inside account identity can be refreshed, but already-created Models do not follow global current-connection switches to another Personal or Team Plan.

### Final Provider

The final Provider no longer nests another Account Access object:

```ts
interface Provider {
  readonly providerId: ProviderId;
  readonly config: ProviderConfig;
  readonly models: readonly ProviderModel[];
}
```

When `provider.config.access.type === "zhipu-account"`, TypeScript narrows the Access Config to `ZhipuAccountAccessConfig`, and the ModelFactory reads `provider.config.access.accessId` directly. `ProviderRegistryProvider` is renamed to the domain name `Provider`.

### Impact on Current Implementation

- Account Source output is a sparse `ProviderConfigMap`; it no longer outputs `AccountProviderAccessEntry[]` or `AccountProviderOverlay[]`.
- Provider Config Snapshot adds the Account Provider Config layer; the Resolver applies the same Overlay in the order Official, Personal, Account.
- `AccountProviderAccess`, `allowedModelIds`, `accessAllowed`, and flattened `accountAccessId` are deleted from the Registry. The request protocol still uses `accountAccessId` to pass the Model's fixed identity to the dynamic authentication Service.
- `ZhipuAccountAccessConfig` includes `accessId`; the final completeness check requires Account Providers to carry the Config fields needed for execution.
- The ModelFactory fixes `accessId` from the final `ProviderConfig.access`; the existing request-period dynamic authentication chain is unchanged.
- Early in this decision's implementation, the old Snapshot was temporarily allowed to project the formal Account `ProviderConfigMap`. M2.8 deleted this production compatibility chain; the Account Source now directly produces formal Config, and Snapshot projection is no longer a viable implementation path.

## 2. Last-known-good View Retained on Source Refresh Failure

> Decision Status: Confirmed; human reviewed and approved the implementation strategy the Agent had already autonomously adopted

### Background

The Registry aggregates Official, Personal, and Account Provider Config into a single complete View. When any source changes, it re-reads, parses, and validates all inputs off to the side, then atomically publishes the new View.

Source refresh may fail from temporarily unreadable files, JSON or Schema parsing failures, abnormal Official sources, or account and plan service timeouts. At that point the system only knows "cannot obtain the latest facts"; it cannot infer that the user deleted Personal Config, the platform removed the Provider, or the account logged out.

Each Overlay layer saves only the fields it owns. Publishing a partial result that drops the failing Source would misread a read exception as a business deletion: Personal failure could erase API Keys and user Providers; Official failure could leave sparse Personal Config unable to form a complete Provider; Account failure could make all Plan models vanish instantly.

`ProviderRegistryService` had already autonomously adopted Last-known-good: on read or parse failure, keep the current Snapshot, reject the current explicit refresh, and emit a refresh error event; the next successful refresh publishes a new View normally. Because the Design still marked "retain old View vs. publish partial results" as pending, this choice required formal human confirmation.

### Decision

Once the Registry holds a successful View, a read, parse, or refresh failure of any Source retains the previous complete View; no partial result missing that Source is published.

```text
Refresh succeeds
└─ Atomically publish new complete View

Refresh fails
├─ Retain previous successful View
├─ Report specific Source and error
└─ Wait for watcher, explicit refresh, or subsequent state changes to recover
```

"Refresh failure" and "successfully obtained empty state" are strictly distinguished. When a Source successfully returns deletion, disable, an empty Config Map, or account invalidation, these are clear new facts; the Registry must build and publish a new View normally. Last-known-good must not block valid state changes.

On first startup there is no successful View to retain. If the first build fails, Registry startup fails and exposes the error; unknown state must not be disguised as a determined empty View.

### Relationship with Request Authentication

A Last-known-good View may briefly retain an Account Provider still shown in the model list, but it does not extend account permissions. The Account Request Auth Service still obtains current credentials per request by the Model's fixed `accessId` and remains the final authority:

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

The Registry's Last-known-good only avoids violent projection jitter from transient faults; it does not cache, restore, or forge JWT, Runtime Key, one-time security verification Headers, or other request authentication material.

### Impact on Current Implementation

- The Registry only publishes complete Views built and validated by all Sources together.
- Refresh failure retains the current revision and View while exposing the failure reason through error events and logs.
- Explicit refresh, file watchers, and Account Source updates enter the same refresh chain; revision deduplication avoids republishing the same change.
- Successful empty states, deletions, disables, and account invalidations must be published and must not be classified as refresh failures.
- The Design's pending wording "retain old View vs. publish partial results" is updated to this conclusion.

## 3. No Longer Supporting Arbitrary Model Options

> Decision Status: Confirmed; Agent autonomous compatibility plan withdrawn

### Background

Old CLI and Desktop Provider configuration share the same underlying format (`provider` → `models` nesting), so both allow writing arbitrary `options` into model configuration:

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

The shared format invites misjudgment: it is neither CLI-exclusive nor evidence that CLI or Desktop established arbitrary Model Options as a formal product capability. The old CLI passes some `model.options` as Provider parameters; Desktop's physical Schema preserves `model.options`, but the formal `ModelProviderModelConfig` and settings page provide no arbitrary Options capability — Desktop explicitly interprets mainly `options.max_tokens`, converging it to the formal `maxOutputTokens`. Internal evaluation configs use only Provider-level `apiKey`, `baseURL`, and model capacity fields. Arbitrary Model Options are an extension port left by the underlying format, not a public contract the new Provider architecture must inherit.

During implementation the Agent added `ModelConfig.requestParameters?: Record<string, unknown>`, passed through Config Overlay, Personal Config projection, and Model creation, forming another arbitrary request-parameter channel. Human rejected it: it bypasses the strongly-typed boundaries already established by `ModelOptionSpecs`, `ModelOptions`, and `reasoningMapping`, and freezes a historical extension that never became a product commitment into the new architecture.

### Decision

The new Provider architecture does not support arbitrary Model Options and does not keep generic `requestParameters`. New model configuration carries only formally defined common options:

```text
reasoningLevel
maxOutputTokens
```

They complete capability declaration, user selection, request-level override, and Provider protocol conversion through `ModelOptionSpecs`, `ModelOptions`, and `reasoningMapping`. Old-config fields with clear formal semantics migrate:

```text
options.max_tokens
        |
        v
maxOutputTokens
```

Other arbitrary `model.options` are not migrated, not passed through, and do not enter the new Model Config. Internal evaluation users can adjust not-yet-public CLI configurations; lossless migration for this historical extension channel is not required.

### Impact on Current Implementation

- `ModelConfig.requestParameters` and its Schema, Overlay, projection, tests, and runtime passing logic are deleted.
- The old CLI Personal Config importer's migration of arbitrary `model.options` is deleted.
- The semantic migration from `options.max_tokens` to formal `maxOutputTokens` is retained.
- Desktop old storage may temporarily preserve unknown `model.options` as-is, but the new Config, Registry, and Model execution chain do not read them.
- Provider-level `options` that historically stored `apiKey` and `baseURL` are unrelated to this decision; they migrate to formal Provider Config fields.
- New model options in the future must first define fixed fields, Option Specs, validation rules, and Adapter mapping, then enter the new architecture as a public capability.

## 4. Static Headers Belong Only to Provider Config

> Decision Status: Confirmed; Agent autonomous compatibility plan withdrawn

### Background

Old CLI and Desktop share the underlying Provider format, allowing both Provider-level Headers (`provider.headers`, `provider.options.headers`) and Model-level Headers (`provider.models.<modelId>.headers`). The old CLI merges them by layer for model requests; Desktop's physical format accepts model-level Headers, but the formal model types and settings page never established them as a product capability, and Official Config and main product paths do not use them.

Provider-level Headers have clear connection semantics: fixed HTTP Headers carried with every request to a specific Provider — enterprise proxy tenant/project routing, additional organization identity, client source and protocol version. They are a constrained `Record<string, string>`, distinct from arbitrary Provider Options without public semantics. Dynamic account authentication Headers (JWT, one-time security material, dynamic Runtime Headers) are obtained per request by the Account Request Auth Service and never enter persistent Provider Config.

During implementation the Agent added `class ModelConfig { headers?: Record<string, string> }`, fixed within the Adapter and overriding same-name Provider Headers, to keep old CLI `model.headers` compatible. Human rejected it: it brings model-level connection differences, which have no formal product use case, into the new Model Config.

### Decision

Provider-level static Headers are retained; Model-level Headers are deleted:

```text
ProviderConfig.headers
└─ static Headers fixed when accessing that Provider

Account Request Auth Service
└─ dynamic authentication Headers obtained per request

ModelConfig
└─ does not contain Headers
```

Old `provider.headers` and `provider.options.headers` migrate together to `ProviderConfig.headers`. Old `provider.models.<modelId>.headers` are not migrated and do not enter the new Config, Registry, or Model execution chain. If two models truly need different fixed connection Headers, configure them as two separate Providers; when genuine model-level routing needs emerge that Provider boundaries cannot express, redesign from the specific use case.

During request execution, dynamic authentication material may override same-name static fields:

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

- `ProviderConfig.headers` and its Schema, Overlay, migration, and Adapter projection are retained.
- Old `provider.headers` and `provider.options.headers` migrate together to `ProviderConfig.headers`.
- `ModelConfig.headers` and its Schema, Overlay, projection, and tests are deleted.
- The old CLI Personal Config importer's migration of `model.headers` is deleted.
- The settings page migration bridge no longer implicitly retains model-level Headers.
- The Account Request Auth Service's request-period dynamic Header mechanism is retained.
- Provider static Headers may temporarily be provided only through config files; the settings page does not need an advanced Header editor immediately.

## 5. OpenAI Compatible Fixed Request Streaming Usage

> Decision Status: Confirmed and implemented; Config close switch withdrawn

The OpenAI Compatible streaming protocol requires carrying in the request:

```json
{
  "stream_options": {
    "include_usage": true
  }
}
```

so the Provider returns accurate Token Usage at the end of the stream. Usage is part of the model execution result, feeding usage statistics, Trace, and the context budget system.

Historical code added `includeUsage?: boolean` to Provider config for compatible services that might not accept `stream_options.include_usage`; no Provider, formal product use case, or user configuration in the repository depends on this close capability. During M2 the Agent carried the old `includeUsage` through the new `ProviderConfig` chain, making "whether to request Usage" a user-closeable config — inconsistent with Usage's semantics in the execution chain.

Human confirms: OpenAI Compatible requests always explicitly enable `includeUsage: true`. Usage is part of the execution result and does not belong to user-closeable Provider config. The new Provider Config does not contain `includeUsage`, and the old config's field is not migrated. Compatible services that do not support `stream_options.include_usage` are outside the formal support scope; no fallback path retries after removing this field.

## 6. Plan Entitlement Cache Requires Account-level Non-sensitive Identity

> Decision Status: Confirmed; `accessId` identifies a specific account connection

Usage / Entitlement already uses the Account Provider's non-sensitive `accessId` to build cache identity, no longer projecting API Key or JWT to the Renderer. The previous Personal and Start Plan `accessId`s expressed only connection type:

```text
start-plan:<providerId>
coding-plan:<providerId>
```

without specific account identity, so two accounts logging in sequentially on the same machine shared one cache key. The Usage page first shows a ten-second short-TTL cache, then silently refreshes; if the new account's refresh fails, the current Hook keeps the already-displayed old cache to avoid network jitter clearing the page. Background refresh alone therefore cannot guarantee account isolation.

### Decision

`accessId` identifies a specific account connection, not just a Start Plan, Personal Coding Plan, or Team Plan connection type. When the specific logged-in account changes, `accessId` must change; JWT, API Key, Runtime Key, or OAuth Token refresh within the same account does not change it.

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

Account Source generates `accessId` from non-sensitive stable identity provided by the account service. It must not contain JWT, API Key, or dynamic Headers, and must not use Secret hashing as Renderer identity. Team Plans keep including specific organization and project connections; if the same organization/project under different accounts must not share connection identity, incorporate account scope as well.

Login, logout, and connection switching may still proactively clear old Usage cache, but clearing is only an auxiliary measure reducing stale data and storage use; it does not carry identity-isolation correctness.

### Implementation Impact

- Account Source must obtain non-sensitive account identity when generating Personal, Start, and Team `accessId`s.
- Usage / Entitlement cache continues to use `providerId + accessId`, without a parallel `accountCacheIdentity`.
- Account Credential Store isolates credentials by account-level `accessId`. The provider-level stable key was an unreleased intermediate M2 implementation with no migration designed for it; the Personal Coding Plan Key is obtained for the current account, the Team Key per account and organization/project.
- Created Models fix the old `accessId`. After an account switch they cannot silently use the new account's credentials; a new Agent Loop creates a new Model from the latest Account Config.
- Account Provider Config, Usage Source, Credential Store, and Request Auth share the same connection identity.
- Request Auth looks up credentials by `accessId` and also verifies the credentials' owning account. An old Model's `accessId(account-A)` cannot be combined with post-switch `credential(account-B)` to initiate requests.

## 7. desktop-attached remote Uses Remote Provider Authority

> Decision Status: Confirmed; step one incorporated into M2.8, continuous sync and remote settings operations as subsequent features

Online `desktop-attached-remote` was read by Desktop from the local complete Provider Registry Snapshot and sent to the Remote Host/Worker via `workspace/updateProviderRegistry`. The Snapshot carried API Key, JWT, Team Plan Key, and Header, and the remote Agent's startup gate read the Desktop base Host's model View. Earlier framing ("how does Remote Worker cross-host request Desktop Account Request Auth", via Renderer relay or Host-to-Host Auth Broker) both assumed Remote Worker belongs to the Desktop Provider Environment.

### Decision

The Remote Environment is an independent Provider Environment with its own Config, Credential, Account Source, Registry, and ModelFactory. Desktop only remotely controls the Session, displays the Remote View, and submits ModelSelection; it does not provide the Remote Worker's Provider facts or request credentials.

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

Step one switches runtime authority and deletes Desktop → Remote injection of the complete Registry, runtimeModel, Account Config, and Secret Snapshots. If the Remote Environment has no available configuration, the product must clearly report that the remote has not yet configured a Provider and must not fall back to Desktop facts.

Step two uses independent sync functionality to continuously write local Config and Credential to the Remote Store. The sync function is only responsible for Provisioning; the Remote Source listens to its own Store, publishes a new revision, and rebuilds the Remote Registry. Registry objects, Account Overlay, Model, and request Headers are not transmitted over this sync link.

Step three lets the App directly call Remote Settings / OAuth Service, remotely editing Remote Personal Config, initiating remote login, and viewing Remote Settings / Selection View. Credential exchange and persistence happen in the Remote Environment.

### Implementation Impact

- The `desktop-attached-remote` special case disabling its own Provider Registry authority is deleted.
- Remote Workspace readiness, model menu, and settings read the Remote Facade.
- The Remote Worker creates long-term Models only from the Remote Registry.
- Remote Request Auth reads only the Remote Credential Store.
- Renderer Auth relay and Host-to-Host Auth Broker topics are deleted.
- `provider/updateAccountConfig` is used only between Host and Worker within the same Environment.
- Local-to-remote continuous sync and App remote settings capability do not block step one's authority switch.

## 8. Usage / Entitlement Exits Old Provider Config and Provider Service

> Decision Status: Confirmed and implemented; Usage has exited the old Provider Service, internal abstraction to be organized subsequently

Product behavior is unchanged: the settings page Usage lists the Personal Coding Plan and all subscribed Team Projects the current account can query, viewable separately; the sidebar and Composer show only the quota of the current model connection.

The source list is already produced by Account Config, Entitlement, and Team Products in `ProviderSettingsView`, but Host's `BigModelUsageQuotaProvider` still read old `ModelProviderService.getAllCached()`, re-found the Provider in `ModelProviderConfig[]`, determined enabled state, read the API Key, inferred the request address, and refreshed the Coding Plan Key — keeping the old Provider object, already exited from the UI main chain, as Usage's execution fact source and blocking deletion of old Config and old Provider Service.

### Decision

Usage / Entitlement exits old `ModelProviderService`, old `ModelProviderConfig`, and old Config. The migration's first goal is to flatten the fact source: once the call chain fully uses new Provider Config, Account Config, and Credential facts, do not retain old dependencies waiting for a final Usage domain abstraction; internal responsibility issues found afterwards can be refactored independently.

When the UI has already selected a Usage Source, the request carries complete, non-sensitive source identity:

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

Host no longer selects sources from old Provider arrays. Whether a Provider is used for model selection, is selectable in the Registry, or which model the current Session uses are not filtering conditions for the settings page Usage Source. When an Account Provider disables model entry for the user, Usage can still be queried as long as the account connection exists.

A regular API Provider that still needs to participate in monitor/usage queries reads only the new Effective API Provider Config; an Account Provider's Secret is always obtained by the request-period Credential/Account service. Any migration adapter may project narrow input only from the new Config, Account, and Credential facts, never reading old Config or old Provider Snapshots.

Known Account Plan Usage routing keeps the existing providerId/family and service address construction logic in this round, but no longer guesses account plan type from the model Endpoint. Whether Usage routing further enters Official Config is left to the Usage domain's later refactoring and does not block the old Provider fact source exit.

### This Round Implementation Boundaries

- Add `accessId` to Coding Plan Usage / Entitlement requests; preserve the existing Team organization/project context.
- Delete the `IModelProviderService` dependency from `BigModelUsageQuotaProvider`, along with `getAllCached()`, `refreshCodingPlanApiKey()`, and `ModelProviderConfig[]` reading.
- Personal, Team, and Start Plans reuse the existing Credential Store, Team Key Resolver, and OAuth Token Store; no new Secret cache copies.
- Maintain settings page, sidebar, Composer, plan reset, and existing cache refresh behavior.
- This round does not require a perfect, general Usage Source/Authorization framework; after flattening, split `BigModelUsageQuotaProvider` separately if it still mixes too many responsibilities.

Completion criterion: when old Provider Config and the Provider Service are deleted, Usage / Entitlement no longer blocks and does not reintroduce an old fact source through compatibility fallback.

## 9. Provider Access, API, and Model API Adapter Layering

> Decision Status: Partially replaced; Provider `access/api` layering remains valid, `ModelConfig.apiAdapter` withdrawn by decision item 11

Previously Provider Config used a single `kind` to express both API Key and account access, with `apiFormat` and `baseURL` flattened on the Provider, and `reasoningMapping` sitting directly on ModelConfig — mixing "how to obtain calling qualification", "which public API to use", and "what fixed adapter behaviors the model has on that API" into one layer.

### Decision

Provider Config splits into two orthogonal sub-configurations:

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

The discriminant field is uniformly `type`. `access` expresses the calling-qualification source; `api` expresses the public request protocol; the internal Adapter type remains an execution implementation and does not enter external Config. The old `kind/apiFormat/baseURL` structure converges into `access/api`; Official, Personal, and Account keep using the same ProviderConfig Overlay, with the Account layer supplementing only account connection and current model members, never persisting request credentials. Schema versions used on the development branch are not a release contract; the final version number is handled by item 10.

This item also initially converged model-and-API fixed behaviors into a `ModelConfig.apiAdapter` wrapper (carrying `reasoningMapping`, `preserveThinking`, `reasoningContentField`, matched via `providerMatch`/`modelMatch`/`apiMatch` rules). Subsequent audits of AI SDK, GLM real interfaces, and vendor Anthropic-compatible interfaces showed that wrapper mixes inherent protocol behaviors, vendor reasoning parameter mapping, and message replay; the decision was withdrawn — see item 11 for the current design.

GLM-5.2 and GLM-5.3's Anthropic API use standard `adaptive thinking + effort` expression and send no budget. The interim conclusion in this item that GLM-5-Turbo retains a 1024 fixed budget was withdrawn by items 11 and 13.

## 10. Personal Config Keeps the Original Path and Ships as Schema Version 1

> Decision Status: Confirmed; supersedes the independent file path and version migration chain from the development phase

The M2 development phase wrote new Personal Provider Config to an independent `provider-config.json` and used internal Schema versions v1–v4 consecutively, preparing v5 for the next structural change. This allowed validating adjacent version migrations during development, but those formats were never released and need not become long-term maintained historical versions.

Desktop's formal user model Provider configuration already lives at `~/.zcode/v2/config.json`. Creating a new `provider-config.json` would change the user's familiar physical path and create authority switching between two files; the final architecture does not need to express domain boundaries through a file name.

### Decision

Personal Provider/Model Config continues to use the original `config.json` file name and path; no formal `provider-config.json` is introduced:

```text
Old format ~/.zcode/v2/config.json
        |
        | Full backup before migration
        v
Same path ~/.zcode/v2/config.json
└─ New ProviderConfigDocument
```

Before migration begins, the user's original configuration must be completely copied as a backup in the same directory. Successful backup is a prerequisite for modifying the original file; backup failure stops the migration without overwriting the original configuration. The backup must not silently overwrite existing backups; specific suffixes and conflict naming are up to the Repository implementation.

When completing M2 and preparing the first release, the new Provider Config document uses:

```json
{
  "schemaVersion": 1
}
```

The v1–v5 from development are unpublished intermediate formats. At M2 closeout, the long-term compatibility branches and public version narratives reserved for them are deleted, and the final complete Schema becomes the formal v1. Subsequent real post-release format changes migrate from v1 to v2.

This decision requires no lossless compatibility for the Standalone CLI history format that is not officially open. Internal evaluation users can adjust configurations; if an Entry migrates existing files, it must follow the data-safety order of "backup first, then atomic replacement".

## 11. Withdraw Model API Adapter Config Layer, Reasoning Mapping Directly Belongs to ModelConfig

> Decision Status: Partially supplemented by items 12 and 13; the withdrawal of `ModelConfig.apiAdapter` remains valid, the required conditions and semantics of `reasoningMapping` follow item 12, and GLM-5-Turbo's specific tiers follow item 13

Item 9's decision added `apiAdapter` to `ModelConfig` to carry `reasoningMapping`, `preserveThinking`, and `reasoningContentField`. Subsequent audits confirmed the three are different concerns:

- `reasoningMapping` describes how the user's selected Reasoning tier forms the request parameters required by a specific Provider/Model/API.
- Anthropic Thinking Block, Signature, and OpenAI Responses Reasoning Item saving and replay are inherent behaviors of their protocols.
- GLM OpenAI Chat's `clear_thinking` is a specific request parameter that can directly be `reasoningMapping` output.

AI SDK already converts `reasoning_content` between OpenAI Compatible messages and standard Reasoning Parts, and the Anthropic Adapter handles protocol replay of Thinking Blocks and Signatures, so the config layer no longer declares response field names or restates message replay strategies. Vendor Anthropic-compatible interfaces have a fairly unified base Messages structure but ununified Reasoning control — DeepSeek, Kimi, MiniMax, Qwen, and MiMo each use different switches, tiers, or budget semantics. `reasoningMapping` therefore stays valuable, but as a protocol parameter mapping selected by Model Config Rules, not an independent Model API Adapter config object.

### Decision

The unpublished `ModelConfig.apiAdapter` and `ModelApiAdapterConfig` are withdrawn. `ModelConfig` stays flattened, with optional `reasoningMapping` directly inside it:

```ts
class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  reasoningMapping?: ReasoningMappingConfig | null;
}
```

`ModelConfigRule.apiMatch` is retained. Together with `providerMatch` and `modelMatch`, it decides which Provider, model, and public API a `reasoningMapping` applies to; rules execute in order, later matches overriding earlier ones. The runtime Provider Adapter continues to exist; this withdrawal removes the `apiAdapter` wrapper in the config Schema and does not change the execution boundaries of the Anthropic, OpenAI Responses, and OpenAI Compatible Adapters.

Item 12 further confirms: the Reasoning parameter mappings for standard OpenAI Responses, Anthropic Messages, and OpenAI Compatible are explicitly provided by Official Config. The runtime Adapter stays responsible for protocol execution and message replay, with no hidden default strategy generating request parameters from `reasoningLevel`.

`preserveThinking` and `reasoningContentField` exit the target Config:

- The `clear_thinking` needed by GLM OpenAI Chat is written directly into the corresponding tier's `reasoningMapping`.
- Reasoning content parsing and replay are done by the message model and Adapter, not by Config specifying field names.
- Historical DeepSeek/MiMo empty `reasoning_content` compatibility patches continue to be audited separately, not expressed through these fields.

GLM-5.2, GLM-5.3, and GLM-5-Turbo all use adaptive thinking and send no fixed budget; GLM-5.2 and GLM-5.3 follow their official effort tiers, GLM-5-Turbo's specifics follow item 13. GLM-5-Turbo has been verified against the BigModel Coding Plan real interface, covering single request, current AI SDK parsing, Tool Call, Thinking Block, Signature, and second-round replay after Tool Result. The interim conclusion to retain a `1024 fixed budget` for GLM-5-Turbo in item 9 is withdrawn.

## 12. Reasoning Mapping is a Required AI SDK Provider Options Mapping

> Decision Status: Confirmed; when a model declares `reasoningLevel`, complete `reasoningMapping` must be provided

ZCode internally uses AI SDK to call models; OpenAI Responses, Anthropic Messages, and OpenAI Compatible each run on their corresponding AI SDK Provider. Users select a unified `reasoningLevel`; `reasoningMapping` converts the tier into the Options received by the current AI SDK Provider:

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

When `ModelConfig.optionSpecs.reasoningLevel` declares selectable tiers, the finally effective `ModelConfig` must simultaneously provide `reasoningMapping` covering all selectable tiers. Default mappings for standard APIs are also written into Official Config, not hidden in Adapter code. For example:

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

`reasoningMapping[level]` is the inner object of AI SDK Provider Options related to Reasoning, passed to the current runtime Provider Adapter. It contains no AI SDK namespaces such as `openai` or `anthropic`, and is not the final HTTP Request Body. The runtime Adapter places it into the correct Provider Options namespace based on the current API type, and the AI SDK Provider encodes it into actual protocol fields.

`reasoningMapping` belongs directly to `ModelConfig` (see the type in item 11) and carries only Reasoning-related Provider Options, such as `reasoningEffort`, `effort`, `thinking`, `enable_thinking`, and `clear_thinking`. API Keys, Headers, Base URLs, and other model request parameters do not belong to this mapping.

## 13. GLM-5-Turbo Only Provides Thinking Switch

> Decision Status: Confirmed; supersedes the "GLM-5-Turbo uses effort" portion of item 11

Zhipu's official documentation states that GLM-5-Turbo supports `thinking.type = enabled | disabled`, default enabled; when enabled, the model dynamically decides whether to think. Formal `reasoning_effort` support starts from GLM-5.2 and does not include GLM-5-Turbo. A real interface accepting a parameter does not make that parameter part of the model's public contract.

GLM-5-Turbo's `reasoningLevel` therefore includes only:

```text
enabled
disabled
```

The OpenAI Compatible API mapping uses `thinking.type`. ZCode, as a long-chain Coding Agent, also sends `clear_thinking: false` when thinking is enabled, and the message model and Adapter fully and verbatim replay historical `reasoning_content` in order. This behavior is fixed protocol configuration, not exposed as a user Option.

The Anthropic Messages API mapping is `adaptive` and `disabled`. When enabled, send no `effort` — the server applies its default reasoning strategy — and send no fixed budget. The `budgetTokens: 1024` previously used for old AI SDK compatibility does not enter the new Official Config.

GLM-5.2 and GLM-5.3 continue to provide effort tiers within their respective official support scopes, unaffected by this decision.

## 14. Idle Tasks Use Builtin Provider and Per-Turn Authentication Materials

> Decision Status: Confirmed; normal Account authentication and idle task authentication use different source boundaries

### Background

Idle tasks were assembled by the Host before each dispatch as a `turnRuntimeModel` carrying both the Provider/Model static configuration and the API Key, Ticket, and Headers for the current execution. The Core Worker temporarily added it to the Registry Overlay, created an execution Model for the Turn, then restored the previous Runtime Model and cleaned up the Overlay. The chain had per-Turn fixed-authentication-snapshot semantics, but it assembled and transmitted static Provider facts together with dynamic authentication material, relying on temporary `setModel`/restore logic.

### Decision

Normal Account Provider authentication takes its fact source from the Core Worker / CLI process's own Account Request Auth Service. The Host and other Entries submit only `ModelSelection`; they do not pass or override a normal Account Provider's API Key, Headers, Provider Config, or Model Config with the Submission. The CLI creates Models from its own Registry and obtains the current connection's dynamic credentials through its own authentication Service when the real request occurs:

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

The current Desktop Worker obtaining normal Account authentication material through protocol callbacks to the Host is a migration chain to be exited; it is not a second fact source in the target architecture.

The idle task's Provider becomes a Builtin Provider managed by Official Config. Its Provider identity, API type, Base URL, model list, Model Properties, and Option Specs enter the formal Registry. It is used for idle task execution and does not appear in normal model selection or settings interactions.

When the Host dispatches each idle Turn, it additionally passes only the dynamic authentication material for the current execution:

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

The Core Worker creates a normal `Model` from the Registry's Builtin Provider, the current `ModelSelection`, and the passed material, explicitly handed to the current Agent Loop; the Loop's Model Steps and auto-Compact keep using the same Model and material.

Authentication material is not written to Official Config, Personal Config, Registry View, or Session persistence. It is valid only for the current Turn and must not be used by subsequent executions after the Turn ends. The idle Model also does not modify the user's Session Model Selection or App Recent.

### Ticket Expiry and Continuation

The current `3102` Ticket expiry semantics are retained:

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

This is a new Turn / Agent Loop for the same idle task and same Session, not a Ticket replacement inside a running Model. Normal JWT or API Key authentication failure does not automatically equal `3102`; whether it needs automatic continuation is outside this decision's scope.

### Execution Model Switch Banner

The model switch banner is determined by the Model actually used by adjacent execution segments. Each Agent Loop holds its own Execution Model; the Guide switching Models within the Loop forms a new execution segment. When a new execution segment begins, compare its `providerId/modelId` with the previous segment's: different identities display the model switch banner; identical identities display none. A reasoning-tier change alone is not a model identity change.

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

Idle models enter the execution model sequence by the same rule, with no idle-task-specific banner state:

```text
Normal Turn A
    |
    v
Idle Turn Idle       -> A vs Idle differ, display A -> Idle
    |
    v
Next normal Turn B   -> Idle vs B differ, display Idle -> B
```

If no new execution segment begins after the idle task ends, the system does not preemptively display "restore to A": no Model is executing, and the banner is generated from the actually created A or B after the next round truly creates one. When the user changes the Session Selection from A to B during the idle task, the timeline naturally shows `Idle -> B`, without passing through an A that never truly executed.

Session Model Selection only creates Models for subsequent execution; it is not the banner's fact source. Each Turn persists the actual Execution Model identity; real-time projection and cold recovery derive banners from the same execution sequence. `lastExecutionModel` represents only the previous actually executed model and does not carry Session Selection's persistence state.

The banner uses an explicit public entry:

```ts
recordExecutionModelChangeMarker({
  modelRef: activeModel.modelRef,
  traceContext,
});
```

This entry only compares this Session's current Execution Model with `lastExecutionModel` and persists a `model_change` Marker when `providerId/modelId` changes. It is called when the normal main Agent Loop starts, the idle main Agent Loop starts, and the Guide's new Model truly takes effect from the next Model Step. Subagents reusing this entry write only to their own Child Session; Title, Memory, Wiki, Verifier, and other independent model tasks do not call it. The entry creates and switches no Models and modifies no Session Selection, Provider Config, or Registry.

The Execution Model takes effect when the Model is successfully created and formally enters the main Agent Loop, or when the Guide formally enters a new Model Step; call `recordExecutionModelChangeMarker()` at that point. If Model creation fails, or Submission is blocked by admission, hooks, or other boundaries before entering the Agent Loop, no new execution model baseline is established. After entering the Loop, even if cancelled before the first Model Request is sent, this Model is still the Execution Model that took effect in this segment and can produce a banner.

`3102` resumption is a new Turn of the same idle task. If the new Turn keeps using the same Idle Model, the execution model identity does not change and no intermediate banner appears; the next execution segment truly started after the whole idle task is compared with Idle.

### Authentication Boundaries

Idle tasks do not extend the normal Account Request Auth Service's responsibilities. They reuse the Builtin Provider's static facts from the CLI Registry; if the CLI cannot yet naturally obtain the full set of dynamic material the idle service needs, the Host may pass execution-scoped Request Auth with the current Turn — an input expressing only this execution's authentication material and Ticket, never Provider or Model static config. If the CLI can later naturally obtain JWT, Coding Plan Key, and other material, the Host's input can be narrowed further; that optimization changes no confirmed boundary and does not block the current migration. Off-Peak Tickets are obtained by the Host scheduling service and keep being passed with the current Turn.

Execution-period authentication must satisfy:

- Normal Account Providers always use the CLI Account Request Auth Service and accept no external authentication override.
- Idle tasks allow the Host to pass API Key, Headers, and Tickets with the current Turn.
- Authentication material between different Turns and concurrent executions must be isolated.
- A Model uses fixed authentication material within one Agent Loop.
- After the Turn ends, fails, or is cancelled, the current authentication material must leave the available state.
- Providers and Models keep executing through the unified ModelFactory and Adapter chain; no idle-task-specific model request protocol is established.

## 15. After Process Registry is Enabled, Old Workspace Catalog Exits Provider Authority

> Decision Status: Confirmed and completed

The process Registry builds Providers and Models from Official, Personal, and Account Config. If the old Workspace Catalog kept participating in member judgment, property synchronization, or projection merging, the Host Snapshot would again become a second fact source. This cannot be deferred merely because the code lives in the old protocol compatibility layer; anything affecting normal long-term Providers is within M2's current high-priority closeout scope.

The confirmed boundary:

```text
Process Registry is enabled
├─ Provider / Model members        -> Registry View
├─ Model Properties / Options      -> Registry Model
├─ Model switch availability       -> App Registry View
├─ Context window of current exec  -> Current App Runtime / Model
└─ Provider revision               -> No longer use old Workspace Catalog revision

Workspace Settings
└─ Workspace default / last-used / mode and other interactive states
```

The `runtimeModel` carried by the old protocol with the Host is no longer written to the Workspace Catalog in the Registry process, nor used to supplement normal long-term Providers. The migration-period idle `runtimeModel` is narrowed by subsequent slices to ModelSelection, Request Auth, and Tickets; it is no reason to retain normal Workspace Provider Snapshots.

Implementation principles confirmed by this item:

- `syncAppWorkspaceModelCatalog()` installs no old Overlays and overwrites no Runtime in process Registry mode.
- App initialization generates no `bootstrapModelConfig` from the old Workspace Catalog.
- Session preflight and cross-Provider switches determine current members from Registry-backed `app.listModels()`.
- `workspace/readState` returns only `settings.model`; the old `modelCatalog` protocol fields, Provider projections, and revision are deleted.
- The App no longer exposes `setModelCatalogOverlay` and saves no Workspace-level Provider/Model Overlays; idle and other single executions still enter through independent Turn Overlays and do not restore long-term Workspace Catalogs.
- `createZCodeApp` must inject the process Registry; tests and internal tools use explicit test Registries, not old Runtime Model Config assembly through omitted optional parameters.
- Cold recovery usage's context window uses the model properties already fixed by the current App Runtime.
- `workspace/readState` is a pure projection interface: it accepts no `runtimeModel` and modifies no Active Session.
- `workspace/setDefaultModel` writes only ModelSelection and accepts no Provider runtime snapshots.
- V4 `createSession` and `switchModelConfig` submit only ModelSelection; the target Provider is validated by the Worker Registry, with no Host `runtimeModel` fallback.
- The Repo Snapshot bypass uses only the Selection or execution-scoped Model explicitly carried by the current command; when missing, allow model metadata to be empty instead of guessing the Provider from `workspace/readState`.
- default, last-used, mode, and other selection/interactive states can remain in Workspace Settings, converged later by Interaction design, never mixed with Provider static facts.

Cleanup unrelated to the current Registry Authority can be deferred — deleting caller-less old hot-update helpers, refactoring idle authentication, atomic Submission, and Guide/Loop-switch semantics. The criterion is whether it reduces the current dual-track, not which phase it was originally marked for.

## 16. Product Semantic Retrospective for M1/M2 Autonomous Decisions

> Decision Status: Confirmed

Five autonomous decisions from implementation and review are formally recognized by product semantics.

### Model Properties are a Unified Check before Request Sending

Callers can read Properties in advance to choose execution strategies; the Model still checks the actual Request before sending. When a model declared as unsupporting is used for images, PDFs, videos, Tool Calls, or Structured Output, the Model returns a clear error.

The target Registry's ModelConfig must be complete, with no `unknown` retained. The image, PDF, and video fields currently allow `undefined` only because default configuration and user settings capabilities are incomplete: during the transition, only explicit `false` blocks requests, and default values pass through temporarily. After the corresponding configuration migration completes, the fields become required and this compatibility semantics is deleted.

### Independent Model Tasks Continue Existing Reasoning Behavior

Title, Git Commit Message, and Memory Selector had closed reasoning before the refactor and continue using the derived Model with reasoning closed. The refactor does not change these tasks' product strategies and does not let them bypass Models to modify Provider parameters directly.

### Account Queries Per-Provider Retain Last-known-good

Remote queries for Start Plan, Personal Coding Plan, and Team Plan each produce `available`, `unavailable`, or `unknown`. When one channel is `unknown`, retain the previous successful result for that Provider only; other Providers' already-obtained definite results continue to be published. Explicit `unavailable` deletes the corresponding Provider.

### Target Design Does Not Retain Temporary Providers

Idle tasks select Official Builtin Providers from the CLI Registry and receive the necessary Request Auth and Off-Peak Tickets with Turns. Submissions carry no complete ProviderConfig or ModelConfig. The idle `runtimeModel` still present in M2 is a compatibly narrowed input, not a new fact source.

### Account Provider's User-visible Behavior Remains the Same

The refactor maintains the current number of Providers, Personal/Team connection switching, and model visibility, without introducing new product forms such as multiple Teams and Personal simultaneously appearing in the model selector. Internal convergence of Config, Registry, and Request Auth must not change this behavior.
