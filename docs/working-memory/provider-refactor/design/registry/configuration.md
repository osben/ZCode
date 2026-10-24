# Provider and Model Configuration

> Current effective design; Provider Template switching is included.

Provider configuration consists of three layers: ZCode Built-in, Account Built-in, and Personal, sharing a
field-level Overlay language. Normal assembly maintains members by field ownership: Account Built-in updates
the Built-in set, Personal updates the Personal set. The five input sources each validate field ownership
through strict boundary Schemas, then enter the common domain Overlay type; Runtime does not replicate five
config types. ZCode Built-in and Personal provide Model Config Rules; Account Built-in provides no model
static capabilities.

The design layer has no "Config Document" domain concept. Config Maps, Rules, and Effective Config are
domain objects; the JSON shell, `schemaVersion`, file names, caches, and serialization formats belong to
Source/Repository implementation.

## Configuration Sources

| Source                            | Owner                 | Persisted | Main content                                                           |
| --------------------------------- | --------------------- | --------- | ---------------------------------------------------------------------- |
| ZCode Built-in Provider Config    | ZCode product release | Yes       | Account Provider definitions and Provider Templates                    |
| Account Built-in Provider Config  | Current account state | No        | Account Access and dynamic model members of Built-in account Providers |
| Personal Provider Config          | User                  | Yes       | Custom Providers, API Keys, final overrides of existing Providers      |
| ZCode Built-in Model Config Rules | ZCode product release | Yes       | Model static facts, default Options, per-option raw-body map           |
| Personal Model Config Rules       | User                  | Yes       | Sparse overrides for specific Provider/Model                           |

Catalog, Preset, Provider Family, remote `builtinProviders/builtinModels`, and business hardcode cannot
become additional Registry Sources. Still-valid system facts migrate into ZCode Built-in Config/Rules; user
explicit configuration into Personal; account connection facts into Account Built-in Config.

### Content Organization of ZCode Built-in

ZCode Built-in physically remains one complete, atomic JSON — not split into per-Provider/model/rule source
files, and no generation/assembly pipeline is introduced. The Provider Map's declaration order and the Model
Config Rules array order are part of the published content; specific Rule types, physical writing order,
Endpoint specialization, evidence, and the default enable catalog follow
[`zcode-builtin-provider-config.md`](./zcode-builtin-provider-config.md). Those specs add no Rule priority or
dynamic reordering.

Built-in Release product sources:

```text
providers
├─ Z.ai / BigModel Individual, Team, Start Plan Account Provider
└─ Off-Peak hidden Account Provider

providerTemplates
├─ Z.AI API / BigModel API
├─ Moonshot / MiniMax / DeepSeek
├─ Alibaba Model Studio CN / International / Xiaomi MiMo
└─ OpenAI / Anthropic / xAI
```

Off-Peak stays invisible to ordinary settings pages and the model selector via `visibility=hidden`.
Ordinary API services publish only as Provider Templates; a Template is not a Provider: it does not enter
the Registry and has no `providerId` or execution state. After a user creates a Personal Provider from a
Template, the Template remains only its official inheritance baseline. Providers have no top-level
`enabled`; an Account Provider's dynamic plan eligibility is written by the Account Overlay into
`access.entitled`, and final execution admission is decided jointly by eligibility, config completeness, and
Model `enabled`.

This order serves config readability and stable default display order; any future explicit grouping in the
settings page is independent interaction design and cannot reverse-change Provider identity, Registry
members, or Model Rule resolution.

### ZCode Built-in Release and Active Cache

Bundled, Remote, and Environment Active Cache share one two-layer Release contract:

```ts
interface ZCodeBuiltinRelease {
  schemaVersion: 3;
  revision: number;
  config: {
    providers: Record<string, ProviderConfigObject>;
    providerTemplates: Record<
      string,
      {
        nameMap: Partial<Record<"zh-CN" | "en-US", string>>;
        config: ProviderConfigOverlayObject;
      }
    >;
    modelConfigRules: StructuredModelConfigRuleGroups;
  };
}
```

The Provider Template is a domain shell: `nameMap` is the Template's own multilingual name metadata; `config`
reuses the formal Provider Config Overlay. Templates absorb no Model Config Rules; those stay centralized so
the application order of Match, Template, Provider, and Personal Rules stays visible. Template names fall
back by current Locale, `en-US`, `templateId`.

`config` atomically contains the Account Provider Map, Provider Template Map, and Model Rules;
`schemaVersion` and the monotonically increasing `revision` belong to the Source publishing shell and do not
enter the Provider Overlay. Remote is a complete replacement and cannot cross-splice Providers and Rules
with Bundled. A published revision must map to unique content; a content rollback also publishes a higher
revision.

