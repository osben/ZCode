# Provider Refactor Core Design

> Status: Current design. This document describes only the final architecture and invariants; migration processes are not re-stated. Historical sources and contradiction rulings see [`evidence-and-contradictions.md`](./evidence-and-contradictions.md).

## 1. Purpose

The sole purpose of the Provider config system is to stably assemble the user's choice and configuration for a model API into an executable model call.

It needs to answer:

- Which Providers exist, and what models each Provider has;
- Which API Schema, Endpoint, and access method each Provider uses;
- What static capabilities models have, which options they accept, and how logical options map to protocol parameters;
- How current account and user config affect the final Provider;
- Which Provider, Model, and Options a single submission ultimately uses;
- Which facts take effect when config updates, account refreshes, and execution concurrency collide.

It is not a unified credential center, nor the final authorization party. API Key Providers can directly save API Keys; Account-type Provider Config only describes static access types; login tokens, Team Project Keys, Start Plan JWTs, and Off-Peak Tickets and other dynamic materials are obtained by account and execution-period services. Model servers still make final authorization rulings on each request.

## 2. Core Principles

### 2.1 One Config Fact, Two Resolution Paths

Provider and Model configs solve different problems, merging finally at the same model identity:

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

Provider path determines "which final Providers exist, which member models, and how to access APIs." Model Rule path determines "what capabilities models have and what option-protocol mappings exist." Do not duplicate a second model capability fact for settings pages, idle tasks, connectivity tests, or any Adapter.

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
- `undefined` means this layer does not override, `null` means this layer explicitly clears, concrete values mean explicit override;
- Overlays themselves can be incomplete; only Effective Configs entering the Registry must be complete.

Model Rules are all ordered Overlays. Builtin effective order:

```text
modelRules
    -> modelApiRules
    -> providerSiteRules
    -> templateModelRules
    -> builtinProviderModelRules
    -> Personal providerModelRules / manualProviderModelRules
```

Among them, `providerSiteRules` matches site behavior by specific Base URL; `templateModelRules` matches template members and default `enabled` by `templateId + modelId`; the two are not the same identity match. Personal Config only allows precise override of specific `providerId + modelId`; no global Match Rules are provided, read, or written for Personal. All rules maintain array writing order; no dynamic priority algorithms introduced.

### Match Config Maintenance Principles (2026-09-10 Ruling)

- Built-in Matches based on mainstream config and official capabilities; official takes priority; do not lower known models' default capabilities for backward or incomplete third-party compatibility.
- Capabilities supported by known models under corresponding API Schemas written to model/model-API rules, using prefix/suffix matching. Do not default-disable just because accessed through third-party proxies; if the proxy does not support, users disable through specific-model Personal config override.
- Official priority does not mean all models of the same brand support it: different model, API Schema explicit support boundaries must be retained; cannot grant all models capabilities via broad brand regex from one model's capabilities.
- Site-specific behavior written to `providerSiteRules`, maintained per "one specific Base URL = one rule"; different domains or endpoints not merged via regex alternation. Same URL can declare multiple confirmed capabilities in one rule; rules that must split due to model/API conditions remain separately retained.
- Canonicalized equivalent forms of same URL (e.g., trailing slashes) can be handled in one rule, but cannot thereby relax to all site paths or arbitrary subdomains.
- Capabilities continue forming final Model properties through unified Overlay/Resolver; no runtime bypasses guessing capabilities by model name or domain. When migrating old behavior, verify each capability separately; cannot mistake deleted old judgments as canceling existing capabilities.

### 2.3 Builtin Provider Maintenance List

Builtin maintenance scope expressed by a short entry inventory table, not repeated as full Provider Config in documentation; specific content per [`Builtin Provider Inventory`](./builtin-provider-inventory.md):

```text
Vendor | Type | templateId / providerId | Base URL | Product-maintained models
```

- Ordinary API entries fill `templateId`; Account entries fill specific `providerId`.
- Models in the table are actively maintained by the product; Template's `builtinModelIds` are the corresponding facts in config.
- No extra maintenance of model display names, model-owned Template duplicate fields, or Provider Site Catalogs.
- Historical models not appearing in the vendor catalog's table do not enter Builtin Templates; no compatibility migration.
- URL-specific rules exist only in config as `providerSiteRules`; they are not another vendor list.

