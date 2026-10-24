# 21 ZCode Built-in Config, Model Activation, Sorting, and Settings Consolidation

> Status: Completed (subsequent Todo 23 removed the last Compatibility Config)
>
> Date: 2026-08-26
>
> Related tasks: [`02`](./todo-02-ai-sdk-execution-registry-retirement.md),
> [`07`](./todo-07-account-connection-selection-and-access-context-cutover.md),
> [`17`](./todo-17-provider-registry-settings-authority-boundary-closure.md),
> [`18`](./todo-18-zcode-builtin-client-config-sync-and-lkg.md),
> [`22`](./todo-22-additional-builtin-providers-and-cloud-access.md)
>
> Related design: [`design.md`](../design/design.md),
> [`provider-and-model-configuration-overview.md`](../design/registry/provider-and-model-configuration-overview.md),
> [`configuration.md`](../design/registry/configuration.md),
> [`model-membership-and-enablement.md`](../design/registry/model-membership-and-enablement.md),
> [`settings.md`](../design/registry/settings.md),
> [`registry.md`](../design/registry/registry.md),
> [`request-compatibility-and-access-protocols.md`](../design/registry/request-compatibility-and-access-protocols.md)

## 0. Task Positioning

Consolidates ZCode Built-in Provider Config, Built-in Model Config Rules and the Provider/Model Settings page into
one set of domain facts. Built-in Config is the sole source of static model and API facts, Settings edits only
Personal Config, and Registry consumes only the final resolved result. No compatibility layer is added to the old
implementation.

Implementation follows the decided domain and product design; it is not changed for local convenience, component
reuse or minimal diff. Ordinary ambiguity is resolved toward the closest existing decision, with minimal impact and
reversibility, and recorded; design adjustments are discussed only after the target is complete.

Not included: Client Config public service refactoring (Todo 18 handles only the minimal integration for the current
Built-in Release); OpenRouter, OpenCode Zen, Azure, Volcano Ark, AWS Bedrock (Todo 22); Google Gemini and Vertex AI
(unsupported); Off-Peak structured error refactoring (this round only adjusts config ownership); rebuilding the old
Catalog, Preset or Adapter Registry; heavy per-commit migration audits.

### Outcome (2026-08-26)

- Five Source Schemas, Provider `group`, structured `provider-model` Rule, Model `enabled`, Builtin-wins and explicit
  Provider/Model ordering are in the official Config/Resolver/Facade/Repository pipeline; the Personal persistent
  field is `modelConfigRules`.
- The Built-in Release atomically switched to `account:` account Providers; Z.ai/BigModel Family and regular API
  Providers are separate; Off-Peak is split into two hidden Family Providers; the Account Overlay determines
  connection constraints, available members and the matching Provider `enabled`.
- Settings consumes Host's groups, addition candidates, full order, member source and executable/selectable results;
  Provider ID is read-only; full Model editing saves a sparse Personal-only Rule.
- Official release request security validation and the Off-Peak execution protocol are folded into Provider Access;
  old reasoning/output-token/Provider-ID runtime compatibility and the Renderer ID whitelist are deleted (Todo 23
  later deleted the last Compatibility Config and the synthetic empty-thinking projection).
- Design Tree, Feature Graph and historical Todo superseded annotations were synchronized.

Verification at completion: Provider core directed tests 255 passed; root `typecheck`, `lint`, Desktop E2E
typecheck, changed-file format check and `git diff --check` passed; root unit tests 12,416 passed with 2 failures
caused by the missing external `zip` command on Linux (`zcode-server-cli` Windows ZIP packaging/installation tests,
unrelated to Provider). Real requests and official E2E run per the final Release Checklist.

## 1. Final Dual-Path Configuration

```text
Provider Config Path                         Model Config Path
====================                       =================

ZCode Built-in Provider Config             ZCode Built-in Model Config Rules
              |                                         +
              v                                         |
Account Built-in Provider Config           Personal Model Config Rules
              |                                         |
              v                                         v
Personal Provider Config                   Effective Model Config Rules
              |                                         |
              v                                         |
Effective Provider Config                              |
├─ group / label / logo                                |
├─ enabled / visibility                                |
├─ api / access                                        |
├─ builtinModelIds / modelIds                          |
└─ modelOrder                                          |
              |                                         |
              +-------------------+---------------------+
                                  |
                                  v
                       Effective Model Config
                       ├─ enabled
                       ├─ properties
                       ├─ optionSpecs
                       ├─ reasoningMapping
                       └─ confirmed narrow request encoding facts
                                  |
                                  v
                    Integrity and execution qualification validation
                                  |
                                  v
                         Provider Registry
                                  |
                                  v
                       ModelFactory -> Model -> Adapter
```

