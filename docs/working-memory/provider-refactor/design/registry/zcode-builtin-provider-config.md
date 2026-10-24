# ZCode Built-in Provider Config Maintenance Design

> Current effective design. This document specifies long-term maintenance of `config/provider/zcode-builtin.json`; field contracts, Overlays, and Registry completeness semantics live in [`configuration.md`](./configuration.md) and [`provider-and-model-configuration-overview.md`](./provider-and-model-configuration-overview.md).

Formal environments use `zcode-builtin.json`; test environments use the sibling `zcode-builtin.test.json`. Both follow the same maintenance rules and are packaged by `ZCODE_ENV`; selection and cache contracts are in [dual-environment packaging](../../../../builtin-provider-config-build-environments.md).

## 1. Goals and Boundaries

A ZCode Built-in Release atomically publishes:

```text
ZCode Built-in Release
├─ Account Provider Config Map
├─ Provider Template Map
│  └─ Template metadata shell + Provider Config Overlay
└─ Model Config Rules
```

The Account Provider Config Map declares ZCode-maintained account Provider identities and call configs. The Provider Template Map provides creation baselines for ordinary API Providers; each Template stores multi-language `nameMap` and reusable Provider Config overlays in domain shells and never enters Registries. Model Config Rules declare model facts, API/Endpoint request capabilities, Option Specs, per-option raw-body maps, and Provider/model product facts.

This document is an author writing specification and review mental model. It does not add:

- Rule `priority`, `specificity`, or sorting fields;
- Runtime Rule rearrangement or a second Resolver;
- Business code branching by modelId, Provider ID, or URL;
- `evidence`, `provenance`, or `confidence` fields in configurations;
- New fact sources for Provider/model members, Account entitlements, or Personal intents.

Capability maintenance must distinguish "not found" from "explicitly unsupported":

- New models without reliable evidence keep the general baseline's conservative defaults.
- Downgrading a published capability from `true` to `false` requires explicit denial in current official material, reproducible request results from the target Endpoint, or an explicit service-publisher decision.
- Absent search results, unrecorded research, or old documents not mentioning a capability are never sufficient downgrade evidence.
- When a model exists across multiple Endpoints/product forms, conclusions are written only at the Model, API, or Endpoint layer the evidence truly covers; never extrapolated from one product page to all routes.

This asymmetry is intentional: conservative defaults for unknown models avoid false-positive admission; declared, deployed capabilities must not be silently disabled by one missed material refresh.

## 2. Two Rule Types

Only two Model Config Rules exist:

```ts
type ModelConfigRule =
  | {
      type: "match";
      providerMatch?: string;
      modelMatch: string;
      apiMatch?: string;
      baseURLMatch?: string;
      config: ModelConfig;
    }
  | {
      type: "provider-model";
      providerId: string;
      modelId: string;
      config: ModelConfig;
    };
```

| Rule type        | Terminology               | Meaning                                                |
| ---------------- | ------------------------- | ------------------------------------------------------ |
| `match`          | Match Rule                | Matches a set of resolution contexts by matcher        |
| `provider-model` | Provider-Model Exact Rule | Precisely matches a `providerId + modelId` combination |

Both Built-in and Personal may contain both types; `Built-in` / `Personal` only name Source owners and create no third Rule type. Built-in Exact Rules are maintained by Releases; Personal Exact Rules follow the settings-page model lifecycle.

## 3. Built-in Rules' Physical Writing Order

Built-in Rules apply in array order; later hits override earlier ones. The hierarchy below is only the published file's writing order and review model — never a code-computed priority:

```text
1. Complete Baseline Match Rule
   └─ modelMatch=.* — complete, conservative defaults for unknown Personal Models
2. Model Match Rule
   └─ modelMatch — model facts independent of API Schema and Endpoints
3. Model + API Match Rule
   └─ modelMatch + apiMatch — request capabilities, Option Specs, parameter mappings under that protocol
4. Model + API + Endpoint Match Rule
   └─ modelMatch + apiMatch + baseURLMatch — verified differences at specific Endpoints
5. Provider-scoped Match Rule
   └─ providerMatch + modelMatch — service capabilities for all current/future members of that Provider
6. Provider-Model Exact Rule
   └─ providerId + modelId — default enabled and narrow product facts not expressible by Endpoints
```

Layers 2-4 of one model family sit contiguously, so facts about one model are not scattered through the file. Cross-model Provider-scoped service facts sit after all model facts and before Exact Rules. Layer 1 appears exactly once. Reasoning Option Spec `values` are written from lowest to highest reasoning intensity: the first item is the lowest public level used for auxiliary calls; the last is the highest public level used for normal default selections. When a model cannot disable reasoning, do not fabricate `off` or `nothink` unified names.