### API Schema Selection Principles

Same vendors may simultaneously provide multiple API Schemas. Official templates uniformly prefer Anthropic Messages; only when the vendor or specific model/Endpoint does not support Anthropic, then choose the other Schema that the entry actually supports and has the most verification. This judgment based on template actual request evidence, not "OpenAI-compatible" marketing labels. If different models on same site must use different Schemas, split template identities, or first propose explicit per-model API config design; do not shove different-protocol models into one fixed `api.type`. Template-determined Schemas can still be overridden by more specific config per existing overlay order.

### Aggregated Provider Model List Principles

Aggregated vendor model lists can reference upstream vendor maintenance lists: upstream-maintained models, as long as the aggregation site actually provides, should enter aggregation entries. For example, current OpenRouter model IDs might be written as `openai/gpt-5.6-sol`, while upstream model IDs are `gpt-5.6-sol`; this is merely the current list and naming correspondence for that aggregation vendor, does not mean all aggregation vendors must carry prefixes, nor requires stripping prefixes at runtime before parsing. Aggregation entries still maintain their own Model/API/Site config; because after passing through an aggregation site, the same model may have different protocols, capabilities, and parameter mappings.

### 2.3 Sparse and Complete Must Be Separate

Write boundaries receive sparse Config; execution boundaries receive only type proven complete. Complete type is a type narrowing of the same Config, not a second DTO, nor a second Registry.

Model fields take complete data schema from `@zcode/shared/model-config` as sole source; sparse schema derives default/null-override semantics from same fields. Constructed input, JSON output, and Registry complete types use schema derivation; behavior classes only retain frozen, overlay, and serialization behavior. Completeness checks reuse this schema, no longer hand-writing second field/value-domain check tables. Pure data schemas do not reference behavior classes, avoiding codec-class circular dependencies. Provider/API/Access also from `config/provider-data-schema.ts` providing single data contract; CLI's ModelProperties/OptionSpecs types and protocol media field projections also derived from shared Model schema, not reverse-dependent on Provider behavior implementation. Shared layer depends only on pure expression compilers, does not contain state or IO. Provider completeness only strengthens existing execution-required fields, not all display/member fields; source write permissions derived through same schema. Personal temporarily retains incomplete endpoint boundaries; bad addresses only block that Provider's Registry admission. Rules derived from `rule-data-schema.ts` by source; data files carry no memory-layer `type` identifiers, nor re-guess rule hierarchy by field presence.

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

Incomplete, disabled, or temporarily non-executable Providers/Models can be saved and displayed on settings pages; they cannot enter executable Registry.

### 2.4 Identity, Capability, Status, and Display Orthogonal

- `providerId + modelId` is model identity; same `modelId` can exist in different Providers.
- No top-level `enabled` on Providers; Personal defines existence = belongs to Settings; Account Providers fixed to corresponding Families.
- Completeness expresses whether facts needed to construct execution objects exist.
- `executable` determined jointly by Account Access entitlement (account-type), Provider completeness, Model enable, and Model completeness.
- `selectable` further affected by Provider `visibility` on top of `executable`.
- `visibility` is Provider's display projection, not permission, auth, or completeness exemption.
- Models have no independent `visibility`; whether Models appear in ordinary selections determined jointly by their execution eligibility and Provider visibility.

### 2.5 Created Models Are Execution Facts

Registry is the directory for creating Models, not a mutable state continuously read during an execution. ModelFactory obtains complete Provider/Model config from current Environment's Registry and creates immutable Models. Subsequent Config or Registry updates only affect subsequently created Models; they do not silently alter already-running requests, Compact, Memory, or sub-agents.

## 3. Config Contracts

### 3.1 Provider Config

Formal fields for Provider Config:

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

Field meanings:

| Field              | Meaning                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `group`            | Personal or Account Family grouping; not Access Mode                                                           |
| `logo`             | Display resource key, unknown key falls back to generic icon                                                   |
| `access`           | Static method for obtaining access materials needed for calls                                                  |
| `api`              | Final API Schema, Base URL, and static Header                                                                  |
| `builtinModelIds`  | Model members owned by ZCode or Account layers                                                                 |
| `personalModelIds` | Model members owned by Personal layer                                                                          |
| `modelOrder`       | User's total ordering intent for final member set                                                              |
| `visibility`       | Whether Provider enters ordinary settings/selection projection; does not affect internal exact Registry lookup |

