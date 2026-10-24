# Provider Refactor Core Design

> Status: Current design. Final architecture and invariants only; migration history is not restated. For
> sources and contradiction rulings see [`evidence-and-contradictions.md`](./evidence-and-contradictions.md).

## 1. Purpose

The Provider config system assembles the user's choice and configuration for a model API into an executable
model call. It answers:

- Which Providers exist and what models each has;
- Which API Schema, Endpoint, and access method each Provider uses;
- What static capabilities models have, which options they accept, and how logical options map to protocol
  parameters;
- How current account and user config affect the final Provider;
- Which Provider, Model, and Options a submission ultimately uses;
- Which facts win when config updates, account refreshes, and execution concurrency collide.

It is not a unified credential center or the final authorization party. API Key Providers save API Keys
directly; Account-type Provider Config only describes static access types; login tokens, Team Project Keys,
Start Plan JWTs, and Off-Peak Tickets are obtained by account and execution-period services. Model servers
make the final authorization ruling per request.

## 2. Core Principles

### 2.1 One Config Fact, Two Resolution Paths

Provider and Model configs solve different problems and merge at the same model identity:

```text
Provider Config Path                              Model Config Path
====================                              =================

Provider Templates + Account Providers            ZCode Built-in Model Config Rules
                |                                                  |
                v                                                  +
      Account Provider Config                      Personal Model Config Rules
                |                                                  |
                v                                                  v
      Personal Provider Config                     Effective Model Config Rules
                |                                                  |
                v                                                  |
      Effective Provider Config                                 |
                |                                                  |
                +-----------------------+--------------------------+
                                        |
                                        | providerId / modelId /
                                        | api.type / baseUrl
                                        v
                              Effective Model Config
                                        |
                                        v
                         Completeness, enable status, and execution eligibility
                              |                       |
                              v                       v
                    Provider Settings View      Provider Registry
                                                        |
                                                        v
                                                 ModelFactory
                                                        |
                                                        v
                                                Immutable Active Model
                                                        |
                                                        v
                                                    Adapter
```

The Provider path determines which Providers exist, their member models, and API access. The Model Rule path
determines model capabilities and option-protocol mappings. Do not duplicate a second model capability fact
for settings pages, idle tasks, connectivity tests, or any Adapter.

### 2.2 Overlays Are Sparse Intent, Effective Is Resolution Result

Provider effective order is fixed:

```ts
effectiveProviders = resolveProviderTemplates(
  zcodeBuiltinProviderTemplates,
  zcodeBuiltinAccountProviders.overlay(accountProviders),
  personalProviders,
);
```

- ZCode Built-in provides ordinary Provider Templates and Account Provider static baselines;
- Account only projects dynamic constraints from account connections and plans;
- Personal takes effect last, expressing explicit user configuration;
- `undefined` means this layer does not override, `null` means this layer explicitly clears, concrete values
  mean explicit override;
- Overlays themselves can be incomplete; only Effective Configs entering the Registry must be complete.

Model Rules are ordered Overlays. Builtin effective order:

```text
modelRules
    -> modelApiRules
    -> providerSiteRules
    -> templateModelRules
    -> builtinProviderModelRules
    -> Personal providerModelRules / manualProviderModelRules
```

`providerSiteRules` matches site behavior by specific Base URL; `templateModelRules` matches template members
and default `enabled` by `templateId + modelId` — they are not the same identity match. Personal Config only
allows precise override of a specific `providerId + modelId`; no global Match Rules are provided, read, or
written for Personal. All rules keep array writing order; no dynamic priority algorithms.

### Match Config Maintenance Principles (2026-09-10 ruling)

- Built-in Matches follow mainstream config and official capabilities; official takes priority. Do not lower
  known models' default capabilities for backward or incomplete third-party compatibility.
- Capabilities of known models under corresponding API Schemas go into model/model-API rules, using
  prefix/suffix matching. Do not default-disable just because access goes through a third-party proxy; if the
  proxy does not support it, users disable through specific-model Personal config override.
- Official priority does not mean all models of a brand support it: per-model and per-API-Schema support
  boundaries must be retained; one model's capabilities cannot be granted to all models via broad brand regex.
- Site-specific behavior goes in `providerSiteRules`, one rule per specific Base URL; different domains or
  endpoints are not merged via regex alternation. One rule may declare multiple confirmed capabilities for
  the same URL; rules that must split by model/API conditions stay separate. Canonicalized equivalent forms
  of the same URL (e.g. trailing slashes) can share one rule, but this must not relax to all site paths or
  arbitrary subdomains.
