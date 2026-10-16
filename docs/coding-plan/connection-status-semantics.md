# Coding Plan Connection Status Semantics (Personal Plan "Disconnected" Regression)

> Subsequent ruling: This document preserves the design and review history of the original branch; the "fetch failure → re-login" and §7.2 candidates have been superseded by [Provider Refactor Todo114](../working-memory/provider-refactor/steps/todo-114-account-status-sync-and-key-retry.md) (upstream was Todo105). The current implementation follows that Todo to complete the sync protocol, unify the two families' missing-Key classification, and reuse refresh retry.

> Status: spec (pending decision / pending implementation)
> Date: 2026-09-10
> Related: `docs/coding-plan/zai-bigmodel-team-plan-symmetry.md`, `packages/services/src/model-provider/codingPlanProviderAvailability.ts`, `packages/provider/src/account-provider-state.ts`, `packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts`

## 1. Problem

**An authenticated account for which the server explicitly responded "this account has no Personal Coding Plan subscription" shows "Disconnected + Connect" on the Settings page Personal Plan card; it should show "Not purchased, activated after purchase + Subscribe button".**

Empirical evidence (2026-09-10, production account `63821741092061425`):

- `GET https://bigmodel.cn/api/biz/subscription/list` → `{"code":200,"success":true,"data":[]}`
- `GET https://bigmodel.cn/api/monitor/usage/quota/limit` → `{"code":500,"msg":"当前用户不存在coding plan"}` (current user does not have a coding plan)
- `bigmodelUsageQuotaMapper.ts:98` `isNoPlanMessage()` matches `"不存在coding plan"` → `unavailableReason: "no_plan"`

Team Plan (`org-64faf` quota `code:200`) and Start Plan (billing/balance has active plan) for the same account work correctly, so the phenomenon manifests as "only the Personal Plan shows disconnected."

## 2. Regression Localization: Behavior Before and After Rebase

**Boundary point:** 2026-09-10 16:43 `pull origin staging` (`790884b1ce` → `fa70e89683`), which pulled in `codex/provider-refactor-m2` (`90b2cf83ceb` 2026-08-20, `524f1ba2e5d` 2026-09-07). The pre-rebase base `790884b1ce` does not contain these two commits.

### 2.1 Why the old implementation was correct

`git show 790884b1ce:.../providerFamilyConnectionVisibility.ts` (old `resolveCodingPlanEntitlementState`) evaluation order:

```
if (!hasCodingPlanProvider && loading)      → checking
if (!hasCodingPlanProvider)                 → disconnected      ← criterion = whether local provider is configured
if (zai && !apiKey)                         → disconnected
if (snapshot.unavailableReason === "no_plan") → notPurchased     ★ Key branch
if (snapshot.unavailableReason === "not_configured") → disconnected
if (snapshot.unavailableReason === "unavailable")    → unavailable
if (currentSubscription / snapshot.quota)   → purchased
default                                     → notPurchased
```

The query gate in old `useCodingPlanEntitlements.ts` checks only **whether the local provider exists**:

```ts
bigmodelCodingPlanQueryEnabled =
  Boolean(bigmodelProviderFingerprint) || Boolean(bigmodelProvider && bigmodelTeamPlanContext);
```

i.e. "if the local provider (including derived key) exists, query entitlement snapshot" — unrelated to whether the account actually has entitlements → personal card gets `no_plan` → **`notPurchased` ("Not purchased, activated after purchase" + Subscribe button)**.

**Conclusion: Under the old implementation, this account's personal card would display "Not purchased," confirming the user observation that "before rebase it was fine."**

### 2.2 Why the new implementation became "Disconnected"

```
packages/services  validateSubscriptionListAvailability()
        → { kind:"unavailable", reason:"coding_plan_not_entitled" }   (reason lexicon at this layer)
        ▼
  accountProviderConnectionResolver.ts:189  connections.push({ status: availability.kind })   ✗ reason lost
        ▼
  packages/provider  account-provider-resolution.ts:63   states[id] = { availability, entitled }  ✗ no reason
        ▼
  packages/ui  resolveAccountProviderInspectionAccess()  accountProviderAccess.ts:48
        if (provider.accountState?.availability === "unavailable") return null;   ✗ no longer initiates entitlement query
        ▼
    resolveCodingPlanEntitlementState()
        const canInspect = accountEntitled || accountAvailability === "pending";
        if (!canInspect) → status:"disconnected"     ✗ short-circuits, never reaches notPurchased
```

Runtime reference (same log):

| Timeframe | Instance code                          | Personal range entitlement queries |
| --------- | -------------------------------------- | ---------------------------------- |
| 15:00     | Before rebase                          | 33                                 |
| 16:00     | Before 16:43 = old code                | 17                                 |
| 17:00     | After rebase (17:17 / 17:25 instances) | **0**                              |

The new implementation didn't even re-fetch the fact that "the server says no plan," instead converging directly to "disconnected" from the Account Overlay's `entitled=false`.

### 2.3 Net conclusion