Member sets preserve source: Built-in members first, Personal members last; duplicates within single set keep only first; Personal and Built-in same-name keeps Built-in identity and discards Personal duplicates. `modelOrder` only sorts existing members, does not create models.

Instances outside rules: `{ providerId, templateId?, providerName?, config }`; templates:
`{ templateId, templateNameMap, config }`. Identity, inheritance, and names are not Config leaves.
Templates generate instance names at creation by current language → en-US → templateId, deduping within Personal file locks. Thereafter, only connection fields modified, no inheritance names written; explicit renames write outer `providerName` only; language changes do not change saved names.

### 3.2 Provider Access

Formal Access union types only two:

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

`group`, `accountType`, and `mode` do not duplicate:

- `group` is Provider's static product grouping;
- `accountType` is Zhipu account system access identity;
- `mode` is that account Provider's access mode.

`entitled` is the single config fact for whether current account has that fixed Account Product eligibility. No top-level `enabled` on Providers. `zhipu-account` Config does not save account connection ID, product ID, organization/project Scope, tokens, or request security verification protocols. Account runtime protocols may still have `planKind`, `productId` etc.; but these belong to accounts, plans, or request-time context, not Provider Config Schema.

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

These fields use same names and same nested structure from Config, Registry, cross-process protocol, to Active Model. Runtime does not derive `supportsImages`, capability maps, or second media DTO.

Effective Model Config must complete:

- `enabled`; MFJS is `properties.requiresMfjsToolSchema`, not saved redundantly at ModelConfig top-level;
- Complete `properties` and all input/output format leaves;
- `maxOutputTokens` Option Spec and its complete `map`;
- `reasoningLevel` Option Spec and its non-empty ordered `values`, complete `map`; non-reasoning models use
  `values: ["disabled"]` and empty Patch `map: "{}"`.

Fields for `reasoningLevel` only `values`/`map`; `maxOutputTokens` only `max`/`map`; member names already determine option forms; no longer persist duplicate `type: "enum"/"limit"`. This does not affect Provider API/Access union-type discriminators.

Specific model reasoning behavior can only be expressed by Model Config Rules; production Runtime does not hardcode thinking intensity, request patches, or replay strategies by specific model IDs. Each Option Spec's restricted CEL `map(value)` directly generates final raw Request Body JSON Merge Patches; Adapters only apply same mapping after AI SDK generates base Body, before request security checks, and are responsible for protocol encoding and its real encoding capability boundaries.

### 3.4 Model Config Rules

Rule belonging sets express hierarchy clearly; records within files no longer duplicate `type`:

| Set                               | Match Identity                                   | Content                                            |
| --------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| modelRules                        | modelMatch                                       | Sparse ModelConfig                                 |
| modelApiRules                     | modelMatch + apiTypeMatch                        | Sparse ModelConfig                                 |
| providerSiteRules                 | modelMatch + baseUrlMatch, optional apiTypeMatch | Sparse ModelConfig                                 |
| templateModelRules                | templateId + modelId                             | Sparse ModelConfig                                 |
| builtinProviderModelRules         | providerId + modelId                             | Sparse ModelConfig                                 |
| Personal providerModelRules       | providerId + modelId                             | Smart config precise overrides                     |
| Personal manualProviderModelRules | providerId + modelId                             | Complete manual config, only enabled inherits/null |

Strict schemas for three Match types reject cross-layer conditions and `providerMatch`. Regex whole-string match, model names case-insensitive, URLs use normalized values; each set array order preserved. Same identity cannot simultaneously be in smart/manual sets. Manual config does not inherit other parameters; only retains enabled's existing independent enable/disable semantics; all required nested leaves and expressions jointly validated on save.

## 4. Resolution, Settings Projection, and Registry

### 4.1 Resolver Is the Sole Convergence Point

Resolver responsible for:

1. Only allowing Account Overlay to act on ZCode Built-in Providers;
2. Computing `Built-in → Account → Personal` Effective Provider;
3. Composing Effective Model Rules;
4. Resolving final model members, sources, and ordering;
5. Parsing Effective Model Config for each `providerId/modelId/api.type/api.baseUrl`;
6. Separately computing issues, enabled, entitled, executable, and selectable;
7. Producing settings candidates and Registry executable sets simultaneously.

Renderers, Usage UI, plan cards, ModelFactory, and Adapters must not re-implement this Overlay or member derivation.

### 4.2 Settings View and Registry Are Two Projections of Same Resolution

```text
                    ProviderConfigResolution
                      /                 \
                     /                   \
       resolvedProviders                 registryProviders
       Complete + incomplete candidates                  Only complete executable items
              |                                  |
              v                                  v
    Provider Settings Facade               Provider Registry
```

Settings View needs to retain:

- Effective Provider;
- Built-in baseline after Account takes effect;
- Personal Provider Overlay;
- Each model's Effective, Effective Built-in, and Personal precise overrides;
- Completeness issues and execution status.

Thus settings page can edit or fix pre-Registry configurations. Registry only retains enabled, complete Providers with at least one executable model, and their executable models.

### 4.3 Account Provider Config

Account Provider Config is formal Provider Overlay, but only projects account upstream facts' impact on Built-in account Providers:

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

Specific rules:

- Account Providers declared by Built-in fixed and enter corresponding Family;
- When current account explicitly owns the product, write `access.entitled=true`; explicitly not eligible, write `false`;
- Individual / Team default to Built-in model members;
- Start Plan models vary by account; successful uses interface-returned model sets to constrain `builtinModelIds`;
- Start Plan without reliable model sets keeps previous available Account Overlay; first-time no available facts fail-closed;
- Temporary query failures `unknown` keeps previous Account Overlay, avoiding flicker; first-time no historical facts fail-closed;
- Dynamic credentials not written to Account Provider Config.

Account State's optional `unavailableReason` passes with same snapshot; Host and CLI strict protocols share reason schemas. Personal plan server explicitly no entitlement displays unactivated; logged-in but Key fetch failure displays fetch failure and reuses manual refresh retry, cannot solely infer OAuth failure or force re-login from missing Key. Z.ai and BigModel use consistent classification. Reasons only belong to runtime facts, not written to Provider Config; specific rulings and verification per [Todo114](../steps/todo-114-account-status-sync-and-key-retry.md) (upstream original Todo105).

Account and Built-in revisions must pair. When Built-in updated but Account still based on old revision, Registry continues serving previous complete snapshot, awaiting Account Source recalculation and atomic publishing; cannot publish "new Built-in + old Account" intermediate state.

### 4.4 Settings Page Does Not Understand Account Overlay

Settings page directly consumes final Effective Provider/Model from Provider Settings View; it does not read, replay, or infer Account Overlay. Plans, quotas, connection errors, and purchase status are independent product projections, controlling only status cards and corresponding actions; cannot decide whether Effective Provider config area, model lists, or model editor entries exist.

Individual / Team Coding Plans can hide Endpoints and API Schema in product UI; but these fields still fully exist in Effective Provider Config, consumed by Registry, ModelFactory, and Runtime. Hiding is a display decision, not an Account DTO after field deletion.

This page closure already completed by Todo 32: Team/Individual details precisely parsed from Provider Settings View by `providerId`; plan status cards no longer control whether Provider config area and model lists exist; pages hiding Endpoints/API Schema do not delete Effective Provider Config.

### 4.5 Start Independent Provider (Todo154)

2026-09-16 user completed layer-by-layer ruling: Start reuses current App login, no separate connection, simultaneously usable with current personal/team plans; does not start Todo101's personal/multi-team full coexistence.

