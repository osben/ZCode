# Todo 55: Provider Template Inheritance and Retirement of Normal Built-in Providers

> Status: Completed
>
> Date: 2026-09-01
>
> Supersedes: the interim designs in Todo 49/50/51 on normal Built-in Provider placement, the fixed Family
> "pay-as-you-go API" slot, the Welcome fixed API Provider Overlay and Provider top-level `enabled`. The Z.ai/BigModel
> Account Family, Account Access, `entitled`, request-time credentials and Off-Peak auth boundaries stay valid.

## 0. Current decisions at a glance

- A Provider Template is not a Provider, only the Built-in config baseline a Personal Provider references when
  created; one Template can create several independent instances.
- All non-Account Built-in Concrete Providers are retired; Z.ai API, BigModel API and other third-party vendors all
  become Provider Templates.
- The Z.ai/BigModel Family stays but organizes only the Start, Individual, Team and Off-Peak Account Providers; no
  more "pay-as-you-go API" connection item.
- Account Provider definitions come from the Built-in Release and are fixed into their Family's Settings structure;
  users neither create nor delete them. The Account Overlay's `access.entitled` decides only whether the current
  account has access eligibility.
- Provider top-level `enabled` is finally decided to be deleted entirely; Settings placement, account entitlement,
  config completeness and Model `enabled` each express one fact.
- Account Access's identity field is renamed from `access.family` to `access.accountType = "zai" | "bigmodel"`; the
  Provider Family product structure stays.
- On Welcome each submission of a Z.ai/BigModel API key creates a new Personal Provider instance from the matching
  Template and writes the key; no lookup, reuse or maintenance of a "canonical API instance".
- Template instance creation reuses the generic `createPersonalProvider`; Provider, initial Personal Overlay, unique
  label and `providerOrder` are written atomically in one Repository update; Welcome owns no dedicated Provider
  creation interface.
- Account login handles only Account Providers and never creates a pay-as-you-go API Personal Provider;
  `providerSetupCompleted` controls only whether the automatic guide reappears, not Provider creation dedup, Registry
  or Family Selection.
- Settings does not merge Template inheritance source with `effectiveBuiltinConfig`: `templateConfig`,
  `effectiveBuiltinConfig`, `personalConfig` and `effectiveConfig` keep their precise meanings.
- The Provider-level `enabled` field, Facade DTO and "Enabled" pill are deleted; `executable`, `entitled` or API key
  presence must not masquerade as a new Provider enabled.

### 0.1 Terminology

| Name                      | Sole meaning                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Provider Template         | Built-in-published Provider config inheritance source; cannot execute                   |
| Account Concrete Provider | Built-in-published account product Provider; constrained by Account Overlay             |
| Personal Provider         | User-created real Provider instance with a unique `providerId`                          |
| Personal Provider Overlay | Sparse config the user saves for a real Provider instance                               |
| Effective Provider Config | Final config the Resolver composes from all applicable sources for Registry             |
| Account Family            | Settings navigation and connection-selection boundary of Z.ai/BigModel account products |
| `access.entitled`         | Whether the current account has access eligibility for the Account Provider             |
| executable                | Resolver result: Provider/Model config is complete and satisfies execution conditions   |

Template, Family, entitlement, Settings placement and executable do not replace each other.

## 1. Goals and invariants

Normal third-party vendors are no longer published as "not yet added but already existing" Built-in Concrete
Providers; they become reusable Provider Templates, and users create one or more Personal Providers with independent
`providerId` from a Template:

```text
Provider Template (DeepSeek, Moonshot Kimi, MiniMax, ...)
   -- create Personal instance; official config facts are not copied -->
Personal Provider (providerId = deepseek-work, templateId = deepseek, Personal Overlay)
   -> Effective Provider Config -> Provider Registry
```

A Template is not a Provider: it never enters Registry, model selection or the created-Provider list, has no runtime
`providerId` and cannot execute directly; it is only the Built-in inheritance baseline of Provider Config.