- Capabilities reach final Model properties only through the unified Overlay/Resolver; no runtime bypasses
  guessing capabilities by model name or domain.
- The generic Model baseline is `contextWindow` 1000000 and `maxOutputTokens.max` 128000 (2026-10-14). The
  latter is a capability ceiling, not the default request output length. Explicit differences for known models
  override it; Personal applies last. Declarations that duplicate these defaults with no earlier-layer
  difference to override are omitted; do not mechanically delete same-valued fields that override a smaller
  family baseline.
- Model / Model+API rules use simple prefix/suffix wildcards from a bounded maintained set (for example
  `.*deepseek-flash.*`), without requiring a suffix separator or date format. Literal escaping and meaningful
  model grouping are retained. Generic families come first, specific variants after, with no runtime
  auto-sorting. Site URL and Template/Provider exact-identity rules stay unchanged.
- Real differences of maintained models take precedence over formal uniformity: GLM-4.6's Messages mapping
  excludes vision models with `(?!v)`, so it keeps its protocol baseline. Historical `off/nothink` recovery
  identifies both old and new matchers but limits recovery scope to the old matcher; newly broadened
  suffixes do not gain historical alias eligibility; user files are not modified.
- Acceptance covers production/test config homology, unknown-model baselines across the three protocols,
  prefix/suffix aliases, base/specific variant inheritance, Site and Personal overrides, and explicit request
  output length remaining unchanged.

### 2.3 Builtin Provider Maintenance List

Daily maintenance starts from [Builtin Provider Template and Model Maintenance](../../../builtin-provider-maintenance/README.md).
[Current state](../../../builtin-provider-maintenance/current-state.md) records templates, full members, and
default enable/disable status per actual configuration; [scope principles](../../../builtin-provider-maintenance/scope.md)
and [configuration rules](../../../builtin-provider-maintenance/configuration.md) carry ongoing maintenance.
The old inventory below is kept for investigation history only.

Builtin maintenance scope is an entry inventory table, not a repeat of full Provider Config:

```text
Vendor | Type | templateId / providerId | Base URL | Product-maintained models
```

- Ordinary API entries fill `templateId`; Account entries fill specific `providerId`.
- Models in the table are actively maintained by the product; Template `builtinModelIds` holds the
  corresponding facts in config.
- No extra maintenance of model display names, model-owned Template duplicate fields, or Provider Site
  Catalogs.
- Historical models not in the vendor catalog table do not enter Builtin Templates; no compatibility
  migration.
- URL-specific rules exist only in config as `providerSiteRules`; they are not another vendor list.

### API Schema Selection Principles

Vendors may provide multiple API Schemas. Official templates prefer Anthropic Messages; only when the vendor
or a specific model/Endpoint does not support Anthropic, choose another Schema the entry actually supports
and has the most verification. Judge by template actual request evidence, not "OpenAI-compatible" marketing
labels. If different models on the same site need different Schemas, split template identities or first
propose an explicit per-model API config design; do not force different-protocol models into one fixed
`api.type`. Template-determined Schemas can still be overridden by more specific config per the existing
overlay order.

### Aggregated Provider Model List Principles

Aggregated vendor model lists may reference upstream vendor maintenance lists: upstream-maintained models,
as long as the aggregation site actually provides them, enter aggregation entries. For example, OpenRouter
model IDs may be `openai/gpt-5.6-sol` while the upstream ID is `gpt-5.6-sol`; that is only this vendor's
current naming correspondence, not a universal prefix rule for all aggregators, and requires no runtime
prefix stripping. Aggregation entries still maintain their own Model/API/Site config, because the same model
behind an aggregator may differ in protocol, capabilities, and parameter mapping.

### 2.3 Sparse and Complete Must Be Separate

Write boundaries receive sparse Config; execution boundaries receive only type-proven complete types. The
complete type is a type narrowing of the same Config, not a second DTO, nor a second Registry.

Model fields take the complete data schema from `@zcode/shared/model-config` as the sole source; the sparse
schema derives default/null-override semantics from the same fields. Constructed input, JSON output, and
Registry complete types use schema derivation; behavior classes only retain frozen, overlay, and
serialization behavior. Completeness checks reuse this schema — no hand-written second field/value-domain
check tables. Pure data schemas do not reference behavior classes, avoiding codec-class circular
dependencies. Provider/API/Access also come from `config/provider-data-schema.ts` as a single data contract;
CLI ModelProperties/OptionSpecs types and protocol media field projections derive from the shared Model
schema, not from Provider behavior implementations. The shared layer depends only on pure expression
compilers and contains no state or IO. Provider completeness strengthens only execution-required fields, not
all display/member fields; source write permissions derive from the same schema. Personal temporarily
retains incomplete endpoint boundaries; bad addresses only block that Provider's Registry admission. Rules
derive from `rule-data-schema.ts` by source; data files carry no memory-layer `type` identifiers, nor
re-guess rule hierarchy by field presence.