- Retains two Start Provider IDs, unified display names, logos each retaining Z.ai/BigModel. Filtered by current brand, displayed independently in existing "Zhipu" grouping, reuses details, only removing connect/disconnect. No virtual Providers, ID merging, or display identity mapping.
- Retains current, interpreted as matching current account access context. Start does not depend on paid selection; personal/team still depend on current paid selection. Start and one paid plan simultaneously allowed current=true; entitlements, model completeness, enable status, and request credentials independently verified. Start connectionKey does not include paid selection.
- Start resolved by saved Provider ID/modelId/options; after exiting single current paid connection mapping; personal/team continue original mapping. Start invalidation or cross-brand does not auto-replace Providers.
- Start requests directly reuse current corresponding brand login's zcodeJwtToken, removing condition that selection.kind must equal Start; retaining original auth, not copying tokens, no new cross-account race checks or interruption mechanisms.
- No model data migration, no upgrade connection snapshots, no extra migration versions, no full-database conversion. Old kind:start-plan remains readable without controlling Start execution; no longer writing this value enables Start. First paid initialization keeps original order; old values cannot be mistaken as new-user empty-state plan selection.
- At submit/create-time, if current is paid plan, same model has clear available quota in Start and reasoning options compatible, prompts "switch plan/cannot" and "do not show again." Switching only modifies current entry's model selection, continuing original submit/save, does not change global paid connections; unknown quotas do not block original submissions.
- Recommendations cover conversation new submissions, scheduled task create/model-save, Wiki manual new-generate, and custom Subagent save/explicit-model immediate-save. Inheritance/default unchanged. Bot, immediate run, background trigger/execution, idle, submitted-queue execution, original-request retry, and Wiki failure-page completion do not prompt; save-and-run only prompts once during save phase.
- "Do not show again" is current App/Host unified persisted preference, effective across entries and restarts, same-host mobile obeys, no cross-device account cloud sync; only closes recommendations, does not specify default plans or change other-entry models; next time still executes per each-entry saved selections, does not shield real quota/credential errors.
- Start retains existing quota banners and unavailability feedback; global connection failure notifications only observe personal/team, retain paid-plan suggestions, delete actions switching through writing Start connections.

