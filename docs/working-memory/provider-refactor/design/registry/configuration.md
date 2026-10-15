# Provider Configuration and Registry

> Status: Current effective design
>
> Last updated: 2026-08-26

Provider Registry answers two questions: which complete Providers/Models currently exist in the Environment, and whether a given ModelSelection can locate and validate the corresponding complete config. Model creation is handled by ModelFactory.

```text
ZCode Built-in Provider Templates + Account Providers
              |
              v
Account Built-in Provider Config + Personal Provider Config
              |
              v
    Effective Provider Config ------------------+
                                                  |
ZCode Built-in Model Config Rules                |
              +                                  |
Personal Model Config Rules                      |
              |                                  |
              v                                  |
Effective Model Config Rules --------------------+
              |
              v
      Provider Registry
      ├─ ordered Provider / Model View
      ├─ lookup by providerId / modelId
      ├─ visible Settings / Selection projection
      └─ validate selection
              |
              v
         ModelFactory
              |
              v
         Active Model
```

Registry manages static, re-buildable Provider/Model Views. Tokens, Tickets, one-time security verification Headers, network status, balances,
rate limiting, and server-side final authorization are handled at request time and do not enter Registry.

## Input Sources

### ZCode Built-in Provider Config

The Provider Templates and account Provider declarations provided by ZCode with the product. Domains, code, and physical naming uniformly use
`zcodeBuiltin*` / `zcode-builtin`; the published file is `config/provider/zcode-builtin.json`. `official` is not used as an alias for this
Provider Config chain, nor is a compatibility entry retained. Implementation cutover is documented in
[`../../steps/todo-10-zcode-builtin-provider-config-naming-cutover.md`](../../steps/todo-10-zcode-builtin-provider-config-naming-cutover.md).

### Account Built-in Provider Config

AccountProviderService only reads Providers from ZCode Built-in with `access.type = "zhipu-account"`, projecting Account Built-in Provider Config based on the current account, plan, and team connection. It participates in Overlay after ZCode Built-in and before Personal:

Provider Config Snapshots must separately carry `zcodeBuiltinRevision` and `personalRevision`; Account Snapshots must
carry `basedOnZCodeBuiltinRevision`. Registry can only resolve and publish when the two are equal:

```text
B0 + A0
   |
   | Built-in -> B1
   v
B1 + A0  -- not published, continues serving old Registry
   |
   | Account -> A1 basedOn B1
   v
B1 + A1  -- atomically published
```

This revision only proves the derivation source of client Account Overlays; it does not require the Account server and Built-in publishing interfaces to share versions. Personal-only updates do not change `zcodeBuiltinRevision`, so they continue to immediately resolve and publish. On first startup, before the formal Account Snapshot arrives, the process can generate an initial Overlay with the same revision and all account Providers set to `access.entitled=false` based on the current Built-in, completing Registry ready in a fail-closed manner; wildcard revisions are prohibited.

```text
ZCode Built-in account Provider
        +
current account connection
        +
entitlement result
        |
        v
Account Built-in Provider Config
├─ access.entitled (whether the current structured selection and account entitlement allow usage)
└─ builtinModelIds (when the interface truly provides)
```

Account does not read, constrain, or rewrite Personal-only Providers; it does not provide model Properties, Reasoning, context, or
max output. Account Built-in Config does not save account Tokens, Runtime Keys, or Headers. Account Connection is the authoritative source for these connection fields; Account Built-in Provider Config is the structured snapshot for Provider execution side.

### Personal Provider Config

Personal saves Providers created from Templates or fully custom Personal Providers, and final overrides on Account Providers. Ordinary
API Providers can save API Keys here. Personal shares field-level Overlay language; normal settings writes maintain `modelIds`, and does not provide interaction to modify `builtinModelIds`. This is a maintenance responsibility, not a Source field permission system.

### Model Config Rules

ZCode Built-in and Personal Model Config Rules are concatenated in array order, with Personal last. Rules only resolve members within Effective Provider source-aware Inventory; they do not add or remove models from Providers. When cross-collection names conflict, only Built-in identity is kept; Personal-specific Rules for the same `providerId/modelId` are still normal Overlays by users on Built-in Models.

## Two Rounds of Resolution

### First Round: Provider

```ts
const effectiveBuiltinProviders = zcodeBuiltinProviders.overlay(accountBuiltinProviders);
const effectiveProviders = resolveProviderTemplates(
  zcodeBuiltinProviderTemplates,
  effectiveBuiltinProviders,
  personalProviders,
);
```

Overlay preserves the position of pre-existing keys; same-key overlays per-field from the back layer; newly added keys from the back layer are appended in their own order.
Model members are combined by ownership and not overlaid on a single shared list:

