# Todo 104: Pre-Release Persistence Schema Review and Refinement

> Later ruling (2026-09-11): [Todo130](todo-130-manual-model-config-editable-field-boundary.md) supersedes the rules here
> about disabling the "recommended not ready" switch and about freezing/fully validating the whole manual config: it
> disables only while saving, and manual mode requires only editable fields while system fields keep being parsed.
> Todo130 is pending; the older implementation and acceptance below stay as history, not as landed new semantics.
>
> Database follow-up (2026-09-10): [Todo109](./todo-109-database-migration-consolidation-and-rollback-readability.md)
> owns whole-database migration consolidation and rollback readability. It keeps the already ruled conversion semantics
> and old fields/values; when this migration has not run, new target fields can be rebuilt from clearly identified old
> sources; unshipped intermediate states are not supported; completed migrations are not re-run; a missing new config
> must not block reading content; dual-write is avoided and used minimally only where content would be unreadable. Within
> the database scope Todo109 prevails over conflicting migration/compatibility clauses here.
>
> Status (2026-09-10): feature implementation and whole-batch review are closed; final artifact acceptance still has
> limits. Implemented: the three 6.18 rollback snapshots, core Schema / rule envelope / names / templates, Personal
> same-file default selection and distribution, runtime paths, source identifiers. Verification: 155 files / 1296 tests,
> Wiki/off-peak 156 tests, Pro settings/session-restore passed; CLI migration tests passed after seeding real legacy data.
> Existing Server/SEA packaging problems and Windows real-device limits are in the ledger, so not every artifact is
> claimed releasable. The 13 supporting items of 6.19 were re-checked individually; Subagent Markdown follows Todo97 and
> is not changed here. The final acceptance item in section 8 is still open.
>
> Authorization (2026-09-10): the user authorized executing the parts that are correct and decidable from existing
> rulings; parts needing new rulings stay open. "Discussion only / not authorized / not implemented" wording in the
> source history is not the current authorization or completion state.
>
> Source: m2 original Todo99, fixed commit `02dfc1b45819626dc6d1614a8e528c72eaed31af`, renumbered to Todo104 to avoid
> clashing with the Worker-fix Todo99 and the completed investigation Todo100. Implementation status and evidence:
> [implementation ledger](../research/todo104-schema-implementation-ledger.md). Current design entry:
> [Design V2](../design-v2/design.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-104-pre-release-schema-review.md`

### Execution Granularity (2026-09-10, latest user request)

Do not run large regressions and Pro verification for every field or small point. Completed commits and evidence stay;
work proceeds in full feature-chain batches.

- During development: write discriminating tests first, run targeted tests covering the change, local typecheck if
  needed. Field propagation and fixture updates do not trigger repository-wide tests, typecheck, shared builds or Pro rebuilds.
- Batches: remaining Provider/Model rule final structure, name/template ownership and read/write entries form one rule
  batch; the default-selection same-file save/distribution coupled to the new Personal envelope is accepted together
  after it is connected; runtime paths and source revision form another chain. Batches may merge when coupled.
- Batch close: run typecheck, lint, architecture check and related cross-domain regressions once; review all clauses and
  upstream/downstream; do not redo evidence unaffected by later changes.
- Pro/E2E waits until the involved settings/execution chains are stable, then shares builds; static and targeted
  verification come first.
- Failures are classified first; only new changes, fixes or unproven key boundaries rerun checks; existing problems are
  recorded, not expanded into fix tasks.
- The full Goal scope, spec/test-first, final complete review and key acceptance are unchanged; untested is never written as passing.

## 1. Background and Working Agreement

The review started from "which persistable schemas does this branch add compared to staging". The user wants field names
and structures settled before release so published user data never needs forced migration. Unreleased branch schemas may
be renamed and reorganized freely for the long-term design; upgrade compatibility of data published on staging is kept
separately. Model Selection, Provider Config and Model Config are the core; other new structures follow their actual
storage locations.

Working agreements:

- Discuss first, then implement. "Save to the document" updates only ruling documents. An earlier misreading of "fix the
  first two" as implementation authorization was fully reverted (no product commit).
- Focus on schema (fields, types, optionality, null, nesting) without a mechanical checklist. Code-backed concrete problems
  may be raised; guesses are never written as found defects or user rulings. Questions about field usage are answered
  with actual usage without expanding into rectification.
- "Do not be too aggressive": pure renames and wrapper trimming without clear benefit are not expanded; refresh /
  distribution records follow the 6.13 shrink.
- Risk is judged by verifiability: "easy to verify is not high risk". Workload or breadth alone is not a reason to retract
  a design (see 6.17).
- Schemas are shown layer by layer as interfaces (top level first, then members, one sentence per layer on what changes,
  fields expanded rather than hidden behind Omit/Identity). Implementation still derives types from the schema.
- Files/tables, schemaVersion and revision are discussed separately; scope is structures added or changed relative to
  staging.
- Scope narrowing: the user rules only what this Todo changes; other Todos and unchanged branch behavior are not review
  tasks. Omissions are recorded separately; the aim is to not break existing behavior.

### 1.1 Schema Is the Single Source of Truth for Types

1. For persisted/protocol structures in this Todo, the schema is the only source of fields, nesting and constraints. No
   second hand-written interface/type with the same semantics; types derive from the schema.
2. Plain data uses `z.infer` / `z.output`; schemas with transforms that need the pre-parse shape use `z.input`; input
   data and transformed classes are not mixed into one type.
3. Complete, sparse-override and fixed-mode variants reuse the base schema through extend/pick/omit with explicit nested
   required handling (top-level required alone does not make nested members complete).
4. Save and parse validation reuse the corresponding schema and shared content constraints, not parallel completeness
   field lists. Edits first determine the smart/manual collection, then validate the full rule against that schema.
   `useRecommendedConfig` and the intermediate `useSmartConfig` are not in the final persisted structure.
5. Behavioral classes (`overlay`, `toJSON`) may stay; a class is not a reason to duplicate the data schema. Constructor
   input, serialization shape and needed narrowing still reuse derived types.
6. Base data schemas and behavior classes keep one-way dependency; no circular reference to derive types, no `any` or
   type assertions to fake derivation.
7. The interfaces in this document communicate target structure and are not a request for a second hand-written type set.

### 1.2 Reading and Implementation Basis

The final target structure takes precedence over text marked "previous plan" / "current code"; historical names only
locate rewrite entries. Implementation supersedes conflicting parts of older designs and updates Design V2. Behavior not
covered stays as-is; "no ruling" is not a license to invent a mechanism. Interfaces show field shapes only; runtime
constraints not expressible in TypeScript stay: non-empty IDs, positive-integer limits, non-empty option arrays, valid
regexes, compilable maps. Sparse override schemas are not turned into complete schemas.

## 2. ModelSelection (confirmed)

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: ModelSelectionOptions;
}
interface ModelSelectionOptions {
  reasoningLevel?: string;
}
```

1. "Unselected / follow default" belongs to the consuming upper-level schema; ModelSelection gets no discriminator field.
2. `maxOutputTokens` is deliberately not in `options` (ModelConfig option definitions are in section 5).
3. Execution-time completeness is runtime validation and does not widen this schema.
4. No new enum, rename or optionality change for `reasoningLevel`, and no other options fields.

The user approved attaching this one ModelSelection to existing structures without per-consumer discussion (6.14).
Structure is approved; old-data migration and consumer adaptation are still verified at implementation.

## 3. ProviderConfig (confirmed changes and retained items)

| Item                               | Ruling                                                      | Background                                                                                            |
| ---------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `modelIds`                         | renamed `personalModelIds`                                  | The old name only meant user-added models and misreads as the full set next to `builtinModelIds`.     |
| `api.baseURL`                      | renamed `api.baseUrl`                                       | Matches `apiKeyManagementUrl` naming; limited to this schema, not all SDK parameters.                 |
| `label`                            | removed from ProviderConfig; outer rule uses `providerName` | Templates keep only `templateNameMap`; the default Provider name is generated at creation (6.5).      |
| `api` / `ProviderApiConfig`        | kept nested and independent                                 | Flattening was proposed and withdrawn; the user wants `api` kept for a possible future OAuth.         |
| `access`                           | existing union kept                                         | No OAuth type or fields added; "maybe OAuth later" is a reason to keep grouping, not to implement it. |
| `entitled`                         | name, position and semantics kept                           | See section 4.                                                                                        |
| `group`, `logo`, `visibility`      | existing design kept                                        | No rename, type change or extension.                                                                  |
| `ProviderConfigOverlay` etc. names | no rename                                                   | Naming discussion ended by the user.                                                                  |
| optionality and `null`             | unchanged                                                   | No new ruling on clearing semantics.                                                                  |

`builtinModelIds` and `modelOrder` keep their names. providerId and templateId moved out of ProviderConfig into the
instance rule (6.4).

### 3.1 Target Structure

```ts
interface ProviderConfig {
  group?: ProviderGroup | null;
  logo?: ProviderLogoRef | null;
  api?: ProviderApiConfig | null;
  access?: ProviderAccessConfig | null;
  builtinModelIds?: string[] | null;
  personalModelIds?: string[] | null;
  modelOrder?: string[] | null;
  visibility?: "visible" | "hidden" | null;
}
type ProviderGroup = "standard-personal" | "zai-family" | "bigmodel-family";
interface ProviderLogoRef {
  type: "builtin";
  key: string;
}
interface ProviderApiConfig {
  type?: ProviderApiType | null;
  baseUrl?: string | null;
  headers?: Record<string, string> | null;
}
type ProviderApiType = "anthropic-messages" | "openai-chat-completions" | "openai-responses";
type ProviderAccessConfig = ApiKeyAccessConfig | ZhipuAccountAccessConfig;
interface ApiKeyAccessConfig {
  type: "api-key";
  apiKey?: string | null;
  apiKeyManagementUrl?: string | null;
}
interface ZhipuAccountAccessConfig {
  type: "zhipu-account";
  accountType?: "zai" | "bigmodel" | null;
  mode?: "start-plan" | "individual-coding-plan" | "team-coding-plan" | "off-peak" | null;
  entitled?: boolean | null;
}
```

### 3.2 Field Background

- `group` is the product grouping: `standard-personal` = ordinary personal Providers (including template-created API Key
  Providers), `zai-family` / `bigmodel-family` = account plan Providers. Used for grouping order, settings navigation,
  deletion limits and save-group validation.
- `logo` is `{ type: "builtin", key }` with a non-empty runtime key check, not a fixed enum; the UI maps keys to built-in
  icons with a fallback for unknown keys. No URL/custom upload types.
- `visibility` controls whether ordinary settings and model selection show a Provider; it does not disable execution.
  A hidden Off-Peak Provider is still usable by its dedicated execution entry.

## 4. `entitled` Ruling and Usage Background

`entitled` stays in Provider Config. The Config decides what ZCode considers usable and how requests are made; final
entitlement is decided by account and remote services together, so a Config may contain dynamic facts.

```text
Built-in / Account / Personal config -> Effective Provider Config (may contain dynamic facts)
  -> ZCode local availability and request assembly
  -> account service supplies request-time access material -> model server final authorization
```

Withdrawn inferences: Config does not have to hold only static facts or equal the persisted user config; a dynamic
`entitled` does not mean it is misplaced; the earlier "design problem" derived from App/CLI assignment differences,
status projection and telemetry was not accepted. No authorization to change `entitled`, `accountState`, the protocol
access object or consumers.

Static usage map (for understanding only, not a rectification list):

| Path                         | Role                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Account result parsing       | `available` -> true; `pending`/`unavailable` -> false; unknown reuses the same identity's old result, else false                  |
| App Off-Peak                 | derived from whether the selected same-account personal/team plan is available                                                    |
| Standalone CLI               | from local account identity and API Key presence; config check looks for any entitled account Provider                            |
| Provider Resolver / Registry | account Provider execution eligibility requires `entitled` true plus current and completeness; selectability also uses visibility |
| Settings page                | nav account state, plan cards, Start Plan visibility, connect/re-authorize completion, first backfill sync                        |
| Quota/plan queries           | sidebar, settings, composer, plan identity snapshot via public helper access object and refresh fingerprint                       |
| Plan read-only inspection    | dedicated helper lets some not-yet-entitled states query benefits; falls back to `entitled` only without `accountState`           |
| Purchase-entry telemetry     | infers plan state from entitled Providers for Automations, Off-Peak create entries                                                |
| Types/projections            | Provider Access Config, AccountProviderState projection, protocol account access object (unchanged)                               |

Code evidence: `packages/provider/src/config/provider-config.ts`, `config/schema.ts`, `account-provider-resolution.ts`,
`resolver.ts`, `packages/services/src/model-provider/accountProviderConnectionResolver.ts`,
`apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts`,
`packages/ui/src/lib/accountProviderAccess.ts`, `packages/ui/src/settings/ModelProviderSection.tsx`,
`packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts`,
`packages/ui/src/hooks/usePlanIdentitySnapshot.ts`, `packages/ui/src/lib/codingPlanFunnelTelemetry.ts`,
`packages/shared/src/zcode-protocol/index.ts`.

## 5. ModelConfig (confirmed changes and layered target structure)

Confirmed:

- `properties.input_format` / `output_format` become `inputFormat` / `outputFormat`; inner `support_text`,
  `support_image`, `support_video`, `support_audio`, `support_pdf` become `supportsText`, `supportsImage`,
  `supportsVideo`, `supportsAudio`, `supportsPdf`.
- `requiresMfjsToolSchema` moves from the ModelConfig top level into `properties`.
- `optionSpecs.reasoningLevel.type` and `optionSpecs.maxOutputTokens.type` are deleted (the schema already binds
  `reasoningLevel` to `enumOptionSpecSchema` and `maxOutputTokens` to `limitOptionSpecSchema`; `map` variable names are
  also bound to these two). Other `type` fields that discriminate member shapes (Provider Access etc.) stay; rule-level
  `type` is handled in 6.6.

Remaining fields, optionality and null are unchanged; `enabled` stays the model enable/disable config.

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
}
interface ModelPropertiesConfig {
  requiresMfjsToolSchema?: boolean | null;
  contextWindow?: number | null;
  inputFormat?: ModelInputFormatConfig | null;
  outputFormat?: ModelOutputFormatConfig | null;
  supportsToolCall?: boolean | null;
  supportsJsonSchemaOutput?: boolean | null;
  supportsNativeWebSearch?: boolean | null;
  supportsMidConversationSystem?: boolean | null;
}
interface ModelInputFormatConfig {
  supportsText?: boolean | null;
  supportsImage?: boolean | null;
  supportsVideo?: boolean | null;
  supportsAudio?: boolean | null;
  supportsPdf?: boolean | null;
}
interface ModelOutputFormatConfig {
  supportsText?: boolean | null;
}
interface ModelOptionSpecsConfig {
  reasoningLevel?: EnumOptionSpecConfig | null;
  maxOutputTokens?: LimitOptionSpecConfig | null;
}
interface EnumOptionSpecConfig {
  values?: string[] | null;
  map?: string | null;
}
interface LimitOptionSpecConfig {
  max?: number | null;
  map?: string | null;
}
```

`values` keeps ordered-level semantics, `max` the supported upper limit, `map` the expression string converting to
request parameters. `EnumOptionSpecConfig` / `LimitOptionSpecConfig` are not renamed and no options are added.

Sparse override semantics are kept: absent field = inherit the previous layer, `null` = explicit clear; config objects
override recursively by existing rules; arrays and `headers` are replaced as a whole. Renames/moves must not turn null
into absent, nor arrays into append, nor headers into deep merge. ManualModelConfig's complete-parameter constraint is
the separate exception in 6.2.

Implementation status (2026-09-10): option `type` deletion landed in B2c (schema, behavior classes, Built-in, CLI
contract, settings save, tests); media renames and MFJS move landed in B2d; Pro SC90/F98 passed. Rule grouping/manual
collections were a later batch; the field work above is not the whole Todo. Code: `packages/provider/src/config/model-config.ts`, `config/schema.ts`.

## 6. Rule Structure Rulings

### 6.1 Match Field Renames (confirmed)

`baseURLMatch` -> `baseUrlMatch`, `apiMatch` -> `apiTypeMatch`. `providerMatch` and its matching logic are deleted. The
shared fields below are not a fourth Match rule a file may contain; each collection must use the strict schema of 6.3.

```ts
interface MatchModelConfigRule {
  modelMatch: string;
  apiTypeMatch?: string;
  baseUrlMatch?: string;
  config: ModelConfig;
}
```

### 6.2 Smart and Manual Configuration: Two Rules, Two Collections (confirmed)

Goal: when smart configuration is off, incomplete parameters must not be saved, with derivation instead of copying. The
intermediate `useRecommendedConfig` -> `useSmartConfig` was replaced by two rule kinds in two collections; the mode is
expressed by the owning collection and no `useSmartConfig`/`type` is persisted. The UI concept stays "smart
configuration". The complete mode after turning it off is `ManualModelConfig` / `manualModelConfigSchema` (replacing
`FixedModelConfig` / `fixedModelConfigSchema`); with smart config on, partial overrides remain allowed.

Before the change, the schema had only optional `useRecommendedConfig` plus sparse ModelConfig; add/edit called
`assertFixedModelConfigComplete` -> `validateComplete` excluding a missing `enabled`, fixed-mode parsing did not fill
from recommended config, and the final Registry rechecked completeness.

```ts
interface PersonalModelConfigRules {
  providerModelRules: ProviderModelConfigRule[]; // smart mode, sparse, overlays previous layers
  manualProviderModelRules: ManualProviderModelConfigRule[]; // manual mode, complete
}
interface ProviderModelConfigRule {
  providerId: string;
  modelId: string;
  config: ModelConfig;
}
interface ManualProviderModelConfigRule {
  providerId: string;
  modelId: string;
  config: ManualModelConfig;
}
interface ManualModelConfig {
  enabled?: boolean | null;
  properties: CompleteModelProperties;
  optionSpecs: CompleteModelOptionSpecs;
}
interface CompleteModelConfig {
  enabled: boolean;
  properties: CompleteModelProperties;
  optionSpecs: CompleteModelOptionSpecs;
}
interface CompleteModelProperties {
  requiresMfjsToolSchema: boolean;
  contextWindow: number;
  inputFormat: CompleteModelInputFormat;
  outputFormat: CompleteModelOutputFormat;
  supportsToolCall: boolean;
  supportsJsonSchemaOutput: boolean;
  supportsNativeWebSearch: boolean;
  supportsMidConversationSystem: boolean;
}
interface CompleteModelInputFormat {
  supportsText: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsPdf: boolean;
}
interface CompleteModelOutputFormat {
  supportsText: boolean;
}
interface CompleteModelOptionSpecs {
  reasoningLevel: EnumOptionSpec;
  maxOutputTokens: LimitOptionSpec;
}
interface EnumOptionSpec {
  values: string[];
  map: string;
}
interface LimitOptionSpec {
  max: number;
  map: string;
}
```

Rules:

1. One providerId + modelId belongs to exactly one personal collection; switching mode moves the entry between
   collections; no second mode boolean; save validation reuses the owning collection's rule schema.
2. Leaf fields of Complete\* are required and non-null. `CompleteModelConfig` is derived from shared field schemas (there
   is no existing standalone complete schema to reuse); `ManualModelConfig` relaxes only `enabled`.
3. During resolution a manual rule keeps the previous layer's `enabled` and applies its own `enabled` override;
   `properties`/`optionSpecs` use the complete manual value without filling from smart config. Turning smart config off
   must not lose the model's enable state (continues current fixed-mode behavior; no third mode).
4. Implementation derives the manual rule schema from the existing exact-rule base schema, replacing only `config` with
   `manualModelConfigSchema`; no `ProviderModelRuleIdentity`, and no `PersonalProviderModelConfigRule` conditional type
   as a second persisted structure.
5. Save may parse the whole rule with its schema instead of a separate fixed-mode completeness check; ranges, array
   contents and Map constraints are reused. Smart rules stay sparse; manual rules must be complete.
6. File reading currently tolerates incomplete config; a future manual-rule validation failure follows the owning personal
   file's error handling. No new behavior of deleting the whole file, auto-completing parameters or silently reverting to
   smart mode; if existing error handling cannot fit, report the concrete conflict.

Evidence: `packages/provider/src/config-service.ts`, `config/schema.ts`, `config/model-config.ts`.

### 6.3 Model Rule Layers: Boundaries and Built-in Member Naming (confirmed)

Before the change `modelRules`, `modelApiRules`, `providerSiteRules` all reused the broad `matchModelConfigRuleSchema`,
and serialization regrouped by API/URL field presence. Each layer now has its own strict schema, reused through extend;
all three Match layers forbid `providerMatch`; instance identity is expressed only by exact rules' providerId + modelId.

The built-in member `providerModelRules` is renamed `builtinProviderModelRules` (only the builtin prefix; the earlier
`providerInstanceModelRules` / `ProviderInstanceModelConfigRule` was a mistaken proposal). The personal collection's
`providerModelRules` has no prefix; the rule type stays `ProviderModelConfigRule`.

```ts
interface BuiltinModelConfigRules {
  modelRules: ModelMatchConfigRule[];
  modelApiRules: ModelApiMatchConfigRule[];
  providerSiteRules: ProviderSiteMatchConfigRule[];
  templateModelRules: TemplateModelConfigRule[];
  builtinProviderModelRules: ProviderModelConfigRule[]; // ordinary only, never manual rules
}
interface ModelMatchConfigRule {
  modelMatch: string;
  config: ModelConfig;
}
interface ModelApiMatchConfigRule {
  modelMatch: string;
  apiTypeMatch: string;
  config: ModelConfig;
}
interface ProviderSiteMatchConfigRule {
  modelMatch: string;
  baseUrlMatch: string;
  apiTypeMatch?: string;
  config: ModelConfig;
}
interface TemplateModelConfigRule {
  templateId: string;
  modelId: string;
  config: ModelConfig;
}
```

- `modelMatch` is required in all three layers; a site-wide rule writes `".*"` explicitly (the existing Z.ai / BigModel
  Anthropic search and mid-conversation System rules use this and are kept).
- Interfaces are display only; types derive from schemas, and the runtime schema must reject unknown `providerMatch`
  (not just remove the TypeScript field).
- Match fields stay regex strings; `apiTypeMatch` does not become a single API enum value. Whole-string matching,
  case-insensitive `modelMatch` and URL normalization are kept; renames must not become equality or substring matching;
  dots in site paths are escaped per regex semantics.
- Array order is preserved; grouping and type deletion do not change priority, and serialization must not guess the
  collection back from fields. Personal ordinary and manual rules are mutually exclusive (6.2), not ordered.
- Layering (override order):

```text
modelRules -> modelApiRules -> providerSiteRules -> templateModelRules -> builtinProviderModelRules
  -> personal ordinary rules OR personal manual rules