Existing Session/draft submissions written back; Automation/explicit Subagent long-term configs may not write back. No migration is a confirmed new behavior choice, does not mean all old config effective results unchanged; specific evidence and revoked full-migration inferences per [C25](./evidence-and-contradictions.md#c25-start-independent-provider-and-current-single-connection-semantics).

Section goals already landed per 2026-09-16 implementation authorization. Full button semantics, entry matrices, status ownership, and verification evidence maintained by [Todo154](../steps/todo-154-start-plan-independent-provider.md). Start resolved precisely as ordinary in shared node facade; recommendations reuse UsageEntitlement and SettingService; preference field is startPlanRecommendationDismissed. Built-in → Account → Personal, target Environment Registry, continuous/replayable, and original submission owners retained.

## 5. Selection, Creation, and Execution

### 5.1 Model Selection Is Sparse User Intent

Model Selection only saves:

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
  };
}
```

It does not copy Endpoints, API Schemas, capabilities, credentials, Provider Snapshots, or Effective Config. Submissions must validate in current Registry of target Environment; remote workspaces cannot pre-judge from local Registry and send local execution facts across.

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
- Zhipu Account Providers obtain current dynamic credentials at request time through account access services;
- Off-Peak still uses fixed Provider IDs to express precise product identities, accessing via `zhipu-account + mode=off-peak`;
- Missing dynamic access materials explicitly fail before network requests;
- Retries can refresh dynamic materials of same access method, but cannot change Providers, Models, or static config identities.

### 5.3 All Execution Branches Use Same Model

Ordinary requests, Compact, Memory, sub-agents, and Off-Peak must all use formal Models/ModelFactory:

- Compact uses this-loop Active Model; does not fall back to Session default Model;
- Async work like Memory retains the Model that created it or same-structure immutable execution facts;
- Sub-agents default to inheriting parent ModelFactory; when explicitly selected, create their own Models through same Registry;
- Off-Peak uses standard ModelSelection and fixed hidden Providers to precisely create Models, without modifying ordinary Session Selection;
- Media gating reads `Model.properties.inputFormat`, simultaneously respecting Adapter's real encoding capabilities.

No ModelRef, ModelConnectionPort, AI SDK execution Registry, Legacy Model Catalog, Runtime capability maps, or second Registries for special execution exist.

## 6. State Ownership and Submission Boundaries

Model selection must distinguish four states:

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
- Session Current Selection is subsequent default;
- Active Model is execution facts already created and frozen.

Queues, Guide steps, recovery, and model switches must not merge these four layers. Auxiliary executions like Off-Peak must not use this opportunity to modify Session Current Selection.

Guide carrying selections still re-resolves and creates Models through existing Factory, ensuring config updates apply to subsequent requests. Model-switch prefix rebuild only compares current Loop's and new execution Model's Provider, models, and reasoning levels; object re-creation or output limit changes do not equal model switches. Session selection events still compare Session before and after submission, cannot replace Loop comparisons. This round does not change real model-switch output style freezing behavior, nor Guide admission/attribution and cross-platform transport.

## 7. Environment, Refresh, and Persistence

### 7.1 Execution Environments Own Their Own Facts

Each Environment truly executing models owns its own:

- ZCode Built-in Config Source;
- Personal Config Repository;
- Account Provider Source;
- Resolver, Registry, and ModelFactory.

Local, SSH, WSL, Docker, or Server each read their Environment config via respective Hosts/Workers. Host does not send Registry Snapshots to Workers, nor let Renderers become config authorities. Remote Provisioning, remote editing, and login sync are independent product capabilities, not part of Provider core refactoring.

### 7.2 Config Updates Must Be Atomic, Self-healing

- Repositories use version envelopes, atomic writes, file locks, and revisions; these are storage implementations, not Provider-domain Config Documents.
- Source watchers only notify "facts may have changed"; Registry Services re-read complete Config and Account snapshots, parsing and publishing once.
- Refresh continues serving previous complete Registry; failures do not publish partial products; subsequent events must be self-healing retryable.
- Built-in remote publishing uses two-layer structure: version/refresh metadata envelope + pure Provider/Model Config content.
- Built-in active caches isolated by ZCode Endpoints, preventing different Environments from reusing wrong configs.
- After settings writes complete, execution entries must observe corresponding Environment's new Registry; connectivity tests should create models through formal Host Registry/ModelFactory, not temporarily assemble another Model in Renderers.

### 7.3 Config Names and Physical Envelopes

Domain names fixed:

- ZCode Built-in Provider Config;
- Account Provider Config;
- Personal Provider Config;
- Effective Provider Config;
- ZCode Built-in Model Config Rules;
- Personal Model Config Rules;
- Effective Model Config Rules;
- Effective Model Config.

Do not use `Official Config` as current alias, nor build `Document` as domain intermediate state. `schemaVersion`, `revision`, remote refresh times, and file migrations belong only to publishing or Repository envelopes.

Final Builtin file: `{ schemaVersion: 1, revision, config }`: inside config `providerConfigRules` contains `templateRules/providerRules`, `modelConfigRules` contains above five Builtin sets. Personal file: `{ schemaVersion: 1, config }`: inside config `providerConfigRules.providerRules`, `modelConfigRules.providerModelRules/manualProviderModelRules` all required (can be empty), plus optional `providerOrder/defaultModelSelection`. Default selection adapters reuse same Personal Repository, no independent files, locks, or watchers. Ordinary field updates retain unmodified members; full distribution replaces entire config, missing defaults clear. Distribution failures roll back by entire-file CAS; user-written new content during cannot overwrite.

Program-maintained files in environment config directories uniformly:

```text
runtime/provider/
  <platform>/<appVersion>/<endpoint-key>/
    zcode-builtin.json
    zcode-builtin-refresh.json
  provisioning.json
  bundled/zcode-builtin.json