The Z.ai/BigModel Family is kept but narrowed to organizing Account Providers only; pay-as-you-go API is decoupled
from the Family:

```text
Z.ai Account Family / BigModel Account Family: Start Plan, Individual Coding Plan, Team Coding Plan, Off-Peak
Normal Provider Templates: Z.ai API, BigModel API, DeepSeek, Moonshot Kimi, ...
```

- `zai-api`, `bigmodel-api` move from fixed Built-in Concrete Providers into Provider Templates and enter the normal
  "Add Supplier" menu like other Templates, allowing several Personal instances.
- Start, Individual, Team and Off-Peak Account Providers stay organized by their Family.
- `ProviderFamilyDomain`, Account Family Header/Connection UI, plan/quota/upgrade, account credentials and the
  Off-Peak consumption chain stay.
- `ProviderFamilyConnectionSelection` drops the `kind: "api-key"` branch and keeps only Start, Individual and Team
  Account selections.
- No `family: "zhipu" | "others"` is added; Settings keeps the existing grouping structure.
- "Keep Family" does not mean keeping the deleted parallel `oauth | apiKey` mode helper; the formal connection
  selection is the narrowed Account `ProviderFamilyConnectionSelection`.

## 2. Config and Built-in Release

### 2.1 Reuse the existing Provider Config value structure

No separate complete `ProviderTemplateConfig` value object. Template Map values reuse `ProviderConfigOverlay`;
Built-in Concrete Provider, Provider Template and Personal Provider share one field Schema, Overlay, nested
API/Access Config and JSON round-trip:

```ts
type ProviderTemplateMap = ReadonlyMap<TemplateId, ProviderConfigOverlay>;
```

Only the Map container keyed by `templateId` is separate, not a second Provider Config value type. Provider Config
adds `readonly templateId?: string | null;`. No new display `family` field. The existing `ProviderGroup` stays for
now: `zai-family` / `bigmodel-family` express only the Family config ownership of Account Providers; Template-created
Personal Providers stay in the existing Personal grouping; once normal Built-in Concrete Providers are cleared,
`standard-builtin` is deleted with its old lifecycle (mechanical scanning only proves zero residue). No "Zhipu /
Others" split or renaming of the existing Family.

Reusing the same value structure does not give a Template Provider identity. Template, Built-in, Account and
Personal Sources use strict Source Schemas (extending or narrowing the shared field Schema), all constructing
Provider Config after parsing. The Template Source Schema narrows the shared Overlay Schema:

```text
Allowed: label / logoUrl; api (type / baseURL / headers); the official static structure of access and
         apiKeyManagementUrl; builtinModelIds
Rejected: templateId (Template does not inherit recursively); group; modelIds / modelOrder; visibility;
          real apiKey, entitled, account credentials or request-time material
```