```text
Sparse Config / Rules
        |
        v
      Resolver
        |
        +--> Resolved candidates + issues  -> Settings
        |
        `--> Complete executable configs   -> Registry
```

Incomplete, disabled, or temporarily non-executable Providers/Models can be saved and displayed on settings
pages; they cannot enter the executable Registry.

### 2.4 Identity, Capability, Status, and Display Orthogonal

- `providerId + modelId` is model identity; the same `modelId` can exist in different Providers.
- No top-level `enabled` on Providers; Personal defines existence = belongs to Settings; Account Providers
  are fixed to corresponding Families.
- Completeness expresses whether facts needed to construct execution objects exist.
- `executable` is determined jointly by Account Access entitlement (account-type), Provider completeness,
  Model enable, and Model completeness.
- `selectable` adds Provider `visibility` on top of `executable`.
- `visibility` is a Provider display projection, not permission, auth, or completeness exemption.
- Models have no independent `visibility`; whether a model appears in ordinary selections follows its
  execution eligibility and Provider visibility.

### 2.5 Created Models Are Execution Facts

Registry is the directory for creating Models, not mutable state read continuously during an execution.
ModelFactory obtains complete Provider/Model config from the current Environment's Registry and creates
immutable Models. Later Config or Registry updates affect only subsequently created Models; they do not
silently alter running requests, Compact, Memory, or sub-agents.

## 3. Config Contracts

### 3.1 Provider Config

```ts
interface ProviderConfig {
  group?: "standard-personal" | "zai-family" | "bigmodel-family" | null;
  logo?: { type: "builtin"; key: string } | null;
  access?: ProviderAccessConfig | null;
  api?: {
    type?: "anthropic-messages" | "openai-chat-completions" | "openai-responses" | null;
    baseUrl?: string | null;
    headers?: Readonly<Record<string, string>> | null;
  } | null;
  builtinModelIds?: readonly string[] | null;
  personalModelIds?: readonly string[] | null;
  modelOrder?: readonly string[] | null;
  visibility?: "visible" | "hidden" | null;
}
```

| Field              | Meaning                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `group`            | Personal or Account Family grouping; not Access Mode                                                           |
| `logo`             | Display resource key; unknown key falls back to a generic icon                                                 |
| `access`           | Static method for obtaining access materials needed for calls                                                  |
| `api`              | Final API Schema, Base URL, and static Header                                                                  |
| `builtinModelIds`  | Model members owned by ZCode or Account layers                                                                 |
| `personalModelIds` | Model members owned by the Personal layer                                                                      |
| `modelOrder`       | User's total ordering intent for the final member set                                                          |
| `visibility`       | Whether the Provider enters ordinary settings/selection projection; does not affect internal exact Registry lookup |

Member sets preserve source: Built-in members first, Personal members last; duplicates within a single set
keep only the first; a Personal member with the same name as Built-in keeps Built-in identity and discards
the Personal duplicate. `modelOrder` only sorts existing members; it does not create models.

Instances outside rules: `{ providerId, templateId?, providerName?, config }`; templates:
`{ templateId, templateNameMap, config }`. Identity, inheritance, and names are not Config leaves. Templates
generate instance names at creation by current language → en-US → templateId, deduping within Personal file
locks. Thereafter only connection fields are modified; no inheritance names are written; explicit renames
write the outer `providerName` only; language changes do not change saved names.

### 3.2 Provider Access

The formal Access union has only two types:

```ts
type ProviderAccessConfig =
  | {
      type: "api-key";
      apiKey?: string | null;
      apiKeyManagementUrl?: string | null;
    }
  | {
      type: "zhipu-account";
      accountType?: "zai" | "bigmodel" | null;
      mode?: "start-plan" | "individual-coding-plan" | "team-coding-plan" | "off-peak" | null;
      entitled?: boolean | null;
    };