```

Bundle copies fixed paths, same content reuse, changes atomic replace; downloads/refreshes still three-dimensional isolated. Upgrades require exiting old processes; no hash historical copies retained. Runtime Builtin revisions contain Active normalized path ranges and publication sequence numbers; Hosts and Workers reading same paths consistent; different Endpoints same sequence number no longer de-duplicated by Registry. Disk publication sequence numbers still monotonically increasing; same-source same-sequence numbers must have same content. Refresh records, distribution statuses, and distribution envelope schemaVersions also 1; Bots still retain existing version3, not included in reset.

## 8. Settings Writes and Interaction Boundaries

- Settings page reads Provider Settings View through Facade/Hooks; does not directly access Repositories.
- Editing Drafts belongs to Renderers; saving executed atomically by Host's Provider Config Service.
- Built-in Provider static fields can display as read-only; Personal Overlays only write user-confirmed modifications.
- Provider/Model rename, create, delete, and reorder are explicit domain operations; ordinary saves do not bear creation or resurrection semantics.
- Same-Provider writes serialized; Model Drafts use revisions to prevent late-save overriding new edits.
- Connectivity tests first save current Draft, wait for formal Registry update, then initiate real protocol probing through ModelFactory; as low-cost auxiliary requests, uses `reasoningLevel.values[0]`, explicitly uses `min(5000, optionSpecs.maxOutputTokens.max)`.
- Save, connection success or failure feedback belong to bottom banners of current Provider detail columns; new states of same operation replace old states; cannot be pushed off current window by long model lists. Specific visual interactions do not change Config or Registry authority.

## 9. Compatibility and Deletion Boundaries

Allowed compatibilities only explicit one-time boundaries:

- Old Personal Config importers can read published historical fields and immediately project as new Personal Overlays;
- Historical account, product, and Usage protocols can continue using their own `planKind/productId`, but must not re-enter Provider Config;
- Adapter internals can use protocol-local helpers, but must not re-expose old capability types as Model fact sources.

Prohibited re-appearance in formal Config, Registry, Models, and Runtime:

- `Official Config` dual-routes;
- `ProviderConfigDocument` / `ModelSelectionConfigDocument` domain objects;
- `request-auth` / `execution-provided` Access;
- `accessId`, static `planKind`, `challenge`, `requestSigning`, `executionProtocol`;
- `executionOnly` or "trusted execution" escape switches;
- Model `visibility`;
- `adapterCompatibility`, `reasoningReplay`, and specific-model Runtime hardcode;
- `modalities`, flat `supportsImages/Pdf/Video` or second capability DTO;
- `ModelRef`, `ModelConnectionPort`, Legacy Catalog/Presets, and second execution Registry.

## 10. Core Invariants

1. Provider static facts have only three sources: ZCode Built-in, Account Overlay, and Personal Overlay.
2. Model static facts have only ZCode Built-in Rules and Personal Rules; Personal takes effect last, precise Personal last.
3. Effective Model Config must resolve within Effective Provider's API context.
4. Settings and Registry from same Resolver resolution; Settings does not reverse-derive incomplete config from Registry.
5. Registry only contains complete executable items, but hidden Providers still executable by internal exact execution.
6. Account Overlay only constrains Built-in account Providers; Start Plan model sets can vary by account.
7. Dynamic account credentials do not enter Config; API Key Configs can hold API Keys; final authorization decided by servers.
8. ModelFactory only consumes current Registry's complete configs; Active Models frozen after creation.
9. Provider/Model identities always `providerId/modelId`; cannot route by modelId alone.
10. Product UIs, plan cards, Usage, and connection errors must not become Provider/Model config fact sources.
11. No second model facts for Off-Peak, connectivity tests, Compact, Memory, sub-agents, or remote execution.
12. If current code differs from already-ruled design, treat as implementation drift, not new implicit design.

## 11. Unfinished Work Not Changing Design

### Provider Start/Read Boundaries (Todo128)

`ProviderRuntime`, `NodeProviderConfigRuntime`, `NodeProviderRegistryRuntime`,
`ProviderRegistryService` and Services' Config handoff layers unified `start(): Promise<void>`.
Only waits for first-ready and retains existing dedup/failure-retry/release; does not return startup snapshots for business long-term caching. Business explicitly reads `configService.read()` or `registryService.getSnapshot()`; explicit refreshes still go through
`refresh()`. Current refers to most recently completed state, not implicitly waiting for future account requests. Idle eligibility and dispatch follow same
Registry-backed credential parsing; no new state owners.

### Other Outstanding Todos

- Todo 15: Historical release verification scope recorded, abandoned, no longer independent Todo;
- Todo 19: Historical Built-in Release gate discussion, abandoned, no longer independent Todo;
- Todo 22: New Built-in Providers and cloud platform Access, still drafts;
- Todo 11 / 11A: Runtime composition cleanup drafts and release issues, cannot change this design before ruling;
- Final integration with latest `origin/staging` and real product verification.

These items can supplement verification, product projections, or implementation cleanup; but to change this document's config layers, Access Schema, Registry authority, or Model lifecycles, must first form new explicit rulings and update this document.