An API key Template without a real key is normal; a Template gets Source structure validation only (no
final-executable Provider integrity validation); Template official members use only `builtinModelIds` (user members
stay in the Personal Provider's `modelIds`); the Template Map's JSON order is the Settings creation menu order (no
second order field). Templates use a `templateId`-keyed Map and Providers a `providerId`-keyed Map; containers reuse
the internal Provider Config Overlay but container APIs and variable names clearly distinguish Template ID from
Provider ID.

### 2.2 Built-in Release structure

```ts
interface ZCodeBuiltinConfigContent {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates: ProviderTemplateMap;
  readonly modelConfigRules: ZCodeBuiltinModelConfigRules;
}
```

`providers` holds Start / Individual / Team and Off-Peak Account Providers; `providerTemplates` holds Z.ai API /
BigModel API, DeepSeek, Moonshot Kimi, MiniMax and other normal third-party vendors. `providerTemplates` is not a
Catalog (no market, discovery, install or independent version semantics). The three belong to one Built-in
revision: parsed together, published together, rolled back together through Active/LKG, never applied by separate
versions. The `zai-api` / `bigmodel-api` fixed Concrete Provider identity and Family slot exit (the strings may stay
as stable Template IDs but never as fixed runtime Provider IDs). No Family-Template bridge: Family resolves Account
Providers, Template creates Personal Providers.

### 2.3 Provider Overlay order

The Resolver first obtains the Concrete Provider's Effective `templateId` by normal Overlay semantics, then
composes: Template -> Built-in Concrete Provider -> Account Overlay -> Personal Overlay -> Effective Provider Config.
Three real paths: Template-created Personal Provider = Template -> Personal; Built-in/Account Provider optionally
inheriting a Template = Template -> Built-in -> Account -> Personal; fully custom Personal Provider = Personal.

A Built-in Provider's `templateId` convention is declared by the Built-in Source and a Personal-only Provider's by
the Personal Source; no new Source ownership gate. A Personal explicit value and `null` follow ordinary Overlay
override/clear semantics. A Template does not inherit a Template: the Resolver reads only the Concrete Provider's
Effective `templateId` and never interprets a `templateId` inside a Template value (no inheritance graph, cycle
detection or multi-level resolver). When the Template and Concrete Provider Access discriminants differ, the existing
`overlayProviderAccess()` whole-replacement semantics apply.

Resolver and Settings keep four distinct facts (no vague `inheritedConfig`):

- `templateConfig?`: the official Template Overlay `templateId` points to; excludes Concrete/Account/Personal.
- `effectiveBuiltinConfig?`: only on the Concrete Built-in Provider path; if it references a Template it is
  Template -> Built-in -> Account (excludes Personal).
- `personalConfig?`: the Personal sparse Overlay of the real providerId.
- `effectiveConfig`: the final Effective Provider Config.

So a Template-created pure Personal Provider has `templateConfig`, `personalConfig` and `effectiveConfig` but no
`effectiveBuiltinConfig`; a fully custom Personal Provider may have only `personalConfig` and `effectiveConfig`.
Inheritance is the Resolver's composition relationship, not a new persisted Config Source. This describes the
Provider Settings Provider View; the Model Settings View's `effectiveBuiltinConfig` still means the baseline
resolved by Built-in Model Rules without a Personal Rule (it may exist even for a model of a pure Personal Provider;
do not delete or fake Model-layer facts because the Provider layer has none).

`templateId` participates only in Config Resolver, Model Rules and Settings baseline. After Effective Config is
produced, Registry, Selection, ModelFactory, Adapter and request protocol do not depend on Template ID; formal
execution always uses the real `providerId`, Effective API and Effective Access.

### 2.4 Provider top-level `enabled` deleted

No compat field or interim dual-read. Its placement duty retires with the normal Built-in Provider lifecycle:
Template needs no Provider `enabled`; a Personal Provider's definition existing means the user created that instance
and it is visible in Settings; incomplete config (missing key, Endpoint) is saved and stays in Settings but never
becomes an executable Registry Provider; Account Providers are fixed in their Family and no longer depend on
Provider `enabled` for placement; Account `access.entitled` still expresses only account eligibility; Model Config
`enabled` stays and controls specific models.

"Account Provider fixed" describes only definition source and Settings placement: the Built-in Release declares the
Account Provider identity and its Family; it does not mean it is necessarily executable — the Account Overlay still
supplies current account facts, and `entitled` plus config completeness decide whether it enters the executable
Registry.

```text
Settings placement: Account Provider = Family structure declaration; Personal Provider = Personal definition exists
Executable: Effective Provider config complete; Account Provider also needs access.entitled; target Model enabled and complete
```

`enabled` deletion closes Resolver, Config Service, Facade, Settings and tests at once, with no second placement
fallback.

## 3. Model Config Rules

### 3.1 Template exact Rule

The `match | provider-model` Rule union adds:

```ts
interface TemplateModelConfigRule {
  readonly type: "template-model";
  readonly templateId: string;
  readonly modelId: string;
  readonly config: ModelConfig;
}
```

`match` matches by general provider/model/api/baseURL facts; `template-model` matches Template official defaults by
`templateId + modelId`; `provider-model` matches a Concrete Provider/instance by real `providerId + modelId`.
Resolution Input adds an optional `templateId` (never passing a Template ID off as a Provider ID):
`modelRules.resolve({ providerId, templateId, modelId, apiType, baseURL })`.

### 3.2 Rules layered by config field

Different Rule types do not rely on the accident of position in one mixed JSON array to express cross-layer priority:

```ts
interface ZCodeBuiltinModelConfigRules {
  readonly matchRules: readonly MatchModelConfigRule[];
  readonly templateModelRules: readonly TemplateModelConfigRule[];
  readonly providerModelRules: readonly ProviderModelConfigRule[];
}

interface PersonalModelConfigRules {
  readonly matchRules: readonly MatchModelConfigRule[];
  readonly providerModelRules: readonly ProviderModelConfigRule[];
}
```

Within each field Overlay is strictly in written order. The Source Decoder concatenates the fields in fixed order
into the existing ordered `ModelConfigRules` sequence; the Resolver still iterates rule by rule with no dynamic
sorting, bucketing or priority inference by Rule type. Order: Built-in match -> Built-in template-model -> Built-in
provider-model -> Personal match -> Personal provider-model -> Effective Model Config.

- Template official differences go in Built-in `template-model`; Account Concrete Provider official differences stay
  in Built-in `provider-model`; editing a concrete instance writes only Personal `provider-model`.
- The Personal Source does not accept `template-model` (users cannot modify the shared Template baseline).
- The Personal exact Rule write API still operates only on `providerModelRules`.

### 3.3 Model membership and enable/disable

No Template-specific `models: [{ modelId, enabled }]` or second Model Config: `Template.builtinModelIds` is the
Built-in-owned membership and initial physical order; Built-in `template-model.config.enabled` is the official
default enable of a model in a Template instance; Built-in `provider-model.config.enabled` is the official default
for an Account Concrete Provider; Personal `provider-model.config.enabled` is the user's final override for a real
instance. A Template's `builtinModelIds` stay Built-in-owned members in the instance and Personal `modelIds` stay
user members; existing member ownership, Built-in-wins dedup and `modelOrder` Overlay are reused.

## 4. Create, update, delete

### 4.1 Create

The old `addBuiltinProvider(providerId)` is retired; blank creation, Settings Template creation and Welcome API key
creation are unified:

```ts
createPersonalProvider(input?: {
  readonly templateId?: string;
  readonly initialConfig?: ProviderConfigOverlay;
}): PersonalProviderCreation;
```

- No `templateId`: blank custom Provider. With `templateId`: confirm the current Release has the Template, generate
  a unique `providerId`, write only `templateId` and the needed Personal initial Overlay.
- No copy of Template API, members or Model Rules; no duplicate Template Rule per instance; one Template can create
  several instances.
- The Template `label` is only the menu text and name seed; creation writes a unique Personal label (`DeepSeek`,
  `DeepSeek 2`); later the label belongs to the instance and renaming a Template does not rename existing instances.
- Provider Config, `templateId`, `initialConfig` (including a Welcome-submitted API key), unique label and
  `providerOrder` are written in one Repository update; never create an empty Provider then add the key through a
  second API.
- `templateId` is accepted only as a top-level creation parameter; `initialConfig` must not carry `templateId`,
  `providerId`, `providerOrder` or other identity/container fields.
- A failed creation writes no `providerSetupCompleted`, half-finished Provider or orphan order member.
- Welcome's existing "set a usable default model after creation" behavior is unchanged and keeps using the existing
  model selection API (not merged into the Provider Config Repository).

Z.ai/BigModel pay-as-you-go API uses the same creation as other Templates: each Welcome/API key form submission
selects the matching Template and passes the key as `initialConfig` to the same atomic `createPersonalProvider`; no
lookup/reuse by Template, brand or API key and no "Family canonical API instance"; `providerSetupCompleted` is
written only after a successful creation and constrains only whether Welcome appears automatically (not a user
explicitly re-entering the API key flow); account login triggers no Template instance creation; Settings lets users
keep creating instances from one Template; creating an API instance writes no `ProviderFamilyConnectionSelection` and
does not change the current Account Family selection; no binding field or recovery logic for "which Template
instance belongs to a Family".

### 4.2 Update

Instance saving keeps using the generic Personal Provider Overlay API. A Template update propagates to all
referencing instances through the Built-in revision; explicit Personal leaves override last. A Registry update
affects only Active Models created afterwards; already created Active Models stay frozen.

### 4.3 Delete

Deleting a Personal Provider atomically deletes in one Repository update: the Personal Provider Config, the Personal
`providerOrder` member and every Personal `provider-model` Rule precisely bound to that `providerId`. It does not
delete generic `match` Rules, Built-in `template-model`, the Template itself or another Provider's Rules. The
existing `deletePersonalProvider -> deleteExactForProvider` atomic boundary is kept. Template-created Z.ai/BigModel
API Providers use the same delete semantics; Account Family Providers do not enter the normal delete entry.

## 5. Settings, Family and Welcome

### 5.1 Settings Template menu

Normal third-party `addableProviders` no longer projects disabled Built-in Providers; an independent
`providerTemplates` candidate projection serves only the Settings creation menu (never the Registry Provider View):
Built-in `providerTemplates` -> Settings Template Menu -> `createPersonalProvider({ templateId })` -> Personal
Provider Instance -> Settings Provider List / Registry (when complete). The Settings Facade projects the four
independent Resolver facts (`templateConfig?`, `effectiveBuiltinConfig?`, `personalConfig?`, `effectiveConfig`) and
no `inheritedConfig` flattens them. Restore defaults, modification marks and member source read the matching fact:
a Template Personal instance's Provider default baseline is `templateConfig`; a Built-in/Account Provider's is
`effectiveBuiltinConfig`; a fully custom Personal Provider has no official Provider baseline; Model defaults are
always resolved by the same Model Rule Resolver excluding that instance's Personal exact Rule (not only the Provider
Template, no UI fallback). These projections must guarantee: "restore default" goes back to the right baseline;
Template models show as Built-in-owned; Personal modification style reflects only the Personal Overlay; newly added
model defaults equal the real Registry; an instance with a missing Template or incomplete config stays visible with a
Config issue.