Provider Config determines Provider identity, access method, members and display order. Model Config determines
whether a model is enabled, its capabilities, allowed options and option encoding. Model Rules cannot create members;
Provider member arrays cannot declare model capabilities.

Overlay is a reusable composition mechanism for inheritance, overriding and clearing of the same configuration slot.
The Provider/Model domain uses it for cross-layer composition, but structure serves the domain model first; Overlay
is not a universal abstraction for all business semantics.

## 2. Five Source Schema

Five input sources each have a strict Schema, but inside the domain they share Provider Config, Model Config and
Overlay language; no five sets of Runtime DTOs.

| Source                            | Writable facts                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ZCode Built-in Provider Config    | Provider group, identity, display, API/Access template, `builtinModelIds`, Provider default state and declared order |
| Account Built-in Provider Config  | Account Provider Access/connection constraints, Provider enabled, `builtinModelIds` when the server actually returns |
| Personal Provider Config          | `standard-personal` new Provider, or API/Access/status Overlay for an existing Provider; `modelIds/order`            |
| ZCode Built-in Model Config Rules | Complete Model defaults, model/API/Provider/Endpoint specialization, official default enable/disable                 |
| Personal Model Config Rules       | The user's single-model overrides and user-written generic Match Rules                                               |

Strong constraints:

- A Personal Overlay cannot rewrite `group` of an existing Provider; Personal-only root declarations must be
  `group=standard-personal`.
- Personal Provider Config cannot write `builtinModelIds`.
- Account constrains only Built-in account Providers, never reads or modifies Personal-only Providers, never writes
  Model Config and never provides context, format, reasoning or other static model facts.
- Personal `modelIds` must not contain IDs in the current Effective `builtinModelIds`; duplicates hand-written are
  Built-in-wins on read and saving the Provider clears them from the Personal array.
- Source Schema owns structure and field ownership; real server authorization is still decided by actual requests.

| Source                     | Must/Allow                                                                                                                                                                         | Explicitly prohibited                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ZCode Built-in Provider    | Each root declaration provides `standard-builtin`, `zai-family` or `bigmodel-family` group; label/logo, enabled, visibility, API, Access template, `builtinModelIds`               | `standard-personal`, `modelIds`, `modelOrder`, `providerOrder`                                             |
| Account Built-in Provider  | Only overrides existing ZCode Built-in Family Providers: enabled, structured Account Access, `builtinModelIds` when the API actually returns them                                  | group, display fields, visibility, API, Personal members/order, Model Config                               |
| Personal Provider          | Root allows `providerOrder`; existing Provider Overlay allows label, enabled, visibility, API, Access, `modelIds/modelOrder`; Personal-only root must be `group=standard-personal` | `builtinModelIds`; rewriting group of existing Providers                                                   |
| ZCode Built-in Model Rules | `provider-model` and `match`; complete Model Config, official enabled defaults, evidence-confirmed Built-in-only narrow compatibility facts                                        | Provider members, order, Access, dynamic credentials                                                       |
| Personal Model Rules       | `provider-model` and `match`; sparse user-overridable Model Config fields                                                                                                          | Provider members/order, Access, product protocols not allowed for Personal override, pending Compatibility |

Structure parsing and semantic validation are two steps: the single-file Parser strictly rejects unknown fields;
constraints that need to know whether an ID comes from Built-in are completed by Source assembly validation.
Unreleased development-middle Rules are rejected with no dual-read or schema migration; truly published old configs
are converted only inside the Legacy importer private boundary.

## 3. Provider Config

```ts
interface ProviderConfig {
  group?: "standard-builtin" | "standard-personal" | "zai-family" | "bigmodel-family" | null;
  label?: string | null;
  enabled?: boolean | null;
  visibility?: "visible" | "hidden" | null;
  api?: ProviderApiConfig | null;
  access?: ProviderAccessConfig | null;
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
  modelOrder?: readonly string[] | null;
}
```

