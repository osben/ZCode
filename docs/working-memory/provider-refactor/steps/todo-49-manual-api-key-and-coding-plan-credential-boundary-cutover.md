# Todo 49: Manual Pay-as-you-go API and Coding Plan Credential Boundary Cutover

> Status: Completed
>
> Date: 2026-08-31
>
> Prerequisite evidence: [`todo-48-account-api-and-manual-api-key-boundary-cleanup.md`](./todo-48-account-api-and-manual-api-key-boundary-cleanup.md)

## 1. Goal

Revoke the "Account API Provider" that Provider Refactor introduced without staging product basis and restore the
staging product semantics:

```text
Family pay-as-you-go API
└─ zai-api / bigmodel-api
   ├─ access.type = api-key
   ├─ group = zai-family / bigmodel-family
   ├─ Built-in enabled = true (fixed Family membership)
   ├─ user types the API key
   ├─ Built-in provides Endpoint / API Schema / models
   └─ Personal saves the key and allowed Overlay

Account Provider: Start Plan, Individual Coding Plan, Team Coding Plan, Off-Peak
```

Coding Plan's automatic acquisition of a project key to run model requests stays, but belongs only to Coding Plan
internal request auth and is never again interpreted as an "account pay-as-you-go API".

## 2. Sole credential chains

### 2.1 Pay-as-you-go API

```text
user types key -> Personal Provider Config -> Effective access.type = api-key -> ModelFactory / Adapter uses the key directly
```

- Provider identities are fixed `zai-api` / `bigmodel-api`, permanently occupying the Family "pay-as-you-go API"
  slot of `zai-family` / `bigmodel-family`; not in normal "Add Supplier" candidates.
- Built-in `enabled=true`, no Provider enable/disable button; a missing key only means incomplete and non-executable.
- No dynamic custom Provider; no copy of Built-in Endpoint, Schema or model members to Personal Config.
- Family connection selection may keep `kind: "api-key"` but must reference this ordinary API Provider.
- Never enters Account Overlay, Account Request Auth or the Coding Plan entitlement chain.

### 2.2 Coding Plan

```text
current logged-in account
  ├─ Individual Coding Plan -> find or create the project key from the personal organization/project
  ├─ Team Coding Plan       -> team project key from the selected organization/project
  ├─ Start Plan             -> Start Plan JWT
  └─ Off-Peak               -> request material of the current compatible Coding Plan connection
```

- Users do not type Coding Plan project keys; auto-obtained keys never enter Personal Provider Config.
- Individual discovers the personal organization/project from the current account then finds or creates the personal
  project key; Team uses the already selected and validated `organizationId/projectId`.
- The two may share the underlying project key API but not identity discovery, cache keys or credential Owner.
- Resolvers are named by real duty so `AccountProviderApiKeyResolver` is not misused for ordinary `api-key`
  Providers; no strategy object or new generic Access abstraction; dispatch by the existing `zhipu-account` Mode.

## 3. Config and Registry

1. Delete `account:zai-api-key` and `account:bigmodel-api-key` from ZCode Built-in Config.
2. Delete `api-key` from `ZhipuAccountMode`; `zhipu-account` keeps only real account product Modes.
3. Keep `zai-api` / `bigmodel-api`, moving their group from `standard-builtin` to `zai-family` / `bigmodel-family`
   as each Family's sole pay-as-you-go API Provider.
4. They are `enabled=true` in Built-in. Built-in keeps the fixed Endpoint, API Schema, model members and default
   order; Personal saves only the key and allowed sparse overrides, no Family Provider ordering, and never
   `enabled=false` to express a missing key.
5. Family `kind=api-key` selection resolves to the ordinary API Provider; Account Resolver no longer enumerates or
   projects the API Key Mode.
6. Registry must not contain two Providers of one Family with identical Endpoint, Schema and models differing only
   by Access type.
7. Personal Source keeps forbidding real `zhipu-account` Providers from overriding `access`; ordinary `api-key`
   Providers can save keys normally.

### 3.1 Unified Settings and Registry semantics

No three "enable UIs" for three Provider kinds. Provider `enabled` only means "joined to the current config"; Account
plan eligibility is `access.entitled`. Both go into one Effective Provider Config consumed side by side by Settings
and Registry:

```text
Effective Provider Config: enabled, visibility, access.entitled (zhipu-account only)
  -> Settings: enabled decides whether a normal Built-in sits in the main list or the add menu
  -> Registry: enabled + access entitlement + complete + model enabled
```

- Normal Built-in: Built-in `enabled=false`, "Add Supplier" writes an explicit Personal `enabled=true`; Family
  pay-as-you-go API and Account Providers: Built-in `enabled=true`, fixed in the Family.
- Missing API key or other config material never rewrites `enabled`.
- Account Overlay no longer rewrites Provider top-level `enabled`, only `access.entitled`.
- No generic manual enable/disable button on the Provider settings page; once the user completes the access
  material, the same Resolver naturally brings the Provider into Registry.

## 4. Services and Runtime

1. Account Provider Connection Resolver deletes the `mode=api-key` availability, account identity check and dynamic
   key loading branch.
2. Account Request Auth deletes the `planKind=api-key` branch, handling only Start, Individual, Team and Off-Peak
   dynamic material.