```

#### 6.3.1 Four Cross-Layer Rules All Move to the Site Layer (confirmed)

A config/commit audit found one account Provider wildcard rule in the Model layer and three Provider-conditioned rules
in the Model + API layer. Retaining `providerMatch` "because it is in use" was rejected: schema follows layer
responsibility.

| Original position and condition                                     | Covered content                     | Handling                                                                                       |
| ------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Model: account personal/team/Start Plan Provider, modelMatch `".*"` | image, video input true             | Endpoint condition in `providerSiteRules`; keep modelMatch `".*"`                              |
| Model + API: anthropic, Claude models, Anthropic Messages           | native search, mid-conv System true | `providerSiteRules` by Anthropic Endpoint; keep model and API conditions                       |
| Model + API: moonshot-kimi, K3 series, Anthropic Messages           | MFJS tool Schema true               | `providerSiteRules` by Moonshot Endpoint; keep K3 model and API conditions; not made site-wide |
| Model + API: deepseek, all models, Anthropic Messages               | native search, mid-conv System true | `providerSiteRules` by DeepSeek Endpoint; keep `".*"` and API conditions                       |

Endpoints (from current config/templates; do not widen to the whole domain):

- Image/video: `https://api.z.ai/api/anthropic`, `https://open.bigmodel.cn/api/anthropic`,
  `https://zcode.z.ai/api/v1/zcode-plan/anthropic`.