Provider `enabled` is the execution gate: disabled Providers do not enter Registry, fallback, selector or exact
creation. `visibility=hidden` only hides normal Settings/Selection; complete and enabled hidden Providers can still
be used by internal products by exact ID. Providers do not save `selectable`.

`group` is an explicit Provider product organization fact, not a substitute for execution capability, Access type or
visibility:

```text
standard-builtin
└─ Providers provided by ZCode templates, configured by users
   └─ Participate in "add supplier" candidates and normal providerOrder

standard-personal
└─ Personal-only Providers created from scratch by users
   └─ Participate in normal providerOrder

zai-family / bigmodel-family
└─ Product providers fixed to corresponding account families
   ├─ Do not participate in normal Provider dragging
   └─ Settings UI does not provide Provider enable/disable operations
```

Renderer no longer infers grouping from Provider ID whitelist, Access type or Endpoint. Providers do not save an
extra `builtin` boolean. `visibility` independently expresses visibility to normal users, `enabled` independently
expresses executability.

Normal external Built-in Providers default to `enabled=false`. Selecting one in "Add Supplier" immediately creates a
Personal Overlay with `enabled=true`. Built-in means maintained by ZCode, not that it uses a ZCode account, already
has credentials or is available by default.

`enabledModelIds` is not adopted. Providers maintain model members and order only; model enable/disable belongs to
Model Config.

## 4. Model Members and Builtin-wins

```text
builtinModelIds
└─ ZCode/Account Built-in owned members

modelIds
└─ User-owned Personal members
```

Member sets are produced only from both. When Builtin and Personal share an ID, only the Built-in member is kept;
single-array duplicates keep the first occurrence. Reading ignores later duplicates deterministically, creates no
conflicting DTOs and never blocks Built-in models. Normal UI prohibits creating duplicates; saving a Provider
normalizes duplicates and invalid members.

Built-in Models cannot be deleted (no delete button). Personal Models can be deleted or have their ID modified.
Provider IDs are never modifiable; Provider label can be modified and is case-insensitive unique after trimming.

## 5. Model Config `enabled`

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  reasoningMapping?: Readonly<Record<string, ReasoningParameters>> | null;
  requiresMfjsToolSchema?: boolean | null;
}
```

Models have no independent `visibility`. `enabled` is the sole model execution gate:

```text
Effective Provider enabled
AND Provider complete
AND model is Effective Provider member
AND Effective Model Config enabled
AND Model Config complete
        |
        v
Executable Model (enters Registry)
        |
        + Provider visibility=visible
        v
Selectable Model (enters normal selector)
```

Disabled models stay in Settings with configuration and order preserved, but cannot be tested, used for fallback,
exactly created, or bypassed by any internal task. Already-created immutable Models are unaffected by config
refresh; later creations respect the new state.

Built-in general Rules provide complete default `enabled=true`; official releases can disable older models with more
specific, later Built-in Rules. Personal Rules always follow Built-in Rules and may override explicitly; "restore
defaults" deletes the Personal `enabled` leaf and re-inherits. Adding a new Personal Model in normal UI atomically
saves members, order and a specific Rule `enabled=true`; hand-written, ungenerated members resolve by Built-in
complete fallback.

## 6. Provider/Model Specific Rules and Generic Match Rules

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

`provider-model` can be Built-in or Personal: Built-in declares official facts for a precise Provider/Model
combination; Personal carries exact overrides from the settings page. Personal-specific Rules follow the user
lifecycle:

- created or updated when toggling enabled or editing Properties/Options/Reasoning;
- atomically moved with members and order when a Personal Model is renamed;
- deleted when the Personal Model is deleted;
- all of a Provider's specific Rules are deleted when its Personal Overlay is deleted;
- an empty Rule is deleted after the last overridden field is restored.

`match` can be Built-in or Personal, targets a group. Provider/Model deletion, renaming and deduplication never
rewrite or delete Match Rules or Built-in-specific Rules. Specific Rules use structured IDs, not regex "exactness"
or an ambiguous `exclusive` boolean. Built-in Rules keep using matchers with the minimal sufficient condition over
model, Provider, API or normalized baseURL.

## 7. Model and Provider Order

Model base order is fixed in three segments:

```text
Built-in Models not appearing in modelOrder
                  +
