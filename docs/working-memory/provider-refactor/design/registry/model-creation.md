# Model Creation and Request Auth

Model creation has only one public chain:

```text
ModelSelection
      |
      v
Current Agent Registry lookup + validation
      |
      v
ProviderConfig + ModelConfig + ModelOptions
      |
      v
ModelFactory
      |
      v
Model
```

Normal sessions, settings page connectivity tests, Subagents, Compact, Goal, Background, Repo Wiki, and idle tasks all use this chain. Visibility only affects user Facades; it does not produce a second Registry, ModelFactory, or execution-only create API.

## ModelSelection

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
  };
}
```

Selection does not carry Endpoint, Access Secrets, Provider Config, Model Config, Adapter type, or model capabilities.
Registry locates the current Effective Config by `providerId + modelId` and validates options against Option Specs.

Selection's options are selection facts, not Provider/Model Config snapshots:

- Formal Selections must carry a valid `reasoningLevel`; when creating a new default selection, only the Host Initial Selection Resolver is allowed to fill once by `values.at(-1)`;
- `maxOutputTokens` is not part of Selection; Agents/callers explicitly decide per Model Request based on the model's `optionSpecs.maxOutputTokens.max` and current task budget;
- `options: {}` normalizes to field absence; formal Selections do not save `null`; patch `null` only expresses deletion of overrides;
- ModelFactory only validates and freezes; it does not fill execution defaults from Option Specs, nor does it write back to Selection or any product records.

When historical runs need to record actual values, use Model/execution facts; do not re-interpret old Selections using later-changed Option Specs.

Registry lookup simultaneously executes Model Config `enabled` gates. `enabled=false` models can still be edited and re-enabled in Settings, but cannot enter normal candidates, default/fallback selections, or create Models through internal exact IDs. Visibility only controls the user interface exposure scope; it does not bypass enabled.

Only Providers have `visibility`, defaulting to `visible`. User entries use the Selection Facade and can only select executable Models from visible Providers; internal product capabilities can create Models from enabled Models in hidden Providers using Registry by exact ID. This difference is a candidate View difference, not an auth or security boundary.

## ModelFactory Input

The runtime `ModelFactory` receives `ModelSelection` and performs final completeness validation against the current Agent Registry before truly creating a Model. After validation passes, the internal assembly layer passes the already-looked-up complete input to the Adapter; the Adapter does not query Registry in reverse:

```ts
interface AdapterModelFactoryInput {
  providerId: string;
  modelId: string;
  providerConfig: RegistryProviderConfig;
  modelConfig: RegistryModelConfig;
  options: Pick<ModelOptions, "reasoningLevel">;
  requestDependencies: ModelRequestDependencies;
}
```

The user `ModelSelectionFacade` only provides visible candidates; it does not expose execution validation methods. Internal product capabilities can use narrow Registry checks from specific Services before saving or dispatching, but cannot replace ModelFactory's final validation.

`RegistryProviderConfig` / `RegistryModelConfig` are static narrowed results of the same Effective Config through a single completeness boundary; Factories do not accept sparse Overlay Config, nor do they refill fields or prove completeness in Bootstrap/Adapter.

`ModelRequestDependencies` includes process-level network/signing Services, and also allows assembling the current execution scope's Request Auth Source. The Source is an execution dependency of the Model, not Config, Selection, or a new Model type; the Model takes current materials from it on each request attempt. Ordinary public `ModelRequest` adds no credential fields.

This way, the Factory can be reused across tests, different Entries, and visible/hidden Providers on the same Registry. After Registry updates, only subsequent inputs are affected; already-created Models hold old configs, Options, and execution resources, continuing to complete their current lifecycle.

## Provider Config to Execution Assembly

ModelFactory passes the same complete Provider/Model Config references from the Registry directly to the Adapter; Bootstrap does not copy the Provider map, nor compiles a same-shape execution DTO first:

```text
RegistryProviderConfig + RegistryModelConfig
          |
          | same complete objects
          v
