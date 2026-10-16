# Provider and Model Configuration System Overview

> Status: Current decision summary; does not replace precise field contracts in individual topic designs
>
> Last updated: 2026-09-01

This document provides a complete narrative of the product and domain decisions already confirmed for the ZCode Provider and Model configuration system. It only answers "what the system is, where each fact belongs, and how they ultimately take effect"; it does not describe how old code migrates, nor does it save implementation steps.

## 1. What the System Ultimately Accomplishes

Provider and Model configurations both serve the same goal: helping users encapsulate a model API call.

```text
Provider Config Path                         Model Config Path
====================                       =================

ZCode Built-in Provider Templates          ZCode Built-in Model Config Rules
        + Account Providers                             |
              |                                         +
              v                            Personal Model Config Rules
Account Built-in Provider Config                        |
              |                                         v
              v                            Effective Model Config Rules
    Personal Provider Config                            |
              |                                         |
              v                                         |
    Effective Provider Config                           |
    ├─ identity / template / group                     |
    ├─ API schema / Endpoint                           |
    ├─ Access                                           |
    ├─ visibility                                       |
    ├─ Built-in / Personal model members                |
    └─ model order                                      |
              |                                         |
              +-------------------+---------------------+
                                  |
                                  | providerId / modelId /
                                  | api.type / baseURL
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
                           Model -> Adapter -> API
```

The left path answers "which Providers ultimately exist in the current Environment, which models each Provider has, and how to access services"; the right path answers "what capabilities a model has, which parameters can be selected, and how these parameters map to the target API." The two paths only merge at the final model resolution; they do not impersonate each other.

Access materials needed for final calls may come directly from Config, or be obtained at request time. Account-type Provider Config does not manage account dynamic credentials; account connections and request auth services provide materials at execution time; the server still handles final authorization. Ordinary API Providers can directly save API Keys in Personal Config.

## 2. Five Configuration Input Sources

The system has only five configuration input sources:

| Source                              | Meaning                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| ZCode Built-in Provider Config    | Account Providers published by ZCode, and reusable Provider Templates |
| Account Built-in Provider Config  | Further constraints by the current account on Built-in account Providers |
| Personal Provider Config          | User-created Providers, and user overrides on existing Providers |
| ZCode Built-in Model Config Rules | Static facts about models and API mappings published by ZCode |
| Personal Model Config Rules       | User's sparse posterior overrides on model facts |

Each source has its own strict input Schema. The five Schemas constrain "what each source can write," but after entering domain resolution, they still use common Provider Config, Model Config, and Overlay languages; five separate Runtime types are not established.

Provider Overlay order is fixed as:

```text
Provider Template? -> ZCode Built-in Account Provider? -> Account Overlay? -> Personal
                                                                      |
                                                                      v
                                                       Effective Provider Config
```

Therefore, Personal is always the final user override. Account's responsibility is only to further constrain account-related Providers in ZCode Built-in; it does not read, modify, or constrain Personal-only Providers.

Model Rules are not three-layer Provider Overlays, but concatenation of two ordered arrays:

```text
ZCode Built-in Model Config Rules
                  +
Personal Model Config Rules
                  |
                  v
Effective Model Config Rules
```

Personal Rules come last. Each Rule only overrides the config items it explicitly provides; Rules are not responsible for creating model members.

Overlay is a natural, reusable config composition semantics and mechanism: it specifies how the same config slot is inherited, overridden, and cleared across multiple input layers. The Provider/Model domain uses this mechanism to implement its own domain semantics, and independently defines config space, member composition, default state, and lifecycle operations. Overlay is not a universal abstraction that can naturally express all business semantics; config structures must obey domain models and cannot be shaped by product semantics in reverse from Overlay's existing capabilities.

## 3. The Accurate Meaning of "Built-in"

`Built-in` only means that the Provider or Model member is provided by ZCode's built-in facts; it does not mean:

- Using ZCode accounts;
- Already having access permissions;
- Already configured credentials;
- Defaulting to enabled;
- Always appearing in the model selector.

Provider Templates are not Providers, and do not have `providerId`, `group`, execution state, or Registry identity. They simply provide reusable Built-in inheritance baselines when creating Personal Providers. Templates use domain shells to store their own `nameMap` and internal `config` overlays; Model Config Rules continue to be centrally maintained and do not enter those shells. Real Provider roots are only Account Built-in Providers and Personal Providers. Account Providers use explicit `group` to express Families; ordinary Personal Providers use `standard-personal` by default.

This must distinguish sparse inputs from complete results:

```text
Provider Template
└─ keyed by templateId; does not declare group, nor enters Registry

Account Built-in Provider root declarations
└─ group = zai-family | bigmodel-family

Personal Provider root declarations
├─ group = standard-personal
└─ templateId? pointing to an optional Built-in Template baseline

Account / existing Provider's Personal Overlay
└─ does not provide group, nor has the authority to change it

Effective Provider / Registry / Settings DTO
└─ group must be a complete value
```