Resolvers still traverse Built-in arrays as-is; Effective Rules combine through existing domain boundaries:

```text
Built-in Rules (physical order)
  + Personal provider-model Rules (internal order)
  + Personal Provider-Model Exact Rules (internal order)
```

Do not modify `ModelConfigRules.composeEffective()` or add dynamic specificity sorting to serve this author specification.

## 4. Facts Served by Each Layer

### 4.1 Complete Baseline

The general baseline guarantees every valid Personal Model a complete Model Config. Defaults are conservative:

- Input/output formats enable only explicitly universal Text;
- Unproven media, tools, JSON Schema output, native search, and MCS are `false`;
- Complete context, max output, and all other required leaves are provided;
- `enabled=true`, so users can create and add Personal Model members that work.

The baseline never impersonates a specific model's real capabilities.

### 4.2 Model Match

Model Match Rules express only facts that do not change with API Schema or Endpoint: context windows and max-output hard limits; Text/Image/Video/Audio/PDF input facts; Text output facts; model-level Tool capabilities reliably expressible by every target Schema. `modelMatch` is ASCII case-insensitive matching on complete Model IDs and never rewrites the real Model ID sent in requests.

### 4.3 Model + API Match

This layer expresses public protocol differences: complete selectable reasoning levels from lowest to highest; `optionSpecs.reasoningLevel.map` and `optionSpecs.maxOutputTokens.map`; whether `responseJsonSchema` can be encoded by that Schema; whether Tools, MCS, and max-output parameters execute under that Schema; `requiresMfjsToolSchema` and other narrow request-encoding facts.

"Covering three Schemas" means each maintained model has clear, auditable resolution results for all three Schemas — not that vendor official Endpoints must support all three, and not copying model facts three times. Missing official protocols use conservative results; third-party compatible Endpoints can be promoted by the next layer.

### 4.4 Model + API + Endpoint Match

Endpoint specialization uses `modelMatch + apiMatch + baseURLMatch` and expresses differences of one model and Schema on a real service route. `baseURLMatch` fully regex-matches normalized URLs: host casing, default ports, and trailing slashes are already normalized; Paths, Queries, and Fragments still carry semantics.

Suitable facts: JSON Schemas, MCS, or reasoning parameters actually supported by official compatible Endpoints; Native Web Search provided only by that Endpoint; verified limitations of one public Schema across server-side implementations. This layer is not responsible for Provider members, Account entitlements, default enabled states, or access materials. A Personal Provider pointing at the same Endpoint naturally receives the same Endpoint facts.

### 4.5 Provider-scoped Match Rule

When a Provider's service chain applies one capability to all current and future model members, and that capability cannot be expressed by API Schema or Endpoint alone, use `providerMatch + modelMatch`. It is still an ordinary Match Rule — no new Rule type. Example: Start Plan, Individual Coding Plan, and Team Coding Plan convert Image/Video to text with visual models before the model API, so all members of those Plan Providers may declare:

```ts
properties.input_format.support_image = true;
properties.input_format.support_video = true;
```

"Multimodal" here means confirmed Image/Video visual input only — never Audio or PDF. This Rule must precisely match Plan Providers; it must not match ordinary API Providers created from `zai-api` / `bigmodel-api` Templates, which keep the model API's native capabilities. There is no `zhipu-account/mode=api-key` "Account API Provider" type.

Provider-scoped Rules are only for truly member-wide service facts. Single-model differences stay in Model/API/Endpoint or Exact Rules; never diffuse them through `modelMatch=.*`.

### 4.6 Provider-Model Exact Rule

Every `builtinModelIds` member must have exactly one Exact Rule explicitly declaring default `enabled`, so new members cannot unexpectedly enter user candidates through the baseline's `enabled=true`. Beyond this enabled matrix, Exact Rule fields stay scarce: the model's default `enabled` under that Built-in Provider, and Provider product-catalog facts not expressible by `model + api + baseURL`. Do not copy Endpoint-reusable facts into multiple Exact Rules for writing convenience.

## 5. JSON Schema Output Fields

The target field is fixed:

```ts
properties.supportsJsonSchemaOutput: boolean;
```

It only means the Effective Model accepts the provided `ModelRequest.responseJsonSchema`, encoded as JSON Schema constraints by the target Adapter/Schema. It never means ordinary JSON, JSON Object Mode, or prompt-based JSON instructions. Evidence proving only `response_format={type:"json_object"}` keeps this field `false`; it becomes `true` only when the target Schema/Endpoint accepts JSON Schema. UI text uses "JSON Schema structured output."