```

`group`, `accountType`, and `mode` do not duplicate each other:

- `group` is the Provider's static product grouping;
- `accountType` is the Zhipu account system access identity;
- `mode` is that account Provider's access mode.

`entitled` is the single config fact for whether the current account holds that fixed Account Product
eligibility. No top-level `enabled` on Providers. `zhipu-account` Config does not save account connection
IDs, product IDs, organization/project Scope, tokens, or request security verification protocols. Account
runtime protocols may still carry `planKind`, `productId`, etc.; those belong to accounts, plans, or
request-time context, not Provider Config Schema.

### 3.3 Model Config

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: {
    requiresMfjsToolSchema?: boolean | null;
    contextWindow?: number | null;
    inputFormat?: {
      supportsText?: boolean | null;
      supportsImage?: boolean | null;
      supportsVideo?: boolean | null;
      supportsAudio?: boolean | null;
      supportsPdf?: boolean | null;
    } | null;
    outputFormat?: {
      supportsText?: boolean | null;
    } | null;
    supportsToolCall?: boolean | null;
    supportsJsonSchemaOutput?: boolean | null;
    supportsNativeWebSearch?: boolean | null;
    supportsMidConversationSystem?: boolean | null;
  } | null;
  optionSpecs?: {
    reasoningLevel?: EnumOptionSpec | null;
    maxOutputTokens?: LimitOptionSpec | null;
  } | null;
}
```

These fields use the same names and nested structure from Config, Registry, cross-process protocol, to
Active Model. Runtime does not derive `supportsImages`, capability maps, or a second media DTO.

Effective Model Config must complete:

- `enabled`; MFJS is `properties.requiresMfjsToolSchema`, not saved redundantly at ModelConfig top level;
- Complete `properties` and all input/output format leaves;
- The `maxOutputTokens` Option Spec and its complete `map`;
- The `reasoningLevel` Option Spec with a non-empty ordered `values` and complete `map`; non-reasoning models
  use `values: ["disabled"]` and empty Patch `map: "{}"`.

`reasoningLevel` persists only `values`/`map`; `maxOutputTokens` only `max`/`map`; member names already
determine option forms; no duplicate `type: "enum"/"limit"` is persisted. This does not affect Provider
API/Access union-type discriminators.

Specific model reasoning behavior is expressed only by Model Config Rules; production Runtime does not
hardcode thinking intensity, request patches, or replay strategies by model ID. Each Option Spec's restricted
CEL `map(value)` directly generates the final raw Request Body JSON Merge Patch; Adapters apply the same
mapping after AI SDK generates the base Body and before request security checks, and own protocol encoding
and its real encoding capability boundaries.

### 3.4 Model Config Rules

Rule belonging sets express hierarchy; records within files no longer duplicate `type`:

| Set                               | Match Identity                                   | Content                                            |
| --------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| modelRules                        | modelMatch                                       | Sparse ModelConfig                                 |
| modelApiRules                     | modelMatch + apiTypeMatch                        | Sparse ModelConfig                                 |
| providerSiteRules                 | modelMatch + baseUrlMatch, optional apiTypeMatch | Sparse ModelConfig                                 |
| templateModelRules                | templateId + modelId                             | Sparse ModelConfig                                 |
| builtinProviderModelRules         | providerId + modelId                             | Sparse ModelConfig                                 |
| Personal providerModelRules       | providerId + modelId                             | Smart config precise overrides                     |
| Personal manualProviderModelRules | providerId + modelId                             | Complete manual config; only enabled inherits/null |

Strict schemas for the three Match types reject cross-layer conditions and `providerMatch`. Regex is
whole-string match; model names are case-insensitive; URLs use normalized values; each set preserves array
order. The same identity cannot be in both smart and manual sets. Manual config inherits no other
parameters; only `enabled` keeps its independent enable/disable semantics; all required nested leaves and
expressions are validated jointly on save.

## 4. Resolution, Settings Projection, and Registry

### 4.1 Resolver Is the Sole Convergence Point

The Resolver is responsible for:

1. Allowing the Account Overlay to act only on ZCode Built-in Providers;
2. Computing `Built-in → Account → Personal` Effective Provider;
3. Composing Effective Model Rules;
4. Resolving final model members, sources, and ordering;
5. Parsing Effective Model Config for each `providerId/modelId/api.type/api.baseUrl`;
6. Separately computing issues, enabled, entitled, executable, and selectable;
7. Producing settings candidates and the Registry executable set simultaneously.

Renderers, Usage UI, plan cards, ModelFactory, and Adapters must not re-implement this Overlay or member
derivation.

### 4.2 Settings View and Registry Are Two Projections of Same Resolution

