# Coding Plan Connection Status Semantics (Personal Plan "Disconnected" Regression)

> Subsequent ruling: the "fetch failure -> re-login" behavior and the §7.2 candidates are superseded by [Provider Refactor Todo114](../working-memory/provider-refactor/steps/todo-114-account-status-sync-and-key-retry.md) (upstream was Todo105). The current implementation follows that Todo to complete the sync protocol, unify the two families' missing-Key classification and reuse refresh retry.

Status: spec; candidate B implemented on branch `fix/coding-plan-not-purchased-status` (see §8; the original header said "pending decision / pending implementation"). Date: 2026-09-10.
Related: `docs/coding-plan/zai-bigmodel-team-plan-symmetry.md`, `packages/services/src/model-provider/codingPlanProviderAvailability.ts`, `packages/provider/src/account-provider-state.ts`, `packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts`

## 1. Problem

An authenticated account for which the server explicitly responded "this account has no Personal Coding Plan subscription" shows "Disconnected + Connect" on the Settings page Personal Plan card. It should show "Not purchased, activated after purchase" plus a Subscribe button.

Evidence (2026-09-10, production account `63821741092061425`):

- `GET https://bigmodel.cn/api/biz/subscription/list` -> `{"code":200,"success":true,"data":[]}`
- `GET https://bigmodel.cn/api/monitor/usage/quota/limit` -> `{"code":500,"msg":"当前用户不存在coding plan"}` (current user does not have a coding plan)
- `bigmodelUsageQuotaMapper.ts:98` `isNoPlanMessage()` matches `"不存在coding plan"` -> `unavailableReason: "no_plan"`

Team Plan (`org-64faf` quota `code:200`) and Start Plan (active plan) work correctly for the same account, so only the Personal Plan shows disconnected.

## 2. Root cause

The regression appeared with the provider-refactor commits pulled in by `pull origin staging` (`790884b1ce` -> `fa70e89683`; `90b2cf83ceb`, `524f1ba2e5d`).

Old implementation (`790884b1ce`, `resolveCodingPlanEntitlementState`): the query gate checked only whether the local provider exists (`bigmodelCodingPlanQueryEnabled = Boolean(bigmodelProviderFingerprint) || Boolean(bigmodelProvider && bigmodelTeamPlanContext)`), so the personal card received `snapshot.unavailableReason === "no_plan"` and resolved to `notPurchased`.

New implementation loses the reason across layers:

```
packages/services  validateSubscriptionListAvailability()
        -> { kind:"unavailable", reason:"coding_plan_not_entitled" }
        v
  accountProviderConnectionResolver.ts:189  connections.push({ status: availability.kind })   reason lost
        v
  packages/provider  account-provider-resolution.ts:63   states[id] = { availability, entitled }  no reason
        v
  packages/ui  resolveAccountProviderInspectionAccess()  accountProviderAccess.ts:48
        if (provider.accountState?.availability === "unavailable") return null;   no entitlement query any more
        v
    resolveCodingPlanEntitlementState()
        const canInspect = accountEntitled || accountAvailability === "pending";
        if (!canInspect) -> status:"disconnected"     short-circuits, never reaches notPurchased
```

Account switching explains why this card has no entitlements now; the provider-refactor explains why no entitlements renders as disconnected.

## 3. Target semantics

Keep the `accountAvailability === "pending"` and `accountEntitled === true` branches unchanged; add back one tier for "authenticated but server explicitly has no subscription":

| accountEntitled | availability | Reason | Card status | Label | Primary button |
| --- | --- | --- | --- | --- | --- |
| true | available | - | per snapshot | current value | current value |
| false | pending | - | per snapshot (pending, may view) | current value | current value |
| false | unavailable | Explicitly no entitlements | **notPurchased** | Not purchased, activated after purchase | **Subscribe** |
| false | unavailable | Credentials expired | unavailable | Fetch failure | Re-login |
| false | unavailable | Not logged in / Not connected | disconnected | Disconnected | Connect {provider} |
| false | unknown / reason missing | - | disconnected (backward compatible) | Disconnected | Connect {provider} |