### 5.2 Family retained

Family is the retained Account product combination and connection-selection boundary:
`ProviderFamilyDomain = zai | bigmodel` -> the Family page (start-plan, individual-coding-plan, team-coding-plan) ->
`ProviderFamilyConnectionSelection`. Kept and verified: Family Header, Account connection menu and persistence of the
current selection; Start/Individual/Team switching and recovery; `providerFamilyDomain` syncing with the login account
system; plan, quota, upgrade, account credentials and Off-Peak consumption of the Z.ai/BigModel identity. Exits: the
`api-key` variant of `ProviderFamilyConnectionSelection`, fixed Provider IDs and the matching App Settings data.
Z.ai/BigModel API Templates enter the normal "Add Supplier" candidates but not the Account Family connection menu; no
second `oauth | apiKey` mode state.

Off-Peak still belongs to the Account Family's account and plan product chain but is a hidden execution Provider: not
a `ProviderFamilyConnectionSelection` candidate, not in the normal Settings Provider list, no user edit entry; internal
idle execution uses it by real Provider ID through the ordinary Registry/ModelFactory.

Inside Account Access this round renames `access.family` to `access.accountType = zai | bigmodel` (the account access
identity). `ProviderFamilyDomain` and Connection Selection describe the product UI and user connection selection.
The value domains are equal but the duties differ; neither replaces the other nor justifies deleting Family state.