```text
                    ProviderConfigResolution
                      /                 \
                     /                   \
       resolvedProviders                 registryProviders
       Complete + incomplete candidates  Only complete executable items
              |                                  |
              v                                  v
    Provider Settings Facade               Provider Registry
```

The Settings View retains:

- Effective Provider;
- The Built-in baseline after Account takes effect;
- The Personal Provider Overlay;
- Each model's Effective, Effective Built-in, and Personal precise overrides;
- Completeness issues and execution status.

The settings page can therefore edit or fix pre-Registry configuration. The Registry retains only enabled,
complete Providers with at least one executable model, and their executable models.

### 4.3 Account Provider Config

Account Provider Config is a formal Provider Overlay projecting only account upstream facts onto Built-in
account Providers:

```text
Account login, Family selection, plan selection, entitlement interfaces
                    |
                    v
       Account Connection Resolver
       ├─ providerId
       ├─ entitled / not-entitled / unknown
       `─ Account model sets explicitly returned by server
                    |
                    v
         Account Provider Config
       └─ access
          ├─ type / accountType / mode (inherited from Built-in)
          ├─ entitled
          `─ builtinModelIds (if server returns)
```

Rules:

- Account Providers declared by Built-in are fixed and enter the corresponding Family;
- When the current account explicitly owns the product, write `access.entitled=true`; when explicitly not
  eligible, write `false`;
- Individual / Team default to Built-in model members;
- Start Plan models vary by account; on success, constrain `builtinModelIds` to the interface-returned model
  set;
- Start Plan without a reliable model set keeps the previous available Account Overlay; first-time with no
  available facts fails closed;
- Temporary query failures (`unknown`) keep the previous Account Overlay to avoid flicker; first-time with no
  historical facts fails closed;
- Dynamic credentials are not written to Account Provider Config.

Account State's optional `unavailableReason` travels with the same snapshot; Host and CLI strict protocols
share reason schemas. A Personal plan server explicitly reporting no entitlement displays unactivated;
logged-in but Key fetch failure displays fetch failure and reuses the manual refresh retry — do not infer
OAuth failure from a missing Key alone or force re-login. Z.ai and BigModel use consistent classification.
Reasons are runtime facts only, never written to Provider Config; rulings and verification per
[Todo114](../steps/todo-114-account-status-sync-and-key-retry.md) (upstream original Todo105).

Account and Built-in revisions must pair. When Built-in is updated but Account still uses the old revision,
the Registry keeps serving the previous complete snapshot, awaiting Account Source recalculation and atomic
publishing; "new Built-in + old Account" intermediate states are not published.

### 4.4 Settings Page Does Not Understand Account Overlay

The settings page consumes the final Effective Provider/Model from the Provider Settings View; it does not
read, replay, or infer the Account Overlay. Plans, quotas, connection errors, and purchase status are
independent product projections controlling only status cards and their actions; they cannot decide whether
the Effective Provider config area, model lists, or model editor entries exist.

Individual / Team Coding Plans may hide Endpoint and API Schema in product UI; the fields still fully exist
in Effective Provider Config, consumed by Registry, ModelFactory, and Runtime. Hiding is a display decision,
not an Account DTO after field deletion.

This page closure was completed by Todo 32: Team/Individual details are resolved precisely from the Provider
Settings View by `providerId`; plan status cards no longer control whether the Provider config area and model
lists exist; pages hiding Endpoint/API Schema do not delete Effective Provider Config.

### 4.5 Start Independent Provider (Todo154)

2026-09-16 user ruling: Start reuses the current App login, needs no separate connection, and is
simultaneously usable with current personal/team plans; it does not start Todo101's personal/multi-team full
coexistence.

- Retains the two Start Provider IDs, unified display names, and per-brand Z.ai/BigModel logos: filtered by
  current brand, displayed independently in the existing "Zhipu" grouping, reusing details minus
  connect/disconnect. No virtual Providers, ID merging, or display identity mapping.
- Retains "current" as matching the current account access context. Start does not depend on paid selection;
  personal/team still do. Start and one paid plan may both be current=true; entitlements, model completeness,
  enable status, and request credentials are verified independently. The Start connectionKey excludes paid
  selection.
- Start resolves by saved Provider ID/modelId/options; after exit, the single current paid connection mapping
  is removed; personal/team keep the original mapping. Start invalidation or cross-brand does not
  auto-replace Providers.
- Start requests directly reuse the current brand login's zcodeJwtToken (no `selection.kind` condition);
  original auth is retained, tokens are not copied, and no new cross-account race checks or interruption
  mechanisms are added.