The Environment stores the current active Release at
`<config-root>/provider/zcode-builtin/<platform>/<appVersion>/<endpointKey>/active.json`; that file also
serves as LKG. `endpointKey` is deterministically generated from the normalized ZCode control-plane Origin;
Active and `refresh-control.json` must sit in the same Endpoint directory. At startup, Bundled and the
current Endpoint's Active are strictly parsed; the higher-revision compatible candidate is materialized to
Active. Active is a discardable cache/LKG, not a startup prerequisite: when Active is missing, corrupt,
older, conflicts with same-revision Bundled content, or its directory's lock/watch/read/delete/write fails,
ready completes directly from trusted Bundled, and Active is rebuilt from Bundled when writable. Startup may
fail only when Bundled itself cannot pass the Release Schema and the existing Provider/Rule parsers. The
client adds no publisher business integrity rules; a future publishing gate would be a new task based on the
final publishing process.

Active/LKG and revisions of different Endpoints are never compared or fallen back across. Switching to an
Endpoint without Active uses Bundled for ready, then refreshes that Endpoint in the background; switching
back reuses that Endpoint's own LKG. The old unpartitioned cache has no formal release compatibility; no
dual-read is provided.

Personal Provider Config is user configuration, not a cache. On file corruption, unsupported Schema, or
one-time migration failure, the runtime keeps a deterministic recovery backup while it can still read the
original, then starts with an empty Personal Overlay; if backup or rewrite also fails, it may degrade to an
in-memory empty overlay for this round only — a Personal file must never take down Bundled and the Account
Provider. Later Personal saves still go through normal atomic writes and return persistence errors to that
operation; fake save success is forbidden. Different processes observe Personal Config through asynchronous
content-revision polling; same-process saves publish immediately; other processes catch up within at most
one polling cycle, without platform-dependent file events.

The Environment's Model Selection Configured Default is only a rebuildable preference. Confirmed JSON,
Schema, or version corruption deletes it only while the file lock is still held; temporary lock, read, or
Legacy importer failures only ignore this round's preference without deleting the file. The current
Registry's normal fallback then re-selects; Configured Default must not block Registry, Model Selection
View, or Agent startup.

## Provider Overlay

```text
ZCode Built-in Provider Config
              |
              v
overlay Account Built-in Provider Config
              |
              v
Effective Built-in Provider Config
              |
              v
 overlay Personal Provider Config
              |
              v
      Effective Provider Config
```

```ts
effectiveBuiltinProviders = zcodeBuiltinProviders.overlay(accountBuiltinProviders);
effectiveProviders = effectiveBuiltinProviders.overlay(personalProviders);
```

Priority is `Personal > Account Built-in > ZCode Built-in`.

### Ordered Map

ProviderConfigMap is an ordered Map:

- When a later layer overrides an existing providerId, the original position is kept;
- When a later layer adds a providerId, it is appended in the later layer's order;
- Personal-only Providers therefore come after Built-in Providers;
- Account Built-in does not change the base order of ZCode Built-in Providers.

Account Built-in explicitly writes `access.entitled` for each account Provider: `true` when entitled,
`false` when not; on unknown status, the last successful Overlay is kept when one exists, otherwise
fail-closed with `entitled=false`. A non-empty model set returned by the Start Plan account interface wholly
replaces `builtinModelIds`; Individual/Team do not write the field and inherit Built-in. A Start Plan
confirmed available but with no parsed model set can only keep the previous successful Overlay; on first
occurrence it is disabled — it must not fall back to broad Built-in members.

Example:

```text
Built-in: [A, B, C]
Account Built-in: [A-account]
Personal: [Y, C-personal, X, A-personal]

Effective: [A-personal, B, C-personal, Y, X]
```

### Config Item Overlay Principles

Config Overlay uses three states:

```text
undefined -> this layer does not override
concrete value -> overrides the previous layer
null      -> explicitly clears the previous layer
```

The Overlay unit is not an arbitrary leaf of the JavaScript object but one config item the product exposes
to the user:

- A field presented as a complete config item (user sees the full inherited value, edits it whole) is wholly
  replaced by Personal once explicitly provided; arrays, Maps, and objects are never implicitly merged;
- A nested object whose leaves are separately exposed as independent config items overlays per leaf; e.g.
  `input_format.support_image` and `support_video` are two independent switches;
- `undefined` keeps inheriting; a concrete value explicitly replaces; `null` explicitly clears clearable
  fields;
- Displaying the full inherited value in Settings produces no Personal override; only actual user
  modification materializes the complete replacement value. "Restore default" deletes the Personal field and
  re-inherits the latest Built-in/Account Built-in value;
- Whether the UI opens a config item decides product interaction only, not the Schema's expressive power:
  fields hidden, read-only, or without an edit entry in the settings page do not become write-forbidden in
  the Personal Schema; hand-edited config still goes through generic Overlay, structural validation, and
  completeness validation;
- A collection whose members are owned by multiple layers, where upstream additions, deletions, and
  reordering must coexist with user intent, cannot be one whole-overlay field: split the data structure by
  ownership and define combination order, conflicts, upstream changes, and deletion semantics separately.

Therefore `api.headers`, `reasoningLevel.values`, etc., when exposed as one complete config item, are wholly
replaced; an Option Spec's `type/values/max/map` are separately exposed leaves, overlaid per leaf. Provider
model members split into two fields because Built-in and Personal own different members.

Personal Config always stays sparse; the Effective View must not reverse-expand into and pollute Personal.

### `builtinModelIds` and `modelIds`

Provider model members split by ownership:

```text
ZCode Built-in builtinModelIds
└─ members declared by ZCode online config

Account Built-in builtinModelIds (when present)
└─ dynamic members returned by the current account interface, wholly replacing ZCode Built-in

Personal modelIds
└─ members the user adds, deletes, and orders
```

Effective Provider keeps both `builtinModelIds` and `modelIds`. In normal assembly Account Built-in
maintains the former and Personal Settings the latter; they no longer contend for one `models[]`. This is
not a Source field permission system. The Resolver produces a source-aware Model Inventory with the normal
order Built-in first, Personal last.

Both fields follow the Config Overlay three states: `undefined` does not override, `null` explicitly clears
that source's set, an array provides members and order. When generating the Inventory, the Resolver
normalizes a finally missing or `null` set to `[]`; an empty set is a legal member fact, not a Provider
completeness error. Duplicate IDs within one set and the same ID across sets are isolated as Model-level
member issues and must not invalidate the whole Provider; Account/Resolver must not silently deduplicate.
A Model ID is trimmed of leading/trailing whitespace and compared as a case-sensitive exact string.

When the same ID appears in both fields, Built-in-wins produces one Built-in member; duplicates within one
set keep the first occurrence. Later items are deterministically ignored on read, normal Settings forbid
writing them, and they are normalized the next time the related Provider is saved. The system builds no
conflict DTO, suspended identity, or second same-name model. When enabled, completeness, and Provider
visibility are satisfied, the Built-in model enters Selection.

The Account-returned `builtinModelIds` is not an unenforceable client-side authorization whitelist: Personal
can still add other IDs through `modelIds`, and the server authorizes real requests finally. Full member,
conflict, and enable/disable semantics: [`model-membership-and-enablement.md`](./model-membership-and-enablement.md).

## Account Built-in Provider Config

AccountProviderService's input must be the ZCode Built-in Provider Config, not the set with Personal
already applied. It processes only account Providers declared by Built-in:

- Writes `access.entitled` only for the Start, Individual, or Team Built-in Provider matching the current
  structured connection settings;
- May override `builtinModelIds` only when the entitlement interface actually returns a model set;
- Provides no context, max output, input/output formats, Reasoning, or other model static capabilities;
- Does not read, constrain, or rewrite Personal-only Providers;
- Does not override `access`, and does not save product, organization, project, account identity, Token,
  Runtime Key, JWT, or one-time security verification Headers.

Account Built-in Provider Config is an atomic Snapshot from one account and connection resolution. When
resolution fully succeeds it is published as a whole; when any external dependency fails, the previous
successful Snapshot is kept as a whole — no mixing of resolution generations and no per-Family or
per-Provider partial last-known-good. Evolution of the account state model and plan topology must not
change this atomic publishing boundary.

## ProviderConfig

Target fields:

```ts
interface ProviderConfigInput {
  templateId?: string | null;
  group?: "standard-personal" | "zai-family" | "bigmodel-family" | null;
  label?: string | null;
  logo?: { type: "builtin"; key: string } | null;
  visibility?: "visible" | "hidden" | null;
  access?: ProviderAccessConfig | null;
  api?: ProviderApiConfig | null;
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
}
```

`logo` is the final Provider's display configuration. A Template provides the default Logo in its internal
`config`, an Account Provider provides its Logo in its own Built-in Config, and a Personal Overlay may
override or clear it with `null`. The `builtin` key is an open string: an unknown key from a remote release
only falls back to a generic icon without affecting parsing, completeness, or execution; unknown `type` is
still rejected by the current Schema. Packaged assets may provide light/dark files per key per theme, but
theme branching does not enter Provider Config.

`group` is a Concrete Provider's product organization fact, not inferred ad hoc by Host, Renderer, or
Provider ID whitelists. Account Provider roots declare `zai-family` or `bigmodel-family`; Template-created
and fully custom Personal Providers use `standard-personal`. `templateId` only references the official
Template baseline and does not turn a Template into a Provider. In the complete Effective Provider,
Registry Config, and Settings DTO produced by the Resolver, `group` must be complete. Providers keep no
separate `builtin` boolean or top-level `enabled`.

This is the common domain field superset. Normal ZCode Built-in and Account Built-in code maintains
`builtinModelIds`, normal Personal code maintains `modelIds`, and the Effective Provider keeps both. Source
boundaries use their own strict Schemas to reject out-of-scope fields; after entering the domain, the common
Provider Config/Overlay is still reused — no five Runtime types are created.

`visibility` defaults to `visible` and controls only the user Settings/Selection Facade. Whether a Provider
enters the executable Registry is decided by config completeness and Access facts: hidden Providers remain
exactly executable by internal capabilities; visible Providers may still only show issues in Settings for
lack of access materials.

### API

```ts
interface ProviderApiConfig {
  type?: "anthropic-messages" | "openai-chat-completions" | "openai-responses" | null;
  baseURL?: string | null;
  headers?: Readonly<Record<string, string>> | null;
}
```

`api.type` describes the public protocol; `baseURL` is the Provider's static request entry in the current
Environment; `headers` is a static Header. Endpoint cannot be inferred from Model IDs and cannot be placed
in an ordinary Turn's Runtime Provider snapshot.