### 5.3 Existing grouping unchanged

No `family: "zhipu" | "others"`, `brandGroup` or `settingsSection`. Settings keeps: the Z.ai / BigModel Account Family
entry (existing preset/family path) and the Personal Provider list (blank creation, Template creation including Z.ai
API / BigModel API). Template changes only the creation source of normal third-party Providers, not the left
navigation information architecture.

### 5.4 Welcome

`providerSetupCompleted` stays as the independent setting meaning "start guide completed or skipped"; it does not
participate in Registry, Template inheritance, Family Connection Selection or Account entitlement. Welcome auto-opens
when `providerSetupCompleted = false` AND there is no executable Provider. Each submission of a Z.ai/BigModel API key
locates the matching Provider Template and calls `createPersonalProvider({ templateId, initialConfig: { access: {
type: "api-key", apiKey } } })`, atomically writing the Personal Provider and order. It copies no Built-in Provider,
writes no Account Overlay and does not write or modify the Account Family Connection Selection. Account login does not
take this chain; `providerSetupCompleted` controls only the automatic guide, not instance reuse or dedup.

## 6. Built-in sync and persistence

- Adding `providerTemplates` bumps the Built-in Release Schema Version; Bundled, Remote, Active, LKG,
  Endpoint-scoped cache and the materializer carry the same Templates; a Remote Release atomically replaces
  `{ providers, providerTemplates, modelConfigRules }`.
