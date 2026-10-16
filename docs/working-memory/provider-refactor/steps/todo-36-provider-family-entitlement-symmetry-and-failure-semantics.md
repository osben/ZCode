# Todo 36: Provider Family Entitlement Symmetry and Failure Semantics Consolidation

> Status: Completed (subsequent Todo 57 completed workspace-wide regression and macOS Provider E2E real-run)
>
> Date: 2026-08-28
>
> Source: Post-Provider Refactor merge code review, Start Plan/Team Plan real-device issue review
>
> Related documents: [`Z.AI / BigModel Start Plan Provider`](../../../zai-start-plan-provider.md),
> [`Todo 32`](./todo-32-team-plan-settings-effective-provider-boundary.md),
> [`Provider Family Merge`](../../../model-provider-family-merge.md)

## 1. Background and Conclusions

Current implementation has established correct product semantics: Z.AI and BigModel are structurally symmetric Provider Families; each Family includes API
Key, Start Plan, Individual Coding Plan, and Team Coding Plan Providers. Start Plan is an independent connection parallel to and explicitly selectable by user from paid Coding Plan, not a fallback after Coding Plan query failure.

But implementation still carries multi-round historical fix shape: same group of Family Provider IDs repeatedly mapped through
`family === "zai" ? ... : ...` in UI, OAuth recovery, and entitlement queries; Z.AI/BigModel queries duplicated into four Hook chains; old comments still claim Coding Plan
disables Start fallback; some pages even reverse-deduce Family from display name. Failure state explanation also inconsistent between settings page and startup recovery chain.

This Todo does not change existing plan product design, but completes the following consolidation:

1. Z.AI and BigModel orchestration entirely driven by `ModelProviderFamilySpec`;
2. Start, Individual, Team use same certain/unknown/invalid state semantics;
3. Real API, auth materials, and Team scope differences continue at Service/Adapter boundary;
4. Only authoritative results explicitly proving no entitlement can break existing selections;
5. UI no longer reverse-deduces Provider Family from names, text, or BigModel constants.

## 2. Decided Domain Model

### 2.1 Family is Static Topology

`MODEL_PROVIDER_FAMILY_SPECS` in `packages/shared/src/model-provider-family.ts` is the unique mapping of Family to each Provider identity:

```text
ModelProviderFamilySpec
├─ id
├─ label
├─ oauthProviderId
├─ apiKeyProviderId
├─ startPlanProviderId
├─ individualCodingPlanProviderId
└─ teamCodingPlanProviderId
```

UI, OAuth recovery, plan navigation, entitlement queries, and Team item construction must not build separate Z.AI/BigModel Provider ID cross-reference tables, nor use
one-of-three ternary expressions to duplicate this mapping.

Family-specific purchase, manage, registration, and other page URLs also belong to Family display/product metadata. They should enter single Family metadata source,
not hidden in general Team item constructor.

### 2.2 Plans are Independent Connections, Not Fallback Chains

```text
One Provider Family
├─ Start Plan
├─ Individual Coding Plan
└─ Team Coding Plan
```

- Start entitlement queried independently when corresponding Account Access exists;
- Individual and current selected Team use their own stable Provider IDs;
- Team queries additionally carry `productId / organizationId / projectId`;
- Coding Plan valid cannot hide Start, prohibit Start query, or override user-selected Start;
- Start valid also cannot override user explicitly selected Individual/Team;
- Automatic selection only used when no selectable retained or current selection explicitly invalidated by authoritative results.

### 2.3 State Semantics Must Be Symmetric

All plan connections uniformly distinguish three facts:

```textCertain available
└─ Has valid subscription/quota/remaining and other authoritative entitlement facts

Definitely no entitlement
└─ Server explicitly returns no_plan under current protocol

Temporarily unknown
├─ loading
├─ Request throws
├─ unavailable
└─ Incomplete or unclassifiable snapshot
```

Temporarily unknown cannot project as "unpurchased," nor break current saved connection selection. Only "definitely no entitlement" can remove Start entry or trigger automatic
fallback.