### Access

```ts
type ProviderAccessConfig =
  | {
      type: "api-key";
      apiKey?: string | null;
      apiKeyManagementUrl?: string | null;
    }
  | {
      type: "zhipu-account";
      accountType: "zai" | "bigmodel";
      mode: "start-plan" | "individual-coding-plan" | "team-coding-plan" | "off-peak";
    };
```

`access.type` describes the primary source of access materials and is orthogonal to `api.type`.
`zhipu-account.mode` is a closed enum of Zhipu account products: official-version request security
verification admission and the Off-Peak protocol are both dispatched by Mode. Instances created from Z.AI
API and BigModel API Templates use ordinary `api-key` Access, do not enter V4, and no pseudo-generic fields
writable by all Access types are created. Dynamic security verification materials, Off-Peak Tickets, and
remote rollout are not persisted into Config. Full execution boundary:
[`request-compatibility-and-access-protocols.md`](./request-compatibility-and-access-protocols.md).

#### api-key

Config directly manages the static access materials needed to call the model API; the current formal field
is the API Key. An Effective Config lacking a non-empty `apiKey` is incomplete; Settings can display and
repair it, but the Provider does not enter the Registry. It is orthogonal to `api.type`: `access.type`
describes the access material source, `api.type` the wire protocol.

#### zhipu-account

ZCode Built-in Providers fix the declared `accountType + mode`; Start, Individual, and Team are separate
Providers. The Account Connection Resolver uses these fields, structured Settings selection, the current
account, and entitlements to project only `access.entitled` and the model members the Start interface
actually returns. Model creation fixes the Built-in-declared `family + mode`.

Each request attempt is checked by the Account Request Auth Service against the static `family + mode` for
the current compatible connection, then obtains Team scope from the current Connection and resolves
materials such as JWT, Runtime Key, API Key, or one-time security verification Headers. Account identity,
product, organization, project, and dynamic credentials do not enter Provider Config or Active Model.

Personal uses whole-replacement semantics for ordinary `api-key` Access; the Personal Source of fixed
`account:*` Providers must not write `access`. Whether the current account has a compatible connection is
judged by Request Auth at request time; the server authorizes finally.

### Credential Principles

> Provider Config is assembly input for model API calls and may save static access credentials or stable
> credential references per Access Type. It is not a unified credential center, is not responsible for all
> dynamic credentials' lifecycles, and does not bear the server-side final authorization ruling.

## Visibility

```text
visible
├─ visible in Provider Settings
└─ visible in Model Selection (with enabled/completeness also satisfied)

hidden
├─ invisible in Provider Settings
└─ invisible in Model Selection
```

Visibility is presentation/option-source configuration, not a security gate. The Registry internally keeps
complete hidden Providers; internal product capabilities can create from them by exact ID. Hidden grants no
exemption from Access, Endpoint, model member, or Model Config completeness.

The never-released `executionOnly`, which combined visibility, Registry exclusion, and completeness
exemption, was deleted outright in M4, with no legacy compatibility read.

## Model Config Rules

Effective Rules compose deterministically at the domain boundary: Built-in keeps publication order, and
Personal `provider-model` keeps internal order, uniformly appended last:

```ts
effectiveModelRules = ModelConfigRules.composeEffective(zcodeBuiltinModelRules, personalModelRules);
```

Built-in and Personal share the Rule structure:

```ts
type ModelConfigRule =
  | {
      type: "provider-model";
      providerId: string;
      modelId: string;
      config: ModelConfig;
    }
  | {
      type: "match";
      providerMatch?: string;
      modelMatch: string;
      apiMatch?: string;
      baseURLMatch?: string;
      config: ModelConfig;
    };
```

Matching is a declarative configuration capability, not a special-case branch in business code. Rules apply
in order; a later hit overrides earlier fields. ZCode Built-in general rules complete all required model
facts, specific rules override differences, and Personal precise rules override last.

The GLM-5.3 family currently contains `glm-5.3` and `glm-5.3-flash`. Flash must enter all Z.ai/BigModel
Providers: API Providers follow the existing lowercase wire ID; account plans and Off-Peak Providers follow
the existing `GLM-*` display/wire ID. It inherits GLM-5.3's context, output limit, reasoning, tools, and
other complete model facts, overriding only the input format to support Image and Video. This relation must
be expressed by contiguous Built-in Model Rules; Runtime, Adapter, and UI must not re-create per-model-ID
special cases.

Model Config is the sole configuration home of model capabilities, Options, and request parameter mappings,
but these facts are not miswritten as "matchable only by modelId." A capability can be a model's public fact
or hold only under a specific Provider, API, or Endpoint access combination; a Rule chooses the minimal
sufficient combination of `modelMatch`, `providerMatch`, `apiMatch`, and `baseURLMatch` for its real
support scope.

`baseURLMatch` is an optional formal-Schema match dimension, but its presence does not obligate Built-in
Rules to use it: prefer `providerMatch` whenever a stable Built-in Provider identity expresses the
difference accurately; use `baseURLMatch` only when a real difference is decided by Endpoint deployment
under the same Provider identity and API type. Enabling URL matching for a fact is ruled case by case; no
generic logic of guessing vendor, model, or Reasoning by URL may be built.