```text
ZCode Built-in builtinModelIds
      |
      v  Account Built-in provides full list overwrite
Effective Built-in builtinModelIds
      |
      +------------------+
                         |
Personal modelIds -------+
                         |
                         v
             source-aware Model Inventory
```

Account Built-in model collection is the dynamic member facts currently allowed for that account Provider. Personal can still declare its own
`modelIds`; the server performs final authentication and authorization on real requests.

Both member fields remain sparse three-state in Config; when generating Inventory, collections that are ultimately missing or `null` are normalized to empty arrays. Empty member collections are valid. Duplicates within the same collection keep the first; cross-collection duplicates use Built-in-wins, producing only one Built-in identity.
Normal Settings prohibit creating duplicates; save-related Providers normalizes duplicates and stale items at save time. Duplicates do not create conflict DTOs, nor does the entire Provider become invalid.

### Second Round: Model

```ts
const effectiveModelRules = new ModelConfigRules([
  ...zcodeBuiltinModelRules.rules(),
  ...personalModelRules.rules(),
]);

for (const [providerId, provider] of effectiveProviders) {
  for (const entry of resolveModelInventory(provider)) {
    const modelId = entry.modelId;
    effectiveModelRules.resolve(providerId, modelId, provider.api?.type);
  }
}
```

The final `api.type` participates in Rule matching, so Personal's Provider API override changes the final Option Map and
raw Request Body fields. Renderer, Shared factories, protocols, and Adapters do not write business-specific checks by modelId; when defaults need to be provided by name convention, use declarative Built-in Rules.

## Completeness

Registry recursively validates Effective Provider Config and each Effective Model Config before publishing Providers.

The Resolver calls the unique complete type creation entry, and reuses its combined result to generate Resolved/Settings diagnostics or executable Registry Values. Failed candidates can remain fixable in Settings; they cannot enter Registry; successful results must not treat Properties or Option Specs as optional downstream. The complete type is merely the type expression of validation results, not a new config layer, persistent object, or independent authority.

All Providers, regardless of `visibility`, must possess:

- `access.type`;
- `api.type`;
- non-empty `api.baseURL`;
- Resolver has produced a valid, ordered Model Inventory from `builtinModelIds` and `modelIds`;
- Each executable identity has complete `enabled`, `properties`, `optionSpecs`, and fields required by the current type.

Registry publishes types `RegistryProviderConfig` and `RegistryModelConfig`. They are the same Effective Config object through a static type expression after completeness validation, not forming a new config layer, persistent object, or Runtime DTO. Provider types only tighten Execution-required fields like Access/API/Endpoint; membership is projected as `Provider.models`; execution consumers do not re-read member arrays. Serialization of complete types must similarly return complete static structures; sparse base class `toJSON()` must not re-leak optional Properties to Selection or Protocol.

Cross-collection Model ID duplicates use Built-in-wins, publishing only Built-in identity; single-collection duplicates keep the first occurrence. Later-item reads are deterministically ignored; Settings saves related Providers normalizes, not creating conflict objects or suspended second identities.

Access-specific requirements:

| Access type     | Config completeness requirement | Request-time requirement                                                           |
| --------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `api-key`       | Non-empty `apiKey`              | Use static Key from Config                                                         |
| `zhipu-account` | Complete `family + mode`        | Account Request Auth resolves dynamic materials from current compatible connection |

Missing account dynamic materials is not Config incomplete; it is a request-time auth error; Adapters must fail before sending network requests.
Network unreachable, Token expired, insufficient balance, rate limiting, and vendor errors are also not static Registry filtering.

## Visibility

Providers use a single user-visible field:

```ts
type ProviderVisibility = "visible" | "hidden";
```

Default is `visible`. Visibility only affects user-facing Facades:

```text
Provider Registry
├─ visible Provider
└─ hidden Provider
       |
       +--> Settings Facade filters hidden
       +--> Selection Facade filters hidden
       `--> internal lookup keeps hidden
```

Hidden does not mean trusted, system permission, temporary execution, or no auth required. It does not bypass `enabled`, Config completeness, or ModelFactory.
Internal product capabilities knowing exact Selections use Registry's ordinary lookup, and create through the same ModelFactory; no special
Model creation interface or second Registry is added.

The currently unpublished `executionOnly` simultaneously bears both visibility and completeness exemption; M4 directly deletes it and does not enter formal compatibility history.

## Registry View and Index

The Registry's complete internal View preserves order and identity:

```ts
interface Provider {
  providerId: ProviderId;
  config: RegistryProviderConfig;
  models: readonly {
    modelId: ModelId;
    config: RegistryModelConfig;
  }[];
}
```

Model Config no longer has visibility. `enabled=false` and config-incomplete models do not enter the Registry View; Settings uses config resolution results to separately retain these members for editing and re-enabling.

Internal indexes only reference this View:

```text
Provider[]
└─ providerById
   └─ modelById
      └─ lookup / validate
