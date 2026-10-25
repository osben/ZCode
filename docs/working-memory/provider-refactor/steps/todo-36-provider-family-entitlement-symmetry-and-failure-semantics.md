# Todo 36: Provider Family Entitlement Symmetry and Failure Semantics Consolidation

> Status: Completed (Todo 57 later completed workspace-wide regression and macOS Provider E2E real run)
>
> Date: 2026-08-28
>
> Source: post-Provider Refactor merge code review, Start Plan/Team Plan real-device issue review
>
> Related documents: [`Z.AI / BigModel Start Plan Provider`](../../../zai-start-plan-provider.md),
> [`Todo 32`](./todo-32-team-plan-settings-effective-provider-boundary.md),
> [`Provider Family Merge`](../../../model-provider-family-merge.md)

## 1. Background and Conclusions

The product semantics were already right: Z.AI and BigModel are structurally symmetric Provider Families, each with
API key, Start Plan, Individual Coding Plan and Team Coding Plan Providers. Start Plan is an independent connection
parallel to paid Coding Plan, explicitly selectable by the user, not a fallback after Coding Plan query failure. The
implementation still carried multi-round fix shapes: `family === "zai" ? ... : ...` repeated in UI, OAuth recovery
and entitlement queries; Z.AI/BigModel queries duplicated into four Hook chains; old comments claiming Coding Plan
disables Start fallback; Family reverse-deduced from display name; inconsistent failure explanation between the
settings page and the startup recovery chain.

This Todo does not change plan product design; it consolidates so that: Z.AI and BigModel orchestration is driven
entirely by `ModelProviderFamilySpec`; Start, Individual and Team use the same certain/unknown/invalid state
semantics; real API, auth materials and Team scope differences stay at the Service/Adapter boundary; only
authoritative results explicitly proving no entitlement can break existing selections; UI no longer reverse-deduces
Provider Family from names, text or BigModel constants.

## 2. Domain Model

### 2.1 Family is static topology

`MODEL_PROVIDER_FAMILY_SPECS` in `packages/shared/src/model-provider-family.ts` is the unique mapping from Family to
Provider identities:

```text
ModelProviderFamilySpec
├─ id, label, oauthProviderId, apiKeyProviderId
├─ startPlanProviderId
├─ individualCodingPlanProviderId
└─ teamCodingPlanProviderId
```

UI, OAuth recovery, plan navigation, entitlement queries and Team item construction must not build separate
Z.AI/BigModel Provider ID tables or ternaries. Family-specific purchase, manage and registration URLs also belong to
the single Family display/product metadata source, not a general Team item constructor.

### 2.2 Plans are independent connections, not fallback chains

One Provider Family has Start Plan, Individual Coding Plan and Team Coding Plan.

- Start entitlement is queried independently when the corresponding Account Access exists.
- Individual and the current selected Team use their own stable Provider IDs; Team queries additionally carry
  `productId / organizationId / projectId`.
- A valid Coding Plan cannot hide Start, prohibit a Start query or override a user-selected Start; a valid Start also
  cannot override a user-selected Individual/Team.
- Automatic selection is used only when no selectable is retained or the current selection is explicitly invalidated
  by authoritative results.

### 2.3 Symmetric state semantics

All plan connections distinguish three facts: certain available (valid subscription/quota/remaining or other
authoritative entitlement facts); definitely no entitlement (the server explicitly returns `no_plan` under the
current protocol); temporarily unknown (loading, request throws, unavailable, incomplete or unclassifiable snapshot).
Temporarily unknown never projects as "unpurchased" and never breaks the saved connection selection; only "definitely
no entitlement" can remove the Start entry or trigger automatic fallback.

`not_authenticated/not_configured` do not independently decide connection selection in this plan evidence state
machine: when Account Source confirms not connected, outer `accountConnected` projects directly to `disconnected`;
active logout is handled by the OAuth, Account Source and Provider Family cleanup chain. Entitlement cannot
reverse-deduce logout from these errors nor report them as "unpurchased".