Therefore, Providers no longer save extra `builtin` booleans, nor do they have `standard-builtin` Concrete Providers. Settings Views directly return accurate `templateConfig?`, `effectiveBuiltinConfig?`, `personalConfig?`, and `effectiveConfig`; Renderers do not guess sources by IDs or groupings. Built-in sources for Models are not written into Model Rules; the Host generates derived sources needed for display and operations based on whether members come from `builtinModelIds` or `modelIds`. When Built-in and Personal share the same ID, only one Built-in member is formed.

## 4. What Provider Config is Responsible For

Provider Config is responsible for the Provider-side assembly facts for model API calls:

```text
Provider Config
├─ providerId / templateId? / group / label / logo
├─ visibility
├─ api.type / baseURL / static headers
├─ access
├─ builtinModelIds
├─ modelIds
└─ modelOrder
```

`visibility=hidden` only hides normal Settings and Selection; complete and enabled hidden Providers can still be used precisely by internal products through ordinary Registry and ModelFactory. The system does not save Provider `selectable`.

There is no `enabled` at the top level of Providers. Personal Providers are fixed in Settings once created; Providers with incomplete config can still be edited, but do not enter the executable Registry. Account Providers are fixed into their corresponding Families; account eligibility is only expressed by `zhipu-account access.entitled`. Model execution toggles are still expressed by Model Config `enabled`.

## 5. Model Members, Enablement, and Ordering

The three model arrays in Providers each have only one meaning:

```text
builtinModelIds
└─ Members managed by ZCode Built-in or Account Built-in

modelIds
└─ Personal members managed by users

modelOrder
└─ Complete display order organized by users
```

Members only come from `builtinModelIds + modelIds`. `modelOrder` cannot create or enable members; Model Config Rules cannot create members either.

When Built-in and Personal members share the same ID, Built-in takes priority. Duplicate IDs within a single array keep the first occurrence. Reading deterministically ignores duplicate later items; no conflict objects are created; the normal settings page prohibits users from writing duplicates, and duplicate-related arrays are normalized the next time they are saved.

Model enablement belongs to the `enabled` of Model Config. Built-in general Rules provide complete default values; specific Built-in Rules can default old models that are obsolete or no longer recommended to `false`; Personal-specific Rules come after Built-in Rules and can only override the `enabled` leaf of a specific Provider/Model. Disabled models still remain in Settings, along with their own config and ordering, but cannot execute, test, fallback, or be created by exact ID.

Model basic ordering is unified as:

```text
Built-in not appearing in modelOrder
                +
Members still valid in modelOrder
                +
Personal not appearing in modelOrder
```

When normal settings pages create new Personal Models, the same atomic save updates `modelIds`, the complete `modelOrder`, and creates a Personal-specific Rule for that model, explicitly writing `enabled=true`. Therefore, "unsorted Personal" only handles user-handwritten, incomplete, or non-normal settings page writes; normal new models do not fall into the third segment. When users drag, they also save the complete order of all current valid members and clean up stale/duplicate IDs.

Provider ordering uses Personal top-level `providerOrder`, no longer borrowing Provider Map insertion order. Z.ai/BigModel Account Families continue as fixed product areas and do not participate in normal Provider dragging; all Personal Providers uniformly participate in normal ordering. When creating Template instances or fully custom Providers, the current complete normal Provider ordering should be written to `providerOrder` as well; the unsorted tail segment only handles deterministic normalization for external handwritten or abnormal inputs.

## 6. Enabled, Executable, and Selectable

These three words belong to different layers:

```text
Enabled
└─ Effective Model Config.enabled

Executable
└─ Registry results after current target Host completes member, enable, and completeness resolution

Selectable
└─ Selection View after Executable results are further filtered by normal user visibility
```

The set relationship is:

```text
Selectable Models
    ⊆
Executable Models
    ⊆
Enabled Models ⊆ Provider Model Members
```

`executable` and `selectable` are not Config fields. Entering Registry itself means executable; entering the Model Selection View itself means selectable. Settings can return derived states and specific issues for display purposes, but cannot save them back as facts.

Providers do not need independent selectable. Whether a Provider appears in the model selection interface depends only on whether it is visible and has at least one selectable Model.

## 7. What Model Config Rules are Responsible For

Model Config is only responsible for facts about models or model/API combinations:

```text
Model Config
├─ enabled
├─ properties
│  ├─ contextWindow
│  ├─ input_format / output_format
│  ├─ supportsToolCall
│  ├─ supportsJsonSchemaOutput
│  ├─ supportsNativeWebSearch
│  └─ supportsMidConversationSystem
├─ optionSpecs
│  ├─ reasoningLevel.values/map
│  └─ maxOutputTokens.max/map
├─ requiresMfjsToolSchema
└─ Narrow compatibility facts confirmed by evidence and truly belonging to request encoding
```