all valid members still in modelOrder
                  +
Personal Models not appearing in modelOrder
```

So newly released but not-yet-ordered Built-in Models default to the front. Normal UI materializes all current valid
members into `modelOrder` when adding a Personal Model, so "unsorted Personal" only handles hand-written or abnormal
input. Every real order save: keep current valid members; delete stale and duplicate IDs (first wins); add all
missing members; save the complete `modelOrder`. Disabled models still participate in Settings order; Selection
filtering preserves the relative order of the rest.

Providers use Personal top-level `providerOrder` (no Map insertion order tricks) with the same principle: unsorted
Built-in first, explicit order middle, unsorted Personal last; each add or reorder materializes the complete normal
Provider order. Z.ai/BigModel Family has fixed product organization and does not participate in dragging.

```ts
interface PersonalProviderConfigFile {
  schemaVersion: 1;
  providerOrder?: readonly string[];
  providers: Record<string, PersonalProviderConfig>;
  modelConfigRules: readonly PersonalModelConfigRule[];
}
```

`providerOrder` is the Personal Source's own collection semantics, not part of Provider field Overlay. ZCode Built-in
Provider base order follows the Release's Provider Map declaration order; Account provides no order. The branch was
unreleased, so the ambiguous `models` storage field was directly renamed to `modelConfigRules` with no migration of
development-middle formats; the Legacy importer outputs final fields.

## 8. Settings: Provider Add, Enable/Disable, and Delete

Provider navigation order: Z.ai/BigModel Account Families first; then the two fixed operations "Add Supplier" and
"Create Custom Provider"; then normal `standard-builtin` and `standard-personal` Providers. The operations do not
participate in `providerOrder` or dragging.

```text
Add Supplier
└─ candidates = visible + group=standard-builtin - Personal Provider Map keys
   └─ Click immediately creates Personal Overlay(enabled=true) and enters editing

Create Custom Provider
└─ First obtain unique and unmodifiable providerId and unique label
   └─ Immediately create group=standard-personal, enabled=true Personal-only Provider
      ├─ access.type=api
      ├─ Do not prefill api.type, baseURL, or models
      └─ Enter full custom editing, no second "create"
```

"Already added" is solely whether the Personal Provider Config Map has this providerId, unrelated to API key,
enabled, executable or selectable. Provider enabled is an independent toggle: disabled still stays in the configured
area; only deleting the Personal Overlay returns it to add candidates.

"Delete Provider" in UI always deletes the Personal Overlay plus that Provider's Personal-specific Rules:

```text
standard-builtin   -> Effective Provider falls back to Built-in, re-enters "Add Supplier" candidates
standard-personal  -> disappears (no other definition exists)
zai/bigmodel-family -> falls back to Built-in/Account state, stays in the fixed Family area
```

The system never deletes ZCode Built-in Config. Generic Personal Match Rules are unaffected. Families do not enter
"Add Supplier" candidates and the UI has no Provider enabled toggle for them (underlying fields still serve
Built-in/Account assembly); special states from manual config edits are outside the Settings UI guarantee.

Host Settings contract provides at minimum:

```text
ProviderSettingsView
├─ revision
├─ addableProviders[]
│  └─ visible + group=standard-builtin + no Personal Overlay yet
├─ providerOrder[]
└─ providers[]
   ├─ providerId / group / label
   ├─ effectiveBuiltinConfig / personalConfig / effectiveConfig
   ├─ enabled / issues / executable
   └─ models[]
      ├─ modelId / builtin
      ├─ effectiveBuiltinConfig / personalExactConfig / effectiveConfig
      └─ enabled / issues / executable / selectable