- Anthropic `https://api.anthropic.com/v1`; Moonshot `https://api.moonshot.cn/anthropic`; DeepSeek
  `https://api.deepseek.com/anthropic`.

The user agreed image/video are declared per Endpoint: an ordinary API Key instance and an account instance on the same
Endpoint get the same site capability (superseding the earlier "keep account capability in `builtinProviderModelRules`"
advice). The original account rule excluded Off-Peak, so its separate Endpoint is not added. The existing site rules for
the two ordinary Z.ai / BigModel Anthropic Endpoints stay (`".*"`, Anthropic Messages, native search and mid-conversation
System true) and are not extended to the Start Plan Endpoint; different rules' URL conditions are not mixed.

`providerMatch` and its parsing/matching/serialization are deleted; no second Provider-regex entry is kept.
Exact providerId + modelId instance rules stay. Evidence: `config/provider/zcode-builtin.json`,
`packages/provider/src/config/model-config.ts`; the account media wildcard rule came in template-refactor commit
`9d3289240d4`. These are static facts and design rulings, not verified server capabilities.

### 6.4 Provider Template, Instance and Rule Collections (confirmed)

`templateId` inside ProviderConfig was awkward; a `ProviderDefinition` shell was rejected (extra layer, scattered
identity, asymmetric naming). Final: providerId and templateId move to the outer rule, symmetric with ModelConfigRule,
and Templates join the rule system as rule collections (not `Rule[]` for Provider vs `Rules` for Model).

```ts
interface BuiltinProviderConfig {
  providerConfigRules: BuiltinProviderConfigRules;
  modelConfigRules: BuiltinModelConfigRules;
}
interface BuiltinProviderConfigRules {
  templateRules: ProviderTemplateConfigRule[];
  providerRules: ProviderConfigRule[];
}
interface ProviderTemplateConfigRule {
  templateId: string;
  templateNameMap: ProviderTemplateNameMap;
  config: ProviderConfig;
}
interface ProviderConfigRule {
  providerId: string;
  templateId?: string | null;
  providerName?: string | null;
  config: ProviderConfig;
}
```

The type name stays `ProviderConfigRule` (not `ProviderInstanceConfigRule`); the builtin prefix applies only to the
Model collection member `builtinProviderModelRules`. Internal `ProviderConfig` drops `templateId` and `label`. Runtime
schemas still limit allowed fields per rule kind (for example templates cannot store an API Key). The personal config
allows only instance rules and adds no user-defined templates. Source-specific schemas: 6.8; names: 6.5.

Conversion boundaries:

1. Old Record key -> rule `providerId`; old `config.templateId` -> rule `templateId`; instance `label` -> outer
   `providerName`; other fields stay in `config`; a template's old `config.label` is no second default-name source.