- Template ID is a stable reference key; Personal instances may reference it long-term. When the publisher deletes a
  Template, referencing instances stay in Settings with a `missing-template` issue and do not enter Registry. No
  Template retirement metadata yet: the publishing discipline is not to delete published Templates.
- Personal `provider_config.json` keeps providers, modelConfigRules and providerOrder, adding only `templateId`.
  Family Connection Selection stays in existing App Settings, not moved into Personal Provider Config.
- The branch was unlaunched, so no alias, compat reading or migrator for unreleased interim shapes.

## 7. Cleanup boundary

Deleted: all non-Account Built-in Concrete Providers including fixed `zai-api` / `bigmodel-api`; normal third-party
Provider top-level `enabled` placement and Built-in resurrection checks; normal third-party `addBuiltinProvider`,
`addableProviders` and Overlay recreation; the two sets of form permission checks for normal Built-in/Personal;
stale tests, Fixtures, docs and Feature Graph seeds; Provider `enabled` in Provider Settings View/DTO, the normal
Provider "Enabled" pill and the UI branches derived from it; the `standard-builtin` group value. Explicitly kept:
`zai-family`, `bigmodel-family` and the current Personal grouping; `ProviderFamilyDomain`, the narrowed Account
`ProviderFamilyConnectionSelection` and its persistence; Account Family Header/Connection UI; the Account plan, quota,
upgrade, credential and Off-Peak Family consumption chain.

Doc/graph sync happens before tests and production code: `design.md`, `configuration.md`,
`provider-and-model-configuration-overview.md`, `zcode-builtin-provider-config.md`,
`model-membership-and-enablement.md`, `settings.md`, `request-compatibility-and-access-protocols.md` (fixed API
Provider / Account Type boundary), and the Feature Graph (normal Built-in placement, Provider enabled, Family
pay-as-you-go API and Welcome fixed Provider seed). Historical Todos remain a decision trail.

## 8. Acceptance

### Config / Release

- `templateId` Overlay, `null` clearing and JSON round-trip.
- Template Source accepts an official baseline without a real key and rejects illegal structure; its field allowlist
  rejects `group/modelIds/modelOrder/enabled/visibility/templateId` and real credentials.
- Built-in Release atomic parsing, version rejection, Remote/LKG fallback.
- A Template never enters the Provider set or Registry; a missing-Template instance keeps a Settings issue and is not
  in Registry; Templates do not inherit recursively.
- The Release's Concrete `providers` hold only Account Providers; Z.ai API / BigModel API exist in Templates.

### Provider / Model Resolver

- Two instances of one Template get the same official baseline and Personal overrides do not pollute each other.
- Built-in/Account Providers can choose to inherit a Template; Personal `templateId` override and `null` clearing
  follow Overlay.
