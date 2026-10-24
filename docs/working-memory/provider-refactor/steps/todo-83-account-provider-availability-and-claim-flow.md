# Todo 83: Account Provider Entitlement State and Claim-Flow Closeout

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implemented (first-round closeout)
>
> Date: 2026-09-04
>
> Source: review of Start Plan "claimed but not yet effective", abnormal model-settings states and claim-page navigation.

## 1. Goal

Fix how Account Providers are represented and navigated in "claimed but not yet effective", "effective but temporarily no usable model" and "not currently selected" states, so account entitlement, settings display, current connection and model selectability are not collapsed into one boolean. This Todo covers Account Provider state resolution, post-claim UI flow and runtime projection only; ordinary Built-in Provider, Personal Provider and Off-Peak config semantics are unchanged.

## 2. Fixed data layers

```text
ProviderFamilyConnectionSelectionSettings (persisted)
  └─ the connection the user selected per Family
Account Provider State (runtime)
  └─ recomputed on each refresh from account credentials, entitlement API, model/quota results
Account Provider Config Overlay (runtime config projection)
  └─ only the account config facts the Provider Runtime needs
```

- `ProviderFamilyConnectionSelectionSettings` keeps the existing fields; no per-Provider `current`, `visible` or `entitled` persisted fields.
- `current` is derived at runtime from the Family's connection selection and applies only to switchable Account Providers (Start, personal Coding Plan, Team Coding Plan); ordinary Built-in, Personal Provider and Off-Peak do not use it.
- The Account Overlay carries only running account config and dynamic model members, not settings display state.
- No persistence migration; existing selection data keeps the current Family-selection semantics.

## 3. Unified Account Provider state

The Account Provider Resolver generates the state in one place; UI, Registry and Model Selection must not each re-judge:

```ts
{
  availability, // available | pending | unavailable | unknown
  entitled,     // whether the account entitlement can be used now
  effectiveAt,  // pending effective time (empty if none)
  current,      // whether the Family selected this connection
  models,       // model members returned by the account
  executable,   // whether an executable model exists
  selectable    // whether it can enter the current model picker
}
```

### 3.1 Upstream state mapping

Reuse the entitlement service's existing `available`, `unavailable`, `unknown`; add only an explicit `pending` for a future effective time, never re-guessing per page.

```text
available -> entitled = true
pending (claimed, effectiveAt in the future) -> shown in settings; entitled = false (not usable yet); keep effectiveAt
unavailable (server says no entitlement/account unusable) -> entitled = false
unknown (network/server cannot confirm) -> keep the last displayable state; do not hide on one failure
```

If upstream returns both "plan claimed" and a future `effective_at`, the upstream field is not silently rewritten to another meaning: keep the raw time and source state and let the central mapping express "claimed but not currently effective", with a test explaining the mapping.

### 3.2 Display, execution and selection boundaries

- Whether an Account Provider appears in settings is decided by the Account connection display result in the unified state, not mixed with Built-in Provider Config's static `visibility`.
- `entitled` only says whether the account entitlement is usable now; `executable` depends on an executable model existing (`entitled=true` with no model still cannot execute); `selectable` holds only for the current connection with an executable model. Pending, unselected, model-less or unavailable Providers never enter Model Selection.
- No models only means no valid Model Selection can form; it must not flip the Provider to "unauthorized" nor drop its state/config snapshot. Whether the Provider shell stays in the Registry follows the existing Runtime projection rule, but no executable model request may result.
- A Family can query Start, personal Coding Plan and Team Coding Plan at once; selecting one connection must not mark the others unauthorized.
- Only the currently selected Account Provider is projected into the runtime Registry; "owned" is not "in use".

## 4. Start Plan claim and navigation

### 4.1 After a successful claim

- The success card keeps the result state and shows `effectiveAt` (for example "effective tomorrow 09:00"), not only success.
- While pending, keep "Got it" and "Model settings"; no "Start now" path that switches to Start Plan immediately.
- When effective with an executable model, the user's explicit "Start now" click switches the connection, re-reading the latest state first (not the claim-time snapshot).
- A successful claim never changes the current connection by itself.
- "Start now" appears or takes effect only when the latest state has both entitlement usable now and an executable model; pending, unknown, clearly unavailable or model-less states offer no switching action.