```

No `isZCodeBuiltin`, `canReorder`, member conflict DTOs, or naming Provider executable as selectable. Renderer
organizes configured areas by `group`; candidates, order, member source and all derived state come from Host.

Host Mutation covers these domain operations (names may follow code style, semantics must not merge):

- `addBuiltinProvider(providerId)`: creates `enabled=true` Personal Overlay and materializes complete `providerOrder`;
- `createPersonalProvider({ providerId, label })`: validates identity, creates an empty API Provider, materializes
  order;
- `savePersonalProvider(providerId, sparseConfig)`: saves label/enabled/API/Access overlays, never the ID;
- `deletePersonalProvider(providerId)`: deletes the Personal Overlay and the Provider's Personal-specific Rules;
- `reorderProviders(completeProviderOrder)`;
- `addPersonalModel`, `renamePersonalModel`, `deletePersonalModel`, `reorderModels`;
- `savePersonalModelConfig` and leaf-level default restoration;
- `previewPersonalModelRename`: moves specific Rules first, then resolves new Built-in defaults;
- `testModel`: saves and refreshes, then executes through the official Registry/ModelFactory.

Every Mutation success response corresponds to the same revision that was persisted and observed by Registry. Local
and remote share the service contract; the service instance belongs to the target Environment Host.

## 9. Settings: Model Editing

The model list uses compact info rows: no editable Model ID input in the list and no Built-in/Personal source label
for now. Source still comes from the Host DTO `builtin` (used for delete permission and domain operations); Renderer
uses no ID whitelist or Preset/Catalog inference.

Rows show Model ID, compact summary, Effective enabled status, test, edit pencil and delete. Delete is shown only on
Personal rows. The enable/disable control shows the current Effective status without emphasizing its origin. When
the Provider is editable, all Effective Built-in/Personal members are sortable. The entire row is the drag
activation area with no drag handle; edit, delete, enable/disable, test and other row controls are excluded.
A pointer movement threshold distinguishes click from drag; touch must not conflict with list scrolling; keyboard
provides equivalent sorting. A plain click on a row opens nothing; only the edit pencil enters the Model editor.

The edit page edits the complete Model Config field set, but persistence always forms sparse Personal Rules with only
the leaves the user explicitly modified or cleared: `enabled`; context/max output; input/output format; tool call,
structured output, native web search, MCS; option specs and reasoning mapping; confirmed Personal-overridable request
encoding fields; `requiresMfjsToolSchema` at the end.

The editor distinguishes (not every field has a Built-in default):

```text
No Personal leaves + upstream has value     -> Inherits that value
No Personal leaves + upstream has no value  -> Not set; never shown as "default off" or a fabricated empty value
Has Personal leaves                         -> User explicitly overrides
Personal explicit clear (field permits)     -> Explicitly clears upstream value
```

| Status                                         | Visual and interaction                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Upstream has value, Personal not overridden    | Real Effective result in low-emphasis text, fill or stroke; no restore operation                          |
| Upstream has no value, Personal not overridden | Neutral dash or "Not set" placeholder, never disguised as off or empty default                            |
| Personal explicit override                     | Normal control emphasis; low-interference undo icon, on Desktop hover/focus, always discoverable on touch |
| Personal explicit clear                        | Clear unset/cleared state, distinct from "no Personal leaves"                                             |
| Validation error                               | Standard error text and semantic colors, not mixed with inheritance/override emphasis                     |

Text and numbers show the inherited upstream value as placeholder (without copying it into Personal) or "Not set";
clearing Personal input restores inheritance; a narrow explicit clear exists only when the field allows it. Enums use
the existing Select language: collapsed shows the Effective result; the menu distinguishes "inherit existing value",
"keep unset", "explicit clear" (when allowed) and explicit values, without stacking "Default (currently X)" text in
the trigger.

Model total `enabled` uses a compact Switch. Input/Output Format and capability Booleans (tool call, structured
output, native web search, MCS) use Toggle Chip / Selectable Tag coordinated with the Modality controls (outline
button with checkmark and short label, wrapping, not a row of Switches). Inherited enabled = low-emphasis selected
Tag; explicit enabled = normal-emphasis selected Tag; inherited/explicit disabled = low-emphasis/normal stroke;
upstream no value = neutral dash. Selected uses a checkmark, not set a dash, Personal override has an undo entry and
accessible name, so status never relies on color alone. Text lock facts keep the existing lock icon and disabled
semantics. PDF/Audio are not shown for now, but unrelated edits preserve their Personal values.

Option Specs and Reasoning Mapping are advanced configuration: independent, syntax-highlighted (at least monospace),
auto-formatting JSON text editors; no total `optionSpecs` editor, table, per-row Mapping or visual Builder. First
version:

```text
Reasoning Level Option Spec JSON    -> directly overrides optionSpecs.reasoningLevel
Max Output Tokens Option Spec JSON  -> directly overrides optionSpecs.maxOutputTokens
Reasoning Mapping JSON              -> directly overrides entire reasoningMapping
```

Each editor is an independent configuration slot; its JSON directly replaces the upstream value of that slot; an
empty Personal editor deletes the slot override and re-inherits. The Personal `optionSpecs` shell contains only
overridden sub-fields, with no finer Overlay inside one editor; `reasoningMapping` must not secretly merge per key.
Each slot's Effective JSON is viewable through read-only preview, collapsible area or tab; it cannot be copied first
then saved as Personal. JSON parsing and the slot's strict Schema validation run before saving, errors locate to
row/column or field path where possible.

No prominent "restore default" buttons next to fields; restore inheritance by clearing input, Select inherit/unset
items, the Toggle Chip undo entry, or clearing JSON Personal content.

Controls reuse `DESIGN.md` and existing component dimensions, border-radius, focus, menus and semantic Tokens; no
hardcoded light/dark values or opacity-only theming. Coverage: Zai Light, Zai Dark, keyboard focus, hover, disabled,
error, touch with no hover. UI uses `text-ui-*` hierarchy, Model ID and JSON use monospace, long Chinese/English
text and narrow screens wrap reasonably.

Model editing stays a popup (no right-side details or secondary settings page). Desktop enlarges it one tier
(`max-w-2xl` as starting point, no ultra-wide or near-full-screen popup); fields grow vertically; Header and Footer
fixed, one middle content scroll area (no stacked popup/JSON-editor scrolling). Narrow screens and Mobile use
available width and height within safe margins without changing fields, inheritance or save semantics. Fine-tuning
inside existing size tiers is allowed, but required fields cannot be hidden to keep the old size.

The Model editing popup explicitly uses manual save, an intentional exception to the settings page auto-save mental
model. Opening establishes a Local Draft from the current Host View and revision; editing Model ID, Properties,
Option Specs, Reasoning Mapping only updates the Draft, never persists per field nor triggers Registry refresh.
Enable/disable, sorting and delete in the list keep their own immediate atomic saves, not merged into the Draft.

```text
Host View @ R1
      |
      v