`not_authenticated/not_configured` do not independently decide connection selection in this plan evidence state machine: when Account Source confirms not connected,
outer `accountConnected` directly projects to `disconnected`; active logout handled by OAuth, Account Source, and Provider Family cleanup chain.
Entitlement cannot reverse-deduce whether user has logged out from these two errors, nor falsely report them as "unpurchased."

### 2.4 Symmetric Does Not Mean Erase Protocol Differences

The following differences are normal facts, must retain:

- Start Plan uses balance/entitlement interface, and may return current account-specific model members;
- Individual uses personal account access context;
- Team requires complete product, organization, and project context;
- Z.AI and BigModel may have different Endpoints, OAuth, registration, purchase, and management pages;
- Specific request Header, credential acquisition, and server error protocol handled by Service/Adapter.

Correct boundary is "upper-layer orchestration and state machine symmetric, differences through Spec/Access Context input, lower-level protocol each handles," not letting UI judge
Family or Plan Kind everywhere.

## 3. Problems Found

### 3.1 Start Temporary Unavailable Treated as Invalid in Recovery Chain

Settings page navigation correctly retains selected Start `checking/unavailable`, but
`resolvePreservedStartPlanSelection()` uniformly returns "not retained" for all non-empty, non-active snapshots. Service returns on network failure:

```ts
{
  unavailableReason: "unavailable",
  subscription: null,
  quota: null,
  remaining: null,
}
```

This snapshot is not `null`, therefore login or startup recovery may rewrite selected Start to Individual/Team. This conflicts with "only explicit `no_plan` allows
switching away."

Target fix: build minimal pure function judging entitlement evidence, returning inactive only when explicit `no_plan`; returning
active when existing authoritative entitlement facts present; returning unknown for `null`, exceptions, `unavailable`, and incomplete snapshots, retaining existing selection. This function does not handle logout, nor owns
Account connection state.

### 3.2 `notPurchased` Fallback Violates Comments and Protocol

`resolveCodingPlanEntitlementState()` comments claim "only server explicitly returns `no_plan` displays unpurchased," but when not matching known branches
still unconditionally returns `notPurchased`. This falsely reports `not_authenticated` or future added/incomplete states as unpurchased.

Target fix: exhaustive, type-safe projection of `UsageEntitlementSnapshot.unavailableReason`; default unknown state only enters
`unavailable/checking/disconnected` matching context, cannot enter `notPurchased`.

Among these, `disconnected` must be decided by `accountConnected` or other authoritative Account state, cannot clean up connection solely by entitlement snapshot.

### 3.3 Family Provider ID Mapping Repeatedly Hardcoded

Current modules repeatedly following pattern:

```ts
family === "zai"
  ? BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  : BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
```

Confirmed distributed in at least:

- `modelProviderFamilyConnectionSelection.ts`;
- `providerFamilyConnectionVisibility.ts` Individual/Team lookup, construction, and quota judgment;
- `useEnterpriseCodingPlanProducts.ts`;
- `oauthProviderFamilySelectionRefresh.ts` OAuth to Provider ID array conversion.

Target fix: uniformly use `getModelProviderFamilySpec(family)` or
`resolveModelProviderFamilySpecByProviderId(providerId)`; delete duplicate mappings and array-position-based `[0]/[1]` reads.

### 3.4 Entitlement Hooks Duplicated into Four Chains

`useCodingPlanEntitlements()` manually maintains Z.AI Coding, Z.AI Start, BigModel Coding, BigModel Start four Access,
Fingerprint, Query, Refresh, Result, and dependency arrays. Code currently basically symmetric, but any subsequent fix likely only landing on one side.

Target structure:

```text
useProviderFamilyEntitlements(familySpec, selection, settingsView)
├─ resolve Coding target (Individual or current Team)
├─ resolve Start target
├─ generate respective Account Access / cache identity
├─ independently call entitlement hook
└─ return isomorphic family result

useCodingPlanEntitlements
├─ Explicitly call Z.AI family hook
├─ Explicitly call BigModel family hook
└─ Merge results and refresh
```

Outer layer must explicitly call two custom Hooks, cannot call React Hooks in dynamic loops. Extraction only eliminates Family duplication, does not create second entitlement cache,
Provider DTO, or state authority.

