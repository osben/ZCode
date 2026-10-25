# Provider and Model Configuration System Overview

> Current decision summary; does not replace the precise field contracts in the individual topic designs. Last updated: 2026-09-01.

This is the current-state narrative of the confirmed ZCode Provider and Model configuration decisions: what the system is, where each fact belongs, and how facts take effect. It does not describe old-code migration or implementation steps.

## 1. What the System Ultimately Accomplishes

Provider and Model configurations serve the same goal: helping users encapsulate a model API call.

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
                                  | ModelSelection
                                  v
                            ModelFactory
                                  v
                           Model -> Adapter -> API
```

The left path answers "which Providers exist in the Environment, which models each has, and how to access services"; the right answers "what a model can do, which options it takes, and how they map to the target API." The two merge only at final model resolution and never impersonate each other.

Access materials for final calls may come from Config directly or be obtained at request time. Account Provider Config does not manage dynamic account credentials — account connections and request-auth services supply materials at execution time, and the server still authorizes finally. Ordinary API Providers may store API Keys directly in Personal Config.

## 2. Five Configuration Input Sources

| Source                            | Meaning                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| ZCode Built-in Provider Config    | Account Providers published by ZCode, and reusable Provider Templates    |
| Account Built-in Provider Config  | Further constraints by the current account on Built-in account Providers |
| Personal Provider Config          | User-created Providers, and user overrides on existing Providers         |
| ZCode Built-in Model Config Rules | Static facts about models and API mappings published by ZCode            |
| Personal Model Config Rules       | User's sparse posterior overrides on model facts                         |

Each source has its own strict input Schema constraining "what this source can write," but after entering domain resolution they share the common Provider Config, Model Config, and Overlay languages — no five separate Runtime types.

Provider Overlay order is fixed: `Provider Template? -> ZCode Built-in Account Provider? -> Account Overlay? -> Personal`, so Personal is always the final user override. Account only further constrains account-related ZCode Built-in Providers; it never reads, modifies, or constrains Personal-only Providers.

Model Rules are not a three-layer Provider Overlay but concatenation of two ordered arrays — `ZCode Built-in Model Config Rules + Personal Model Config Rules` — with Personal last. Each Rule overrides only the config items it explicitly provides; Rules never create model members.

Overlay is a reusable config-composition mechanism (how one config slot is inherited, overridden, and cleared across input layers). The Provider/Model domain uses it and independently defines config space, member composition, default state, and lifecycle operations. Overlay is not a universal abstraction for all business semantics: config structures obey domain models and are never shaped in reverse from Overlay's existing capabilities.

## 3. The Accurate Meaning of "Built-in"

`Built-in` only means the Provider or Model member comes from ZCode's built-in facts. It never means: using ZCode accounts; having access permission; configured credentials; defaulting to enabled; or always appearing in the model selector.

Provider Templates are not Providers — no `providerId`, `group`, execution state, or Registry identity. They only provide reusable Built-in inheritance baselines when creating Personal Providers, using domain shells for their `nameMap` and internal `config` overlays; Model Config Rules stay centrally maintained and outside those shells. Real Provider roots are only Account Built-in Providers and Personal Providers. Account Providers express Families with explicit `group`; ordinary Personal Providers default to `standard-personal`.

Distinguish sparse inputs from complete results:

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

So Providers save no extra `builtin` booleans and have no `standard-builtin` Concrete Providers. Settings Views return `templateConfig?`, `effectiveBuiltinConfig?`, `personalConfig?`, and `effectiveConfig` accurately; Renderers never guess sources from IDs or groupings. Built-in sources for Models are not written into Model Rules; the Host derives display/operation sources from whether members come from `builtinModelIds` or `modelIds`. When Built-in and Personal share an ID, only one Built-in member forms.

## 4. What Provider Config is Responsible For

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

`visibility=hidden` hides only normal Settings and Selection; complete, enabled hidden Providers remain usable precisely by internal products through ordinary Registry and ModelFactory. The system saves no Provider `selectable`.

Providers have no top-level `enabled`. Personal Providers are fixed in Settings once created; Providers with incomplete config can still be edited but do not enter the executable Registry. Account Providers are fixed into their Families; account eligibility is expressed only by `zhipu-account access.entitled`. Model execution toggles stay in Model Config `enabled`.

## 5. Model Members, Enablement, and Ordering

The three model arrays have one meaning each: `builtinModelIds` = members managed by ZCode Built-in or Account Built-in; `modelIds` = Personal members managed by users; `modelOrder` = the user's complete display order. Members come only from `builtinModelIds + modelIds`; `modelOrder` and Model Config Rules cannot create or enable members.

When Built-in and Personal members share an ID, Built-in wins. Duplicate IDs within one array keep the first occurrence; reads deterministically ignore later duplicates; no conflict objects are created; the normal settings page blocks writing duplicates and normalizes duplicate-affected arrays on the next save.

Model enablement belongs to Model Config `enabled`. Built-in general Rules provide complete defaults; specific Built-in Rules may default obsolete or unrecommended models to `false`; Personal-specific Rules come after Built-in and override only the `enabled` leaf of one Provider/Model. Disabled models stay in Settings with their config and ordering but cannot execute, test, fall back, or be created by exact ID.

Model basic ordering is `Built-in not in modelOrder + members still valid in modelOrder + Personal not in modelOrder`. Creating a new Personal Model on the normal settings page atomically updates `modelIds`, the complete `modelOrder`, and a Personal-specific Rule with explicit `enabled=true` — so "unsorted Personal" only arises from handwritten, incomplete, or non-normal-page writes. Drag saves write the complete order of all current valid members and clean up stale/duplicate IDs.

Provider ordering uses Personal top-level `providerOrder`, never Provider Map insertion order. Z.ai/BigModel Account Families are fixed product areas outside normal dragging; all Personal Providers take part in normal ordering. Creating Template instances or fully custom Providers also writes the current complete Provider order to `providerOrder`; the unsorted tail only normalizes external handwritten or abnormal input.

## 6. Enabled, Executable, and Selectable

Three different layers:

```text
Enabled     └─ Effective Model Config.enabled
Executable  └─ Registry results after the target Host completes member, enable, and completeness resolution
Selectable  └─ Selection View after Executable results are further filtered by normal user visibility