Boundaries that stay unchanged:

- Start Plan is excluded: it renders the claim/pay card via `disconnected` (`StatusCards.tsx` `disconnectedStartPlanPricingVisible`), and `notPurchased` in `buildVisibleFamilyConnectionItems` means "explicitly no entitlements -> hide entry" (locked in `packages/ui/test/providerFamilyConnectionVisibility.test.ts`).
- Team Plan is excluded: Team cards are assembled from Team Plan entitlement snapshots by `buildTeamPlanItems`, with their own labels ("Team plan not assigned", ...).

## 4. Chosen approach: pass the availability reason through (candidate B)

1. `packages/provider`: optional `unavailableReason` on `AccountProviderState` / `AccountProviderConnectionResult(unavailable)` (`not-authenticated` / `not-connected` / `credential-failed` / `not-entitled`); `unknown` follows the last State's rule and stays consistent with `availability`; written only to Account State, not Provider Config.
2. `packages/services`: `accountProviderConnectionResolver` maps `CodingPlanUnavailableReason` to this union.
3. `packages/ui`: `useModelProviderNavigation` passes through `accountState.unavailableReason`, routing per §3 for the individual provider only; a missing reason falls through to current behavior.

Rejected candidate A (restore the old `no_plan` snapshot signal by relaxing the `availability === "unavailable"` interception): it re-introduces an entitlement query for an "unavailable" provider and leaves two authorities for one fact (`not_entitled` from availability, `no_plan` from quota), so drift is likely. B has a single authority (the Account Overlay already computes `not_entitled`), no extra requests, and matches the provider-refactor direction, at the cost of a cross-three-package contract change.

## 5. Tests (test-first)

- `packages/ui/test/providerFamilyConnectionVisibility.test.ts`: the four reason branches; fallback to `disconnected` when the reason is missing; Start Plan with "explicitly no entitlements" behaves unchanged (regression guard).
- `packages/services/test/accountProviderConnectionResolver.test.ts`: reason mapping and State passthrough; `unknown` follows the previous reason.
- E2E: see §8.

## 6. Impact and risk

- B is an additive optional field; `available` / `entitled` judgment and model availability are unaffected.
- The personal card moves from `disconnected` to `notPurchased`: entry visibility is unaffected (hide rules apply only to Start Plan) and the "Subscribe" button (`buyAction`) already exists.
- Confirm Host<->Renderer `accountState` has no schema trimming.
- Shared by desktop and mobile remote control; no `continuous` / `replayable` difference.

## 7. Out of scope (adjacent defects)

### 7.1 Team quota swallows business 500 into "not assigned"

`validateTeamPlanQuotaAvailability` on HTTP 200 + envelope `code:500, success:false` takes the `hasQuotaData=false -> coding_plan_not_entitled` definite path and writes a 24h entry cache (`codingPlanProviderAvailability.ts:381-392`). It should be `unknown` (no cache). Observed: 11 `code:500` instances for `org-272fbf` on 2026-09-10.

### 7.2 Z.AI vs BigModel "missing derived key" reason asymmetry (decided not to change this round; pending product confirmation)

Trigger: the logged-in account is in the zai family (`providerFamilyDomain` resolves to zai) and the account-level derived key is empty (no plan means no derived key, or derivation failed).

| Account status | BigModel reason | Z.AI reason | Displayed |
| --- | --- | --- | --- |
| Not logged in | `not_connected` (resolver early-exit, `accountProviderConnectionResolver.ts:111-120`) | same early-exit | "Disconnected" on both, no divergence |
| Logged in + derived key empty | `not_connected` (call-site constant) | `auth_failed` (`resolveMissingZaiApiKeyReason` checks user_info) | Disconnected vs **Fetch failure** (divergence) |
| Logged in + has key + subscription list empty | `not_entitled` | `not_entitled` | "Not purchased" on both (the fix target) |