### 2.4 Symmetric does not erase protocol differences

Retained normal differences: Start Plan uses a balance/entitlement interface and may return account-specific model
members; Individual uses the personal account access context; Team requires complete product, organization and
project context; Z.AI and BigModel may have different Endpoints, OAuth, registration, purchase and management pages;
request Header, credential acquisition and server error protocol are handled by Service/Adapter. The boundary:
upper-layer orchestration and state machine are symmetric, differences enter via Spec/Access Context input, and
lower levels each handle their protocol; UI does not judge Family or Plan Kind everywhere.

## 3. Problems and Target Fixes

1. **Start temporary unavailable treated as invalid in recovery.** `resolvePreservedStartPlanSelection()` returned
   "not retained" for every non-empty non-active snapshot, while the Service returns on network failure
   `{ unavailableReason: "unavailable", subscription: null, quota: null, remaining: null }`; login/startup recovery
   could rewrite selected Start to Individual/Team. Fix: a minimal pure function normalizing plan evidence to
   `active | inactive | unknown` — inactive only for explicit `no_plan`, active when existing authoritative
   entitlement facts are present, unknown for `null`, exceptions, `unavailable` and incomplete snapshots (retain the
   existing selection). It does not handle logout nor own Account connection state.
2. **`notPurchased` fallback violates comments and protocol.** `resolveCodingPlanEntitlementState()` was documented as
   "only explicit `no_plan` displays unpurchased" but returned `notPurchased` for unmatched branches (falsely
   reporting `not_authenticated` or future/incomplete states). Fix: exhaustive, type-safe projection of
   `UsageEntitlementSnapshot.unavailableReason`; unknown only enters `unavailable/checking/disconnected`, never
   `notPurchased`; `disconnected` is decided by `accountConnected` or other authoritative Account state, never by the
   entitlement snapshot alone.
3. **Family Provider ID mapping hardcoded repeatedly** (`modelProviderFamilyConnectionSelection.ts`,
   `providerFamilyConnectionVisibility.ts`, `useEnterpriseCodingPlanProducts.ts`,
   `oauthProviderFamilySelectionRefresh.ts`). Fix: use `getModelProviderFamilySpec(family)` or
   `resolveModelProviderFamilySpecByProviderId(providerId)`; delete duplicate mappings and positional `[0]/[1]` reads.
4. **Entitlement Hooks duplicated into four chains** (`useCodingPlanEntitlements()` maintained Z.AI Coding, Z.AI
   Start, BigModel Coding, BigModel Start Access, Fingerprint, Query, Refresh, Result and dependency arrays). Target:
   `useProviderFamilyEntitlements(familySpec, selection, settingsView)` resolves the Coding target (Individual or
   current Team) and Start target, generates their Account Access / cache identities, calls the entitlement hook
   independently and returns an isomorphic family result; `useCodingPlanEntitlements` calls the Z.AI and BigModel
   family hooks explicitly (no dynamic-loop Hook calls) and merges results and refresh. No second entitlement cache,
   Provider DTO or state authority.
5. **OAuth recovery used positional arrays and redundant gates.** `resolveCodingPlanProviderIdsFromOAuth()` returned
   `[individual, start, team]` read by index; `ProviderFamilyDomain` is already `zai | bigmodel` so
   `if (domain === "bigmodel" || domain === "zai")` was redundant. Fix: normalize the OAuth Provider to Family first,
   read named Spec fields, delete positional arrays and the redundant whitelist.
6. **Team manage URL wrongly used BigModel constants.** General Team item construction wrote
   `BIGMODEL_CODING_PLAN_TEAM_MANAGE_URL` for both Families, so Z.AI Team manage/upgrade could open BigModel pages.
   Fix: URLs come from Family product metadata (BigModel Team -> BigModel URL; Z.AI Team -> the Z.AI URL; if only a
   general Z.AI subscription manage URL exists, configure it explicitly, never fall back to BigModel constants); add
   click-target tests for both Families.