Open popup -> Local Model Draft @ R1
                 +--> Edit fields --------> Only modifies Draft
                 +--> Cancel / X / Esc ---> Discard Draft, do not write config
                 `--> Save
                        +--> Full validation failure ----> Keep popup and Draft, show errors
                        `--> One atomic Host Mutation
                                  v
                          Persist + Registry @ R2
                                  v
                              Close popup
```

Save is not re-triggerable while the Draft is invalid or submitting. It validates and submits the complete Draft's
sparse Personal config in one go; a Model ID change migrates members, order and the specific Rule in the same atomic
Mutation. The popup closes only after Host confirms the persistence result was observed by Registry; save failures
keep user input and never fall back to per-field auto-save.

When modifying a Personal Model ID, preview semantics first move that model's `provider-model` specific Rule, then
re-resolve Built-in Rules by new ID, Effective API and Endpoint, finally overlay the original Personal sparse values:
inherited defaults update, user explicit values stay.

## 10. Built-in Config Writing and Organization

Providers are arranged continuously by product origin: Zhipu direct API and accounts/subscriptions/Off-Peak first,
external mainstream Providers last. Normal external Built-in Providers default to `group=standard-builtin`,
`enabled=false`, `visibility=visible`, providing protocol, Endpoint, Access template and recommended members;
Personal Config fills actual access material.

Z.ai/BigModel each keep two API Key product identities:

```text
Family API Key Provider
├─ account:zai-api-key       -> group=zai-family
└─ account:bigmodel-api-key  -> group=bigmodel-family
   └─ Managed by fixed Family UI together with account plans

Regular API Provider
├─ zai-api           -> group=standard-builtin
└─ bigmodel-api      -> group=standard-builtin
   └─ Entered from "Add Supplier", users fill API Key independently