Root cause: in `codingPlanProviderAvailability.ts:140-154` zai passes dynamic judgment, bigmodel a constant; `resolveMissingZaiApiKeyReason` (same file, :657-662) reports "no derived key" as `auth_failed`, reusing the "credentials rejected by server" semantics.

Candidate fixes (not executed):

- A: `return userInfo ? "coding_plan_not_connected" : "coding_plan_not_authenticated"` aligns it in one line; `auth_failed` stays only for true 401/403 from `classifyAvailabilityError`.
- B: when the key is missing, query `subscription/list` with the OAuth access token and fold that state into "not purchased" (needs backend confirmation that the endpoint accepts OAuth tokens).

"Not visible when not logged in" is not a valid reason to skip: `shouldShowCodingPlanForProviderFamilyDomain` (`useModelProviderNavigation.ts:307-312`) returns `true` for both families when `providerFamilyDomain` is empty (both cards display), filters by family only after the domain resolves, and the domain does not reset on logout. The divergence audience is zai-domain users in "logged in + derived key empty".

Decision this round: no change (zai keeps the new "Fetch failure" label in this state). If product rejects that label, the minimal convergence is to remove the UI-side `credential-failed -> unavailable` branch so it falls back to `disconnected` (pre-change behavior); the net effect of this MR is then only "no subscription -> not purchased".

### 7.3 Other items pending confirmation

- When the personal card becomes `notPurchased`, `canDisconnectProvider` flips from false to true (`StatusCards.tsx:255/392/515`, `Detail.tsx:728`), exposing the disconnect entry in the "Not purchased" state. Product confirmation needed.
- `unavailableReason` enters `states`, and `packages/provider/src/sources.ts:61` computes `revision = hash([..., providers, states])`, so pure display-reason changes advance the Account snapshot revision and trigger registry resync. Confirm acceptability.
- `packages/provider/test/account-provider-resolution.test.ts` does not cover the new State projection logic (reason dispatch, `unknown` preservation, no leak when upstream has no reason).

## 8. Implementation status and E2E gaps (2026-09-10)

Implemented (branch `fix/coding-plan-not-purchased-status`, base `origin/staging`):

- `packages/provider`: `AccountProviderState` / `AccountProviderConnectionResult` gain `unavailableReason`; `unknown` follows the previous round.
- `packages/services`: `CodingPlanUnavailableReason` exported and mapped to the account-domain reason, published with the connection result.
- `packages/shared`: new `isIndividualCodingPlanModelProviderId`.
- `packages/ui`: `resolveCodingPlanEntitlementState` routes `unavailable + not-entitled -> notPurchased`, `credential-failed -> unavailable`, personal plan only.
- Unit tests: 7 new UI groups and 2 services groups; 50 tests pass (including existing Start/Team regression guards).

Verification: `pnpm lint` 0 errors; `pnpm typecheck` shows exactly the same error set as the pre-change baseline (91 pre-existing dist declaration staleness errors in built-in packages).

E2E not completed (must not be reported as verified). The desktop E2E infrastructure cannot express "logged in + no personal plan":

- The upgrade mock can provide the data (`subscription/list` empty + quota "当前用户不存在coding plan"), but in that scenario the Settings page does not render the family connection mode selector (nav has only `preset:account:bigmodel-start-plan` and two custom providers; `model-provider-connection-mode-trigger` count = 0), so the Personal Plan card is unreachable.
- Team mocks have only `personalOnly` / `teamOnly` / `both` scenarios, all with plans.
- Related existing e2e tests are broken by provider-refactor id changes: `coding-plan-upgrade-personal-sold-out` (and tests using `preset:builtin:bigmodel`) fail locally with `model-provider-nav-item-preset:builtin:bigmodel: missing`.

Recommendation: add a `personalNone` scenario to the team mock (or have the upgrade mock render the family root card), then follow the `visible()` pattern from `provider-family-responsive.test.ts` (navigation has hidden copies; operate on visible elements) to add a Settings page test; also separately fix the broken coding-plan e2e test ids.