2. Providers/modelIds already in the new identity system keep their IDs (saved ModelSelections keep identity). Staging's old
   identities still migrate through the existing importer / identity conversion; "moving does not change IDs" does not
   cancel old-identity migration.
3. Same-level identity uniqueness survives Record -> array: one source's `providerRules` have no duplicate providerId,
   `templateRules` no duplicate templateId; different sources overriding the same Provider stays valid. Do not convert to
   a Map and let the last entry silently win. This does not forbid several Match rules hitting one model.
4. `providerOrder` stays independent display order, not derived from array order.
5. Resolution builds a template index first; templates and instances need not be ordered by reference.
6. Staging upgrade entries output the final structure; unreleased intermediate branch formats need no transition migration.

```text
providerConfigRules: templateRules -> template index; providerRules -> look up template by templateId -> synthesize instance config
```

### 6.5 Template Name and Provider Name (confirmed)

Templates keep only the multi-language `templateNameMap` (not `displayNames`); no separate `name` or `config.label`.

```ts
interface ProviderTemplateNameMap {
  "zh-CN"?: string;
  "en-US"?: string;
}
```

The outer `providerName` (optional/null as above) replaces the intermediate `name`. User-specified names win; the default
name contract:

1. At creation take the non-empty name of the current language from `templateNameMap`, fall back to `en-US`, then to `templateId`.
2. Deduplicate against existing Provider names, ignoring leading/trailing whitespace and case.
3. If taken, try `Name 2`, `Name 3`, ... (existing Anthropic and Anthropic 2 -> new one is Anthropic 3).
4. The result is saved into `providerName`; language switches or template-name updates do not rename created instances;
   the default is not derived from the template at display time.
5. Reading existing names, generating a free name and saving happen in one config update, so concurrent creation cannot
   duplicate a name.

Before this change creation took `template.config.label`; switching the source to `templateNameMap` was the work of this
Todo. Code: `packages/provider/src/config-service.ts`, `config/provider-config.ts`.

### 6.6 Collections Determine Category; Persisted Rule `type` Deleted (confirmed)

Each rule kind owns one array, so no rule object stores a redundant `type`:

| Collection                                          | Member type                   |
| --------------------------------------------------- | ----------------------------- |
| providerConfigRules.templateRules                   | ProviderTemplateConfigRule    |
| providerConfigRules.providerRules                   | ProviderConfigRule            |
| modelConfigRules.modelRules                         | ModelMatchConfigRule          |
| modelConfigRules.modelApiRules                      | ModelApiMatchConfigRule       |
| modelConfigRules.providerSiteRules                  | ProviderSiteMatchConfigRule   |
| modelConfigRules.templateModelRules                 | TemplateModelConfigRule       |
| built-in modelConfigRules.builtinProviderModelRules | ProviderModelConfigRule       |
| personal modelConfigRules.providerModelRules        | ProviderModelConfigRule       |
| personal modelConfigRules.manualProviderModelRules  | ManualProviderModelConfigRule |

Internal execution may add a category tag from the owning collection but files never store one, and the category must not
be guessed back from Map/API/URL fields. The UI smart-config switch maps to the personal ordinary/manual collection. Only
collection-determined rule `type` is deleted; Provider API protocol `type`, Access `api-key`/`zhipu-account`, Logo
resource `type` stay.

### 6.7 Built-in / Personal Config File Envelope (confirmed)

The built-in file keeps version, release revision and config; the unreleased built-in format moves from
`schemaVersion: 3` to `schemaVersion: 1` (revision rules: 6.12). The personal file gains a `config` layer, separating
version from content.

```ts
interface ZCodeBuiltinRelease {
  schemaVersion: 1;
  revision: number;
  config: BuiltinProviderConfig;
}
interface PersonalProviderConfigFile {
  schemaVersion: 1;
  config: PersonalProviderConfig;
}
interface PersonalProviderConfig {
  providerOrder?: string[];
  providerConfigRules: PersonalProviderConfigRules;
  modelConfigRules: PersonalModelConfigRules;
  defaultModelSelection?: ModelSelection;
}
interface PersonalProviderConfigRules {
  providerRules: ProviderConfigRule[];
}
```

Collections not marked optional must exist in the final file (empty array when empty), e.g. personal `providerRules`,
`providerModelRules`, `manualProviderModelRules`; `providerOrder` and `defaultModelSelection` may be absent and are not
written as null. `providerOrder` expresses display order independently of rule order. The earlier layout with
`providerOrder` / `providerConfigRules` / `modelConfigRules` at the file root is replaced.

```text
built-in file: schemaVersion, revision, config{providerConfigRules{templateRules[],providerRules[]},
  modelConfigRules{modelRules[],modelApiRules[],providerSiteRules[],templateModelRules[],builtinProviderModelRules[]}}
personal file: schemaVersion, config{providerOrder[],providerConfigRules{providerRules[]},
  modelConfigRules{providerModelRules[],manualProviderModelRules[]},defaultModelSelection?}
```

### 6.8 Source-Specific Config Schemas: Existing Boundaries Kept (review passed)

A public `ProviderConfig` for every rule's `config` would hide that sources may write different fields. These are the
same public config with different allowed fields per writing entry, not a new file or domain structure. Targeted audit
found no structure problem.

| Source   | Verified allowed/restricted fields                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template | logo, api, builtinModelIds and API Key Access metadata without apiKey; no personal models; old label deleted, name only in `templateNameMap`                                                                                 |
| Built-in | `group` required and limited to zai-family / bigmodel-family; allows logo, api, access, builtinModelIds, visibility; no personalModelIds / modelOrder; identity and name moved out (6.4/6.5)                                 |
| Personal | no builtinModelIds; group only the standard-personal override; fixed Account Provider access cannot be overridden by the personal layer; personal Endpoint may keep an unfinished string until final completeness validation |
| Account  | only builtinModelIds and the zhipu-account Access `entitled` override; not an arbitrary ProviderConfig write path                                                                                                            |

Keep these limits via derivation from base schemas with the confirmed renames and identity/name move; add no source
reorganization or dedicated type naming. Validations depending on providerId (such as forbidding personal access on a
fixed Account Provider) must remain in the outer-rule validation after IDs move out. Verification: provider-config-kinds,
config-overlay, config-service, todo21-source-contracts (66 cases) passed. Code: `config/schema.ts`,
`packages/provider-node/src/provider-config-file-codec.ts`, `zcode-builtin-release.ts`.

### 6.9 Default Model Selection Merged into the Personal File (confirmed)

The separate `model-selection.json` (`schemaVersion` + `configuredDefault`) is merged into the personal file as
`config.defaultModelSelection`. A logical structure need not be a separate physical file; this supersedes the earlier
requirement to keep `model-selection.json` independent. (During the risk discussion the user briefly cancelled the merge,
then restored it once concurrency, notification, distribution and rollback were shown verifiable; the cancellation never
entered product code.) `configuredDefault` is rejected as a name: "configured" repeats and "default" names no object.

- Type: the section-2 `ModelSelection` with no extra wrapper and no default semantics in ModelSelection. Absent means the
  user specified no environment default; it is an environment preference, not a session selection history.
- The standalone-file read/write entries connect to `config.defaultModelSelection`. File-name style
  (`provider_config.json` vs hyphen) is not decided.
- Reads/writes carry the field fully: saving Provider, Model or ordering preserves the default; setting/clearing the
  default preserves other personal config. Clearing removes only that optional member and never deletes
  `provider_config.json`. The old default-selection repository `rm`s the file on decode failure; that must not be moved
  to the merged file (it would delete Providers and API Keys); the personal-file repository handles file errors.
- Updates reuse the personal config locked read-modify-write and conflict checks; the persisted revision covers the
  default selection; change notifications reach default-selection consumers. No extra revision field or lock protocol.

```text
Provider/Model/ordering edits + default set/clear -> same personal-file update entry
  -> locked read of latest -> change target member, keep others -> atomic write -> notify consumers
```

A final personal file without `defaultModelSelection` means no default; startup must not restore a cleared choice from
old config (legacy import and final-file-exists checks adapt together). Old-file deletion is not decided here; unreleased
intermediate formats need no compatibility (6.10). Code: `packages/provider-node/src/model-selection-config-file-codec.ts`,
`model-selection-config-repository.ts`, `packages/services/src/node.ts`.

### 6.10 New-File Decisions and Program-Maintained Directory (confirmed)

Scope: files and tables new relative to staging. This round adds no database file or table, but adds a
`model_selection TEXT` column to each of `automations`, `automation_runs` and `off_peak_tasks` in the existing
`tasks-index.sqlite` (so "no new table" is not "no new column or migration"; see 6.14). Whole-repository existing files
are not restructured.

User config: keep `provider_config.json` (personal Provider/Model config, ordering, 6.9 default selection); the old
combined `config.json` keeps other config, old Provider content is only upgrade input. Global file naming style is not decided.

Program-maintained data lives under `runtime/provider/` of the environment directory ("runtime" = program-maintained, not
disposable temp). The earlier `cache/` + `state/` plan is replaced.

