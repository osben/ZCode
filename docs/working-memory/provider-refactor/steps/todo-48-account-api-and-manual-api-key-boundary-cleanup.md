# Todo 48: Account API and Manual API Key Boundary Cleanup

> Status: research complete / decision record; not an independent implementation Todo
>
> Date: 2026-08-31
>
> Source: review of the Account Provider settings page and the Welcome API key chain after Todo 26

## 1. Problem

Provider Refactor had defined `account:zai-api-key` and `account:bigmodel-api-key` as `zhipu-account / mode=api-key`
and assumed the logged-in account would automatically supply a pay-as-you-go API key at request time. A vertical
trace of the latest `origin/staging` shows this was never the original product behavior: staging's `API Key`
connection method is a user-typed key; the code that creates/copies a project key from the login state serves only
Coding Plan credential refresh and is not an independent "account pay-as-you-go API Provider". The branch also had
the ordinary-key `zai-api` / `bigmodel-api` Providers, so the same Endpoint, model members and API Schema were
modeled twice.

```text
User-typed API key -> Built-in API Provider + Personal key -> formal Model            (staging API key chain)
Current logged-in account -> Start / Individual / Team / Off-Peak
                          `-> Coding Plan project key create/copy                      (staging account chain)
```

The error is not "the Account API page forgot to hide an input": the Account API Provider with no product basis
itself entered formal Config, Resolver, Runtime and UI.

## 2. Confirmed boundaries

### 2.1 staging's typed key is a Built-in Provider preset

Latest `origin/staging@5ebc182b61`: on Welcome the user picks Z.ai / BigModel and types a key; the pre-existing
`builtin:zai` / `builtin:bigmodel` updates only `apiKey`, `enabled`, `updatedAt`; Endpoint / API Schema / models stay
the Built-in preset; the Family mode is written as apiKey; the default model selection is that Provider's first
model; Registry selects that Built-in Provider exactly in apiKey mode; Runtime uses the Provider's stored key
directly. It does not create a custom Provider dynamically nor copy Endpoint, Schema and model list at submit time;
semantically it is a custom Provider with Endpoint/Schema/models prefilled where the user fills only the key, but
the product identity is the fixed Built-in Provider taking part in Family connection selection.

### 2.2 What the auto create/copy key is really for

staging's `OAuthPresetProviderRepoProviderResolvers.resolveProviderApiKey()` does obtain a real key through the
personal account chain (OAuth / business access token -> `getCustomerInfo` -> personal organization / project ->
find or create `zcode-api-key` -> copy secret). But its caller `loadSinglePresetProvider(...,
shouldResolveApiKey)` creates `builtin:zai-coding-plan` / `builtin:bigmodel-coding-plan` and only an explicit
`refreshCodingPlanApiKey()` turns the branch on; ordinary `builtin:zai` / `builtin:bigmodel` Built-in sync
explicitly writes an empty key and waits for the user to type it. Team Coding Plan does not reuse the "auto-discover
personal organization/project" identity chain: it uses the user-selected and validated `organizationId/projectId` to
get the team project key. Individual and Team may share the underlying project key API but identity source, cache
key and credential Owner stay separate. So "an auto-fetch-key capability exists" and "an account pay-as-you-go API
product entry exists" are different; the former is true, the latter has no staging evidence.

### 2.3 Target access boundary

- `api-key`: user-typed key saved to Personal Provider Config.
- `zhipu-account`: only for Start, Individual, Team, Off-Peak, which genuinely depend on account, plan or
  request-time account material.
- `zhipu-account / mode=api-key` is removed from the formal contract; `account:zai-api-key` /
  `account:bigmodel-api-key` are deleted.
- `zai-api` / `bigmodel-api` are each Family's only manual API Provider; fixed Endpoint, API Schema and Built-in
  model members come from ZCode Built-in; Personal saves only the key and allowed Overlay.
- They use `zai-family` / `bigmodel-family` respectively, permanently occupy the Family's "pay-as-you-go API" slot,
  and no longer appear in the normal "Add Supplier" candidates.
- Their Built-in `enabled=true` means fixed Family membership. A missing key keeps them visible but incomplete and
  non-executable; `enabled=false` is not auto-written to fake completeness.
- Family connection selection `kind=api-key` points to this ordinary API Provider and never enters Account Overlay
  or Account Request Auth.
- Coding Plan's automatic project key resolution stays in the Coding Plan request credential chain and cannot prove
  a non-existent Account API Provider.
- Account Provider plan entitlement projects only to `access.entitled` (not Provider top-level `enabled`, see Todo
  50).

### 2.4 UI branches directly on Effective Access

Provider settings reads the Effective Provider Config `access` discriminated union without
`hideApiKeySection`, `readOnlyEndpoints` or Family-page booleans as a second fact:

```text
access.type = api-key        -> show and save the manual API key
access.type = zhipu-account  -> show account connection, plan, quota and automatic credential status
other access types           -> show per that access's formal contract
```

A real Account Provider neither shows, reads nor saves a manual API key. The Family "pay-as-you-go API" choice sits
beside Account plans, but its detail gets the API key form naturally from `access.type=api-key`; it does not
masquerade as Account Access.

### 2.5 Copy and write boundary

Family connection selection's internal `kind: "api-key"` stays, but the UI always says "pay-as-you-go API" (the
standard pay-as-you-go model API; details have the user type the key). Provider Config Service mechanically rejects
a Personal `access` for fixed `zhipu-account` Built-in Providers before writing the Personal Overlay; invalid config
must not hit disk first and only be rejected by the Personal Source Schema on the next read.

## 3. Implementation scope (done by Todo 49)

[`todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md`](./todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md)
implements this uniformly; this file keeps only research evidence and product decisions, so two Todos do not drift as
rival execution lists: delete the two fictional Account API Providers from Built-in, ID constants, Account Resolver,
Request Auth, Protocol, UI and tests; move `zai-api` / `bigmodel-api` into the Family group with the Family API key
connection referencing them (detail by `access.type=api-key`, not in "Add Supplier"); Welcome typed key updates that
Built-in API Provider's Personal Overlay and never writes Account Access; delete
`restoreFamilyApiKeyProviderForApiKeyMode` and duplicated API key persistence helpers; Account Resolver stops
handling `mode=api-key` and Coding Plan auto project key resolution is kept and renamed for its real duty; Config
Service keeps rejecting Personal `access` on real Account Providers; user copy becomes "pay-as-you-go API"; update
Provider Settings Design, Access Protocol Design, Feature Graph and Todo 26, retracting the wrong Account API
conclusion.

## 4. Acceptance and completion

- The Family "pay-as-you-go API" page shows and saves the manual key; ordinary Built-in API Providers and custom API
  Providers keep the formal `api-key` chain.
- UI branches read only Effective `access.type`; no page boolean controls the same fact.
- Writing Personal `access` for a fixed Account Provider fails.
- Welcome typed key goes to the matching Built-in API Provider, creates no custom Provider and does not enter Account
  Request Auth.
- Registry has no duplicated API Provider with the same Endpoint/models in one Family just from a wrong Access
  assumption.
- `rg` and `dep:refs` show the old Family key restore helper and Account key persistence are zero.
- Unit tests (UI, Provider, Services) and related E2E; typecheck, lint, format check, `git diff --check`.
- Completion: no Account API Provider without staging product basis; typed key belongs only to the unique
  Built-in/Personal `api-key` Provider keeping the Family "pay-as-you-go API" entry; Coding Plan auto project key and
  typed pay-as-you-go key have fully separate credential source, storage location and UI shape; no new Family-only
  display boolean or second Access discriminant fact.