Selectable Models ⊆ Executable Models ⊆ Enabled Models ⊆ Provider Model Members
```

`executable` and `selectable` are not Config fields: entering Registry means executable; entering the Selection View means selectable. Settings may return derived states and issues for display but never saves them back as facts. Providers need no independent `selectable` — appearing in the model selection UI depends only on being visible and having at least one selectable Model.

## 7. What Model Config Rules are Responsible For

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

Each Option's `map` directly generates the RFC 7396 Patch for the target API's raw JSON Request Body; there is no independent `reasoningMapping`, no AI SDK Provider Options mapping, and no duplicate max-output field authority. Precise contract: [`../model/model-option-map.md`](../model/model-option-map.md).

Model Config holds no model `visibility`, Provider Access, credentials, members, or ordering. Models have no second visibility: what normal users see is the Selection View formed by Provider visibility plus Model enabled.

Personal Rules divide into two categories:

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

The effective combination is fixed: `ZCode Built-in Rules + Personal provider-model Rules`. Personal allows only exact `providerId + modelId` overrides; settings pages must not manufacture global match rules by rewriting JSON arrangement.

Both Built-in and Personal Sources may use `type="provider-model"` — facts belonging to one precise Provider/Model. Built-in-specific Rules are managed by ZCode Built-in Releases and unaffected by settings-page lifecycle operations; Personal-specific Rules are managed by the settings page, moved when Personal Models are renamed, deleted when they are deleted.

Only Built-in Sources may use `type="match"` for groups of targets. Personal never saves or reads global Match Rules; specific Rules use structured IDs, need no regex escaping of IDs, and use no misleading `exclusive=true` flags.

Rules may use `modelMatch`, `providerMatch`, `apiMatch`, and optional `baseURLMatch` from true facts. This is not hardcoding models in business code: matching and config values belong to Built-in/Personal Rules; Adapters and Runtime read only final parsed results.

Built-in Rules' stable organization order is an author specification for published files: complete conservative fallbacks first, then Model Matches, Model + API Matches, Model + API + Endpoint Matches, Provider-scoped Matches applying to all members, and a few Provider-Model Exact Rules; same-family models sit contiguously. `modelMatch` is ASCII case-insensitive regex matching on complete Model IDs; other matchers follow their own contracts. Rules apply in physical array order; later hits override earlier ones. Full maintenance specification: [`zcode-builtin-provider-config.md`](./zcode-builtin-provider-config.md).

## 8. Model Input Output Format

Config, Registry, Model, Runtime, Adapters, and protocols all use the same structure:

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

No flat capability DTOs, and no second set of media facts derived from modelId, Provider type, or Session default models. PDF participates in real request checks and the existing encoding chain; Audio exists only as complete static facts. Settings pages show locked Text and editable Image/Video/PDF; hidden Audio must be preserved as-is when editing other fields.

## 9. Provider Access and Request Compatibility

`access.type` describes how access materials are obtained; `api.type` describes which public protocol requests use; the two are orthogonal. Zhipu product protocols use a limited Access Mode:

```text
zhipu-account/start-plan
└─ Official-version access security verification

zhipu-account/individual-coding-plan | team-coding-plan
└─ ZCode V4 transport request proof admission; not spread to ordinary api-key Providers