Each Option's `map` directly generates the RFC 7396 Patch for the target API's raw JSON Request Body; independent `reasoningMapping`, AI SDK Provider Options mappings, and duplicate max-output field authorities do not exist. The precise contract is documented in [`../model/model-option-map.md`](../model/model-option-map.md).

Model Config does not contain model `visibility`, Provider Access, credentials, members, or ordering. Models do not have a second set of visibility; whether normal users can see models is determined by the Selection View formed by Provider visibility and Model enabled together.

Personal Rules are divided into two categories:

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

The effective combination is fixed as `ZCode Built-in Rules + Personal provider-model Rules`.
Personal only allows exact `providerId + modelId` overrides; settings pages must not manufacture global match rules by rewriting JSON physical arrangement.

Both Built-in and Personal Rule Sources can use `type="provider-model"`: it expresses that facts belong to a precise Provider/Model combination. Built-in-specific Rules are managed by ZCode Built-in Releases and are unaffected by settings page lifecycle operations; Personal-specific Rules are managed by the settings page, moved when Personal Models are renamed, and deleted when Personal Models are deleted.

Only Built-in Sources can use `type="match"` to express groups of targets. Personal does not save or read global Match Rules; specific Rules use structured IDs and do not need to escape IDs to regex, nor do they use easily misleading `exclusive=true` flags.

Rules can use `modelMatch`, `providerMatch`, `apiMatch`, and optional `baseURLMatch` based on true facts. This does not mean hardcoding models in business code: matching and config values belong to Built-in/Personal Rules; Adapters and Runtime only read final parsed results.

Built-in Rules' stable organization order is an author specification for published files: after complete conservative fallbacks, place Model Matches, Model + API Matches, Model + API + Endpoint Matches, Provider-scoped Matches applicable to all members, and a few Provider-Model Exact Rules in sequence; models of the same family are arranged contiguously. `modelMatch` performs ASCII case-insensitive regex matching on complete Model IDs; other matchers match according to their respective contracts. Rules still only apply in physical array order; later hits override earlier ones. The complete maintenance specification is documented in [`zcode-builtin-provider-config.md`](./zcode-builtin-provider-config.md).

## 8. Model Input Output Format

Config, Registry, Model, Runtime, Adapters, and protocols all use the same real structure:

```ts
properties: {
  input_format: {
    support_text: boolean;
    support_image: boolean;
    support_video: boolean;
    support_audio: boolean;
    support_pdf: boolean;
  }
  output_format: {
    support_text: boolean;
  }
}
```

No flat capability DTOs are established, nor is another set of media facts derived from modelId, Provider type, or Session default models. PDF continues to participate in real request checks and existing encoding chains; Audio currently exists only as complete static facts. Settings pages only display locked Text and editable Image/Video/PDF; hidden Audio must be preserved as-is when editing other fields.

## 9. Provider Access and Request Compatibility

`access.type` describes how access materials are obtained; `api.type` describes which public protocol the requests use; the two are orthogonal. Zhipu product protocols use a limited Access Mode:

```text
zhipu-account/start-plan
└─ Official version access security verification

zhipu-account/individual-coding-plan | team-coding-plan
└─ ZCode V4 transport request proof admission; not spread to ordinary api-key Providers

zhipu-account/off-peak
└─ Off-Peak queuing, Ticket, and retry protocol entry
```

These fields are not Model capabilities. Dynamic security verification materials, Runtime Keys, JWTs, Off-Peak Tickets, and remote rollouts do not enter Config.

Confirmed compatibility decisions are:

- OpenAI-compatible reasoning uses real canonical history and current SDK native encoding; ZCode special replay is deleted;
- GitHub Copilot `omitMaxOutputTokens` is deleted;
- Snowflake Cortex is currently unsupported; dedicated output field rewriting is deleted;
- Official version request security verification and Off-Peak execution protocol are dispatched by `zhipu-account.mode`;
- `requiresMfjsToolSchema` remains in Model Config; explicitly enabled only when converting; errors on failure;
- DeepSeek Anthropic synthetic empty thinking has been deleted; only real canonical reasoning replay is retained;
- Unentered Z.ai text/tool signature candidates are not adopted.

The default historical replay principle is: whatever the server truly returns, the same model re-run returns completely. Adapters can losslessly project real fields but cannot manufacture non-existent reasoning, thinking, or signatures.

## 10. Settings Page Product Semantics

Settings pages only edit Personal Config owned by the target Environment Host. Local workspaces use Local Hosts; remote workspaces use Remote Hosts. Renderers do not Overlay, sort, judge sources, manufacture fallbacks, or impersonate remote facts with local configs.

