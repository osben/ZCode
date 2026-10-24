# Provider Target Design

> Status: Current effective design (last updated 2026-09-01)

The Provider system turns Provider config, Model Config Rules, and one ModelSelection from the target
Environment into Models that stably encapsulate model API calls.

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

The left path determines which Providers exist, their models, and the API/access method; the right path
determines model capabilities and option-to-parameter mapping. The paths merge at
`providerId + modelId + api.type + baseURL`.

## Configuration Language

Provider Config resolves in fixed order:

```ts
effectiveBuiltinProviders = zcodeBuiltinProviders.overlay(accountBuiltinProviders);
effectiveProviders = effectiveBuiltinProviders.overlay(personalProviders);
```

Priority is `Personal > Account Built-in > ZCode Built-in`. Account Built-in processes only account Providers
declared by ZCode Built-in; the result is Effective Built-in Provider Config. Personal stores user-defined
Providers and final overrides.

Ordinary config items use full replacement or per-leaf Overlay; Provider model members split into
`builtinModelIds` and `modelIds` by ownership, with `modelOrder` expressing ordering. Model Config `enabled`
expresses model enable intent; dual-source same ID defaults to Built-in-wins, deterministically ignoring
later duplicates; Model Config stores no members or visibility. Full semantics per
[`registry/model-membership-and-enablement.md`](./registry/model-membership-and-enablement.md).

Model Config Rules combine in fixed order:

```ts
effectiveModelRules = ModelConfigRules.composeEffective(zcodeBuiltinModelRules, personalModelRules);
```

Internal order is `ZCode Built-in + Personal provider-model`. Personal JSON stores only precise Rules;
physical ordering does not change the precise Rule last-overrides semantics.

Rules resolve models from Effective Provider Config; models must not be resolved before appending the
Account or Personal Provider Overlay. `Effective` only means Overlay/resolution is complete; it produces no
second public DTO.

- Fields, Overlay, visibility, Access, storage, migration: [`registry/configuration.md`](./registry/configuration.md).
- Built-in Release Provider/Rule ordering, Match/Exact Rule hierarchy, Endpoint specialization, evidence
  boundaries, default enable catalog: [`registry/zcode-builtin-provider-config.md`](./registry/zcode-builtin-provider-config.md).
- Model historical playback, request encoding compatibility, Provider Access product protocol ownership:
  [`registry/request-compatibility-and-access-protocols.md`](./registry/request-compatibility-and-access-protocols.md).
- Model Option value domains, constrained CEL Map, raw Request Body injection points, unique request field
  authority: [`model/model-option-map.md`](./model/model-option-map.md).
- Full decision narrative: [`registry/provider-and-model-configuration-overview.md`](./registry/provider-and-model-configuration-overview.md) —
  the mental-model overview; field-precise contracts stay in the topical documents.

## Provider Config and Credentials

Provider Config is assembly input for model API calls; it can save static access credentials or stable
credential references. It is not a unified credential center, does not manage dynamic credential lifecycles,
and does not bear the server-side final authorization ruling.

```text
api-key
└─ Config saves static apiKey

zhipu-account
└─ Config saves family, mode
   └─ Request-time Account Request Auth Service resolves scope and dynamic credentials from current compatible connection
```

When Request Auth is missing, Model/Adapter returns typed authorization errors before network requests.
Account tokens, Runtime keys, one-time security verification headers, Off-Peak tickets, and other dynamic
materials do not enter Provider Config or Registry View. Ordinary API Key Providers can be saved by Personal
Config.

Account Access categories are declared by ZCode Built-in; the Account Overlay writes only `access.entitled`
and constrains Provider model members when the server returns account model sets. `productId`,
`organizationId`, `projectId`, account identity, and dynamic credentials are owned by the Account Connection
Service, resolved at request time by static `family + mode`, and do not enter Provider Config or Active
Model.

Start, Individual Coding Plan, and Team Coding Plan of the same Family are three fixed-type independent
Built-in Providers. The Account Overlay records each fixed Provider's current plan eligibility separately; a
Coding Plan Provider cannot runtime-morph between Individual and Team, and Plan is not inferred from
Built-in Provider ID strings. Top-level `enabled` expresses only whether that Provider definition
participates in config resolution; it carries no account eligibility semantics.

Provider `visibility` only controls whether users see it in Settings and Model Selection. Hidden Providers
still use ordinary completeness checks, Registry, and ModelFactory; visibility expresses no authorization or
security permission.

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