- **Account switching** explains "why this card has no entitlements now" (the personal plan is attached to the test account);
- **The rebase-pulled provider-refactor** explains "why having no entitlements renders as disconnected" — the old `snapshot.no_plan → notPurchased` path was replaced by the new architecture's `canInspect` short-circuit, and `unavailableReason` was lost across layers.

## 3. Target Semantics

Keep existing branches where `accountAvailability === "pending"` and `accountEntitled === true` unchanged; only add back one tier for "authenticated but server explicitly has no subscription":

| accountEntitled | availability             | Reason                        | Card status                                 | Label                                   | Primary button     |
| --------------- | ------------------------ | ----------------------------- | ------------------------------------------- | --------------------------------------- | ------------------ |
| true            | available                | —                             | Per snapshot                                | Current value                           | Current value      |
| false           | pending                  | —                             | Per snapshot (pending, may view)            | Current value                           | Current value      |
| false           | unavailable              | Explicitly no entitlements    | **notPurchased**                            | Not purchased, activated after purchase | **Subscribe**      |
| false           | unavailable              | Credentials expired           | unavailable                                 | Fetch failure                           | Re-login           |
| false           | unavailable              | Not logged in / Not connected | disconnected                                | Disconnected                            | Connect {provider} |
| false           | unknown / reason missing | —                             | disconnected (current, backward compatible) | Disconnected                            | Connect {provider} |

**Boundaries (must remain unchanged)**:

- **Start Plan is excluded**: it renders the claim/pay card via `disconnected` (`StatusCards.tsx` `disconnectedStartPlanPricingVisible`), and `notPurchased` in `buildVisibleFamilyConnectionItems` means "explicitly no entitlements → hide entry" (already locked in `packages/ui/test/providerFamilyConnectionVisibility.test.ts`).
- **Team Plan is excluded**: Team cards are assembled from Team Plan entitlement snapshots by `buildTeamPlanItems`, with their own labels ("Team plan not assigned," etc.), bypassing this routing.

## 4. Candidates (pending decision)

### Candidate A: Restore old signal (snapshot `no_plan`)

Relax the `availability === "unavailable"` interception in `resolveAccountProviderInspectionAccess`, so the personal provider can still fetch the snapshot; `resolveCodingPlanEntitlementState` falls to `notPurchased` when `!canInspect` and `snapshot.unavailableReason === "no_plan"`.

- Pros: Behavior consistent with pre-rebase, changes concentrated in UI layer, no cross-package contract changes.
- Cons: Re-introduces an entitlement query for an "unavailable" provider (as the old implementation did); the same issue has two authorities (`not_entitled` from availability and `no_plan` from quota), making future drift likely.

### Candidate B: Pass through availability reason (recommended)

1. `packages/provider`: Add optional `unavailableReason` to `AccountProviderState` / `AccountProviderConnectionResult(unavailable)` (`not-authenticated` / `not-connected` / `credential-failed` / `not-entitled`); `unknown` follows the last State's rule and stays consistent with `availability`; writes only to Account State, not Provider Config.
2. `packages/services`: `accountProviderConnectionResolver` maps `CodingPlanUnavailableReason` to this union.
3. `packages/ui`: `useModelProviderNavigation` passes through `accountState.unavailableReason`, routing per §3; applies to the **individual** provider only; when reason is missing, falls through to current behavior (backward compatible).

- Pros: Single source of authority (Account Overlay already computed `not_entitled`), no extra requests, consistent with the direction of provider-refactor.
- Cons: Cross-three-package contract change, requires adding unit / e2e tests.

## 5. Testing Requirements (implement test-first)

- Unit test `packages/ui/test/providerFamilyConnectionVisibility.test.ts`: four reason branches; fallback to `disconnected` when reason is missing; Start Plan passing "explicitly no entitlements" must behave unchanged (regression guard).
- Unit test `packages/services/test/accountProviderConnectionResolver.test.ts`: reason mapping and State passthrough; `unknown` follows the previous reason.
- E2E: see §8 gap analysis.

## 6. Impact and Risk

- Candidate B is an additive optional field; `available` / `entitled` judgment and model availability are unaffected;
- Personal card transitions from `disconnected` to `notPurchased`: entry visibility unaffected (hide rules only apply to Start Plan), "Subscribe" button (`buyAction`) already exists;
- Need to confirm Host↔Renderer `accountState` has no schema trimming;
- This semantic layer is shared between desktop and mobile remote control, with no `continuous` / `replayable` difference.

## 7. Out-of-Scope (adjacent defects, handled separately)

### 7.1 Team quota swallows business 500 into "not assigned"

`validateTeamPlanQuotaAvailability` when HTTP 200 + envelope `code:500, success:false` takes the `hasQuotaData=false → coding_plan_not_entitled` definite path and writes 24h entry cache (`codingPlanProviderAvailability.ts:381-392`). Should be `unknown` (no cache). Same account `org-272fbf` projects: 11 instances of `code:500` observed 2026-09-10.

### 7.2 Z.AI vs BigModel "missing derived key" reason asymmetry (decided not to change this round, pending product confirmation)