- No model data migration, upgrade connection snapshots, extra migration versions, or full-database
  conversion. Old `kind:start-plan` remains readable without controlling Start execution; not writing this
  value anymore enables Start. First paid initialization keeps its original order; old values cannot be
  mistaken for new-user empty-state plan selection.
- At submit/create time, if the current is a paid plan and the same model has clear available quota in Start
  with compatible reasoning options, prompt "switch plan/cannot" and "do not show again". Switching modifies
  only the current entry's model selection and continues the original submit/save; global paid connections
  are unchanged; unknown quotas do not block the original submission.
- Recommendations cover conversation new submissions, scheduled task create/model-save, Wiki manual
  new-generate, and custom Subagent save/explicit-model immediate-save. Bot, immediate run, background
  trigger/execution, idle, submitted-queue execution, original-request retry, and Wiki failure-page
  completion do not prompt; save-and-run prompts only once, during the save phase.
- "Do not show again" is a current App/Host unified persisted preference, effective across entries and
  restarts; same-host mobile obeys; no cross-device account cloud sync. It only closes recommendations; it
  sets no default plans and changes no other entries' models; next time each entry still executes its saved
  selection; real quota/credential errors are not shielded.
- Start retains existing quota banners and unavailability feedback; global connection failure notifications
  observe only personal/team, retain paid-plan suggestions, and delete actions that switch by writing Start
  connections.

Existing Session/draft submissions are written back; Automation/explicit Subagent long-term configs may not
write back. No migration is a confirmed new-behavior choice, not a claim that all old configs keep their
previous effective results; evidence and the withdrawn full-migration inference per
[C25](./evidence-and-contradictions.md#c25-start-independent-provider-vs-current-single-connection-semantics).

Landed per the 2026-09-16 implementation authorization. Full button semantics, entry matrices, status
ownership, and verification evidence live in [Todo154](../steps/todo-154-start-plan-independent-provider.md).
Start resolves precisely as ordinary in the shared node facade; recommendations reuse UsageEntitlement and
SettingService; the preference field is `startPlanRecommendationDismissed`. Built-in → Account → Personal,
target Environment Registry, continuous/replayable, and original submission owners are retained.

## 5. Selection, Creation, and Execution

### 5.1 Model Selection Is Sparse User Intent

Model Selection saves only:

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
  };
}
```

It does not copy Endpoints, API Schemas, capabilities, credentials, Provider Snapshots, or Effective Config.
Submissions must validate against the current Registry of the target Environment; remote workspaces cannot
pre-judge from a local Registry or send local execution facts across.

### 5.2 ModelFactory Fixedly Stores Complete Execution Facts

```text
ModelSelection
      |
      v
Target Environment Provider Registry
      |
      v
ModelFactory
├─ Provider API / Endpoint / Access
├─ Model properties / optionSpecs
├─ Defaults and user options
├─ optionSpecs.*.map → final raw Request Body
`─ This request's dependencies
      |
      v
Immutable Model
```

- API Key Providers use Keys saved in Config;
- Zhipu Account Providers obtain current dynamic credentials at request time through account access
  services;
- Off-Peak still uses fixed Provider IDs for precise product identities, accessed via
  `zhipu-account + mode=off-peak`;
- Missing dynamic access materials fail explicitly before network requests;
- Retries may refresh dynamic materials of the same access method, but cannot change Providers, Models, or
  static config identities.

### 5.3 All Execution Branches Use Same Model

Ordinary requests, Compact, Memory, sub-agents, and Off-Peak all use formal Models/ModelFactory:

- Compact uses this loop's Active Model; it does not fall back to the Session default Model;
- Async work like Memory retains the Model that created it or same-structure immutable execution facts;
- Sub-agents default to inheriting the parent ModelFactory; when explicitly selected, they create their own
  Models through the same Registry;
- Off-Peak uses standard ModelSelection and fixed hidden Providers to create Models precisely, without
  modifying ordinary Session Selection;
- Media gating reads `Model.properties.inputFormat`, while respecting the Adapter's real encoding
  capabilities.

No ModelRef, ModelConnectionPort, AI SDK execution Registry, Legacy Model Catalog, Runtime capability maps,
or second Registries for special execution exist.

## 6. State Ownership and Submission Boundaries

Model selection distinguishes four states:

```text
Composer Draft Selection
        |
        | Atomically frozen on submission
        v
Submission Selection
        |
        v
Session Current Selection
        |
        | Creating this execution
        v
Active Model
```