zhipu-account/off-peak
└─ Off-Peak queuing, Ticket, and retry protocol entry
```

These fields are not Model capabilities. Dynamic security verification materials, Runtime Keys, JWTs, Off-Peak Tickets, and remote rollouts never enter Config.

Confirmed compatibility decisions:

- OpenAI-compatible reasoning uses real canonical history and current SDK native encoding; ZCode special replay is deleted.
- GitHub Copilot `omitMaxOutputTokens` is deleted.
- Snowflake Cortex is currently unsupported; dedicated output field rewriting is deleted.
- Official-version request security verification and the Off-Peak execution protocol are dispatched by `zhipu-account.mode`.
- `requiresMfjsToolSchema` stays in Model Config; enabled only when explicitly converting; errors on failure.
- DeepSeek Anthropic synthetic empty thinking is deleted; only real canonical reasoning replay remains.
- Unentered Z.ai text/tool signature candidates are not adopted.

Default historical replay principle: whatever the server truly returns, the same model re-run returns completely. Adapters may losslessly project real fields but never manufacture non-existent reasoning, thinking, or signatures.

## 10. Settings Page Product Semantics

Settings pages edit only Personal Config owned by the target Environment Host (Local Hosts for local workspaces, Remote Hosts for remote). Renderers never Overlay, sort, judge sources, manufacture fallbacks, or impersonate remote facts with local configs.

Two creation entries:

```text
Add Vendor
└─ Select from Provider Templates
   └─ Seed the label from the Template name in the current language, atomically creating
      a Personal Provider with a unique providerId/label, then enter editing

Create Custom Vendor
└─ Immediately create a Personal Provider not referencing Templates
   ├─ Write group=standard-personal, access.type=api-key
   │  └─ API Keys may temporarily be missing; Access discriminator fields must not be missing
   ├─ Do not infer API type, Endpoint, or models
   └─ Enter complete custom details
```

Creation takes effect immediately — no temporary Renderer-only Provider Drafts, no second "Create" click in similar pages. Provider IDs are never editable; Provider Names are independent, editable, case-insensitively unique labels. Z.ai/BigModel Families keep their account product organization and are not broken apart by Template lifecycles; Z.AI API and BigModel APIs are ordinary Templates occupying no Family connection entries.

Template selection happens through top-level entries in the right detail area, consuming the template order and multi-language names published by the Settings View — no extra Catalog data sources, searches, ID sort tables, or Renderer brand lists. Provider brand icons come only from Effective Provider Config `logo`; UI resource tables only load packaged materials for open Built-in keys; unknown keys fall back to generic icons without affecting execution.

Providers have no top-level `enabled`: a Personal Provider exists by its Personal root declaration; incomplete API Keys/Endpoints may still be saved and edited but keep the Provider out of the executable Registry. Account Providers display fixedly in Families; `access.entitled` expresses only account entitlement. Settings placement and Registry executability consume the same facts but are not the same conclusion.

"Delete Vendor" means deleting the Personal Provider instance: for `standard-personal`, delete the Personal root declaration, model-specific Rules, and ordering members; for `zai-family | bigmodel-family`, no delete operation exists (Account Providers are Built-in-published). The system never deletes Provider Templates or Account Built-in Config. Built-in Models show no delete button; Personal Models can be deleted or ID-modified; both types can be enabled/disabled and reordered. Personal Model Config Rules record only sparse overrides formed by explicit user modification; field editability and member rename/delete rights are independent product boundaries.

The Model editing page maintains sparse Personal Rules only. Text, numeric, and JSON inheritance/effective values display as placeholders; no separate read-only preview; one "restore all defaults" clears all Personal Rule overrides for that model; the list's `enabled` toggle always saves explicit booleans with no per-item "restore default". Other inheritable boolean leaves use one unified control: effective values set checkmarks; explicit Personal leaves show high-saturation borders; no "default/modified" text. Product-open Model Properties and Option values are all editable in the first version; Option Spec Maps are hidden configs preserved as-is by other edits; `requiresMfjsToolSchema` sits last; Provider Access product protocols never enter normal Model editing pages.

When a Personal Model ID changes: move its Personal exact Rule to the new ID first (preview semantics), re-parse Built-in Rules with the new ID and final Provider API/Endpoint, then overlay the original Personal sparse values — only inherited defaults change; user-entered values are never overwritten.

## 11. Built-in Publishing and Client Config

ZCode Built-in Provider Config and Model Config Rules publish as one atomic Release, never two separately remote fields that can mismatch. Repository/package installation config is the base fallback before and after pulling; the most recent successfully accepted remote Release for the Environment is Active/LKG; a successful remote result fully replaces the same Built-in Source and never cross-splices with Bundled.

Each Environment has its own control-plane Endpoint, Active/LKG, and Registry. Remote Hosts independently select and refresh remote Environment Built-in Releases; Desktop Renderers never push local Releases to remote execution environments.

LKG means Last Known Good only, not "newer than the package installation". Only Active/LKG that is Schema-compatible and higher-revision than Bundled takes priority; incompatible, corrupted, or older ones fall back to Bundled.

## 12. Facts Still Pending Decisions

1. Whether DeepSeek Anthropic-compatible genuinely requires synthetic empty thinking must be answered with real A/B requests.
2. OpenRouter, OpenCode Zen, Azure, Volcano Ark, and AWS Bedrock are split into [`Todo 22`](../../steps/todo-22-additional-builtin-providers-and-cloud-access.md); Todo 21 is not expanded further. Google Native Providers and Vertex AI are currently unsupported.

These change saved facts or support scope and must be decided before writing precise Schemas and interaction designs; implementation details cannot substitute for the decisions.