### 3.5 OAuth Recovery Uses Positionless Arrays and Redundant Gates

`resolveCodingPlanProviderIdsFromOAuth()` returns `[individual, start, team]`, callers read by index. This makes third Team ID
easily overlooked, also conceals existing Family Spec.

`ProviderFamilyDomain` already limited to `zai | bigmodel`, startup recovery again writing
`if (domain === "bigmodel" || domain === "zai")` has no new protective meaning.

Target fix: OAuth Provider first normalized to Family, then read named Family Spec; delete positional arrays and redundant Family whitelist.

### 3.6 Team Manage URL Wrongly Depends on BigModel Constants

General Team item construction currently writes `BIGMODEL_CODING_PLAN_TEAM_MANAGE_URL` for both Z.AI and BigModel. This means Z.AI Team
"manage/upgrade" operations may also open BigModel pages.

Target fix:

- BigModel Team uses BigModel Team manage URL;
- Z.AI Team uses Z.AI corresponding manage URL;
- URLs obtained from Family product metadata;
- If current only Z.AI general subscription manage URL, explicitly configure that URL, no longer using BigModel constants as fallback;
- Add click-target tests for both Families.

### 3.7 UI Reverse-Deduces Family from `providerName`

`StatusCards.tsx` currently uses:

```ts
providerName.toLowerCase() === "bigmodel" ? "bigmodel" : "zai";
```

This interprets any display name not exactly `BigModel` as Z.AI, and lets localization or text changes change business behavior. Icons,
account hints, and registration hints controlled by this result may all be wrong.

Target fix: status cards receive explicit `providerId` or `family`, resolve identity through Family Spec; `providerName` only for display, not participating in any
status, routing, or interaction judgment.

### 3.8 Old Comments and Deleted Fallback Semantics Conflict

`useCodingPlanEntitlements.ts`, `V4ComposerToolbar.tsx`, and related tests still have "Coding Plan activation disables Start Plan fallback
query" comments. Implementation changed to Start independent query; these comments mislead subsequent maintainers re-introducing mutual exclusion logic.

Target fix: delete or rewrite all old fallback comments, test names, and variable descriptions. `enabledStartPlanProviderIds` if still having real call value, should only
express "Start Providers with current query identity," no longer explained by fallback.

### 3.9 Unused Selection Resolver

`resolveMissingModelProviderFamilyConnectionSelection()` currently only test-referenced, no production calls, and has different priority from actual used
`resolveLatestModelProviderFamilySelection()`. Two similar algorithms make design appear to have two default selection rules.

Target fix: after confirming with static reference checks, delete unused Resolver and its isolated tests; retained Resolver renamed by real usage context,
explicitly only for "automatic selection after no current selection retained," not using ambiguous `Latest/Missing`.

### 3.10 Team Family List and Legacy Defaults Scattered in Business Flows

`providerFamilyConnectionVisibility.ts` builds `TEAM_PLAN_DOMAINS = ["bigmodel", "zai"]`, some product data deep uses `product.family ?? "bigmodel"`. All potential extension break points.

Target fix:

- Team Family iteration directly from `MODEL_PROVIDER_FAMILY_SPECS`;
- Legacy product missing `family` BigModel compatibility only allowed at importer/normalizer boundary;
- Products must have explicit Family before entering navigation and state construction;
- Do not change existing historical data compatibility results.

## 4. Target Implementation Structure

```text
MODEL_PROVIDER_FAMILY_SPECS
          |
          +-------------------------------+
          |                               |
          v                               v
Z.AI Family Context               BigModel Family Context
├─ static provider ids            ├─ static provider ids
├─ product/manage URLs            ├─ product/manage URLs
└─ selected connection            └─ selected connection
          |                               |
          +---------------+---------------+
                          |
                          v
              Unified Family Entitlement Orchestration
              ├─ Coding target
              │  ├─ Individual
              │  `─ Team + product/org/project
              ├─ Start target
              ├─ cache / refresh
              `─ entitlement outcome
                          |
          +---------------+----------------+
          |                                |
          v                                v
Connection Selection Recovery and Auto Selection                 Settings / Composer Projection
├─ active -> retained/selectable                  ├─ checking
├─ inactive -> fallback allowed                   ├─ purchased
`─ unknown -> retain current selection              ├─ notPurchased (only definite no-entitlement)
                                       `─ unavailable/disconnected
```