- Composer Draft is unsubmitted drafts;
- Submission Selection is the exact selection accepted by this user submission;
- Session Current Selection is the subsequent default;
- Active Model is created and frozen execution facts.

Queues, Guide steps, recovery, and model switches must not merge these four layers. Auxiliary executions
like Off-Peak must not use this path to modify Session Current Selection.

Guide carrying selections still re-resolves and creates Models through the existing Factory, so config
updates apply to subsequent requests. Model-switch prefix rebuild compares only the current Loop's and the
new execution Model's Provider, models, and reasoning levels; object re-creation or output limit changes do
not equal model switches. Session selection events still compare the Session before and after submission,
not Loop comparisons. This round does not change real model-switch output style freezing, nor Guide
admission/attribution and cross-platform transport.

## 7. Environment, Refresh, and Persistence

### 7.1 Execution Environments Own Their Own Facts

Each Environment truly executing models owns its own:

- ZCode Built-in Config Source;
- Personal Config Repository;
- Account Provider Source;
- Resolver, Registry, and ModelFactory.

Local, SSH, WSL, Docker, or Server each read their Environment config via respective Hosts/Workers. Host
does not send Registry Snapshots to Workers, nor let Renderers become config authorities. Remote
Provisioning, remote editing, and login sync are independent product capabilities, not part of Provider core
refactoring.

### 7.2 Config Updates Must Be Atomic, Self-healing

- Repositories use version envelopes, atomic writes, file locks, and revisions; these are storage
  implementations, not Provider-domain Config Documents.
- Source watchers only notify "facts may have changed"; Registry Services re-read complete Config and
  Account snapshots, parsing and publishing once.
- Refresh keeps serving the previous complete Registry; failures publish no partial products; subsequent
  events must be self-healing retryable.
- Built-in remote publishing uses a two-layer structure: version/refresh metadata envelope + pure
  Provider/Model Config content.
- Built-in active caches are isolated by ZCode Endpoint, preventing different Environments from reusing
  wrong configs.
- After settings writes complete, execution entries must observe the corresponding Environment's new
  Registry; connectivity tests create models through the formal Host Registry/ModelFactory, not a
  temporarily assembled Model in Renderers.

### 7.3 Config Names and Physical Envelopes

Domain names are fixed:

- ZCode Built-in Provider Config;
- Account Provider Config;
- Personal Provider Config;
- Effective Provider Config;
- ZCode Built-in Model Config Rules;
- Personal Model Config Rules;
- Effective Model Config Rules;
- Effective Model Config.

Do not use `Official Config` as a current alias, nor build `Document` as a domain intermediate state.
`schemaVersion`, `revision`, remote refresh times, and file migrations belong only to publishing or
Repository envelopes.

Final Builtin file: `{ schemaVersion: 1, revision, config }`; inside config, `providerConfigRules` contains
`templateRules/providerRules`, and `modelConfigRules` contains the five Builtin sets above. Personal file:
`{ schemaVersion: 1, config }`; inside config, `providerConfigRules.providerRules` and
`modelConfigRules.providerModelRules/manualProviderModelRules` are all required (may be empty), plus optional
`providerOrder/defaultModelSelection`. Default selection adapters reuse the same Personal Repository — no
independent files, locks, or watchers. Ordinary field updates retain unmodified members; full distribution
replaces the entire config, and missing defaults clear. Distribution failures roll back by entire-file CAS;
user-written new content during that window cannot be overwritten.

Program-maintained files in environment config directories are uniform:

```text
runtime/provider/
  <platform>/<appVersion>/<endpoint-key>/
    zcode-builtin.json
    zcode-builtin-refresh.json
  provisioning.json
  bundled/zcode-builtin.json
```

Bundle copies use fixed paths, reuse same content, and replace atomically on change; downloads/refreshes stay
three-dimensionally isolated. Upgrades require exiting old processes; no hash historical copies are kept.
Runtime Builtin revisions contain the Active normalized path range and publication sequence number; Hosts and
Workers reading the same paths are consistent; the same sequence number across different Endpoints is no
longer de-duplicated by the Registry. Disk publication sequence numbers stay monotonically increasing;
same-source same-sequence numbers must have identical content. Refresh records, distribution statuses, and
distribution envelope schemaVersions are also 1; Bots keep their existing version 3, excluded from this
reset.

## 8. Settings Writes and Interaction Boundaries

- The settings page reads the Provider Settings View through Facade/Hooks; it does not access Repositories
  directly.