`providerMatch` / `modelMatch` / `baseURLMatch` are regex texts used by the local Rule Resolver, matched in
full against the complete Provider ID, Model ID, and Effective Provider `api.baseURL` respectively.
`modelMatch` is fixed to ASCII case-insensitive matching; it affects config resolution only and never
rewrites the real Model ID sent to the Provider. A rule that truly needs containment writes explicit
leading/trailing `.*`; the Resolver does not auto-widen every exact model rule into contains, because short
IDs like `k3`, `glm-5` would overlap more specific models and wrongly override capability facts by array
order.

`providerMatch` and `apiMatch` stay case-sensitive. `baseURLMatch` is also case-sensitive, but its match
target is not the user-entered raw string: the Resolver first normalizes scheme, hostname, default port,
and trailing slash with a standard URL parser, then matches the normalized result; path and query case is
preserved. Rule authors write patterns against the normalized URL and must not mask Host case differences
through whole-URL case-insensitive matching.

`provider-model` may appear in a Built-in or Personal Source, precisely declaring one Provider/Model
combination. Built-in-specific Rules are managed by the ZCode Built-in Release; Personal-specific Rules by
Settings. `match` lets one declarative Rule cover a group of models — it is not a remote config matcher and
triggers no per-model branch in business code. The settings page writing a single Provider/model creates
only a structured `type="provider-model"`, never encoding IDs into regex.

Only Personal-specific Rules follow the Personal lifecycle: moved on Personal Model rename, deleted on
Personal Model delete; deleting a Provider's Personal Overlay deletes all its Personal-specific Rules.
Built-in-specific Rules and Built-in Match Rules are never auto-rewritten or deleted by these operations.
Restoring a field's default deletes only the corresponding leaf in the Personal-specific Rule; an emptied
Rule is deleted.

Resolution must read the Effective Provider:

```ts
effectiveModelRules.resolve({
  providerId: effectiveProviderId,
  modelId,
  apiType: effectiveProvider.api.type,
  baseURL: effectiveProvider.api.baseURL,
});
```

Renderer, Shared, protocol, and Adapter must not guess a model's capabilities or Reasoning intensity through
string helpers.

### Writing and Arrangement of Built-in Model Rules

ZCode Built-in Rules stay in one array but are no longer split into distant global sections of "all model
facts / all API specializations / all Provider specializations." Apart from the complete fallback and truly
cross-model service rules, rules of the same model family are arranged contiguously so a maintainer sees a
model's complete declaration in one place. Later hits override earlier ones, so the arrangement order is
both a readability spec and runtime semantics:

```text
Complete Fallback
        |
        v
GLM family
├─ family common
├─ model A
│  ├─ model common facts
│  ├─ model + API schema
│  ├─ provider + model
│  ├─ provider + model + API schema
│  └─ provider + model + API schema + Endpoint (only when truly needed)
└─ model B ...
        |
        v
GPT -> Claude -> Grok -> Kimi -> MiniMax -> DeepSeek -> Qwen -> MiMo
        |
        v
Cross-model Provider / Service Rules (only when they cannot fit a single model family)
```

Family reading order follows the Provider product order: GLM first, then GPT, Claude, Grok, Kimi, MiniMax,
DeepSeek, Qwen, MiMo; new families append at their product position. The GLM family carries the common
facts of both ZCode-product and public GLM models; account, Endpoint, or API Schema differences still use
narrower rules.

Within each family, rules are written contiguously by override layer:

| Order | Typical match                                                          | Main responsibility                                                                    |
| ----- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1     | family-scope `modelMatch`                                              | facts shared by same-family models and confirmed identical                             |
| 2     | specific `modelMatch`                                                  | the model's intrinsic Properties, input/output formats, context, Option Specs          |
| 3     | `modelMatch + apiMatch`                                                | the model's Option Map, Replay, and request-field differences under public API Schemas |
| 4     | `providerMatch + modelMatch`                                           | differences of a service's actual deployment of the model                              |
| 5     | `providerMatch + modelMatch + apiMatch`, plus `baseURLMatch` as needed | final differences still caused by API Schema or Endpoint under the same service        |

A model's API specializations follow its common facts contiguously in the stable order
`anthropic-messages`, `openai-chat-completions`, `openai-responses`. Nonexistent combinations write no empty
rules. Provider/Service rules scoped to one family stay inside that family; only rules truly covering
multiple unrelated families go to the trailing Cross-model area.

Mandatory:

- The complete fallback is first, completing all required fields with conservative defaults only;
  family-wide rules precede specific model rules, and no wider rule may be appended after a precise one
  that overrides it;
- One Rule per match condition. Duplicate detection treats `modelMatch` per its case-insensitive semantics;
  duplicate content merges into one config object — never rely on the accidental order of two equivalent
  matchers;
- Generic model facts and API-independent Properties go in the specific model rule; request dialect
  differences in the adjacent API specialization; Provider/Service/Endpoint specializations override only
  differing leaves, never copying a whole model config;