Account connection and active logout outside diagram: Account Source decides whether Provider connected, enabled, and executable; logout chain responsible for cleaning up account,
credentials, and current Family. Entitlement outcome does not participate in these two ownership decisions.

Must not add:

- Second Provider Family registry;
- Renderer-maintained Account Overlay;
- Plan capability DTO;
- Helpers deducing identity from display text, URLs, or Provider names;
- Runtime business hardcoding of specific model IDs or Provider IDs.

## 5. Implementation Order

### 5.1 Write Failing Tests First

1. Selected Start receiving `unavailable` snapshot: login and startup recovery both retain selection and do not write Settings;
2. Selected Start query throws or returns `null`: continues retaining;
3. Selected Start explicitly returns `no_plan`: allows automatic selection of other connections;
4. `not_authenticated/not_configured/unavailable` all do not project as `notPurchased`; first two connection semantics determined by
   `accountConnected`/Account Source;
5. Z.AI and BigModel share same state matrix using parameterized tests;
6. Z.AI/BigModel Start, Individual, Team all obtain Provider IDs from Family Spec;
7. Z.AI Team manage button opens Z.AI URL, BigModel Team opens BigModel URL;
8. Modifying Provider display names or localization text does not change Family, icons, and interactions;
9. Current user selection prioritized over automatic selection; automatic selection only when explicitly invalid;
10. entitlement refresh continues using independent cache keys by Provider/Team scope, maintaining in-flight merge.

### 5.2 Fix Failure Semantics

- Build minimal pure function normalizing plan evidence to `active | inactive | unknown`: only explicit `no_plan` is inactive, existing authoritative entitlement facts
  is active, rest unknown;
- Settings page state and selection recovery uniformly reuse that judgment, must not each explain once;
- Fix Start preservation and `notPurchased` fallback;
- Exhaustive checks on union types, making future added states exposed at compile or test time.
- Do not merge logout, Account connection, or credential cleanup into that function.

### 5.3 Consolidate Family Orchestration

- Use existing `ModelProviderFamilySpec` replacing all duplicate Provider ID ternary mappings;
- Extract symmetric Family Entitlement Hook;
- OAuth/startup recovery reads named Spec fields;
- Team navigation and quota judgment uniformly works by Spec;
- Legacy Family defaults moved to single normalization boundary.

### 5.4 Fix UI Identity and Management Links

- Status cards changed to receive explicit Provider/Family identity;
- Delete `providerName` identity inference;
- Family metadata completes respective Team manage URLs;
- Delete general Team item hardcoding of BigModel URL;
- Keep multilingual display names only承担text responsibilities.

### 5.5 Delete Residue

- Delete Resolvers without production calls;
- Delete distorting fallback comments and test descriptions;
- Delete mapping helpers, constant lists, and branches superseded by Family Spec;
- Use `rg`, `pnpm dep:refs`, and `pnpm knip` to check orphan exports and old semantics residue.

## 6. Verification Matrix

### 6.1 Family Symmetry

Following matrix uses same parameterized assertions for Z.AI and BigModel:

| Connection | Access Condition               | Query Target                     | Additional Context  |
| ---------- | ------------------------------ | -------------------------------- | ------------------- |
| Start      | Start Account Access exists    | `startPlanProviderId`            | No Team scope       |
| Individual | Individual Access exists       | `individualCodingPlanProviderId` | Personal            |
| Team       | Selected valid Team connection | `teamCodingPlanProviderId`       | product/org/project |

### 6.2 Failure State

