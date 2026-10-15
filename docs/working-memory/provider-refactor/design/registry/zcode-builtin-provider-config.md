# ZCode Built-in Provider Config Maintenance Design

> Status: Current effective design
>
> This document specifies the long-term maintenance method for `config/provider/zcode-builtin.json`. Field contracts, Overlays, and Registry
> completeness semantics are documented respectively in [`configuration.md`](./configuration.md) and
> [`provider-and-model-configuration-overview.md`](./provider-and-model-configuration-overview.md).

Formal environment source files continue to use `zcode-builtin.json`; test environments use the same directory `zcode-builtin.test.json`.
Both follow the same maintenance specifications and are packaged according to `ZCODE_ENV`; selection and cache contracts are documented in
[dual-environment packaging](../../../../builtin-provider-config-build-environments.md).

## 1. Goals and Boundaries

ZCode Built-in Releases atomically publish two types of content:

```text
ZCode Built-in Release
├─ Account Provider Config Map
├─ Provider Template Map
│  └─ Template metadata shell + Provider Config Overlay
└─ Model Config Rules
```

Account Provider Config Map declares ZCode-maintained account Provider identities and call configs. Provider Template Map provides creation baselines for ordinary API
Providers; each Template stores multi-language `nameMap` and reusable Provider Config overlays in domain shells; they do not enter
Registries. Model Config Rules declare model facts, API/Endpoint request capabilities, Option Specs,
per-option raw-body maps, and Provider/model product facts.

This document is an author writing specification and review mental model; it does not add:

- Rule `priority`, `specificity`, or sorting fields;
- Runtime Rule rearrangement or second Resolver;
- Business code branches written by modelId, Provider ID, or URL;
- `evidence`, `provenance`, or `confidence` fields in configurations;
- New fact sources for Provider/model members, Account entitlements, or Personal intents.

Capability fact maintenance must also distinguish "not found" from "explicitly unsupported":

- When new models have no reliable evidence, the general baseline continues to provide conservative defaults;
- When published model capabilities downgrade from `true` to `false`, there must be current official material's explicit denial, reproducible request results from the target Endpoint,
  or explicit decisions from the service publisher;
- Search result absences, research reports not recorded, or old documents not mentioning, cannot alone serve as capability downgrade evidence;
- When the same model exists in multiple Endpoints/product forms, conclusions can only be written to the Model, API, or Endpoint layer where evidence truly covers; they cannot be extrapolated from one
  product page to all routes.

This asymmetric rule is intentional: unknown models adopting conservative defaults avoids false positive放行; declared and deployed capabilities cannot be silently closed due to one material
refresh omissions.

## 2. Two Rule Types

The system has only two Model Config Rules:

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

Unified terminology:

| Rule type        | Terminology               | Meaning                                                |
| ---------------- | ------------------------- | ------------------------------------------------------ |
| `match`          | Match Rule                | Matches a set of resolution contexts by matcher        |
| `provider-model` | Provider-Model Exact Rule | Precisely matches a `providerId + modelId` combination |

Both Built-in and Personal can contain both types. `Built-in` and `Personal` only indicate Source owners; they do not produce a third
Rule type. Built-in Exact Rules are maintained by Releases; Personal Exact Rules follow the settings page model lifecycle.

## 3. Built-in Rules' Physical Writing Order

Built-in Rules are applied in array order; later-hit config items override earlier ones. The following hierarchy is only the writing order and review mental model for published files,
not calculated by code as priorities:

```text
1. Complete Baseline Match Rule
   └─ modelMatch=.*
   └─ Provides complete, conservative default configs for unknown Personal Models
            |
            v
2. Model Match Rule
   └─ modelMatch
   └─ Model facts independent of API Schema and Endpoints
            |
            v
3. Model + API Match Rule
   └─ modelMatch + apiMatch
   └─ Request capabilities, Option Specs, and parameter mappings under that public protocol
            |
            v
4. Model + API + Endpoint Match Rule
   └─ modelMatch + apiMatch + baseURLMatch
   └─ Verified differences at specific official or compatible Endpoints
            |
            v
5. Provider-scoped Match Rule
   └─ providerMatch + modelMatch
   └─ Service capabilities applicable to all current/future members of that Provider
            |
            v
6. Provider-Model Exact Rule
   └─ providerId + modelId
   └─ Default enabled and narrow product facts not expressible by Endpoints
```

Layers 2-4 of the same model family are placed contiguously to avoid maintaining facts about the same model in different areas of the file. Cross-model
Provider-scoped service facts are placed after all model facts and before Exact Rules. Layer 1 appears only once.
Reasoning Option Spec's `values` must be written from lowest to highest reasoning intensity; the first item is the lowest public level used for auxiliary calls;
the last item is the highest public level used for normal default selections. When models do not support disabling, do not fabricate `off` or `nothink` for unified names.

Resolvers continue to traverse Built-in arrays as-is. Effective Rules are still combined by existing domain boundaries:

```text
Built-in Rules (maintaining physical order)
              +
Personal provider-model Rules (maintaining internal order)
              +
Personal Provider-Model Exact Rules (maintaining internal order)
```