- "OpenAI-compatible" means only similar base request shapes — not that vendor extension fields like
  `enable_thinking`, `thinking`, `reasoningEffort` are identical; such parameters are constrained to the
  minimal combination supported by official service facts;
- The JSON array order already expresses grouping and override relations: add no runtime-meaningless
  `group`/`section`/`name` fields for layout, split Built-in into multiple files, or add a generation
  pipeline;
- Personal Rules always append after all Built-in Rules, keeping final user override priority.

Reordering existing Built-in Rules is a behavior change: for the `providerId/modelId/api.type/baseURL`
combinations actually present in Built-in, compare Effective Model Config before and after. A pure
reordering must keep resolution equivalent; merging duplicate Rules may remove accidental overrides, but
any config value change is a separate, explicit fact correction — an equivalence check of the current
reordering, not a per-commit, per-leaf historical migration audit.

### Fact Sources and Old-implementation Closure

When consolidating Built-in, verify against this evidence priority:

```text
ZCode product/account service contracts
        >
vendor Models API live successful responses
        >
vendor's current official API and model docs
        >
current AI SDK official contract + actual request body
        >
reproducible service requests
        >
old config, Catalog, Preset, hardcode
```

Old implementations only reveal possibly missed facts; they are not automatically the correct answer for new
config. A heavy per-commit, per-leaf migration audit table is not required, but every non-obvious Reasoning,
compatibility switch, or Provider specialization must be explainable by official contracts, product service
facts, or reproducible requests. Once confirmed as carried by Built-in Config, old business hardcode must be
deleted and must not remain as a second fact-source fallback.

Models API evidence scope follows the fields actually present in the response: the ID set proves members
visible to the current access materials; only capability, context, or output limits explicitly returned by
the interface prove the corresponding model facts. A documented example response is not a live catalog, and
a service accepting a request while ignoring its content is not capability proof. The Models API is used
for publishing validation and diff reports, never participating in Runtime Overlay; formal static facts
still enter the Resolver only through the existing Built-in, Account, and Personal layers.

### OpenAI Responses Reasoning

OpenAI Responses generic options still use `Model.options.reasoningLevel`; specific levels map to the raw
request body `reasoning.effort` via the corresponding Model Rule's `optionSpecs.reasoningLevel.map`.
Built-in must not copy literals from OpenAI Chat or third-party OpenAI-compatible services into Responses:
e.g. whether the product generic level `max` maps to OpenAI's `xhigh` must be declared per the effort set
the specific model currently supports.

When OpenAI/Anthropic Providers join Built-in, their models' API-independent facts, API-specific Option
Maps, and request body contract tests must be completed together. Tests should observe the final HTTP
request body, not only internal SDK parameters. For custom Base URLs or SDK-unrecognized reasoning models,
protocol differences go into narrower Model Config Rules; no Runtime global guessing rules are created.

## ModelConfig

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
}
```

`modelId` comes from the Provider's source-aware Model Inventory and resolution context, not repeated in
ModelConfig. `enabled` is an execution gate — not an API Property, and expresses neither server
authorization nor membership. Models have no independent visibility; user visibility is expressed jointly
by Provider visibility and whether the model is executable in the Selection View. ModelConfig's remaining
fields describe the model Properties of the public contract, user-selectable Options, and each Option's
mapping to the target API's raw request body.

Built-in general Rules must complete the `enabled=true` default; specific Built-in Rules may declare
`enabled=false` for deprecated or no-longer-recommended models. Personal-specific Rules may override that
leaf afterwards; normally adding a Personal Model writes `enabled=true` explicitly.

Model Config has no generic Compatibility container. Historical reasoning uniformly keeps canonical facts
with standard Adapter encoding; real reasoning must not be deleted per model, and no synthetic
empty-thinking is fabricated for tool calls. OpenAI-compatible reasoning no longer uses a separate
`openai-reasoning-content` mode; the old GitHub Copilot `omitMaxOutputTokens` and Snowflake
`maxOutputTokensRequestField` are deleted. Official-version request security verification and the Off-Peak
execution protocol are dispatched by the closed `zhipu-account.mode` enum, no longer appear in Model Config,
and are not pseudo-generic Access fields. Exact boundary:
[`request-compatibility-and-access-protocols.md`](./request-compatibility-and-access-protocols.md).

### Properties

```ts
interface ModelPropertiesConfig {
  contextWindow?: number | null;
  input_format?: {
    support_text?: boolean | null;
    support_image?: boolean | null;
    support_video?: boolean | null;
    support_audio?: boolean | null;
    support_pdf?: boolean | null;
  } | null;
  output_format?: {
    support_text?: boolean | null;
  } | null;
  supportsToolCall?: boolean | null;
  supportsJsonSchemaOutput?: boolean | null;
  supportsNativeWebSearch?: boolean | null;
  supportsMidConversationSystem?: boolean | null;
}
```

Rules may default or override per leaf. Effective Model Config must obtain complete `input_format` and
`output_format`; Runtime, Adapter, Compact, Memory, Subagent, and UI all read the same fields and create no
derived capability map. Detailed contract: [`../model/input-output-format.md`](../model/input-output-format.md).

### Option Specs

```ts
interface ModelOptionSpecsConfig {
  reasoningLevel?: {
    type?: "enum" | null;
    // Ordered by reasoning intensity, low to high; the first item is the lowest public level.
    values?: readonly string[] | null;
    map?: string | null;
  } | null;
  maxOutputTokens?: {
    type?: "limit" | null;
    max?: number | null;
    map?: string | null;
  } | null;
}
```

Core understands only generic `reasoningLevel` and `maxOutputTokens`, never Provider dialect fields.
`reasoningLevel.values` is ordered lowest to highest. Normal default selection takes the last item at the
Host Selection boundary; auxiliary calls explicitly using the lowest level select the first item. One must
not infer from level names whether the Provider supports disabling Reasoning.

Each Option's `map` uses restricted CEL reading the final variable of its own Option's name — the Reasoning
Map reads `reasoningLevel`, the Max Output Map reads `maxOutputTokens` — and returns an RFC 7396 JSON Merge
Patch Object. ModelFactory compiles Maps when creating the Active Model; the Adapter applies the Patch on
the AI SDK-serialized final JSON Body, before dynamic auth and signing. Concrete wire fields like
`reasoning_effort`, `thinking.type`, `max_tokens` exist only in Map results — they do not enter Core and no
longer pass through a separate `reasoningMapping` or AI SDK Provider Options. Full contract:
[`../model/model-option-map.md`](../model/model-option-map.md).

All old code identifying Reasoning intensity by specific model must exit; valid differences enter ZCode
Built-in Model Config Rules.

## Completeness Validation

Schema validation covers field format and unknown fields; the Registry complete-type creation entry
recursively checks the post-Overlay final result, expressed as `{ ok: true, config } | { ok: false, issues }`.
The Resolver reuses this one result for Settings diagnostics or the Registry Value; failed candidates do
not enter the Registry, and the successful result's static type no longer contains the sparse Rule's
optional required fields. Filtering by `issues.length === 0` and then bare-asserting the same sparse Config
type is not allowed.

Sparse `ProviderConfig` / `ModelConfig` remain Overlay inputs; the Registry uses `RegistryProviderConfig` /
`RegistryModelConfig` for validated facts. The complete creation entry only tightens the static type of
Effective Config — it adds no persisted Config Source, Runtime DTO, or second config authority.

```ts
interface RegistryProviderConfig extends ProviderConfig {
  readonly access: CompleteProviderAccessConfig;
  readonly api: CompleteProviderApiConfig;
}