- `template-model` hits only by Template ID + Model ID; within a field written order holds, across fields the Config
  Schema fixes the order; Account `provider-model` comes after Template Rules and Personal Rules always last;
  generic match, API Schema, baseURL and Active Model freeze do not regress.

### Lifecycle / Settings

- One Template can create several instances with unique Provider IDs and labels; the Template label is only a name
  seed and existing instances do not follow a rename.
- Creation atomically writes Provider, initialConfig and providerOrder in one Repository transaction; failure leaves
  no half-finished state.
- Deleting an instance atomically clears order and exact Personal Rules.
- A blank custom Provider without a Template can still be configured, saved, tested and executed; incomplete config
  is visible but not executable.
- Template baseline correctly drives defaults, restore defaults, modification marks and member source; a Template
  Personal instance has no fake `effectiveBuiltinConfig`; the four Settings Config projections have accurate
  semantics.
- The Template menu includes Z.ai API / BigModel API and each can create several instances; Family pages contain only
  Start, Individual and Team (no pay-as-you-go API); Off-Peak is not in Family Connection Selection or the normal
  Settings list, and internal exact execution does not regress.
- Each Welcome key save creates a new instance from the correct Template, reuses no old instance and does not modify
  Account Connection Selection; account login creates no pay-as-you-go API Template instance;
  `providerSetupCompleted` does not take part in instance dedup.

### Family / Account regression

- `providerFamilyDomain` switching and login recovery; Start/Individual/Team Connection Selection round-trip; no
  residue of the old `api-key` variant.
- Z.ai API / BigModel API Template instances are not consumed by Family navigation or the Account Resolver; Start
  model members, Individual/Team entitlement and state do not regress; plan, quota, upgrade, account credentials and
  Off-Peak read the right Account Type; no second `oauth | apiKey` mode state.
- Provider Settings DTO and UI have no Provider-level enabled or "Enabled" pill; Model enabled unchanged.

### Runtime / mechanical

- Connection tests and real requests use the instance's real `providerId` and Effective Config; the same modelId in
  different instances does not cross Providers; Automation, Subagent, Repo Wiki do not know Templates; desktop
  continuous, Web/Mobile replayable and remote workspace add no runtime state.