3. The over-wide API Key Resolver is narrowed to Coding Plan duty: Individual personal project key; Team the
   selected team project key; ordinary pay-as-you-go API never calls it.
4. Welcome and Provider Settings typed keys go only into the `zai-api` / `bigmodel-api` Personal Overlay.
5. The old helper that restored Account Provider enabled by a typed key, its save branch and contrary tests are
   deleted.
6. Start JWT, Team scope, Off-Peak execution, official release request security validation and server final
   authorization semantics are unchanged. Deleting `zhipu-account/mode=api-key` must keep `zai-api` /
   `bigmodel-api` real-request V4 behavior equivalent: deleting the wrong Provider identity must not silently drop
   existing signing, nor spread V4 to other ordinary `api-key` Providers. Pin this boundary with current Adapter
   behavior and request tests first, then move the static admission to the correct Family pay-as-you-go API
   identity.

## 5. UI

The Provider settings page reads only Effective `access.type`: `api-key` shows the API key input, management entry
and ordinary Provider model configuration; `zhipu-account` shows account connection, plan, quota and product status.

- No `hideApiKeySection`, `readOnlyEndpoints` or other page booleans duplicating Access.
- The Family menu `kind=api-key` copy is "pay-as-you-go API"; choosing it shows the typed-key UI.
- `zai-api` / `bigmodel-api` are not in the "Add Supplier" menu.
- Account Individual/Team pages keep hiding Endpoint, API Schema and account credentials, but model list and model
  config stay editable.
- Welcome's API key entry and the settings page use the same Provider identity and save primitive.

Model Config editing permission is not decided by a Personal Model Config Rule: the Rule is only the sparse
persistence of user changes. Every Built-in/Personal Model the settings page allows editing saves overrides through
the same Personal Rule; whether a model can be renamed or deleted is decided by member source (Builtin Model IDs are
read-only and not deletable).

## 6. Cleanup scope

`account:zai-api-key` / `account:bigmodel-api-key` constants, Fixtures, migration special cases and tests;
`zhipu-account / mode=api-key` Schema, Protocol, Resolver, Runtime and Design text; Account Provider typed key
persistence; `restoreFamilyApiKeyProviderForApiKeyMode` and its callers; UI conditions guessing key display from
Family/Provider ID; class names, comments and logs that call a Coding Plan project key an Account API key; wrong
conclusions in Todo 26, Provider Settings Design, Access Protocol Design and Feature Graph.

## 7. Acceptance

- Config/Provider: Built-in has only the two Family pay-as-you-go Providers `zai-api` / `bigmodel-api`, with the
  Family group, Built-in `enabled=true`, not in `addableProviders`; `ZhipuAccountMode` rejects `api-key`; ordinary
  API Provider Personal key Overlay, JSON round-trip and integrity validation; Account Personal `access` override
  still rejected; no duplicate pay-as-you-go Provider in a Family.
- Services/Runtime: Family `kind=api-key` selects the ordinary API Provider exactly; typed key goes unchanged into the
  Active Model without calling Account Request Auth; Individual Coding Plan fetches the personal project key; Team
  uses the selected team project key; Start uses JWT; Off-Peak uses the current compatible plan material; being
  logged out does not affect a configured typed pay-as-you-go Provider, and a typed key cannot fake Coding Plan
  availability.
- UI/E2E: Welcome Z.ai/BigModel key lands in the matching Built-in API Provider; Family "pay-as-you-go API" shows
  the typed key, saved models are selectable and can send requests; with an empty key the Provider stays visible and
  `enabled`, but is not in Registry, and clearing a key does not auto-disable it; Individual/Team/Start show no typed
  key; Family switching copies no key, creates no duplicate Provider and does not pollute Account Selection;
  Desktop, Web and mobile remote show consistent model candidates and selection identity.
- Mechanical: `rg` / `dep:refs` show deleted Provider IDs, Mode and old helpers at zero; related Provider, Services,
  UI unit tests; affected Desktop E2E; `pnpm typecheck`, `pnpm lint`, format check, `git diff --check`.

Completion: Family pay-as-you-go API and Account plan access no longer share a wrong Access semantics; typed key,
Coding Plan project key, Team project key and Start JWT each have a unique Owner and request chain; no Account API
Provider phantom in Config, Registry, Runtime, UI or docs; `zai-api` / `bigmodel-api` belong to the Family and stay
out of the normal add-Supplier flow; no second Access DTO, page permission matrix or credential center.

## 8. Outcome and Verification

`account:zai-api-key`, `account:bigmodel-api-key` and `zhipu-account / mode=api-key` were deleted from Built-in,
Schema, Protocol, Resolver, UI, Fixtures and model rules. `zai-api` / `bigmodel-api` are the Family's sole
pay-as-you-go API configs, fixed in the Family settings entry, with `access.type=api-key` and a Personal API key, no
longer in the normal "Add Supplier" catalog. Account Start, Individual, Team and Off-Peak use only account access
material; Account pages hide Endpoint, API Schema and typed key by Effective `access.type=zhipu-account` while model
config keeps the unified Personal Model Rule. Welcome API key and the settings page share the real Family API
Provider identity; Coding Plan project key acquisition stays in the Coding Plan request-time credential chain.
Built-in integrity, Access Schema, Account/typed-key Runtime, login and settings page directed tests passed;
mechanical scanning confirms fictional Provider IDs, the old Mode and the restore helper are zero in production code.
