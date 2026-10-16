# Todo86: Consolidate Provider Refresh Ownership and Waiting Semantics (Draft)

> Status: Discussion required; implementation not authorized. Side-session notes from 2026-09-06.
> Archived on 2026-09-09: this adds a previously untracked historical draft; it does not authorize implementation or create new outstanding work. Facts below are an investigation snapshot from 09-06. Todo99/100 have since made partial fixes/investigations, and Todo101 records a deferred direction; compare with current code and deduplicate before resuming discussion.
> This change only records the draft. Confirm the approach in a later discussion; do not interrupt Todo85 restoration work or modify its execution record.

## Problem and Verified Facts

Successful claims are currently followed by `providerSettingsService.refresh()` from the active page. That entry point refreshes not only the Account Source but also forces a remote Built-in refresh, then explicitly asks the Registry to recalculate. Meanwhile, the Registry already subscribes to Account Source/Config Source changes. Thus there are two ways to drive downstream work; whether they cause duplicate computation depends on scheduling and cannot be assumed to happen twice every time.

`claimManualPlan()` itself only requests the claim endpoint and returns the result; it does not notify Account Source. Removing the page-level call without replacing post-claim account refresh would therefore be incomplete.

Currently identified production entry points:

- Successful claim: `ManualClaimPlanBanner.tsx`.
- Account-plan query after login and startup recovery: `oauthProviderFamilySelectionRefresh.ts`.
- Root-wide refresh: `useRootProviderStateRefresh.ts`, used for login, startup recovery, logout, and some login-onboarding checks.
- Purchase completion: `CodingPlanUpgradeDialog.tsx`.
- Manual refresh in Settings: `useModelProviders.ts`.

Service-chain locations: `packages/provider/src/facades.ts`, `packages/services/src/model-provider/providerRuntime.ts`, `packages/provider/src/account-provider-service.ts`, and `packages/provider/src/registry-service.ts`. Before implementation, recheck call sites and code after parallel changes; this list is not a substitute for a current search.

## Preferred Principles; Specific Design Pending Confirmation

```text
Claim / purchase / login account change -> notify Account Source to fetch current facts
Config save                            -> update Config Source
                                                |
                                                v
                                    Source publishes consistent snapshot
                                                |
                                                v
                                    Unified subscription drives Provider recomputation
                                                |
                                                v
                                    Settings / Selection View updates
```

Business notifications should be consolidated at an appropriate service orchestration/dependency-injection boundary. UI should not access a concrete Account Source implementation or restore the old Provider Store; pages should not need to refresh both Source and Registry.

Most call sites only need to trigger a reliable update and need not await downstream results. Identify separately the few that genuinely need the latest View.

## Topics for the Next Discussion

### 1. Is Manual Refresh in Settings Still Needed?

Do not decide in advance to keep or remove the button. Reactive propagation can only surface changes already discovered by the client; it does not automatically discover server-side changes. First check whether existing events, polling, and reconnect handling cover remote claims/purchases, expiration, recovery from transient failures, and remote Built-in publication.

If automatic refresh is reliable enough, consider removing manual refresh. If there are still clear cases, state exactly which sources the user refreshes. Even if retained, it must not become a second downstream-computation path.

### 2. Which Calls Need to Wait, and How?

Classify every entry point as: trigger only, await Source, or await derived View. Focus on plan selection after login, claim-result queries, and any logic that immediately reads a View after `await refresh()`.

```text
Source update completes -> publishes change -> downstream computation completes -> latest View is readable
          ^                                      ^
These are different completion points.
```

If the latest View is required, investigate waiting for the corresponding source state using existing revision/snapshot mechanisms, rather than recalculating again or sleeping. Do not treat an old View as the new result, and do not merely wait for “the next event”: no event may fire if the refresh result is unchanged, so immediately verify that the existing result meets the requirement. Also check how concurrent updates, failures, and disposal end the wait, but do not introduce a complex generic waiting framework prematurely.

### 3. Does Claim-entitlement Lookup Depend Unnecessarily on a Full Provider Refresh?

In fixed staging, entitlement lookup and Provider refresh run in parallel; the current query is serialized after full Provider refresh. Check what account access actually depends on so an unrelated Built-in refresh failure does not block display of the effective date. Do not bypass credentials, account identity, or correct boundaries for pending entitlements just to run in parallel.

A successful claim/purchase is a server fact; a later refresh failure must not change it into a claim/purchase failure.

### 4. Scope for Consolidating Interfaces and Existing Responsibilities

Decide whether `Settings.refresh()` should be removed, narrowed, or changed into a source-refresh request that can await results. Review whether existing save flows, startup initialization, and remote Provisioning recomputation/waiting have the same issue, but do not expand this draft into a remote-sync rewrite.

## Boundaries with Existing Work and Follow-up Verification

- Todo83/85 cover restoration of correct account and claim behavior; this draft discusses refresh responsibilities and does not overturn approved product state or architecture.
- Activity-preview stale-response protection, requery after login changes, and polling manage active UI requests and should remain; do not conflate them with Account Overlay updates.
- No persistent data change or migration is currently needed; do not add duplicate account state.
- After confirming the design, add distinguishing tests first: account changes trigger downstream updates; a claim does not force a Built-in refresh; unchanged state does not wait forever; flows needing a new View do not read stale data; a later refresh failure does not rewrite claim success. For interaction work, use the agreed MacBook Air validation; do not multiply tests around call counts or implementation details.
- No code, tests, or commits were performed for this draft. These are investigation facts and directions requiring a decision, not a completion claim.