Do not modify `ModelConfigRules.composeEffective()` or add dynamic specificity sorting to implement the above author specifications.

## 4. Facts Served by Each Layer

### 4.1 Complete Baseline

The general baseline ensures any valid Personal Models receive complete Model Configs. Defaults must be conservative:

- Input/output formats only enable explicitly universal Text;
- Unproven media, tools, JSON Schema output, native search, and MCS are `false`;
- Provide complete context, max output, and other required leaves;
- `enabled=true`, allowing users to create and explicitly add Personal Model members to be available.

The general baseline cannot disguise itself as specific models' real capabilities.

### 4.2 Model Match

Model Match Rules only express facts that do not change with API Schemas or Endpoints, such as:

- Context windows and model maximum output hard limits;
- Text/Image/Video/Audio/PDF input facts;
- Text output facts;
- Model-level Tool capabilities that can be reliably expressed by all target Schemas.

Model name matching performs ASCII case-insensitive matching on complete Model IDs, but does not rewrite the real Model IDs sent in requests.

### 4.3 Model + API Match

This layer expresses public protocol differences, such as:

- Complete selectable values of reasoning levels from lowest to highest;
- `optionSpecs.reasoningLevel.map` and `optionSpecs.maxOutputTokens.map`;
- Whether `responseJsonSchema` can be encoded by that Schema;
- Whether Tools, MCS, max output parameters are executable under that Schema;
- `requiresMfjsToolSchema` and other narrow facts truly belonging to request encoding.

"Covering three Schemas" means each maintained model has clear, auditable parsing results for all three Schemas; it does not mean vendor official Endpoints
must support all three Schemas, nor does it require copying complete model facts three times. Missing official protocols use conservative results; third-party compatible Endpoints can be promoted by the next layer.

### 4.4 Model + API + Endpoint Match

Endpoint specializations prioritize using:

```text
modelMatch + apiMatch + baseURLMatch
```

It expresses differences of the same model and Schema on a real service route. `baseURLMatch` performs full regex matching on normalized URLs:
Host casing, default ports, and trailing slashes are already normalized; Paths, Queries, and Fragments still have semantics.

Facts suitable for this layer include:

- JSON Schemas, MCS, or reasoning parameters actually supported by official compatible Endpoints;
- Native Web Search only provided by that Endpoint;
- Verified limitations of the same public Schema across different server-side implementations.

It is not responsible for Provider members, Account entitlements, default enabled states, or access materials. When a Personal Provider points to the same Endpoint,
it should naturally receive the same Endpoint facts.

### 4.5 Provider-scoped Match Rule

When a Provider's service chain provides the same capabilities for all its current and future model members, and that capability cannot be independently expressed by API Schemas or
Endpoints, use:

```text
providerMatch + modelMatch
```

It is still an ordinary Match Rule and does not produce new Rule types. For example, Start Plan, Individual Coding Plan, and Team Coding Plan
use visual models to convert Image/Video to text before the model API, so all model members of those Plan Providers can declare:

```ts
properties.input_format.support_image = true;
properties.input_format.support_video = true;
```

"Multimodal" here only refers to confirmed Image/Video visual inputs; it does not infer Audio or PDF. This Rule must precisely match Plan Providers;
it cannot match ordinary API Providers created by `zai-api` / `bigmodel-api` Templates; the latter continues to use the model API's native capabilities. The system does not exist
`zhipu-account/mode=api-key` "Account API Providers."

Provider-scoped Rules are only used for truly member-wide service facts. Differences only applicable to a single model are still placed in Model/API/Endpoint
or Exact Rules; do not diffuse through `modelMatch=.*`.

### 4.6 Provider-Model Exact Rule

Each `builtinModelIds` member must have exactly one Exact Rule explicitly declaring default `enabled`, avoiding new members unexpectedly entering user candidates due to the general baseline
`enabled=true`. Except for this enabled matrix, Exact Rule fields should remain scarce, mainly responsible for:

- The default `enabled` of that model under a specific Built-in Provider;
- Provider product catalog facts that cannot be accurately expressed by `model + api + baseURL`.

Do not copy facts that could be reused by Endpoint Matches to multiple Exact Rules for writing convenience.

## 5. JSON Schema Output Fields

The target field name is fixed as:

```ts
properties.supportsJsonSchemaOutput: boolean;
```

It only expresses that the current Effective Model can accept the provided `ModelRequest.responseJsonSchema`, and is encoded as JSON Schema constraints by the target Adapter/Schema. It does not mean ordinary JSON, JSON Object Mode, or prompt requirements to return JSON.

Evidence only proving `response_format={type:"json_object"}` means this field must remain `false`. It can only be set to `true` when target Schema/Endpoints can accept JSON Schema. UI text uses "JSON Schema structured output."

The `supportsJsonSchemaOutput` in the current implementation is a legacy name awaiting migration; during migration, Config, Registry, Model, Runtime, Adapter,
Protocol, Settings, and tests must be renamed all at once; no dual fields or Runtime aliases are retained.

## 6. Evidence and Conservative Inference