```

The two groups have different providerId, Personal Overlay, enabled, API Key, model members and ordering even when
Endpoint, API Schema and recommended models are identical; credentials are never shared or silently copied.
Duplicate static model facts reuse Model Rules' matcher; no ID special case in Runtime/Adapter for these four
Providers.

The old account Provider ID `builtin:` prefix became `account:`:

```text
builtin:zai-*       -> account:zai-*
builtin:bigmodel-*  -> account:bigmodel-*
builtin:offpeak-idle-plan
                    -> account:zai-offpeak-idle-plan
                     + account:bigmodel-offpeak-idle-plan
```

The branch was unreleased, so no old ID aliases, dual-read or persistent migration; tests, Family Spec,
ModelSelection fixtures and exact Provider constants switched atomically.

Off-Peak is two complete Providers (no execution-time dynamically-following shared Provider):

```text
account:zai-offpeak-idle-plan       group=zai-family       visibility=hidden  access.executionProtocol=off-peak
account:bigmodel-offpeak-idle-plan  group=bigmodel-family  visibility=hidden  access.executionProtocol=off-peak
```

The Account Built-in Overlay enables only the matching Off-Peak Provider from the current structured Family/Coding
Plan connection; the other is explicitly `enabled=false`. The Off-Peak creation entry gets the exact Provider of the
current Family. Saved tasks keep their original `ModelSelection`: after the user switches Family the old Family
Provider is disabled, the task is retained but unscheduleable; switching back and re-validating the connection
restores it. The system never silently migrates saved tasks to another Family nor creates a substitute
ModelSelection.

Model Rules are a single ordered array: complete conservative fallback first, then per model family (public facts
with model match only; model + API specialization; provider + model specialization; necessary Endpoint
specialization). Rules of one model family are consecutive. Runtime, Adapter and UI establish no second fact based
on specific modelId, Provider ID or URL. Repo config gets a lightweight correctness review: all Built-in members
parse into complete Model Config, and MCS, Native Web Search, media format, Reasoning and MFJS are covered by Rules;
strict historical comparison tables are not restored.

## 11. Access and Adapter Boundaries

`access.executionProtocol = "off-peak"` belongs to Provider Access. Official release request security validation
admission also belongs to Provider Access and runs at the Adapter's final HTTP transport boundary (fields and
implementation are maintained only in the official release). It does not enter Model properties, is not decided by
modelId and does not replace API Key authentication.

Compatibility decisions:

- OpenAI-compatible reasoning depends on canonical history and SDK native encoding; ZCode special replay is deleted;
- GitHub Copilot `omitMaxOutputTokens` is deleted;
- Snowflake Cortex is unsupported; `maxOutputTokensRequestField` is deleted;
- official release request security validation and Off-Peak failure/execution protocol move from Model Config to
  Access; Off-Peak string errors are not refactored this round;
- `requiresMfjsToolSchema` stays in Model Config; when enabled it projects Tool JSON Schema and a projection failure
  errors directly;
- DeepSeek Anthropic uses canonical replay, no synthetic empty thinking;
- Z.ai text/tool signature patches not in the current baseline are not merged; if needed, real response evidence
  comes first, following "return whatever is received".

## 12. Client Config Boundaries

ZCode Built-in Provider Config and Built-in Model Config Rules are released as one atomic `zcodeBuiltin` Release.
Repository/package contents are the fallback before pull and on failure; each Environment uses its own Active/LKG and
Registry. Remote workspaces are pulled and parsed by the Remote Host, which returns its configuration; Renderer does
not pass Local Host config off as remote facts. This Todo only requires new fields to round-trip along Todo 18's
existing minimal pipeline, not to unify all `/client/configs` consumers.

## 13. Acceptance Scenarios

### Config and Resolver

- Five Source Schema allow/reject matrix.
- Built-in `group` is required and cannot be `standard-personal`; Personal-only is fixed `standard-personal`; Overlay
  cannot change group; the four groups (normal Built-in, Personal-only, Z.ai Family, BigModel Family) are complete
  and mutually exclusive.
- The two Off-Peak Providers are mutually enabled by the Account Overlay per current Family.
- Personal cannot write `builtinModelIds` nor normally save Built-in duplicate `modelIds`; same ID Built-in/Personal
  is Built-in-wins; single-array duplicates keep the first.
- Model `enabled`: Built-in default, official specialization, Personal override, restore default, JSON round-trip.
- `provider-model` and `match` order, deletion, renaming and empty Rule cleanup.
- Provider/Model enabled, integrity and Provider visibility form the executable/selectable formulas.

### Ordering and Lifecycle

- Model/Provider three-segment order; a new Built-in falls into the unsorted Built-in segment.
- Normal new Personal Model atomically updates members, order and an `enabled=true` specific Rule.
- Order save adds missing, deletes stale, removes duplicates.
- Personal Model rename/delete atomically updates members, order and specific Rule.
- Provider deletion deletes Overlay and specific Rules, not generic Match Rules.
- Disabled members keep their position in Settings and are excluded from Selection/Registry.

### Settings and Cross-Environment

- "Already added" is only Personal Map membership; disabling does not return to candidates, only deleting does.
- Adding a Built-in and creating a Personal-only both take effect immediately and write `enabled=true`.
- Normal candidates come only from `group=standard-builtin`; Families are not filtered by ID whitelist, do not
  participate in ordering, have no enabled toggle; deleting their Personal Overlay keeps them in the fixed Family area.
- Custom Provider creation does not guess API Schema, Endpoint or models; an incomplete Provider is created right
  after identity confirmation.
- Family API Key and regular Z.ai/BigModel API Providers have isolated Personal Config, credentials, enabled and
  order.
- `account:` Provider IDs switch atomically across the chain with no old aliases.
- After switching Family, old-Family Off-Peak tasks are retained but unscheduleable and restored on switching back;
  no silent ModelSelection migration.
- Built-in Models have no delete button, Provider IDs are read-only, label is unique.
- Effective placeholder, explicit override and restore default; hidden fields preserved losslessly; the four editing
  states (upstream default, upstream no default, Personal override, explicit clear) never confuse each other.
- Model `enabled` uses Switch; capability Booleans use Toggle Chip/Selectable Tag; selected, not set and Personal
  override have non-color cues.
- `optionSpecs.reasoningLevel`, `optionSpecs.maxOutputTokens` and `reasoningMapping` each have an independent
  formatted Personal JSON editor and read-only Effective preview, directly replacing their own slot.
- Larger proportional popup (no right-side page), no ultra-wide Desktop layout, fixed Header/Footer with only the
  middle area scrolling, Mobile within the safe viewport.
- Local Draft and manual save: field edits write no config early, Cancel/X/Esc produces no Mutation, Save issues one
  atomic Mutation and closes after Registry observed it; failures keep the Draft and popup.
- Row enable/disable, sorting and delete remain immediate atomic operations separate from the popup Draft.
- Compact rows have no Model ID input or source label and keep test, edit, enable/disable and Personal delete; a
  plain click opens no editor; whole-row drag is not triggered by row buttons and supports pointer threshold, touch
  scrolling and keyboard equivalents.
- Provider fixed operations, Model list and full Model editor cover Zai Light/Dark, Desktop/Mobile and
  Chinese/English.
- Modifying a Model ID first moves Personal-specific Rules, then refreshes the Built-in preview.
- Local workspace uses Local Host, remote workspace uses Remote Host; Renderer does no local fallback parsing.

### Adapter and Regression

- Official release request security validation and Off-Peak route by Access; Model Config no longer shows those
  fields.
- Deleting Copilot/Snowflake/old OpenAI replay means no Runtime fallback.
- MFJS on, off and conversion failure.
- DeepSeek A/B real request results become reproducible fixtures before deciding field retention.
- Normal requests, Compact, Memory, Child Agent and Off-Peak use only Active Model/Registry facts.

## 14. Completion Definition

- Design Tree, summary and Feature Graph match the implementation and no longer present `enabledModelIds`, Model
  visibility or conflicting DTOs as target design.
- Providers manage only members and order; Model Config `enabled` is the sole model execution gate.
- Built-in general Rules provide complete defaults; official can default-disable old models via specific Rules.
- Single-model editing on the settings page lands in structured Personal-specific Rules; generic Match Rules are not
  guessed by lifecycle operations.
- "Added Provider", Provider enabled and Provider delete semantics are not mixed.
- Built-in config covers current known static model/API hardcode and creates no Runtime second facts.
- Access product protocols and Model request compatibility are correct, decided-to-delete items have no residue.
- `pnpm typecheck`, `pnpm lint`, related unit tests, format check and affected E2E pass.
