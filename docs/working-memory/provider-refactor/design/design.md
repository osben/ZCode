# Provider Target Design

> Status: Current effective design
>
> Last updated: 2026-09-01

The Provider system accomplishes one thing: it transforms Provider config, Model Config Rules, and one ModelSelection from the target Environment into Models capable of stably encapsulating model API calls.

```text
Provider Config Path                         Model Config Path
====================                       =================

ZCode Built-in Provider Config             ZCode Built-in Model Config Rules
              |                                         |
              v                                         +
Account Built-in Provider Config           Personal Model Config Rules
              |                                         |
              v                                         v
Effective Built-in Provider Config         Effective Model Config Rules
              |                                         |
              v                                         |
    Personal Provider Config                           |
              |                                         |
              v                                         |
    Effective Provider Config                           |
    ├─ providerId / group                              |
    ├─ final api.type                                  |
    ├─ final endpoint                                  |
    ├─ final access                                    |
    ├─ final builtinModelIds                           |
    ├─ final modelIds                                  |
    ├─ final modelOrder                                |
    ├─ final enabled                                   |
    └─ final visibility                                |
              |                                         |
              +-------------------+---------------------+
                                  |
                                  | providerId / modelId / api.type / baseURL
                                  v
                       Effective Model Config
                       ├─ enabled
                       ├─ properties
                       ├─ optionSpecs
                       │  └─ per-option raw-body map
                       └─ necessary request encoding facts
                                  |
                                  v
                    Provider / Model completeness check
                                  |
                                  v
                         Provider Registry
                                  |
                                  | ModelSelection
                                  v
                            ModelFactory
                                  |
                                  v
                                Model
                                  |
                                  v
                      ModelRequest -> Adapter -> API
```

The left path determines which Providers ultimately exist, what models each Provider has, which API and access method to use; the right path determines what capabilities each model has and how options map to request parameters. The two paths merge at the final
`providerId + modelId + api.type + baseURL`.

## Configuration Language

Provider Config resolves in fixed order:

```ts
effectiveBuiltinProviders = zcodeBuiltinProviders.overlay(accountBuiltinProviders);
effectiveProviders = effectiveBuiltinProviders.overlay(personalProviders);
```

Priority is `Personal > Account Built-in > ZCode Built-in`. Account Built-in only processes account Providers declared by ZCode Built-in; the result is Effective Built-in Provider Config. Personal stores user-defined Providers and final overrides.

Ordinary config items continue using full replacement or per-leaf Overlay; Provider model members split into `builtinModelIds` and `modelIds` due to different ownership, with `modelOrder` expressing ordering. Model Config's `enabled` expresses model enable intent; dual-source same ID defaults to Built-in-wins, deterministically ignoring later duplicates; Model Config does not store members or visibility. Full semantics per
[`registry/model-membership-and-enablement.md`](./registry/model-membership-and-enablement.md).

Model Config Rules combine in fixed order:

```ts
effectiveModelRules = ModelConfigRules.composeEffective(zcodeBuiltinModelRules, personalModelRules);
```

Internal order is `ZCode Built-in + Personal provider-model`. Personal JSON stores only precise Rules; physical ordering does not change the precise Rule last-overrides semantics.

Rules resolve models from Effective Provider Config; models must not be resolved before appending Account or Personal Provider Overlay. `Effective` only means Overlay/resolution is complete; it produces no second public DTO.

Full fields, Overlay, visibility, Access, storage, and migration per
[`registry/configuration.md`](./registry/configuration.md).

ZCode Built-in Release Provider/Rule ordering, Match/Exact Rule writing hierarchy, Endpoint specialization, evidence boundaries, and default enable catalog maintenance specs per
[`registry/zcode-builtin-provider-config.md`](./registry/zcode-builtin-provider-config.md).

Model historical playback, request encoding compatibility, and Provider Access product protocol ownership per
[`registry/request-compatibility-and-access-protocols.md`](./registry/request-compatibility-and-access-protocols.md).