```text
~/.zcode/v2/
  provider_config.json, bot-config.v3.json, bot-state.v3.json
  runtime/provider/
    <platform>/<app-version>/<server-address-id>/zcode-builtin.json, zcode-builtin-refresh.json
    provisioning.json
    bundled/zcode-builtin.json
```

The path shows the default environment; real paths come from the environment's path resolution and host injection
(never a hard-coded home). Downloaded config and refresh records keep the platform / app version / server-address
isolation dimensions.

| Current implementation or resource            | Target                                                | Reason                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider_config.json                          | kept                                                  | personal config in one place, not the old combined config.json                                                                                     |
| model-selection.json                          | merged into config.defaultModelSelection              | 6.9                                                                                                                                                |
| active.json                                   | `runtime/provider/<isolation dir>/zcode-builtin.json` | downloaded active built-in config; rebuildable from the bundled config when missing                                                                |
| refresh-control.json                          | same directory `zcode-builtin-refresh.json`           | multi-process refresh lease, refresh time and failure retry info; not user config                                                                  |
| provider-provisioning-state.json              | `runtime/provider/provisioning.json`                  | successful distribution request IDs and results, so resent requests do not overwrite targets; not a config copy and lost history cannot be rebuilt |
| bot-config.v3.json                            | kept as the current new file                          | imported from staging `bot-config.json`; old file stays; no continuous dual-write                                                                  |
| bot-state.v3.json                             | kept as the current new file                          | imported from staging `bot-state.v2.json` etc.; old file stays                                                                                     |
| bundled `zcode-builtin.json`                  | kept bundled resource                                 | first-start/offline baseline; same release schema as remote content                                                                                |
| embedded-resource `zcode-builtin-<hash>.json` | fixed `runtime/provider/bundled/zcode-builtin.json`   | reused by single-file CLI / Server read chain; a resource copy, not a user config                                                                  |

Resource copy overwrite semantics: no hash-named history copies. On startup the new program compares the bundled config;
if different it writes a temp file and atomically replaces, if equal it reuses. This assumes the old program and child
processes exited normally before upgrading; a still-running old process would see new content on re-read. Replacement is
done by program startup, not the installer. Downloaded config and bundled resource stay separate.

Compatibility: staging-published data must upgrade to the final format; unreleased intermediate branch formats need no
compatibility or migration. Keeping an unsupported-format file is not the same as supporting its reading; invalid and
future-version file handling is not expanded here.

Bot correction: an earlier note recorded "reuse the original file for migration" as a user ruling and proposed changing
the migration trigger; that was a recording error. The new files are intended: keep `bot-config.v3.json` /
`bot-state.v3.json` with `version: 3`, import from old files when the new file is absent, and do not override the
original path. Bot `version` is not part of the 6.11 reset.

Evidence: [Todo 33 personal config file ruling](./todo-33-personal-provider-config-file-cutover.md),
`packages/provider-node/src/zcode-builtin-cache-paths.ts`,
`packages/services/src/model-provider/providerProvisioningTarget.ts`, `packages/services/src/bots/repo.ts`,
`packages/provider-node/src/zcode-builtin-provider-config-materializer.ts`,
`apps/zcode-cli/packages/cli/src/provider-runtime-env.ts`.

### 6.11 schemaVersion Scope and Purpose (confirmed)

After merging the standalone Model Selection file, new version boundaries drop from six to five (four file formats, one
transport format), each starting at version 1. A version identifies the format, selects a migration or rejects
unsupported input, and does not change with ordinary value edits.

| Version boundary                 | Target             | Scope                                                                           |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| PersonalProviderConfigFile       | `schemaVersion: 1` | whole personal config incl. defaultModelSelection                               |
| ZCodeBuiltinRelease              | `schemaVersion: 1` | release format shared by bundled, released copy and downloaded content (3 -> 1) |
| built-in refresh record          | `schemaVersion: 1` | lease, time, failure count                                                      |
| Provider distribution state file | `schemaVersion: 1` | saved completed requests and results                                            |
| Provider distribution envelope   | `schemaVersion: 1` | whole package of config, settings, credentials sent to the target environment   |

ProviderConfig, ModelConfig, ModelSelection have no own version (their file/envelope manages it). The standalone Model
Selection file and its version shell are gone; Bot `version` pre-exists in staging and is not a new boundary. A version
field does not itself migrate: user config normally migrates to keep data, refresh records can be rebuilt, downloaded
content/transport envelopes may reject unsupported formats. Unreleased intermediate formats may also say `schemaVersion: 1`;
the number alone does not prove the final format and files still decode against the final schema, with no migration for
them. Staging's old config files and Bot originals are published upgrade inputs and must still be imported.

### 6.12 Built-in Release Revision and Targeted Review (rulings and fixes)

Release layer: one shared monotonic release-number rule for bundled and online content compared by the same client within
one config source:

- Changed config content must increase the release revision; the same revision must mean identical content; an unchanged
  repackage may reuse the number.
- A rollback to old content is republished with a larger revision, else clients ignore it as old.
- `schemaVersion` (format) is separate from release revision; collapsing `schemaVersion` to 1 does not reset the revision.
- `revision` keeps its non-negative safe-integer constraint (`<= Number.MAX_SAFE_INTEGER`); a derived schema type must not
  widen it to arbitrary number.

Runtime layer: generated content/combination identifiers and view counters need no manual upkeep; staging already had a
whole-Registry content hash and this round added layered identifiers and a view counter; fields passing the same
identifier are not independent version systems.

Review: built-in old/new revision comparison, same-revision content conflict check and the lock-validated personal save
path showed no problem. Three fixes were ruled (8 related test files / 95 cases passed; a temporary test reproduced the
issue and was removed; each fix needs a formal regression):

1. Runtime built-in identifier includes the source scope. `snapshotFromRelease` produced only `zcode-builtin:<revision>`;
   different Endpoints have separate caches and may share a revision. With equal revision but different content, after
   switching, Source read the new content while Registry skipped publishing because the combination identifier was
   unchanged. The runtime identifier must include the normalized Endpoint source and flow through built-in, combined
   config and Account basis identifiers; the numeric file revision and its comparison stay. Direct file Source / Worker
   source passing is checked too, not just one refresh UI.

```text
Endpoint A rev 20 model-a -> switch to cached Endpoint B rev 20 model-b
before: Source = model-b, Registry = model-a;  target: identifier changes with the source, Registry publishes model-b
```

2. Delete the distribution envelope `sourceRevision` (computed and transmitted but with no consumer; target dedup uses
   `syncId`). Remove the schema/derived-type member and dedicated computation; keep `syncId` dedup and the content hash
   needed for personal config read-consistency.
3. Distribution result `registryRevision` is renamed `configRevision` (the value is `snapshot.sourceRevisions.config`, the
   config-source combination identifier, not an integer Registry counter). Adjust the shared result schema, result write,
   result member in the state file and consumers/cases; no extra revision field.

Evidence: `packages/provider-node/src/zcode-builtin-provider-config-source.ts`,
`endpoint-scoped-zcode-builtin-source.ts`, `packages/provider/src/registry-service.ts`,
`packages/services/src/model-provider/providerProvisioningSource.ts`, `providerProvisioningTarget.ts`,
`packages/shared/src/provider-provisioning.ts`.

### 6.13 Refresh / Distribution Records: Minimal Change

Shrunk to two small adjustments plus the adaptation needed for the default-selection merge; no format change for naming
or wrapper trimming; this supersedes the earlier `endpointOrigin` and `results` array proposals.

#### 6.13.1 Refresh File

Fields kept; file location per 6.10. `endpointKey` (normalized config-service source) is not renamed `endpointOrigin`.
`leaseId` identifies one refresh lease; `leaseUntil` and `nextEligibleAt` are millisecond timestamps; the lock, lease and
retry mechanism is kept.

```ts
interface RefreshControl {
  schemaVersion: 1;
  endpointKey: string;
  leaseId?: string;
  leaseUntil: number;
  nextEligibleAt: number;
  failureCount: number;
}
```

#### 6.13.2 Distribution Envelope

`sourceRevision` is deleted (6.12); `personalConfig` becomes the final `PersonalProviderConfig` including
`defaultModelSelection`, with no outer `configuredDefault`. Data schema reuse keeps one-way package dependency (shared
does not depend on provider behavior).

```ts
interface ProviderProvisioningEnvelope {
  schemaVersion: 1;
  syncId: string;
  personalConfig: PersonalProviderConfig;
  accountSettings: ProviderProvisioningAccountSettings;
  credentials: ProviderProvisioningCredentialEntry[];
}
```

#### 6.13.3 Distribution Members

Account settings and credential items are unchanged; account connection selection is not renamed or reorganized.
Credential scope validation and array size limits are kept; distributable credential kinds are not widened.

```ts
interface ProviderProvisioningAccountSettings {
  providerFamilyDomain: "zai" | "bigmodel" | null;
  providerFamilyConnectionSelections: ProviderFamilyConnectionSelectionSettings;
}
interface ProviderProvisioningCredentialEntry {
  scope: "oauth-session" | "account-provider";
  key: string;
  value: string;
}
```

#### 6.13.4 Distribution State File

