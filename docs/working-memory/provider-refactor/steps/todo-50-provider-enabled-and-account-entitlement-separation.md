# Todo 50: Provider Enabled and Account Access Entitlement Separation

> Status: Completed
>
> Date: 2026-08-31
>
> Prerequisite: Todo 49 first deleted the fictional Account API Provider and restored the real identity of the Family
> pay-as-you-go API.

## 1. Problem

Provider top-level `enabled` expressed two different things: for normal Built-in, a Personal `enabled=true` means
the user added the Provider to the current config; for Account Providers, the Account `enabled=true/false` meant
whether the current account has plan eligibility. The Resolver interpreted both as the execution gate, so "user
enabled the config" and "account entitled to this Access" could not be expressed independently.

## 2. Final contract

Provider top-level `enabled` stays and means only "this Provider config is enabled and joined to the user's current
config". Account eligibility moves into the Access:

```ts
type ZhipuAccountAccessConfig = {
  type: "zhipu-account";
  family: "zai" | "bigmodel";
  mode: "start-plan" | "individual-coding-plan" | "team-coding-plan" | "off-peak";
  entitled: boolean;
};
```

- `entitled` exists only on `zhipu-account`.
- Built-in owns `type/family/mode` exclusively; the Account Overlay may only override `access.entitled`; the
  Personal Overlay may not modify any Access field of a fixed Account Provider.
- Rich entitlement evidence from the Account Service projects into the Effective Provider Config as `entitled` only;
  unknown follows the existing LKG/fail-closed handling.
- No Provider top-level `available`, `configured`, `activated` or second state DTO.

## 3. Settings and Registry

```text
Built-in + Account + Personal Provider Config -> Effective Provider Config: enabled, visibility, access (entitled for zhipu-account), models
  -> Settings View: visibility; enabled (true: main list, false: add menu); configuration issues
  -> Provider Registry: enabled, access entitled (Account), Provider complete, Model enabled, Model complete
```

```ts
const accessEntitled = provider.access.type === "zhipu-account" ? provider.access.entitled : true;
const providerExecutable = provider.enabled && accessEntitled && providerComplete;
const modelExecutable = providerExecutable && model.enabled && modelComplete;
```

- Normal Built-in: Built-in `enabled=false`; "Add Supplier" writes Personal `enabled=true`; deleting the Overlay
  falls back to false.
- Personal-only: `enabled=true` on creation; deletion removes the whole definition.
- Family pay-as-you-go API: Built-in `enabled=true`, fixed display, no enable/disable button; a missing key only
  makes it incomplete.
- Account Provider: Built-in `enabled=true`, fixed display; the Account Overlay updates only `access.entitled` and
  account model facts.
- Off-Peak: Built-in `enabled=true`, `visibility=hidden`; the Account Overlay updates `access.entitled`.

## 4. Scope

1. Provider Access Config, JSON Schema, Overlay and serialization add `zhipu-account.entitled`.
2. Account Source Schema lets account Providers write only `access.entitled` and rejects `type/family/mode`.
3. Account Resolver writes `access.entitled` instead of the Provider top-level `enabled`.
4. Account Built-in/Off-Peak Providers have top-level `enabled=true` fixed; normal Built-in false/Personal true
   behavior is unchanged.
5. Registry Resolver checks Provider `enabled` and Account `access.entitled` separately.
6. Settings View places normal Built-in by `enabled` in the main list or add menu; entitlement does not change
   Settings placement.
7. Delete judgments, names and comments that treat Provider `enabled` as plan entitlement.
8. Model Config `enabled` is unchanged.

## 5. Acceptance

- Normal Built-in add/delete only changes Personal `enabled`.
- Account Provider `enabled=true, entitled=false`: fixed visible but not in Registry; `enabled=true, entitled=true`
  and complete: enters Registry.
- API key Provider Schema neither accepts nor needs `entitled`.
- Account Overlay cannot rewrite Access identity (only `entitled`); Personal cannot write Account Access.
- Entitlement unknown keeps the LKG/fail-closed behavior.
- Settings, Registry, ModelFactory, Off-Peak, Start, Individual, Team directed tests; `rg` shows Account Resolver no
  longer writes Provider top-level `enabled`; `pnpm typecheck`, `pnpm lint`, related E2E and `git diff --check`.

## 6. Outcome and Verification

`zhipu-account.access.entitled` is in Config, strict Schema, Protocol and Effective Provider; the Account Overlay can
write only `builtinModelIds` and `access.entitled`, no longer Provider top-level `enabled` or Access identity.
Account/Off-Peak Built-in Providers fix `enabled=true`; the Resolver checks config participation, account
entitlement, Provider completeness and Model completeness separately. Settings placement reads only Provider
`enabled`; entitlement affects only Registry executability; the settings page has no generic Provider enable/disable
button, only a read-only status (adding/removing a normal Built-in stays in the formal Personal Overlay flow).

Verification: Account Resolver, Source fail-close, Registry, Settings View, Off-Peak and Start/Individual/Team
directed tests passed; `pnpm typecheck` passed; `pnpm lint` 0 errors; changed files passed targeted format check and
`git diff --check` (repo-wide `fmt:check` still blocked by pre-existing invalid HTML in Electron docs and binary
`gb2312.js`). Full `pnpm test:unit`: 12,749 passed, 25 skipped, 2 failed — the pre-existing CUA non-macOS stable
identity expectation drift and the V4 model trigger Provider name display expectation drift, both independently
reproducible and outside this change; the 410 Provider directed tests and 60 CLI directed tests passed.