interface RegistryModelConfig extends ModelConfig {
  readonly enabled: boolean;
  readonly properties: RegistryModelProperties;
  readonly optionSpecs: RegistryModelOptionSpecs;
}
```

The complete types must also provide serialization contracts returning complete object types: one must not
tighten properties with `extends ModelConfig` while still inheriting a `toJSON()` returning sparse
`ModelConfigObject` — Selection/Protocol would see optional Properties again. Override the serialization
return type or provide a unique `toRegistryJSON()`; never copy and maintain a second DTO.

Provider minimum completeness:

- `access.type` and its static fields;
- `api.type`;
- `api.baseURL`;
- The Resolver produces a legal, ordered Model Inventory; duplicates normalized by Built-in-wins /
  keep-first.

Model minimum completeness:

- Complete `enabled`;
- Complete Properties;
- Complete input/output format;
- Complete max output Option Spec (positive integer max plus a compilable map returning an Object Patch);
- Complete reasoningLevel Option Spec: values non-empty, no blank or duplicate items, ordered low to high,
  compilable map; clients do not guess semantics from names;
- All positive integers and enum values legal.

Runtime, Adapter, and Telemetry must not scan names like `disabled`, `off`, `nothink`, `none` to guess
switch semantics. Maps read only the current Option's final value; they receive no other Option, context,
Provider, Model, or credentials. Settings Resolution may keep disabled, incomplete, and member issues; the
Registry publishes enabled, complete models; cross-set duplicates publish the Built-in identity, single-set
duplicates keep the first. Models have no hidden state. Post-Registry consumers must not re-check or
re-complete Properties, Option Specs, or Provider execution fields.

An enabled `zhipu-account` must have complete `family + mode`; Team scope is not static completeness. When
account dynamic materials are missing, the Adapter fails before the network.

Personal Config need not be complete itself and may inherit Built-in; Settings Preview and Registry both
check after Overlay. Hidden Providers use the same completeness rules.

## Settings and Sparse Saving

Settings reads simultaneously: Personal explicit value, Effective inherited value, validation issues.

An input's real value expresses only the Personal explicit field; the Effective Built-in value may be a
placeholder. When a complete set or object is exposed as one config item, the UI may display its full
inherited value, but only actual user modification writes the modified complete value into Personal. Input
equal to the Built-in default is still saved as explicit Personal; "restore default" deletes the Personal
field.

Model format editing directly maintains nested `input_format/output_format`. Text is locked, Image/Video
editable, PDF/Audio hidden but preserved as-is; saving produces a per-leaf sparse Personal Rule.

Settings interaction and reordering: [`settings.md`](./settings.md).

## Source and Physical Storage

Domain Services consume plain Config Snapshots, unaware of files, databases, or remote services:

```text
ZCode Built-in Config Source ─┐
Personal Config Repository ───┼─> ProviderConfigService
                              └─> ProviderRegistry