**Trigger condition:** The logged-in account is the zai family (`providerFamilyDomain` resolves to zai) **and** the account-level derived key is empty (no plan means no derived key, or derivation failed).

| Account status                                | BigModel reason                                                                       | Z.AI reason                                                               | Displayed after fix                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Not logged in                                 | `not_connected` (resolver early-exit, `accountProviderConnectionResolver.ts:111-120`) | Same (same early-exit branch)                                             | "Disconnected" on both sides, no divergence           |
| Logged in + derived key empty                 | `not_connected` (call-site constant)                                                  | `auth_failed` (`resolveMissingZaiApiKeyReason` checks user_info → judges) | Disconnected vs **Fetch failure**, divergence         |
| Logged in + has key + subscription list empty | `not_entitled`                                                                        | `not_entitled`                                                            | "Not purchased" on both sides, this is the fix target |

**Root cause:** In `codingPlanProviderAvailability.ts:140-154`, zai passes dynamic judgment, bigmodel passes a constant; `resolveMissingZaiApiKeyReason` (same file :657-662) reports "no derived key" as `auth_failed`, reusing the "credentials rejected by server" semantics.

**Fix (not executed):**

- A: `return userInfo ? "coding_plan_not_connected" : "coding_plan_not_authenticated"` — one line to align, `auth_failed` reserved only for true 401/403 from `classifyAvailabilityError`;
- B: When key is missing, query `subscription/list` using the OAuth access token, folding that state into "not purchased" (requires backend confirmation that the endpoint accepts OAuth tokens).

**Why "not visible when not logged in" is not a valid reason for not fixing:** `shouldShowCodingPlanForProviderFamilyDomain` (`useModelProviderNavigation.ts:307-312`) returns `true` for both families when `providerFamilyDomain` is empty (i.e., both cards display), only filtering by family after the domain is resolved; and the domain does not reset on logout when resolved. Therefore the divergence audience = zai-domain users in the "logged in + derived key empty" state.

**Decision this round:** No change (keep zai's new label "Fetch failure" in this state); if product later deems this label change undesirable, the minimal convergence is to remove the `credential-failed → unavailable` branch on the UI side, causing it to fall back to `disconnected` (equivalent to pre-change behavior), in which case the net effect of this MR is only "no subscription → not purchased."

### 7.3 Other items pending confirmation (from 2026-09-10 review)

- When the personal card becomes `notPurchased`, `canDisconnectProvider` flips from false to true (`StatusCards.tsx:255/392/515`, `Detail.tsx:728`), exposing the disconnect entry in the "Not purchased" state — product confirmation needed.
- `unavailableReason` enters `states`, and `packages/provider/src/sources.ts:61`'s `revision = hash([..., providers, states])`, so pure display reason changes advance the Account snapshot revision and trigger registry resync — confirm acceptability.
- `packages/provider/test/account-provider-resolution.test.ts` does not cover the new State projection logic (reason dispatch / `unknown` preservation / upstream absence of reason does not leak).

## 8. Implementation Status and E2E Gaps (2026-09-10)

**Implemented** (branch `fix/coding-plan-not-purchased-status`, base `origin/staging`):

- `packages/provider`: `AccountProviderState` / `AccountProviderConnectionResult` gains `unavailableReason`, `unknown` follows the previous round;
- `packages/services`: `CodingPlanUnavailableReason` exported and mapped to account-domain reason, published with connection result;
- `packages/shared`: new `isIndividualCodingPlanModelProviderId`;
- `packages/ui`: `resolveCodingPlanEntitlementState` routes by `unavailable + not-entitled → notPurchased`, `credential-failed → unavailable`, applies to personal plan only;
- Unit tests: UI gained 7 test groups, services gained 2 groups, 50 tests total pass (including existing Start/Team semantic regression guards).

**Verification results:** `pnpm lint` 0 errors; `pnpm typecheck` is **exactly the same set of errors as the pre-change baseline** (91 items are all pre-existing dist declaration staleness issues in built-in packages on the branch, unrelated to these changes).

**E2E not completed (must not report as verified):** The current desktop E2E infrastructure cannot express the "logged in + no personal plan" state:

- The upgrade mock can provide this data (`subscription/list` empty + quota returns "当前用户不存在coding plan"), but in that mock scenario the Settings page **does not render the family connection mode selector** (actual nav only `preset:account:bigmodel-start-plan` and two custom providers, `model-provider-connection-mode-trigger` count = 0), so navigation to the Personal Plan card is impossible;
- Team mocks only have `personalOnly` / `teamOnly` / `both` scenarios, all with plans, so "no plan" cannot be expressed;
- Related existing e2e tests are broken due to provider-refactor id changes: `coding-plan-upgrade-personal-sold-out` (and tests using the same `preset:builtin:bigmodel`) fail locally with `model-provider-nav-item-preset:builtin:bigmodel: missing`.

**Recommendation:** Add a `personalNone` scenario to the team mock (or have the upgrade mock render the family root card), then follow the `visible()` pattern from `provider-family-responsive.test.ts` (navigation has hidden copies, must operate on visible elements) to add a Settings page test case; also separately fix the broken coding-plan e2e test id.