7. **UI reverse-deduced Family from `providerName`** (`StatusCards.tsx`:
   `providerName.toLowerCase() === "bigmodel" ? "bigmodel" : "zai"`), so localization or text changes changed
   business behavior and icons/account hints/registration hints could be wrong. Fix: status cards receive explicit
   `providerId` or `family` and resolve identity through Family Spec; `providerName` is display-only.
8. **Old comments conflict with deleted fallback semantics** ("Coding Plan activation disables Start Plan fallback
   query" in `useCodingPlanEntitlements.ts`, `V4ComposerToolbar.tsx` and tests). Fix: delete or rewrite old fallback
   comments, test names and variable descriptions; `enabledStartPlanProviderIds`, if still useful, only expresses
   "Start Providers with a current query identity".
9. **Unused selection Resolver.** `resolveMissingModelProviderFamilyConnectionSelection()` was test-referenced only
   and had a different priority from the actually used `resolveLatestModelProviderFamilySelection()`. Fix: delete
   the unused Resolver and its isolated tests (after static reference checks); rename the retained one by its real
   use ("automatic selection after no current selection retained"), not `Latest/Missing`.
10. **Team Family list and Legacy defaults scattered** (`TEAM_PLAN_DOMAINS = ["bigmodel", "zai"]`,
    `product.family ?? "bigmodel"`). Fix: iterate Team Families from `MODEL_PROVIDER_FAMILY_SPECS`; the BigModel
    compat for legacy products missing `family` is allowed only at the importer/normalizer boundary; products have an
    explicit Family before entering navigation and state construction; historical data compat results unchanged.

## 4. Target Structure

```text
MODEL_PROVIDER_FAMILY_SPECS
  -> Z.AI Family Context / BigModel Family Context (static provider ids, product/manage URLs, selected connection)
  -> Unified Family Entitlement Orchestration
       Coding target: Individual | Team + product/org/project; Start target; cache / refresh; entitlement outcome
  -> Connection Selection Recovery and Auto Selection:
       active -> retained/selectable; inactive -> fallback allowed; unknown -> retain current selection
  -> Settings / Composer Projection:
       checking; purchased; notPurchased (only definite no-entitlement); unavailable/disconnected
```

Account connection and active logout sit outside this: Account Source decides whether a Provider is connected,
enabled and executable; the logout chain cleans up account, credentials and the current Family. Entitlement outcome
takes part in neither ownership decision. Must not add: a second Provider Family registry; Renderer-maintained
Account Overlay; a Plan capability DTO; helpers deducing identity from display text, URLs or Provider names; Runtime
business hardcoding of model IDs or Provider IDs.

## 5. Acceptance Scenarios

Failing tests first:

1. Selected Start receiving an `unavailable` snapshot: login and startup recovery both retain the selection and do
   not write Settings.
2. Selected Start query throws or returns `null`: retained.
3. Selected Start explicitly returns `no_plan`: automatic selection of other connections allowed.
4. `not_authenticated/not_configured/unavailable` never project as `notPurchased`; the first two connection
   semantics are decided by `accountConnected`/Account Source.
5. Z.AI and BigModel share the same state matrix via parameterized tests.
6. Z.AI/BigModel Start, Individual and Team all take Provider IDs from Family Spec.
7. Z.AI Team manage button opens the Z.AI URL, BigModel Team opens the BigModel URL.
8. Changing Provider display names or localization text does not change Family, icons or interactions.
9. Current user selection beats automatic selection; automatic selection only when explicitly invalid.
10. Entitlement refresh keeps independent cache keys by Provider/Team scope and in-flight merge.

Family symmetry matrix (same parameterized assertions for Z.AI and BigModel):

| Connection | Access condition               | Query target                     | Additional context  |
| ---------- | ------------------------------ | -------------------------------- | ------------------- |
| Start      | Start Account Access exists    | `startPlanProviderId`            | No Team scope       |
| Individual | Individual Access exists       | `individualCodingPlanProviderId` | Personal            |
| Team       | Selected valid Team connection | `teamCodingPlanProviderId`       | product/org/project |

Failure state matrix:

| Entitlement result          | Existing selection        | Retain?                                | UI status                |
| --------------------------- | ------------------------- | -------------------------------------- | ------------------------ |
| active                      | Any matching connection   | Yes                                    | purchased                |
| no_plan                     | Corresponding connection  | No, can auto-fallback                  | notPurchased             |
| unavailable                 | Corresponding connection  | Yes                                    | unavailable              |
| not_authenticated           | Decided by Account Source | Entitlement does not decide separately | disconnected/unavailable |
| not_configured              | Decided by Account Source | Entitlement does not decide separately | disconnected/unavailable |
| Request throws / null       | Corresponding connection  | Yes                                    | unavailable/checking     |
| Incomplete unknown snapshot | Corresponding connection  | Yes                                    | unavailable              |

Regression: Start and Coding both valid -> both visible, user selection not overwritten by refresh; Team and
Individual both valid -> selected Team not overwritten by startup recovery with a personal plan; Team pricing
temporarily failed -> selected Team retained; Account Provider Settings keeps reading `ProviderSettingsView` without
re-applying Overlay; Start account model member coverage, Team scope and Request Auth behavior unchanged; Settings,
Composer and Sidebar use the same entitlement cache identity; active logout still exits through the existing
OAuth/Account/Family cleanup chain, not an entitlement-state-machine fallback; Desktop, Web and phone remote control
add no new state Owner and keep continuous/replayable semantics.

The review baseline of four related test files (49 tests) was green but lacked proofs of Start selection
preservation under `unavailable` non-empty snapshots and of `not_authenticated` not projecting as `notPurchased`;
those failing tests are supplemented first. Required checks: UI entitlement / Provider Family navigation / OAuth
callback/startup restore directed unit tests; Services usage entitlement and Team scope; Account Provider Settings
interaction E2E; `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm fmt:check`, `git diff --check`.

## 6. Completion and Outcome

- Z.AI/BigModel Provider IDs, Team manage URLs and OAuth identities come from one Family Spec/metadata; UI business
  code no longer infers Family from display names; no duplicate Z.AI/BigModel query implementations; Start/Individual/
  Team consistently handle active, inactive, unknown; `notPurchased` only from definite no-entitlement; temporary
  request failures do not break saved connections.
- Plan evidence normalization (`active | inactive | unknown`) is shared by settings state and selection recovery;
  login and startup recovery only break existing selections when Start is explicitly inactive; `unavailable`,
  request exceptions and incomplete snapshots are retained.
- OAuth, Team navigation, Sidebar, Composer and enterprise plan queries read named `ModelProviderFamilySpec` fields;
  positional arrays, Family Provider ID ternaries and the unused second selection Resolver are deleted. Z.AI/BigModel
  Team manage URLs live in Family Spec; status cards resolve Family by `providerId`.
- Four hand-written entitlement Hook chains became one Family Hook called explicitly for Z.AI and BigModel; Start and
  Coding keep independent Provider IDs, Account Access and cache keys.
- Legacy product missing Family BigModel interpretation is centralized in one normalization function; the "Start
  fallback disabled after Coding activated" comments are deleted.
- Phase review: 6 UI test files / 278 tests passed; `pnpm typecheck` passed; `pnpm lint` 0 errors (33 pre-existing
  warnings); `git diff --check` passed. Todo 57 later completed root `typecheck`, `lint`, full unit (12,797 passed)
  and macOS Provider/Account/Selection WDIO real run on the same final baseline.