Each non-obvious fact is classified into one of three categories in the publishing review materials, but the classification is not written into runtime Config:

| Category              | Meaning                                                                                                    | Configurable scope                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Official confirmation | Vendor's current model/API docs explicitly declared                                                        | Corresponding Model, Schema, or Endpoint                           |
| Product confirmation  | ZCode product/service, account interfaces, or internal official contracts explicitly declared              | Corresponding Built-in Provider product facts                      |
| Protocol inference    | Conservative general results provided for third-party compatible services, with no official Endpoint proof | Uncertain capabilities are `false`; Personal overrides are allowed |

### 6.1 Models API is Publishing Evidence, Not a New Runtime Config Layer

Some vendors provide model discovery interfaces alongside reasoning Endpoints:

```text
Base URL + API Schema + Current Access Materials
                    |
                    v
         Provider Models API
                    |
                    +--> Model IDs currently visible under current access materials
                    `--> Optional context / output / capability metadata
```

The query object here is not a Base URL detached from accounts, but `Endpoint + API Schema + current access materials`. The same Endpoint
may return different members under different accounts, regions, plans, or API Keys. The Models API paths and authentication are also jointly determined by protocols and vendors;
mechanically appending `/models` after any `baseURL` is prohibited.

Publishers use results according to the following boundaries:

- Model IDs in real-time successful responses are strong evidence verifying members currently visible under those access materials; example responses in documents can only prove response shapes,
  not replace real-time directories;
- Fields explicitly returned in responses, such as context, max output, input capabilities, thinking, or structured output, can serve as official evidence for corresponding
  Model/API/Endpoint Rules;
- OpenAI-compatible basic Models responses usually only contain IDs, owners, and timestamps; media, reasoning, or
  Option Specs cannot be inferred from this;
- Anthropic Models APIs can currently return richer capabilities and token limits, but third-party Anthropic-compatible
  Endpoints may only implement subsets of these;
- Account or Plan account-specific model collections still belong to Account Overlays; general Models APIs do not override product entitlement interfaces.

Models APIs only enter publishing verification, difference reports, or user-initiated import flows. They do not directly override
ZCode Built-in, Account, or Personal Config during application startup or normal request periods; they do not form a fourth Config layer; nor do they let transient network failures change Registries.

Writing "Structured Output," "Search," or "Tools" on official websites is not sufficient to spread across Schemas, Endpoints. When official materials are missing, conservative rules for all three
Schemas can be supplemented, but risky capabilities cannot be enabled based on same-family, similar names, or marketing terminology.

Capability evidence must also distinguish "service accepts input" from "model consumes input." Requests carrying unknown fields, images, or other content without errors may just be
server tolerance or ignoring; capabilities cannot be set to `true` based on this. Media capabilities require at least official explicit declarations, ZCode product service contracts, or protocol-level tests proving
content actually participates in model answers.

Models from official websites not listed but possibly provided by third-party compatible services can have complete conservative Model Rules; only after official docs, real-time Models APIs
or product facts confirm that the model can be called by target Endpoints and API Schemas can they be added as corresponding official Built-in Provider's
default enabled members. This provides defaults for Personal Providers without disguising compatibility inferences as official product commitments.

## 7. Model Members, Default Enabled, and Initial Ordering

Each Built-in Provider's `builtinModelIds` contains the complete product catalog reserved for user configuration. Default enabled is expressed by that Provider's
Exact Rules.

Published files simultaneously comply with:

```text
builtinModelIds
├─ enabled=true current mainstays or unique models
└─ enabled=false old models, duplicate aliases, or replaced models
```

This is only the Built-in initial member ordering. The system does not add enabled-first dynamic sorting, nor rewrites Personal `modelOrder`. When Account Overlays return model subsets, they project by that Built-in order; after users produce complete `modelOrder`, the existing member ordering algorithm continues to be responsible.

Default enabled reviews must at least answer:

1. Is it the current mainstay model?
2. Does it provide speed, price, visuals, ultra-long context, or Coding capabilities that other enabled models do not?
3. Is it merely another model's alias?
4. Is it already deprecated, offline, or explicitly replaced?
5. Does the current Built-in Endpoint really provide that Model ID?

## 8. Publishing Checks

Each maintenance of Built-in Releases must at least verify:

- Provider Maps and Rules still serve as a single atomic Release;
- Each `builtinModelIds` member can be parsed into complete Model Config;
- Each maintained model has clear parsing results under all three API Schemas;
- Endpoint differences prioritize using `baseURLMatch`; Exact Rules maintain product fact boundaries;
- Provider-scoped Match Rules only express service capabilities成立 for all current/future members;
- Built-in Rule physical order conforms to this document's hierarchy, with no reliance on dynamic priorities;
- `enabled` in Exact Rules is consistent with the initial member ordering of the same Provider;
- Retired/alias models are default-disabled when retained;
- Personal Exact Rules can still override posteriorly;
- Runtime, Adapters, and UIs do not re-infer facts by specific modelId/Provider IDs;
- Non-obvious capabilities have official, product, or reproducible Endpoint evidence.

Publishing checks can use model IDs to verify config facts; production business code must not branch by this.