Model Option value domains, constrained CEL Map, raw Request Body injection points, and unique request field authority per
[`model/model-option-map.md`](./model/model-option-map.md).

Complete decision narrative of current Provider/Model config system per
[`registry/provider-and-model-configuration-overview.md`](./registry/provider-and-model-configuration-overview.md). This overview establishes the whole mental model first; field-precise contracts remain per topical documents in this design tree.

## Provider Config and Credentials

Provider Config is assembly input for model API calls; it can save static access credentials or stable credential references. It is not a unified credential center; it does not manage all dynamic credential lifecycles; it does not bear the server-side final authorization ruling.

```text
api-key
└─ Config saves static apiKey

zhipu-account
└─ Config saves family, mode
   └─ Request-time Account Request Auth Service resolves scope and dynamic credentials from current compatible connection
```

When Request Auth is missing, Model/Adapter returns typed authorization errors before network requests. Account tokens, Runtime keys, one-time security verification headers, Off-Peak tickets, and other dynamic materials do not enter Provider Config or Registry View. Ordinary API Key Providers can still be saved by Personal Config.

Account Access categories are declared by ZCode Built-in; Account Overlay only writes `access.entitled` and constrains corresponding Provider model members when the server returns account model sets.
`productId`, `organizationId`, `projectId`, account identity, and dynamic credentials are owned by Account Connection Service, resolved at request time by static `family + mode`, and do not enter Provider Config or Active Model.

Start, Individual Coding Plan, and Team Coding Plan of the same Family are three fixed-type independent Built-in Providers. Account Overlay records each fixed Provider's current plan eligibility separately; the same Coding Plan Provider cannot runtime-morph between Individual and Team, and Plan is not inferred from Built-in Provider ID strings. Top-level `enabled` always only expresses whether that Provider definition participates in config resolution; it does not bear account eligibility semantics.

Provider `visibility` only controls whether users can see it in Settings and Model Selection. Hidden Providers still use ordinary completeness checks, Registry, and ModelFactory; visibility does not express authorization or security permissions.

## A Single Ordinary Execution

After a user selects a model in Composer and submits:

```text
1. Entry fixes this ModelSelection
2. Core atomically receives full Submission
3. Registry looks up Effective Provider / Model Config
4. ModelFactory creates Model
5. Agent Loop holds Active Model
6. Each ModelRequest calls Provider through Adapter
7. Usage, Trace, and error attributed to actual Model
```

Selection only saves `providerId`, `modelId`, and generic Options. Endpoint, Access, model Properties,
Option Spec Map, and Provider API protocol come from Registry, ModelFactory, and request-time dependencies. Config updates only affect subsequently created Models; they do not hot-modify currently executing objects.

## Registry, Settings, and Selection

Registry stores all complete, enabled Providers in the current Environment, and models with complete Effective Model Config and `enabled=true` within them, including visible and hidden Providers:

```text
Provider Registry
├─ complete visible Provider
└─ complete hidden Provider
       |
       +--> Provider Settings Facade: projects only visible
       +--> Model Selection Facade: projects only visible
       `--> Internal exact lookup/create: share same Registry