Selection saves only `providerId`, `modelId`, and generic Options. Endpoint, Access, model Properties, Option
Spec Map, and Provider API protocol come from Registry, ModelFactory, and request-time dependencies. Config
updates affect only subsequently created Models; they do not hot-modify executing objects.

## Registry, Settings, and Selection

Registry stores all complete, enabled Providers in the current Environment, and models within them with
complete Effective Model Config and `enabled=true`, visible and hidden alike:

```text
Provider Registry
├─ complete visible Provider
└─ complete hidden Provider
       |
       +--> Provider Settings Facade: projects only visible
       +--> Model Selection Facade: projects only visible
       `--> Internal exact lookup/create: share same Registry
```

The Settings Facade provides Effective Built-in, Personal explicit fields, Effective Config, member source,
enable status, ordering, and completeness issues. The Selection Facade organizes only executable models from
visible Providers. Built-in/Personal name conflicts return only Built-in candidates; later items are
normalized on the next Provider save. The Renderer does not read physical config, does not duplicate Overlay,
members, sorting, or candidate algorithms, nor infers model capabilities by modelId.

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

A single Agent Loop typically holds the same Active Model from start to finish. Guide/"Immediate" are explicit
Step switches: already-issued requests continue on the old Model; subsequent Steps use the new Model.
Automatic Compact uses the Loop's current Active Model. Subagents create their own Models through Registry
from explicit Selection.

Input/output capabilities come directly from `Model.properties.input_format/output_format`; Config, Model,
Runtime, Adapter, and protocol establish no second capability DTO. See
[`model/input-output-format.md`](./model/input-output-format.md).

## Special Execution

Special execution carries no complete ProviderConfig or ModelConfig and creates no temporary Providers:

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

Idle tasks precisely use the user-invisible Built-in `account:zai-offpeak-idle-plan` or
`account:bigmodel-offpeak-idle-plan` based on the current account Family; both are ordinary, complete
Providers, not runtime-morphed at execution. Idle loops do not modify and restore Session Selection;
Permission approve/deny uses the same automatic Turn continuing the idle Model; Foreground Subagents use the
idle Selection via generic override and create their own Models. Full semantics per
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

These states cannot simulate each other. Idle tasks, Subagents, and Background do not write back App Recent;
idle tasks also do not rewrite Session Selection. Ordinary selections' Reasoning is completed to a concrete
value at the Host Selection boundary by ordered levels; ModelFactory only validates and freezes the Active
Model, no longer owning Option defaults. See [`interaction/interaction.md`](./interaction/interaction.md).

## Environment Boundary

Provider Config and Registry belong to the target Environment actually executing model requests:

```text
Local Environment  -> Local Config / Registry / Execution
SSH Environment    -> Remote Config / Registry / Execution
Cloud Environment  -> Cloud Config / Registry / Execution
```

This is the long-term ownership blueprint; Remote Provisioning, remote settings, and login are not part of
this Provider Refactor. Desktop continuous, Mobile replayable, Queue, snapshot, and workspace identity are
not Provider semantics; shared protocol changes only perform invariant regression. See
[`environment/environment.md`](./environment/environment.md).

## Layered Reading

- [`registry/registry.md`](./registry/registry.md): config becomes Registry and Model.
- [`registry/configuration.md`](./registry/configuration.md): fields, Overlay, Visibility, Access, Rules, storage.
- [`registry/zcode-builtin-provider-config.md`](./registry/zcode-builtin-provider-config.md): Built-in Provider/Model Rule publishing maintenance.
- [`registry/model-membership-and-enablement.md`](./registry/model-membership-and-enablement.md): model member ownership, name conflicts, enable/disable, UI.
- [`registry/model-creation.md`](./registry/model-creation.md): ModelFactory, Adapter, request-time auth.
- [`model/model.md`](./model/model.md): Model, ModelRequest, Options, lifecycle, attribution.
- [`interaction/interaction.md`](./interaction/interaction.md): Submission, Session Selection, Active Model.
- [`execution/execution.md`](./execution/execution.md): Compact, Subagent, Goal, Background, idle tasks.
- [`environment/environment.md`](./environment/environment.md): long-term Environment ownership blueprint.

Design describes only the target system. Migration order and implementation results go to
[`../steps/steps.md`](../steps/steps.md); current code facts go to [`../research/research.md`](../research/research.md).