The settings page provides two entries:

```text
Add Vendor
└─ Select from Provider Templates
   └─ Use the Template name in the current language as a seed, atomically creating a Personal Provider with a unique providerId/label and entering editing

Create Custom Vendor
└─ Immediately create a Personal Provider not referencing Templates
   ├─ Write group=standard-personal, access.type=api-key
   │  └─ API Keys may temporarily be missing; Access discriminator fields must not be missing
   ├─ Do not infer API type, Endpoint, or models
   └─ Enter complete custom details
```

Creation takes effect immediately; it does not establish temporary Provider Drafts existing only in the Renderer, nor does it require users to click "Create" a second time in similar pages.
Provider IDs are never editable; Provider Names are independent, editable, and case-insensitive unique labels. Z.ai/BigModel Families maintain existing account product organization and are not broken apart by normal Provider Template lifecycles. Z.AI API and BigModel APIs are also just normal Templates and do not occupy Family connection methods.

Template selection is completed through top-level entries in the right detail area, directly consuming the template order and multi-language names published by the Settings View; no additional Catalog data sources, searches, ID sort tables, or Renderer brand lists are created. Provider brand icons are determined only by the Effective Provider Config's `logo`; UI resource tables are only responsible for loading packaged materials for open Built-in keys; unknown keys fall back to generic icons without affecting execution.

There is no `enabled` at the top level of Providers. Whether a Personal Provider exists is expressed by its Personal root declaration. When API Keys, Endpoints, etc. are not yet complete, they can still be saved and edited, but do not enter the executable Registry. Account Providers display fixedly in Families; `access.entitled` only expresses account entitlement. Settings placement and Registry executable consume the same set of facts, but are not the same conclusions.

"Delete Vendor" in the UI product semantics means deleting the Personal Provider instance:

```text
group = standard-personal
└─ Delete its Personal root declaration, model-specific Rules, and ordering members

group = zai-family | bigmodel-family
└─ Account Providers are published by Built-in; no delete operation is provided
```

The system never deletes Provider Templates or Account Built-in Config. Builtin Models do not show delete buttons; Personal Models can be deleted or have their IDs modified. Both types of models can be enabled/disabled and reordered. Personal Model Config Rules only record the sparse overrides formed after users explicitly modify them; whether fields can be edited and whether model members can be renamed/deleted are two independent product boundaries.

The Model editing page only maintains sparse Personal Rules. Text, numeric, and JSON inheritance/effective values are displayed as placeholders; no separate read-only preview is built; a single "restore all defaults" that clears all Personal Rule overrides for that model is provided; the `enabled` toggle in the model list always saves explicit boolean values and does not show per-item "restore default." Other boolean leaves allowing inheritance use a unified control: Effective values determine checkmarks; explicit Personal leaves are expressed with high-saturation borders; no "default/modified" text is appended. Product-open Model Properties and Option values are all editable in the first version; Option Spec Maps are hidden configs and are preserved as-is when editing other fields. `requiresMfjsToolSchema` is placed last. Provider Access product protocols do not enter normal Model editing pages.

When Personal Model IDs change, the corresponding Personal exact Rule must first be moved to the new ID in the preview semantics, then Built-in Rules must be re-parsed using the new ID and final Provider API/Endpoint, and finally the original Personal sparse values must be overlaid. This way, only inherited defaults change; user-entered values are not overwritten.

## 11. Built-in Publishing and Client Config

ZCode Built-in Provider Config and Model Config Rules are published as a single atomic Release, not split into two separate remote fields that may mismatch. Repository/package installation configs serve as the basic fallback before and after pulling; the most recent successfully accepted remote Release for the current Environment serves as Active/LKG; successful remote results completely replace the same Built-in Source and do not cross-splice with Bundled.

Each Environment uses its own control plane Endpoint, Active/LKG, and Registry. Remote Hosts independently select and refresh remote Environment Built-in Releases; Desktop Renderers do not push local Releases to remote execution environments.

LKG only means Last Known Good and does not guarantee being newer than the package installation. Only Active/LKGs that are Schema-compatible and have a revision higher than Bundled take priority; incompatible, corrupted, or older ones fall back to Bundled.

## 12. Facts Still Pending Decisions

The following issues have not yet become current design facts:

1. Whether DeepSeek Anthropic-compatible genuinely requires synthetic empty thinking; must be answered with real A/B requests.
2. OpenRouter, OpenCode Zen, Azure, Volcano Ark, and AWS Bedrock have been split into
   [`Todo 22`](../../steps/todo-22-additional-builtin-providers-and-cloud-access.md), no longer expanding Todo 21. Google Native Providers and Vertex AI are currently unsupported.

These questions will change saved facts or support scope and must be decided before writing into precise Schemas and interaction designs; other implementation details cannot substitute for decisions in reverse.