- Provider, Provider Node, Services, UI directed tests and typecheck; Template multi-instance and Account Family
  isolation E2E; `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, format check, `git diff --check`; `rg`/`dep:refs`
  prove the normal Built-in lifecycle and Provider enabled cleanup is complete, and tests prove Account Family was not
  mistakenly deleted while fixed API Provider and Family `api-key` branches are fully cleared.

## 9. Review risks and implementation constraints

1. **Template validation timing:** a Template gets only Source structure validation; the completeness/executable
   check happens at the Effective Provider Config of the Concrete/Personal/Account layers. No fake key for
   Templates, no relaxed final completeness, no fallback around the boundary.
2. **Template Map vs Provider Map:** `providerTemplates` uses `templateId`, `providers` uses `providerId`; Template
   Map values reuse `ProviderConfigOverlay` (no second full Template Config value type) and Template ID is never
   called Provider ID in APIs or variables.
3. **Settings source facts come from the sole Resolver:** Template inheritance is not `effectiveBuiltinConfig`; the
   Resolver keeps `templateConfig`, `effectiveBuiltinConfig`, `personalConfig` and `effectiveConfig` separately and
   Settings only projects them; Registry, Settings and Preview must not each assemble a Template, or restore
   defaults, member source, modification marks and new-model defaults diverge.
4. **Account Family is an explicitly kept invariant:** pay-as-you-go API moves from Family to Template, but Account
   Family must not be deleted or rebuilt along the way (Template path: ordinary Provider Template incl. Z.ai/BigModel
   API -> Personal Provider Instance; Family path: Z.ai/BigModel Account Family -> Account Connection Selection ->
   Account Provider; both feed Provider Registry).
5. **Z.ai/BigModel API Template is not bound to Family:** no fixed Provider ID, canonical instance, Family slot or
   "current Family API instance"; Family consumes only Account Providers; Template instances execute only through the
   standard Settings/Registry path.
6. **Provider `enabled` decoupled from Family placement:** Account Provider display comes from the Family structure,
   Personal Provider display from its Personal definition existing; do not infer display from API key presence or
   `executable` (incomplete but visible is a legal state). Facade and UI delete Provider-level `enabled` together:
   normal Providers show no "Enabled" pill; Account Provider product state is expressed by the plan/connection
   status card; config problems by issues and the executable result; none may be renamed to enabled.
7. **Rule classification by Config:** `composeEffective()` stays the shared composition entry; with Template it still
   builds one ordered Rule sequence and three places must not each sort or concatenate.
8. **Release and tooling extend atomically:** `providerTemplates` touches the Release codec, remote client, Endpoint
   cache, materializer, formal bundle, integrity tests, publisher evidence, E2E fixtures and helpers; dev success does
   not replace formal-package and Remote Workspace proof.
9. **Template ID never enters runtime:** it is a config inheritance source, not a request routing identity;
   Selection, task persistence, ModelFactory and Adapter add no Template branch.
10. **Template ID vs Provider ID:** the two Maps allow `templateId = deepseek` and `providerId = deepseek`; the
    independent `template-model` / `provider-model` Rules must keep identities from being confused by string
    equality.

## 10. Completion criteria

Template and Provider identities are strictly separate while the config values reuse Provider Config; Template Map
values reuse `ProviderConfigOverlay` with an explicit Source field allowlist; one Template can create several
non-polluting Personal Providers; Built-in/Account Concrete Providers may inherit a Template; Built-in Config
atomically contains fixed Providers, Provider Templates and layered Model Rules; the normal third-party Built-in
Concrete Provider, placement enabled and addable lifecycles are fully gone; Z.ai/BigModel API enters the normal
Personal Provider creation chain as a Template with the fixed Concrete Provider identity cleared; the Z.ai/BigModel
Account Family, the narrowed Account Connection Selection and the Account product chain are fully kept; the Family
`api-key` item, fixed API Provider ID special cases and the Welcome fixed Overlay chain are zero; no
`family = zhipu | others` or other grouping field; no second Provider/Model facts in Settings, Registry, ModelFactory
or Runtime; Settings does not confuse Template source, Effective Built-in, Personal Overlay and the final Effective
Config; Provider-level enabled field, DTO, pill and implicit substitutes are zero while Model enabled stays; Account
entitlement, plan, request-time credentials, Off-Peak and Active Model freeze are correct; all targeted, full and
E2E evidence passes.

## 11. Outcome (2026-09-01)

Provider Template cutover completed: the Built-in Release is the atomic `providers + providerTemplates +
modelConfigRules` version; all normal third-party Providers became Templates (only Account/Off-Peak keep Built-in
Concrete Providers); Settings and Welcome both create independent Personal Providers through
`createPersonalProvider(templateId, ...)`; Z.ai/BigModel pay-as-you-go API left the Family Connection Selection and
Template ID is no longer a runtime Provider ID; Account Registry Access uses `accountType` while request-time account
access facts keep using `family`; Provider top-level `enabled`, fixed API Provider special cases and related
UI/test residue are deleted; Personal Rules and the Provisioning Envelope use the layered Rule structure;
Z.ai/BigModel Endpoint-specific capabilities match by `baseURL + api.type`, not by fixed Provider ID.

Verification: Provider/Provider Node directed tests, affected Services/UI tests, root `typecheck`, `lint` and full
`test:unit`; CLI Bootstrap Provider directed tests and standalone `typecheck` passed. CLI Bootstrap full run has 106
test files and all Todo 55-related cases pass; the remaining 8 failures belong to the existing v4 boundary/stale
revision, official plugin resource and real-network Marketplace baselines, not Provider Template. Real Electron/WDIO
evidence is supplied uniformly by Todo 57.