### 4.2 Manual entry from settings

Users can still manually view a pending Start Plan state and effective time in model settings, but it must not appear in the current model picker nor produce an invalid Model Selection.

### 4.3 Illegal navigation guard

Every Provider navigation from the claim page or other entries validates the target (does not exist; not displayable; entitlement not obtained; no executable model). An illegal target shows a clear error and returns to a stable page, never leaving settings loading forever or blank. The guard sits at the navigation entry, not duplicated per page.

## 5. Activity card refresh

Restore the staging activity-preview refresh: refresh on regaining visibility, after login and after claim completion; keep the last valid result on a transient network failure. The removed polling/refresh logic must not be dropped as unrelated cleanup; the polling interval is not part of the Provider abstraction and the existing one may stay.

## 6. Acceptance

- Five states display and recover correctly: unclaimed, claimed-pending, effective-without-model, effective-with-model, query unknown.
- With personal Coding Plan in use, Team and Start entitlements are still queried independently; an owned but unselected connection does not enter the current Model Selection.
- After claiming Start Plan the effective time is visible; pending never auto-switches; effective and executable switches only on an explicit "Start now".
- With no usable model no valid model selection results; Provider page, Registry and Model Selection agree.
- An illegal Provider navigation does not hang or break the current page.
- The claim card keeps correct refresh after login, re-show, claim completion and short network failures.
- Cover state display and entry behavior on desktop and Web/remote; desktop graphical E2E reruns on the MacBook Pro; the Desktop continuous and Web replayable message-chain boundary is unchanged.

## 7. Relation to other Todos

Todo 50/51 fixed the Provider config enablement, account entitlement and Off-Peak boundaries (no Provider top-level `enabled`, no change to Off-Peak static hidden config). Todo 69/70/71/72 own rollback compatibility, old-data migration and Model Selection restore (no new selection migration; Account state does not overwrite a restored user selection). Todo 76 owns Built-in Config layering (dynamic entitlement is not written into Built-in Templates). Todo 78's Desktop Provider E2E debt should absorb this Todo's state matrix and claim flow. Todo 81 owns scenario-scoped selection-invalidation notices (a pending entitlement is not misreported as a Composer migration error).

## 8. Non-goals

Do not flatten Account Providers into ordinary Personal Providers; do not delete Family connection-selection persistence or add per-Provider persisted `current`; do not rewrite ordinary Provider Config `visibility` from Account dynamic state; do not force-switch the user to Start Plan because of "claimed"; do not substitute a default model or the first Provider-list item for an Account Provider with no usable model; no automatic overwrite repair for historical configs already wrongly migrated to disk (handled manually).

## 9. First-round outcome (2026-09-04)

Only behavior with clear risk was changed, namely the claim-navigation gate. Existing behavior already covers: `CodingPlanAvailabilityResult` `available / unavailable / unknown` produced uniformly by the service layer; Start Plan's future effective time parsed from the entitlement snapshot's `effectiveTime` and shown in the claim result dialog with early use disabled; after a successful claim activity preview, entitlement snapshot and Provider Settings refresh in parallel, and a network failure keeps the claim success result instead of degrading to "unclaimed"; the Family selection stays the only persisted connection selection with no per-Provider `current`, `visible` or `entitled`.

New deterministic fix: after the user clicks "Start now", `ManualClaimPlanBanner` applies one central gate on the post-claim latest `ProviderSettingsView`. If the Provider refresh fails, the target Provider is missing/not executable, or there is no model that is both `executable` and `selectable`, `providerFamilyConnectionSelections` is not written and the prompt "Start Plan is not available yet" shows. A claim success with a failed entitlement query keeps the success dialog; switching is allowed only when the latest Provider View passes the gate.

Verification: 7 affected files, 94 tests pass; `pnpm typecheck` passes; `pnpm lint` passes (40 existing warnings, 0 error).

The entitlement snapshot, Provider Runtime and Settings display were not forced into one duplicate DTO (they separately consume the service-layer account availability, the Provider Settings View and the entitlement display snapshot). Merging the three data contracts needs runtime evidence of repeated cross-page state first and its own Todo, to avoid a second cache or more complex async sync.