- Editing Drafts belongs to Renderers; saving is executed atomically by the Host's Provider Config Service.
- Built-in Provider static fields can display read-only; Personal Overlays write only user-confirmed
  modifications.
- Provider/Model rename, create, delete, and reorder are explicit domain operations; ordinary saves carry no
  creation or resurrection semantics.
- Same-Provider writes are serialized; Model Drafts use revisions to prevent late saves overriding new edits.
- Connectivity tests first save the current Draft, wait for the formal Registry update, then initiate real
  protocol probing through ModelFactory; as low-cost auxiliary requests they use `reasoningLevel.values[0]`
  and explicitly `min(5000, optionSpecs.maxOutputTokens.max)`.
- Save and connection success/failure feedback belong to bottom banners of the current Provider detail
  column; new states of the same operation replace old states; they cannot be pushed off the current window
  by long model lists. Specific visual interactions do not change Config or Registry authority.

## 9. Compatibility and Deletion Boundaries

Allowed compatibilities are explicit one-time boundaries only:

- Old Personal Config importers can read published historical fields and immediately project them as new
  Personal Overlays;
- Historical account, product, and Usage protocols can keep their own `planKind/productId`, but these must
  not re-enter Provider Config;
- Adapter internals can use protocol-local helpers, but must not re-expose old capability types as Model
  fact sources.

Prohibited from reappearing in formal Config, Registry, Models, and Runtime:

- `Official Config` dual-routes;
- `ProviderConfigDocument` / `ModelSelectionConfigDocument` domain objects;
- `request-auth` / `execution-provided` Access;
- `accessId`, static `planKind`, `challenge`, `requestSigning`, `executionProtocol`;
- `executionOnly` or "trusted execution" escape switches;
- Model `visibility`;
- `adapterCompatibility`, `reasoningReplay`, and specific-model Runtime hardcode;
- `modalities`, flat `supportsImages/Pdf/Video`, or a second capability DTO;
- `ModelRef`, `ModelConnectionPort`, Legacy Catalog/Presets, and a second execution Registry.

## 10. Core Invariants

1. Provider static facts have only three sources: ZCode Built-in, Account Overlay, and Personal Overlay.
2. Model static facts have only ZCode Built-in Rules and Personal Rules; Personal takes effect last; precise
   Personal last.
3. Effective Model Config must resolve within the Effective Provider's API context.
4. Settings and Registry come from the same Resolver resolution; Settings does not reverse-derive incomplete
   config from the Registry.
5. Registry contains only complete executable items, but hidden Providers remain executable by internal
   exact execution.
6. Account Overlay constrains only Built-in account Providers; Start Plan model sets can vary by account.
7. Dynamic account credentials do not enter Config; API Key Configs can hold API Keys; final authorization
   is decided by servers.
8. ModelFactory consumes only the current Registry's complete configs; Active Models are frozen after
   creation.
9. Provider/Model identities are always `providerId/modelId`; never route by modelId alone.
10. Product UIs, plan cards, Usage, and connection errors must not become Provider/Model config fact sources.
11. No second model facts for Off-Peak, connectivity tests, Compact, Memory, sub-agents, or remote execution.
12. If current code differs from an already-ruled design, treat it as implementation drift, not new implicit
    design.

## 11. Unfinished Work Not Changing Design

### Provider Start/Read Boundaries (Todo128)

`ProviderRuntime`, `NodeProviderConfigRuntime`, `NodeProviderRegistryRuntime`, `ProviderRegistryService`, and
Services' Config handoff layers unify `start(): Promise<void>`. It only waits for first-ready and retains
existing dedup/failure-retry/release; it does not return startup snapshots for business long-term caching.
Business explicitly reads `configService.read()` or `registryService.getSnapshot()`; explicit refreshes still
go through `refresh()`. "Current" means the most recently completed state, not implicitly waiting for future
account requests. Idle eligibility and dispatch follow the same Registry-backed credential parsing; no new
state owners.

### Other Outstanding Todos

- Todo 15: historical release verification scope recorded, abandoned, no longer an independent Todo;
- Todo 19: historical Built-in Release gate discussion, abandoned, no longer an independent Todo;
- Todo 22: new Built-in Providers and cloud platform Access, still drafts;
- Todo 11 / 11A: runtime composition cleanup drafts and release issues; cannot change this design before
  ruling;
- Final integration with latest `origin/staging` and real product verification.

These items may supplement verification, product projections, or implementation cleanup; changing this
document's config layers, Access Schema, Registry authority, or Model lifecycles requires a new explicit
ruling and an update to this document first.