```

Settings Facade simultaneously provides Effective Built-in, Personal explicit fields, Effective Config, member source, enable status, ordering, and completeness issues. Selection Facade only organizes executable models from visible Providers. Built-in/Personal name conflicts return only Built-in candidates; later items normalized on next Provider save. Renderer does not read physical config, does not duplicate Overlay, members, sorting, or candidate algorithms, nor infers model capabilities by modelId.

Full Registry design per [`registry/registry.md`](./registry/registry.md), settings page per
[`registry/settings.md`](./registry/settings.md), runtime assembly per [`registry/runtime.md`](./registry/runtime.md).

## Model Execution Boundary

Model is the only model call object used by business code:

```text
Model
├─ providerId / modelId
├─ immutable ProviderConfig / ModelConfig / ModelOptions
├─ bind(options)
├─ generateText(request)
└─ streamText(request)
```

A single Agent Loop typically holds the same Active Model from start to finish. Guide/"Immediate" are explicit Step switches; already-issued requests continue using the old Model; subsequent Steps use the new Model. Automatic Compact uses Loop's current Active Model. Subagents create their own Models through Registry based on explicit Selection.

Input/output capabilities come directly from `Model.properties.input_format/output_format`; Config, Model, Runtime, Adapter, and protocol do not establish a second capability DTO. See [`model/input-output-format.md`](./model/input-output-format.md).

## Special Execution

Special execution does not carry complete ProviderConfig or ModelConfig, nor creates temporary Providers:

```text
Core Submission
├─ prompt / attachments / mode
├─ ModelSelection
└─ optional execution context
   ├─ Request Auth
   ├─ Ticket / attribution
   └─ Subagent Model override
             |
             v
       Registry / ModelFactory
             |
             v
       Loop Active Model
```

Idle tasks precisely use user-invisible Built-in `account:zai-offpeak-idle-plan` or
`account:bigmodel-offpeak-idle-plan` based on current account Family; both are ordinary, complete Providers, not runtime-morphed at execution. Idle loops do not modify and restore Session Selection; Permission approve/deny uses the same automatic Turn continuing idle Model; Foreground Subagents use idle Selection via generic override and create their own Models. Full semantics per
[`execution/execution.md`](./execution/execution.md).

## State Hierarchy

```text
Composer Selection
└─ Complete model and Reasoning selection for next submission in current draft

App Recent
└─ Recent selection for new App Sessions isolated by workspaceKey

Session Selection
└─ Selection for subsequent ordinary main execution of current Session

Loop Active Model
└─ Immutable Model truly called by current Loop
```

These states cannot simulate each other. Idle tasks, Subagents, and Background do not write back App Recent; idle tasks also do not rewrite Session Selection. Ordinary selections' Reasoning are completed to concrete values at Host Selection boundary by ordered levels; ModelFactory only validates and freezes Active Model, no longer owning Option defaults. See [`interaction/interaction.md`](./interaction/interaction.md).

## Environment Boundary

Provider Config and Registry belong to the target Environment actually executing model requests:

```text
Local Environment  -> Local Config / Registry / Execution
SSH Environment    -> Remote Config / Registry / Execution
Cloud Environment  -> Cloud Config / Registry / Execution
```

This is the long-term ownership blueprint; it does not mean Remote Provisioning, remote settings, or login belong to this Provider Refactor. Desktop continuous, Mobile replayable, Queue, snapshot, and workspace identity are also not Provider semantics; shared protocol changes only perform invariant regression. See [`environment/environment.md`](./environment/environment.md).

## Layered Reading

- [`registry/registry.md`](./registry/registry.md): How config becomes Registry and Model.
- [`registry/configuration.md`](./registry/configuration.md): Fields, Overlay, Visibility, Access, Rules, and storage.
- [`registry/zcode-builtin-provider-config.md`](./registry/zcode-builtin-provider-config.md): Built-in Provider/Model Rule publishing maintenance specs.
- [`registry/model-membership-and-enablement.md`](./registry/model-membership-and-enablement.md): Model member ownership, name conflicts, enable/disable, and UI.
- [`registry/model-creation.md`](./registry/model-creation.md): ModelFactory, Adapter, and request-time auth.
- [`model/model.md`](./model/model.md): Model, ModelRequest, Options, lifecycle, and attribution.
- [`interaction/interaction.md`](./interaction/interaction.md): Submission, Session Selection, and Active Model.
- [`execution/execution.md`](./execution/execution.md): Compact, Subagent, Goal, Background, and idle tasks.
- [`environment/environment.md`](./environment/environment.md): Long-term Environment ownership blueprint.

Design describes only the target system. Migration order and implementation results go to [`../steps/steps.md`](../steps/steps.md); current code facts go to [`../research/research.md`](../research/research.md).