Adapter private execution closure
├─ SDK kind / factory
├─ baseURL / static headers
├─ api static credential
├─ signing / network infrastructure
└─ model factory cache
```

The private execution closure has no independent Source; it does not participate in Config Overlay, model selection, Visibility, or Model Properties resolution.
The Adapter only holds process-level network, signing, routing, retry, and other execution infrastructure; it does not hold Provider lists, nor does it expose a `replaceRegistryConfig()` that business callers can update.

## Access Types

### api-key

```text
Personal/Built-in Provider Config
└─ access.type = api-key
   └─ apiKey
        |
        v
ModelFactory / Adapter
        |
        v
Provider Request
```

API Key is a static Config field. Effective Providers missing a Key are incomplete and do not enter Registry. Settings can display the issue and fill in; connectivity tests use the saved formal Model.

### zhipu-account

```text
ZCode Built-in Provider Config
└─ access.type = zhipu-account
   └─ family + mode
        |
        v
ModelFactory fixes static account access category
        |
        v
Each request attempt
        |
        v
Account Request Auth Service(current compatible connection)
        |
        v
ModelRequestAuth { apiKey, headers }
```

Access explicitly saves the Family and Mode needed for call assembly. Account identity, products, and Team scope are owned by the Account Connection Service; each attempt resolves the current compatible connection based on the static category. When switching to an incompatible Family/Plan or logging out, it fails before the network; the current connection and refreshed credentials of the same Family/Plan can be used by old Active Models.

Start Plan, Individual Coding Plan, and Team Plan can share Account Provider infrastructure, but correspond to independently typed Built-in Providers. Account Built-in Overlay only projects `access.entitled` for the current account. Account Services determine how to obtain request materials; the server determines whether to ultimately authorize.

There is no `enabled` at the top level of Providers; account plan eligibility is expressed through `zhipu-account.entitled`. Start Plan can also constrain members using non-empty `builtinModelIds` returned by the account interface; Individual/Team inherits Built-in members. Any such Account Overlay is only allowed to create subsequent Models by Registry after matching the ZCode Built-in revision that produced it.

### Off-Peak Request-time Materials

```text
Provider Config
└─ access.type = zhipu-account
   └─ mode = off-peak
        |
        v
ModelFactory creates ordinary Model
        |
        v
Each Model request attempt
        |
        v
ModelRequestDependencies.requestAuth.resolve()
        |
        +-- Request Auth present -> Adapter request
        `-- missing              -> typed auth error before network
```

Off-Peak does not save Secrets. Its dynamic materials are assembled by this idle execution at Model creation time, while ordinary `zhipu-account` Modes are resolved by the Account Request Auth Service at call time.

Request Auth is a per-request-attempt dependency within the execution scope:

- Does not enter ProviderConfig, ModelConfig, or Registry View;
- Does not enter Session Selection, App Recent, or Personal Config;
- Does not enter conversation events, snapshots, or logs;
- Retries can only be reused or refreshed within the current valid call/execution context;
- Fails before the network when missing, expired, or unresolvable.

## Static and Dynamic Headers

```text
ProviderConfig.api.headers          -> static headers
Account / Off-Peak request source   -> dynamic auth headers
ModelRequest / Adapter options      -> protocol request fields
```

The Adapter merges and protects auth fields at fixed priorities. Renderer, Core business logic, and Model Config Rules do not assemble JWTs, Tickets, one-time security verification, organization/project, or Provider dialect Headers.

## Idle Tasks

`account:zai-offpeak-idle-plan` and `account:bigmodel-offpeak-idle-plan` are two complete ZCode Built-in Providers;
the Scheduler precisely selects one based on the current account Family; the Provider itself does not switch Families at execution time:

```text
ProviderConfig
├─ visibility = hidden
├─ access.type = zhipu-account
├─ access.mode = off-peak
├─ api.type
├─ api.baseURL
├─ static headers (if any)
└─ builtinModelIds

Model Config Rules
└─ properties / optionSpecs (including per-option raw-body map)
```

The Host/Scheduler dispatches ordinary ModelSelection and provides Request Auth, Tickets, and necessary attribution for this automatic Turn. It does not carry Provider/Model static snapshots, nor creates temporary Provider Sources:

```text
Core Submission
├─ idle ModelSelection
└─ execution context
   ├─ Request Auth
   ├─ Off-Peak Ticket
   └─ optional Subagent override
            |
            v
Registry lookup + ModelFactory
            |  Assemble this round's requestAuth source
            |
            v
Idle Active Model
```

Request Auth/Tickets are only valid for this valid dispatch. When a Ticket expires, is cancelled, fails, succeeds, is preempted, or the process restarts, the Scheduler ends the current execution context; after re-securing a ticket, it sends a new Submission and creates a new Model. Task queuing, re-runs, and settle do not belong to Provider/Registry.

## Active Model

The Model returned by ModelFactory is an immutable execution object:

```text
Model
├─ fixed providerId / modelId
├─ fixed ProviderConfig / ModelConfig
├─ fixed Selection/Binding Options
├─ fixed account family / mode (if applicable)
└─ request-time dependency ports
```

Ordinary config updates, Composer selection changes, or account global switches do not modify old Models. Guides create and switch new Active Models at explicit Step boundaries; already-issued requests continue to be completed by the old Model.

Idle tasks create their own Loop Active Models but do not write Session Selection. Automatic Compact uses the current Active Model; Subagents create their own Models based on the final Selection.

## Subagent

```text
Core Server override
        >
Subagent Profile Selection
        >
Parent Active Selection
        |
        v
Registry / ModelFactory
        |
        v
Child-owned Model
```

Each Child owns its own Model and does not borrow the parent's mutable object. Idle tasks pin Foreground Children's idle Selection through general override, and pass the current Request Auth/Ticket context to Child requests; Background is refused by Tool Policy before making model requests.

## Adapter

The Adapter is only responsible for Provider protocol and IO:

```text
ModelRequest
      |
      v
Adapter
├─ API Schema serialization
├─ reasoning parameters
├─ input media validation/encoding
├─ request auth resolution
├─ retry / stream handling
└─ error normalization
```

Core does not understand `reasoning_effort`, `enable_thinking`, `thinkingBudget`, or specific Header names; Model Config Rules provide the mapping of public Options to Adapter parameters. Input/output formats are read directly from Model.properties, not inferred by modelId.

## Usage, Trace, and Errors

Each request records the actual Model identity:

```text
providerId
modelId
effective options
request source / task attribution
usage
error
```

Off-Peak taskId, Goal, Compact, Subagent, and Repo Wiki are execution source dimensions; they do not replace Provider/Model attribution. Retries cannot attribute a request to another Model; if the product explicitly switches the Model, a new Model and new execution boundary must be created.

## Error Boundaries

| Stage           | Typical Errors                                                                       |
| --------------- | ------------------------------------------------------------------------------------ |
| Config parse    | schema/unknown field                                                                 |
| Completeness    | Missing access/api/baseURL/models/model config                                       |
| Selection       | provider/model/options does not exist or is invalid                                  |
| ModelFactory    | Adapter/execution dependencies cannot assemble                                       |
| Request auth    | Invalid Account Access, missing/expired Request Auth                                 |
| Adapter/network | Auth rejection, rate limiting, service errors, protocol parsing, stream interruption |

Each layer reports only its own errors; it does not silently fallback using old Runtime Snapshots, Catalogs, or default Providers.

## Invariants

- All Models are created through the same Registry/ModelFactory chain.
- Visibility only affects user Facades.
- Hidden Providers still use ordinary completeness and Access validation.
- Disabled Models do not enter candidates, fallback, or ModelFactory creation; internal exact lookups also cannot bypass.
- Adapter private Factories do not query Registry in reverse; runtime ModelFactories must query the current Agent Registry at the creation boundary and fully validate Selection.
- Config updates do not hot-modify already-created Models.
- API Keys can be saved by Config; Account and Off-Peak dynamic materials are obtained at request time.
- Account Providers fix `family + mode`; current account, products, and Team scope do not enter Models.
- Missing Request Auth must fail before the network.
- Submissions do not carry complete ProviderConfig or ModelConfig.
- Adapter execution projections have no independent fact sources.
- Usage, Trace, and errors are attributed to actual Models.