Account Built-in Config Source ───> ProviderRegistry
```

Built-in release files are uniformly named `config/provider/zcode-builtin.json`. Desktop, CLI/TUI, tests,
and SEA each explicitly inject an accessible Source path or plain object; `@zcode/provider` reads no files.
The Provider Config chain keeps no `official.json`, old environment variable, or old protocol field
compatibility; the atomic switchover plan:
[`../../steps/todo-10-zcode-builtin-provider-config-naming-cutover.md`](../../steps/todo-10-zcode-builtin-provider-config-naming-cutover.md).

Personal Config uses the current Environment's `.zcode/v2/provider_config.json`, physically isolated from
other consolidated config files. The Repository provides read, change notification, and atomic `update()`;
file locking, atomic writes, retries, and content-revision polling are Repository implementation.

## Old Config Migration

The published old `config.json` is imported one-time, only when the new target file is missing, by the
Host/Standalone composition root inside the Repository lock:

```text
legacy config + current Built-in baseline
                  |
                  v
     project explicitly represented facts
                  |
                  v
       sparse Personal Config + Built-in Rules
                  |
                  v
             validate -> atomic create
```

Custom Providers without a Built-in baseline enter Personal wholly; Providers with a baseline save only
differences. Dynamic account credentials, Runtime Snapshots, Catalog enrichment, and old hardcode do not
participate. The old standalone Provider Store and its Coding Plan Keys are no longer read. Model
Properties not explicitly expressed in old files write no Personal Override; the Built-in general Rule
provides defaults. The Importer adds no `COMPATIBILITY_*` and guesses no values from Catalog, modelId,
Provider type, or Endpoint. On parse failure or post-Overlay completeness failure, the original file is not
modified.

For the Standalone CLI's `~/.zcode/cli/config.json` kept for evaluation compatibility, first import also
preserves custom models' output caps: select the limited positive integer by `limit.output` →
`options.max_tokens` → the model top-level `maxOutputTokens`, writing
`optionSpecs.maxOutputTokens.max` of the precise Personal Model Rule. A rule is created with output only,
without context; when missing, no default is written and the map still inherits from the formal config
rule. String conversion is not accepted, arbitrary options like `extra_body` are not extended, and the
original parser's rejection of illegal explicit fields is unchanged. This exception applies only to the
CLI's first import and does not change Desktop's context-only migration; an existing formal Personal file
is not back-migrated, and modifying the old file does not overwrite the new config. Implementation and
acceptance: [Todo161](../../steps/todo-161-cli-legacy-output-token-migration.md).

The unversioned Legacy importer is a transitional release facility: once the forced-upgrade window closes
and the minimum supported version / upgrade chain guarantees users passed through an importer-bearing
version, or the product explicitly accepts earlier-version users reconfiguring, delete the importer, old
parsers, Catalog dependency, migration-specific constants, and tests. Adjacent `schemaVersion` migrations
of formal Config remain, outside this retirement chain.

The current branch's unreleased Provider Config Schema changes directly to the final structure: no internal
`models[]` version history, no adjacent schema migration, no dual-read of in-development intermediate
formats. Only formally released format changes add adjacent migrations.

## Provider and Model Reordering

The settings page allows dragging only Personal-only Providers. Built-in/Account Built-in Providers keep
Built-in order; Personal overrides of them do not change position. Model dragging reorders only `modelIds`;
`builtinModelIds` keeps the ZCode/Account Built-in managed order. Model dragging does not modify the Model
Config Rules priority order.

## Invariants

- The domain layer has no "Config Document" intermediate concept.
- Provider Overlay is ZCode Built-in -> Account Built-in -> Personal.
- Account Built-in processes only ZCode Built-in account Providers.
- Model Rules are Built-in + Personal and act on the Effective Provider.
- Sparse Rules exist only before Overlay; the Registry publishes only the statically complete Config after
  `requireComplete` succeeds.
- A fully exposed single config item is wholly replaced; collections with members owned by multiple layers
  must split the data structure and define combination semantics.
- Whether the UI opens editing and whether the Schema allows expression are independent; the Personal Schema
  adds no write-forbidden rules by UI visibility or field source — hand-edited config accepts only generic
  structural/completeness validation and request-time failure.
- In normal assembly, Built-in/Account Built-in maintains `builtinModelIds` and Personal maintains
  `modelIds`; this is not a Source field permission system, and duplicates remain explicit conflicts.
- Visibility controls only the user View.
- Access and API type are orthogonal.
- API Keys can be saved in Personal Config; account and call-level dynamic credentials do not enter Config.
- The Account Connection produces the current account, product, and Team scope; `zhipu-account` Access fixes
  only the `family + mode` needed for execution, and the current connection's compatibility is verified at
  request time.
- Hidden Providers gain no completeness or auth exemptions.
- Model capabilities and Reasoning come only from Model Config Rules, never per-model hardcode.
- The Legacy importer migrates only explicit old facts, guesses no capabilities, and is deleted wholesale
  after the forced-upgrade compatibility window ends; normal versioned migrations remain.