The `records` wrapper and record-level `syncId` stay (not `results: ProviderProvisioningResult[]`); the duplicated ID
needs no format change.

```ts
interface ProvisioningStateFile {
  schemaVersion: 1;
  records: ProvisioningStateRecord[];
}
interface ProvisioningStateRecord {
  syncId: string;
  result: ProviderProvisioningResult;
}
```

#### 6.13.5 Distribution Result

Only `registryRevision` -> `configRevision`; status, count and rollback fields are unchanged. The state file stores
success results; failures can be returned to the caller without persisted failure history.

```ts
interface ProviderProvisioningResult {
  syncId: string;
  status: "applied" | "already-applied" | "unsupported" | "failed" | "rollback_failed";
  personalProviderCount: number;
  credentialCount: number;
  configRevision?: string;
  errorMessage?: string;
  rolledBack: boolean;
}
```

The default-selection merge changes write, validation and failure rollback so they no longer treat two independent files;
target `syncId` dedup and the existing check preventing rollback from overwriting newer values stay. `personalConfig` is
the source's whole personal config snapshot, not a patch: if the source has no `defaultModelSelection`, the target does
not keep an old default after applying. Rollback treats the merged personal file as one before/after snapshot, keeps the
"modified meanwhile -> do not overwrite" protection, and never rolls back rules and default selection separately (which
would overwrite the whole file). This differs from ordinary field edits, which preserve unmodified members.

```text
source personal config (with defaultModelSelection) -> same envelope -> target dedups by syncId
  already succeeded -> return existing result
  not executed -> apply config/settings/credentials and validate
     success -> save records;  failure -> roll back the actual write scope
```

Evidence: `packages/provider-node/src/zcode-builtin-remote-synchronizer.ts`,
`packages/shared/src/provider-provisioning.ts`, `providerProvisioningSource.ts`, `providerProvisioningTarget.ts`.

### 6.14 Other Structures Passed or Not Adjusted

#### 6.14.1 Attaching ModelSelection to Existing Structures: Passed

User ruling: everything that adds a model selection on top of existing structure passes ("pass means approved": it is not
to be re-marked skipped, unconfirmed or needing re-approval). Session/message, recent selection, Subagent state, Wiki,
Bot, Automation and Off-Peak selection fields reuse the section-2 selection; each entry's own unselected / follow-default
semantics stay with the upper layer. Old fields are not deleted (Off-Peak / Wiki preservation: 6.18) and that does not
overturn the passed structure.

New columns, all in the existing `tasks-index.sqlite` (no new database or table):

| Existing table  | New column             | Ruling                        |
| --------------- | ---------------------- | ----------------------------- |
| automations     | `model_selection TEXT` | reuses ModelSelection, passed |
| automation_runs | `model_selection TEXT` | reuses ModelSelection, passed |
| off_peak_tasks  | `model_selection TEXT` | reuses ModelSelection, passed |

The new localStorage key `zcode-model-selection-recent-v1` plus workspace identity is client storage, not a JSON file or
table. Subagent Markdown keeps its `model` / `thoughtLevel` text. Bot keeps its v3 files (6.10). Passing the schema does
not waive staging data migration verification; the SQL NULL / JSON null / explicit selection distinctions keep their upper
semantics. Evidence: `packages/services/src/session/automationRepo.ts`, `offPeakTaskRepo.ts`,
`packages/ui/src/lib/composerRecent.ts`, `packages/shared/src/subagent-markdown-selection.ts`.

#### 6.14.2 Account Connection Selection: Not Adjusted

`providerFamilyConnectionSelections` in `setting.json` stays: `zai` / `bigmodel` each store a connection selection; `kind`
is `start-plan`, `individual-coding-plan` or `team-coding-plan`; team items carry `productId`, `organizationId`,
`projectId`. The earlier "ignore for now" is now "not adjusted": no kind/mode renaming, no field reorganization. Duplicate
hand-written types still follow 1.1 (type-source cleanup, persisted format unchanged). Code:
`packages/shared/src/provider-family-connection-selection.ts`.

#### 6.14.3 Account Credential Key: Unchanged

The `account-provider:...:api-key` key composition/encoding in `credentials.json` (Provider, account identity, and team
product/organization/project IDs) is kept; `coding-plan`/`team` are not renamed and credential storage is not redone.
Code: `packages/services/src/model-provider/accountProviderCredentialKey.ts`. Source-specific schema field scope likewise
stays "not adjusted" (6.8).

### 6.15 Goal Achievement and Implementation Boundary

Design review closed for the Provider / ModelSelection refactor relative to staging: core schema, rules and sources,
physical files and new table columns, schemaVersion, revision and the directly related distribution records. Rollback
discussion added the 6.18 old-field preservation; 6.19 narrowed to the 13 supporting items. Design review is not
implementation or release verification.

| Review item                                                               | Conclusion                         |
| ------------------------------------------------------------------------- | ---------------------------------- |
| ModelSelection, ProviderConfig, ModelConfig                               | sections 2, 3, 5                   |
| smart/manual, layered rules, Provider/Template outer, names               | 6.1-6.7                            |
| source-specific field limits                                              | 6.8 kept, review passed            |
| default selection, file paths, Bot files, resource overwrite, new columns | 6.9-6.10, 6.14                     |
| five format versions, release revision, runtime identifier                | 6.11-6.12                          |
| refresh / distribution records                                            | 6.13 shrunk                        |
| other ModelSelection attachments, account selection, credential key       | 6.14 passed / not adjusted         |
| schema single source                                                      | 1.1, 7 as implementation principle |

Release needs real results proving: a fresh install writes the final format; staging published data upgrades directly into
the same final format; unreleased intermediate branch formats are not supported.

```text
fresh install -> final format;  staging published data -> upgrade -> same final format;  unreleased intermediate -> no compatibility
```

Acceptance concentrates on: landing schema / read-write / consumers per this document; verifying staging upgrade and
repeated startup neither lose nor resurrect old config; verifying distribution / rollback after the default-selection
merge and the same-revision cross-Endpoint fix. Report concrete conflicts rather than inventing fields or migration
versions. This does not promise no later migration, is not a repository-wide persistence audit, and does not authorize
widening to unaddressed behaviors (illegal hand-edited files, future-version compatibility).

### 6.16 Implementation Location and Document Review Supplement

Maps rulings to actual entries so schema definitions are not changed while write-back, migration or standalone CLI is
missed. Staging reference checked: `790884b1ce`; re-check diffs if the baseline moves.

| Ruling                                         | Entries to check together                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Field renames, rule grouping, type removal     | `provider/config/schema.ts` parsing, `provider-config.ts` / `model-config.ts` constructors and `toJSON`, `toPersonalJSON`, `toZCodeBuiltinJSON`; write-back must not emit old fields                                                                                                       |
| Personal config envelope and default merge     | provider-node `provider-config-file-codec.ts`, `personal-provider-config-repository.ts`, `model-selection-config-repository.ts`, host assembly and default-selection subscription; no second continuously written `model-selection.json`                                                   |
| Staging personal config import                 | App `legacyPersonalProviderConfigImporter.ts` and standalone CLI `legacy-cli-personal-provider-config-importer.ts` both output the final format; keep user-intent extraction and old identity conversion; do not freeze old Effective Config system default capabilities as user overrides |
| Bot keeps v3 files                             | `bots/repo.ts`, `storageMigration.ts` keep the new-file import chain; verify old config/draft selections enter v3 files and old files are not overwritten; no original-path migration                                                                                                      |
| Built-in release and runtime source identifier | `config/provider/zcode-builtin.json`, release codec, download Source, fixed resource release path, CLI / Server embedded resource chain; bundled and downloaded use one final release schema                                                                                               |
| Distribution adaptation                        | `shared/provider-provisioning.ts` with Source / Target / state result codecs change together; send, receive and failure rollback read the same `personalConfig`                                                                                                                            |

Existing migration entries: `packages/services/src/model-provider/legacyPersonalProviderConfigImporter.ts`,
`apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts`,
`packages/services/src/bots/storageMigration.ts`. The document review also clarified: public Match example vs formal
schema, complete vs manual config, `enabled` and null override semantics, rule order and identity uniqueness, full
read/write and rollback after the default merge, final version 1 vs legacy import. If implementation needs to change these
behaviors, report the reason; "document completion" is not authorization to widen product work.

### 6.17 Re-assessment by Verifiability

Criterion: "easy to verify is not high risk". The earlier high-risk grading of the default-selection merge and outer
reorganization mixed in workload; this section replaces it. Every group has constructible inputs and decidable results;
the default merge, revision passing and resource overwrite need fuller integration/packaging verification but have clear
methods. "Verifiable" does not mean "current tests already prove the final design".