```

Indexes do not form a second set of config facts. After any Config Source update, Registry creates a new View and index; already-created
Models continue holding old configs until their own lifecycle ends.

## Settings and Selection Facade

```text
Provider Config Service ─ Personal Config ─┐
                                            ├─ Provider Settings Facade
Provider Registry ─ Effective View ─────────┘

Provider Registry
└─ Model Selection Facade
```

Settings Facade:

- Filters hidden Providers;
- Retains disabled Models for editing and re-enabling;
- Returns Effective Built-in, Personal explicit fields, Effective Config, explicitly `builtin` model members, completeness issues, and
  enabled/executable/selectable;
- Provider and Model are saved separately: Provider operations only write Personal Provider Config; single-model operations only write precise Personal
  Model Config Rules; adding, deleting, renaming, and reordering models use atomic operations in the member domain;
- Writes to the same Provider are completed in user operation order; different Providers can run in parallel;
- After saving completes, wait for Registry to observe the new revision.

Selection Facade:

- Filters hidden Providers, and disabled and incomplete Models;
- Does not generate candidates for `enabled=false` and incomplete models; cross-collection name conflicts continue to use Built-in candidates;
- Organizes candidates by Provider;
- Validates `providerId`, `modelId`, and general Options;
- Does not manage Composer Draft, App Recent, Session Selection, or Active Model.

Selection Facade only projects visible candidates and revision/change events; it does not provide a general `validate()`. The Renderer
can display unavailable based on this, but cannot replicate the authority option validator. When truly starting execution, the current Agent's ModelFactory
must re-validate Selection using the complete Registry; internal product capabilities can do narrow checks by exact ID before saving or dispatching. Internal products directly use Registry by exact ID. This difference is a View/call scenario difference, not a security authorization boundary.

## Account Dynamic Connection

Provider Config's `zhipu-account` Access only fixes `family + mode`. Account identity, specific products, and Team scope
are owned by the Account Connection/Subscription Service; they do not enter Registry or Active Model. Each request attempt
reads the current compatible connection based on static constraints; without a compatible connection or credentials, it fails before the network. The server remains the final authorization authority.

## Access and API Orthogonality

`access.type` describes how access materials are obtained; `api.type` describes the public request protocol. The two are orthogonal: API Keys, account connections, and request-time injection can all access Anthropic Messages, OpenAI Responses, or OpenAI Chat Completions.

```text
ProviderConfig
├─ access.type -> credential acquisition
└─ api.type    -> Adapter/request shape
```

Adapter's internal SDK type does not enter Provider Config. Static Headers belong to Provider Config; dynamic account or call-level
Headers belong to Request Auth and are merged at request time.

## Change Notification and Lifecycle

Registry simultaneously subscribes to Config Sources and Account Sources:

```text
Built-in / Personal changed ─┐
Account changed ─────────────┼─> invalidate -> rebuild -> new revision
                             └─> notify Facades / Model runtime
```

The first read is a ready barrier. When refresh fails, Sources handle according to their own last-known-good rules; Registry does not restore another set of facts from old Provider Stores, Workspace Catalogs, or Runtime Snapshots.

Specific Sources, processes, and refresh chains are documented in [`runtime.md`](./runtime.md), Model creation and dynamic auth in
[`model-creation.md`](./model-creation.md), and settings interaction in [`settings.md`](./settings.md).

## Invariants

- Provider Overlay is ZCode Built-in -> Account Built-in -> Personal.
- Account Built-in only reads ZCode Built-in account Providers; it does not read Personal.
- Model Rules are Built-in + Personal, and act on Effective Providers.
- During normal assembly, Built-in/Account Built-in maintain `builtinModelIds`; Personal maintains `modelIds`; no Source field permission system is established.
- Dual-source same ID is an explicit conflict; normally disabled models do not enter Selection; Settings always visible.
- Built-in/Personal same ID: Built-in identity continues execution; conflicting Personal precise Rules are suspended.
- Provider/Model Visibility only affects user Facades; hidden complete enabled members remain in Registry.
- All visible/hidden Providers use the same completeness validation, Registry, and ModelFactory.
- Access acquisition method and API protocol are orthogonal.
- Static Account Access only saves family, mode; Team Scope is read at request time from the current Connection.
- Whether the UI offers editing does not change Schema expressibility; Personal manual configuration does not accept source qualification validation.
- Dynamic credentials do not enter Registry; the server makes the final authorization.
- Config updates do not hot-modify already-created Models.