| Entitlement Result          | Existing Selection        | Retain?                                | UI Status                |
| --------------------------- | ------------------------- | -------------------------------------- | ------------------------ |
| active                      | Any matching connection   | Yes                                    | purchased                |
| no_plan                     | Corresponding connection  | No, can auto-fallback                  | notPurchased             |
| unavailable                 | Corresponding connection  | Yes                                    | unavailable              |
| not_authenticated           | Decided by Account Source | Entitlement does not decide separately | disconnected/unavailable |
| not_configured              | Decided by Account Source | Entitlement does not decide separately | disconnected/unavailable |
| Request throws / null       | Corresponding connection  | Yes                                    | unavailable/checking     |
| Incomplete unknown snapshot | Corresponding connection  | Yes                                    | unavailable              |

### 6.3 Regression

- Start and Coding both valid: both visible, user selection not overwritten by refresh;
- Team and Individual both valid: selected Team not overwritten by startup recovery with personal plan;
- Team pricing temporarily failed: still retains selected Team;
- Account Provider Settings continues reading `ProviderSettingsView`, does not re-apply Overlay;
- Start account model member coverage, Team scope, and Request Auth behavior unchanged;
- Settings, Composer, Sidebar use same entitlement cache identity;
- Active logout continues thoroughly exited by existing OAuth/Account/Family cleanup chain, not fallback by entitlement state machine;
- Desktop, Web, phone remote control do not add new state Owner, not changing continuous/replayable semantics.

## 7. Automation Requirements

Execute and pass:

1. UI entitlement, Provider Family navigation, OAuth callback/startup restore directed unit tests;
2. Services usage entitlement and Team scope directed unit tests;
3. Account Provider Settings related interaction E2E;
4. `pnpm typecheck`;
5. `pnpm lint`;
6. `pnpm test:unit`;
7. `pnpm fmt:check` and `git diff --check`.

Current Review baseline four related test files 49 tests all passed, but lacks Start selection
preservation under `unavailable` non-empty snapshots, and `not_authenticated` must not project as `notPurchased` proofs. This Todo must first supplement these two failing tests, cannot use
existing green lights to replace boundary verification.

## 8. Completion Criteria

- Z.AI/BigModel Provider IDs, Team manage URLs, and OAuth identities all from single Family Spec/metadata;
- UI business code no longer infers Family from display names;
- Family orchestration no duplicate Z.AI/BigModel query implementations;
- Start/Individual/Team consistent handling of active, inactive, unknown;
- `notPurchased` only produced by definite no-entitlement;
- Temporary request failures do not break saved connections;
- Old fallback comments, positional arrays, redundant Family gates, and unused Resolvers cleaned up;
- Related unit tests, interaction verification, workspace-wide typecheck/lint/unit all pass;
- Final commits follow Conventional Commit, listing actual deleted old branches and verification evidence in implementation records.

## 9. Implementation Records (2026-08-28)

- Added `active | inactive | unknown` plan evidence normalization: only `no_plan` is inactive; unknown snapshots no longer falsely report unpurchased,
  no longer over-explaining Account disconnection status.
- Login and startup recovery only break existing selections when Start explicitly inactive; `unavailable`, request exceptions, and incomplete snapshots all retained.
- OAuth, Team navigation, Sidebar, Composer, and enterprise plan queries changed to reading named `ModelProviderFamilySpec`, deleting positional arrays,
  Family Provider ID ternary mappings, and unused second selection Resolver.
- Z.AI/BigModel Team manage URLs entered Family Spec; status cards resolve Family by `providerId`, no longer reading display names.
- Four hand-written entitlement Hook chains consolidated to one Family Hook, explicitly calling Z.AI, BigModel twice; Start and Coding
  continue using independent Provider IDs, Account Access, and cache keys.
- Legacy product missing Family BigModel interpretation centralized to single normalization function, navigation and usage projection no longer writing fallback.
- Deleted distorting "Start fallback disabled after Coding activated" comments; Start now explicitly independent query target.

Phase Review evidence: related 6 UI test files 278 tests passed; `pnpm typecheck` passed; `pnpm lint` 0 error
(33 all pre-existing warnings outside this phase); `git diff --check` passed. Final `test:unit/fmt:check` executed uniformly across all phases.

Subsequent regression evidence: Todo 57 completed root `typecheck`, `lint`, full unit
(12,797 passed), and macOS Provider/Account/Selection WDIO real-run on same Provider Refactor final baseline. Todo 36 no longer retains independent "waiting final regression" status.