| Change group                                                   | Decidable result                                                                                                                                                                        | Verification and current boundary                                                                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ModelSelection and existing attachments                        | same providerId / modelId / reasoningLevel survives read/write; upper empty semantics kept                                                                                              | reuse existing consumers and migration tests; the three new columns still check upgrade read/write                                                                            |
| Provider/Model renames, property moves, option `type` deletion | final file has only target fields; round trip loses nothing; effective semantics kept                                                                                                   | schema positive/negative cases, serialization assertions, before/after effective-value comparison; no self-consistent same-codec round trip as proof                          |
| Provider/Template outer reorg and names                        | IDs, template relations, overrides and order kept; creation name by language, deduplicated, stable across restart                                                                       | adapt creation / concurrent dedup / Overlay tests; add array/field-move assertions and settings E2E                                                                           |
| smart/manual grouping, source-specific schemas                 | illegal source fields and incomplete manual rules are rejected leaving no half edit; `enabled` independent; manual params do not follow earlier layers                                  | existing fixed-config / source-limit / atomic-edit tests plus collection exclusivity cases                                                                                    |
| Match layering, `providerMatch` deletion, four rules to Site   | each layer rejects out-of-layer fields; specified Endpoint/API/model hits, near misses do not; order kept                                                                               | explicit hit/miss matrix incl. ordinary API Key on the same Endpoint, Start Plan and Off-Peak boundaries; verifies declared local scope, not real remote capability           |
| Default merge and distribution adaptation                      | editing any member loses no others; cleared default does not return after restart; concurrent edits all kept; failed distribution restores the original without overwriting newer edits | file update, import and fault injection; plus real two-process write/notify and real distribution integration                                                                 |
| Staging import and Bot files                                   | fresh install and legacy import both produce the final format; repeated start does not re-import; Bot writes v3 and old file untouched                                                  | existing App/CLI importer and Bot tests with old-file fixtures and independent expected results                                                                               |
| schemaVersion and built-in release revision                    | five boundaries accept version 1 and reject malformed input; higher revision accepted, same revision with different content rejected                                                    | codec/release tests; real packaging/online release must also check revision vs content in one release scope                                                                   |
| Built-in runtime revision source fix                           | two Endpoints with the same revision but different content converge across Source, Account, Registry and Worker and really use the new config                                           | formal regression from the real Source / Config / Registry repro, covering real Host / Worker; in-memory mocks are not enough                                                 |
| `runtime/provider` paths and fixed resource overwrite          | correct isolated directories per host; replace on change, reuse on no change, no hash-growing copies, no half-file reads                                                                | temp-dir file tests, concurrent/failure cases, plus Desktop / CLI / Server built-artifact startup checks; atomic replace on supported systems                                 |
| Schema single source and two distribution tweaks               | types derive from schema without confusing pre-parse and class serialization; no `sourceRevision` consumer left; result value is still the config identifier                            | typecheck, negative type cases as needed, codec behavior tests, dependency check, send/receive protocol cases; typecheck alone cannot show runtime validation was not widened |

Verification boundaries found: the test named "multiple processes concurrently first read" in
`provider-node-runtime.test.ts` creates two Repositories in one process, so it cannot independently prove cross-process
locking and notification. `providerProvisioningTarget.test.ts` has failure rollback, concurrent credential protection and
empty-snapshot sync scenarios but mostly mocks, so it is a base, not proof of merged real-file rollback. The resource
materialization test currently asserts keeping old hash versions and must be replaced by the fixed-path expectation.

The two integration-heavy chains use controllable execution barriers, fault injection and actual persisted results, not
repeated runs or arbitrary sleeps:

```text
process A edits Provider + process B edits default selection -> same file update -> both kept -> another process reads new values
  distribution applied then injected failure -> original restored / newer values not overwritten
Endpoint A(rev 20) -> switch to B(rev 20, different content) -> Source -> Account / Registry -> Worker uses B
```

All confirmed changes are kept; steps follow data structure, file merge, source identifier and path assembly. Code with
shared-dependency coupling changes in the same step without temporary dual-write, intermediate migration or new
compatibility formats. Tests: `packages/provider/test/config-service.test.ts`, `model-config-rules.test.ts`,
`packages/provider-node/test/provider-node-runtime.test.ts`, `packages/services/test/providerProvisioningTarget.test.ts`.

### 6.18 Practical Rollback: Keep Old Fields and Three Fixes

The user prefers added fields/files for practical rollback and ruled that fields "cannot be deleted". Old values stay for
the old version; the new version updates only its own fields and does not keep reverse-syncing into the old format. This
applies to staging-published stores this Todo changes; the unreleased new Provider format is still renamed/grouped/merged.
Subagent Markdown was settled in Todo 97 and is not overturned (6.19.2). Rollback evidence: [Todo 69](./todo-69-provider-refactor-practical-rollback-compatibility.md).

#### 6.18.1 Off-Peak: Old Model Columns No Longer Cleared

`updateEditableFields` also set `model` / `thought_level` to NULL on save. Fix: remove the `model = NULL` /
`thought_level = NULL` assignments from the UPDATE; update only the new selection and the edited business fields; old
columns keep their value and are not rewritten from the new selection; new records without old values do not fabricate
legacy choices; reuse existing update, validation and save entries. Acceptance reads raw SQLite columns: after editing
only the title or the new selection both old columns equal their prior values and `modelSelection` reads correctly.

#### 6.18.2 Wiki / Draft: Preserve Old Fields on Save

Reading converts `generationModel` / `generationOptions.thoughtLevel` to the new `modelSelection`, but the runtime object
no longer carries the old fields, so writing it back deletes on-disk old values. Fix in `RepoWikiStorage`'s Wiki / Draft
save adaptation: preserve those on-disk old values using the existing file lock and `atomicWriteText`; old fields are only
a rollback snapshot and do not take part in new selection parsing. Not "delete two lines": no new save service, cache or
background sync, no change to general IO tools; new files without old values get no fabricated old params; any need to go
beyond this local scope must be reported with the reason.