The current `supportsJsonSchemaOutput` name is a legacy awaiting migration; the migration renames Config, Registry, Model, Runtime, Adapter, Protocol, Settings, and tests all at once, with no dual fields or Runtime aliases.

## 6. Evidence and Conservative Inference

Every non-obvious fact is classified in publishing review materials (never written into runtime Config):

| Category              | Meaning                                                                                           | Configurable scope                                             |
| --------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Official confirmation | Vendor's current model/API docs explicitly declared                                               | Corresponding Model, Schema, or Endpoint                       |
| Product confirmation  | ZCode product/service, account interfaces, or internal official contracts explicitly declared     | Corresponding Built-in Provider product facts                  |
| Protocol inference    | Conservative general results for third-party compatible services, with no official Endpoint proof | Uncertain capabilities are `false`; Personal overrides allowed |

### 6.1 Models API is Publishing Evidence, Not a New Runtime Config Layer

Some vendors offer model discovery interfaces beside reasoning Endpoints. The query object is not a bare Base URL but `Endpoint + API Schema + current access materials`: the same Endpoint may return different members under different accounts, regions, plans, or API Keys. Models API paths and authentication are decided by protocol and vendor; mechanically appending `/models` to any `baseURL` is prohibited.

Publisher boundaries for results:

- Model IDs in real-time successful responses are strong evidence of members currently visible under those access materials; document example responses prove only response shape, never a live catalog.
- Explicitly returned fields (context, max output, input capabilities, thinking, structured output) are official evidence for the corresponding Model/API/Endpoint Rules.
- OpenAI-compatible basic Models responses usually contain only IDs, owners, and timestamps; media, reasoning, or Option Specs cannot be inferred from them.
- Anthropic Models APIs can return richer capabilities and token limits, but third-party Anthropic-compatible Endpoints may implement only subsets.
- Account/Plan-specific model collections still belong to Account Overlays; general Models APIs never override product entitlement interfaces.

Models APIs enter publishing verification, difference reports, or user-initiated import flows only. They never override ZCode Built-in, Account, or Personal Config during startup or normal requests, form no fourth Config layer, and never let transient network failures change Registries.

"Structured Output", "Search", or "Tools" on official websites does not spread across Schemas and Endpoints. Missing official material may be supplemented with conservative rules for all three Schemas, but risky capabilities are never enabled from same-family names, similar names, or marketing terms.

Capability evidence must also distinguish "service accepts input" from "model consumes input": requests with unknown fields or images passing without error may only be server tolerance or ignoring. Media capabilities need at least an official explicit declaration, a ZCode product service contract, or protocol-level tests proving the content actually reaches model answers.

Models absent from official sites but plausibly served by third-party compatible services get complete conservative Model Rules; they become default-enabled members of the corresponding official Built-in Provider only after official docs, live Models APIs, or product facts confirm the model is callable by the target Endpoints and API Schemas. This provides Personal Provider defaults without disguising compatibility inference as official product commitment.

## 7. Model Members, Default Enabled, and Initial Ordering

Each Built-in Provider's `builtinModelIds` holds the complete product catalog reserved for user configuration; default enabled is expressed by that Provider's Exact Rules:

```text
builtinModelIds
├─ enabled=true current mainstays or unique models
└─ enabled=false old models, duplicate aliases, or replaced models
```

This is only the Built-in initial member ordering: no enabled-first dynamic sorting, no rewriting of Personal `modelOrder`. When Account Overlays return model subsets, they project by that Built-in order; once users produce a complete `modelOrder`, the existing member-ordering algorithm takes over.

Default-enabled review answers at least: (1) is it a current mainstay model? (2) does it offer speed, price, visuals, ultra-long context, or Coding ability no other enabled model has? (3) is it merely another model's alias? (4) is it deprecated, offline, or explicitly replaced? (5) does the current Built-in Endpoint actually serve that Model ID?

## 8. Publishing Checks

Every Built-in Release maintenance verifies at least:

- Provider Maps and Rules remain one atomic Release;
- Every `builtinModelIds` member resolves to a complete Model Config;
- Every maintained model has clear resolution results under all three API Schemas;
- Endpoint differences use `baseURLMatch` first; Exact Rules keep product-fact boundaries;
- Provider-scoped Match Rules express only capabilities that hold for all current/future members;
- Built-in physical order follows this document's hierarchy, with no reliance on dynamic priorities;
- Exact Rule `enabled` matches the Provider's initial member ordering;
- Retired/alias models retained are default-disabled;
- Personal Exact Rules can still override posteriorly;
- Runtime, Adapters, and UIs re-infer nothing by specific modelId/Provider ID;
- Non-obvious capabilities have official, product, or reproducible Endpoint evidence.

Publishing checks may verify config facts by model ID; production business code must never branch on it.