`generationOptions.maxOutputTokens` is a published staging field and is preserved by the same rule; the new version still
uses the model Limit, does not restore the manual output budget and does not generate old budgets for new files (a
storage supplement to Todo 94's "normal save removes the old budget", not a reversal of its execution/UI rulings).

Acceptance (Wiki and Draft): after saving a new selection the old model / reasoning / budget values remain, body and
current `generateDiagrams` save normally, old params do not enter the current request; an explicitly cleared or invalid
new selection is not resurrected from old fields after restart. The concrete save marker is not fixed here, and the
withdrawn implementation's `modelSelection: null` is not a user schema ruling.

```text
on-disk old fields -- original values kept --> read after rollback by the old version
new selection -- updates new field/file --> read by the current version; after clearing, new state wins and old values are not re-imported
```

#### 6.18.3 Session: Add `modelSelection`, Keep Old Fields

Implementation update (2026-09-10): B1c landed the on-disk wrapper and old snapshot preservation; local integration
regression passed; full delivery verification follows B5. The logical `SessionStorePort` keeps the `ModelSelection`
payload and the adapter wraps/unwraps uniformly; core/bootstrap need not know rollback fields.

`session_entry` already has entries of type `runtime/model_selection` (the current model choice). Before the change the
migration, on hitting that old entry, reused its id and rewrote its data JSON; deriving from old messages added a new
entry; old message rows kept their bytes. Example for the old Z.ai Coding Plan identity:

```text
same session_entry.data before: providerId "builtin:zai-coding-plan", modelId "GLM-5.2", thoughtLevel "high"
same session_entry.data (earlier migration): providerId "account:zai-individual-coding-plan", modelId "GLM-5.2", options { reasoningLevel: "high" }
```

Two in-place losses: `thoughtLevel` was replaced and `providerId` kept its field name but changed value; keeping
`thoughtLevel` alone does not preserve the original model identity. Staging already had an entry of the same type with
a stable id, so it is not a new record category.

Ruling (user confirmed an omission): keep the entry's id / type and add `modelSelection` in `data`; old `providerId` /
`modelId` / `thoughtLevel` keep original values; later new-version selection writes update only the new member and do not
reverse-sync old fields. No new table or entry type; supersedes the earlier "store a separate new record" suggestion.

```ts
interface SessionModelSelectionEntryData {
  providerId?: string;
  modelId?: string;
  thoughtLevel?: string;
  modelSelection?: ModelSelection;
}
```

Old fields are optional because new records need no fabricated old values; other existing `data` fields are not removed.
`modelSelection` reuses the section-2 structure.

```text
first upgrade: old providerId/modelId/thoughtLevel -> original values kept (old version) + converted into modelSelection (new version)
later edits: update only modelSelection, keep old fields
```

An existing old entry gets the new member; with only old messages a selection entry may still be created with the new
selection in `modelSelection` and old messages unchanged. New-version read, save, restore and fork-like selection-copy
entries adapt to the wrapper (not just the migration function). Once new-version state exists it is not re-filled from old
fields or history; after clearing or invalid selection a restart does not resurrect old values; the empty marker follows
upper-layer constraints.

Acceptance reads raw database JSON: old fields equal before/after migration, the new member's identity and level
conversion are correct, editing the new selection keeps the old snapshot, migration is idempotent, old messages
unchanged; also check with the target old-version reader that original identity and level still read. Static old-version
check (staging restore chain): it reads unknown IDs but judges the model unavailable; with an available model there is a
fallback path, with none history opens but sending is blocked; the old version does not read `options.reasoningLevel`.
So the ruling fixes loss of the original selection snapshot; it does not claim the old version cannot open the whole
session, and no real old-App rollback was done.

Evidence: `packages/services/src/session/offPeakTaskRepo.ts`, `packages/services/src/repo-wiki/repoWikiStorage.ts`,
`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/model-selection-migration.ts`,
`packages/shared/src/legacy-model-provider-identity.ts`.

#### 6.18.4 Boundaries to Keep in Mind

- Session migration is decided; ModelSelection's general structure and other passes are unchanged. 6.19 lists only this
  Todo's own items.
- "Cleared selection must not resurrect old values" after preserving old values is a verification requirement of the three
  fixes and does not widen the general ModelSelection.
- Todo 69's rollback evidence covers the frozen staging Reader in its document and claims no full old-App rollback;
  acceptance must name the real rollback target and not treat new-version read/write tests as proof of old-version readability.

### 6.19 Supporting Changes Outside the Core Schema: Scope Narrowed and Approved

The user rules only this Todo's changes ("make sure nothing is broken; omissions are fine"). This section replaces the
earlier A/B/C list that mixed existing branch behavior.

#### 6.19.1 The 13 Supporting Items

| No. | Item                             | Confirmed change and boundary                                                                                                                                                                                                                 |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Session selection migration      | `modelSelection` added to the original `entry.data`, old `providerId` / `modelId` / `thoughtLevel` kept; read, save, restore and fork copy entries adapt; no new table or entry type (6.18.3)                                                 |
| 2   | Off-Peak save                    | the UPDATE no longer sets old `model` / `thought_level` to NULL; existing save chain (6.18.1)                                                                                                                                                 |
| 3   | Wiki / Draft save                | storage layer keeps old model, level and `maxOutputTokens` on save, reusing existing lock and atomic write; no restored budget feature, no save-mechanism refactor (6.18.2)                                                                   |
| 4   | Default-selection merge          | `model-selection.json` merged into `provider_config.json` `config.defaultModelSelection`; read/write, locked update, conflict check and notification adjust; clearing does not delete the file; no authorization to delete the old file (6.9) |
| 5   | Downloaded config path           | `active.json` -> `runtime/provider/<platform>/<app-version>/<server-address-id>/zcode-builtin.json`, keeping three isolation dimensions                                                                                                       |
| 6   | Refresh record path              | `refresh-control.json` -> same-directory `zcode-builtin-refresh.json`; fields, lease and retry unchanged                                                                                                                                      |
| 7   | Distribution record path         | `provider-provisioning-state.json` -> `runtime/provider/provisioning.json`; `records` / `syncId` and dedup semantics kept                                                                                                                     |
| 8   | Embedded resource copy           | fixed `runtime/provider/bundled/zcode-builtin.json`, atomic overwrite on startup when content differs, no per-hash copies (6.10)                                                                                                              |
| 9   | Format version closure           | five `schemaVersion` boundaries set to 1; default-selection own version shell removed; Bot keeps `version: 3` (6.11)                                                                                                                          |
| 10  | Source-switch refresh fix        | runtime built-in identifier includes the Endpoint source across existing consumers; no new persisted revision field (6.12)                                                                                                                    |
| 11  | Envelope and rollback adaptation | `sourceRevision` removed; default selection travels in `personalConfig` without outer `configuredDefault`; whole personal file applied, validated and rolled back as one with concurrent-edit protection (6.13)                               |
| 12  | Distribution result rename       | `registryRevision` -> `configRevision`, value and other result fields unchanged; `records` wrapper not trimmed (6.13)                                                                                                                         |
| 13  | Duplicate type cleanup           | data types derive from the schema within this Todo, including the account connection selection duplicate types without changing persisted fields (1.1 / 7)                                                                                    |

Parsing, serialization, App / standalone-CLI staging import and consumer adaptation required by the core schema rulings
still execute fully per 6.16. The unified monotonic release revision rule (6.12) stays but is not a new storage change.
Not required: message/Part formats, usage tables, global reasoning preference, recent selection, Automation, Bot, account
connection or credential mechanisms; the 6.14 passes/not-adjusted hold, and only the call adaptation needed by core
interface changes is done.

#### 6.19.2 Subagent Markdown: Misjudgment Corrected, Todo 97 Respected

Recording the A10 in-place Provider identity conversion as "newly found, awaiting ruling" was an error and is withdrawn.
Per [Todo 97 §1-3](./todo-97-subagent-markdown-in-place-migration-and-legacy-read-audit.md): Markdown is for users to read
and hand-edit; the official format keeps `model` / `thoughtLevel`; only old Provider identities in the user data
directory migrate in place within the original fields; project/plugin files are not written back; model ID, level, body,
comments and unrelated content are preserved. Here the original fields are the official format, not "old fields" of JSON
stores. This Todo does not turn Markdown into nested `modelSelection`, add fields, shadow files or old-identity
compatibility bypasses, and does not ask for Todo 97 to be re-approved; its execution/test evidence stays with Todo 97.

#### 6.19.3 Verification Meaning

Examples of already confirmed behavior, not four new mechanisms; reuse existing read/write and concurrency protection:

```text
old value kept: old field A -> new selection B -> old field still A, new field B
cleared does not resurrect: new version clears B -> restart -> still unselected, A not re-imported
merge does not overwrite: edit default model -> API Key and Provider config in the same file are kept
failed rollback does not overwrite: distribution writes B -> user saves C -> distribution fails -> C is not overwritten with the pre-distribution A
```

The clearing example applies only to entries where the business allows clearing; Off-Peak does not allow saving an empty
selection and gets no clear feature. No new null format or global compatibility framework.

## 7. Schema / Hand-Written Type Audit

Scope: the core structures discussed and directly related complete config/protocol types; not a repository-wide audit.

| Structure                                                 | Verified fact                                                                                                                                           | Direction                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ModelSelection                                            | `shared/model-selection.ts` already uses `z.infer`; `provider/registry.ts` re-exports and derives options                                               | keep                                                                                                                               |
| ProviderConfig, API, Access, Logo, Template               | `config/schema.ts` has runtime definitions; `provider-config.ts` still hand-writes Input / Object / interfaces                                          | derive from base data schemas; separate class input from serialized object                                                         |
| ModelConfig, Properties, input/output format, OptionSpecs | `config/schema.ts` has runtime definitions; `model-config.ts` hand-writes Input / Object                                                                | share schemas, derive data types; class deletion is not a precondition                                                             |
| ModelConfigRule members                                   | schema factory defines rule structure, `model-config.ts` hand-writes rule interfaces                                                                    | derive from each concrete rule schema; the factory parameter uses `ZodTypeAny`, so keep the concrete `config` type and avoid `any` |
| Registry complete config                                  | `resolver.ts` hand-writes `RegistryModelConfig` / `RegistryModelConfigObject`; completeness relies on `validateComplete`, no standalone complete schema | share field definitions with complete / sparse / manual configs; do not claim a complete schema already exists                     |
| Protocol `ZCodeProviderAccountAccess`                     | `shared/zcode-protocol/index.ts` already infers from schema; Resolver has a same-shape hand-written Registry account access structure                   | keep derived protocol types; obey package dependency direction when sharing shapes                                                 |
| Account connection selection and settings                 | `shared/provider-family-connection-selection.ts` defines two schemas but hand-writes union and settings-map types                                       | derive from schema; no change to kind, team IDs or persisted shape                                                                 |

## 8. Status Checklist

Done (all recorded in the sections above): review background and unreleased-schema reorganization principle;
ModelSelection shape; ProviderConfig renames and retained items; ModelConfig layering; Match renames, layered Match and
smart/manual collections (`useSmartConfig` superseded); rule-collection naming, strict Match boundaries, `providerMatch`
deletion and the four rules moved to Site; `templateNameMap` / `providerName` / creation-time name dedup; rule `type`
deletion; personal `config` layer and full file layering; default-selection merge; `runtime/provider` layout and fixed
resource overwrite; five `schemaVersion` boundaries and unified release revision; refresh / distribution shrink; other
ModelSelection attachments passed and account selection / credential key not adjusted; Session `modelSelection`
migration with read/save/copy adaptation (B1c, B5 evidence in ledger); 6.19 narrowed to 13 items and Subagent A10
misjudgment withdrawn; Off-Peak / Wiki old-field preservation verified; 6.12 source identifier fix, `sourceRevision`
deletion and `registryRevision` rename (real file Source/Registry and the built Worker source delivery and exact model
request passed); section 7 duplicate data types derived from schemas with one-way dependency; sections 3, 5, 6 fields,
modes and structures landed with schema, serialization, consumers and batch verification (the `api` layer kept; withdrawn
or skipped suggestions not implemented).

Open:

- [ ] Complete the 6.15 implementation acceptance: fresh install and staging upgrade converge to the final format;
      verify repeated start, distribution rollback and source switching; no migration for unreleased intermediate formats.

Follow-up implementation uses the repository spec/test conventions; Design V2 and the Todo status are synced once landed
and verified. This document does not create migration versions, OAuth fields, a global naming convention or new
architecture work.
