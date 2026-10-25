# Todo86: Consolidate Provider Refresh Ownership and Waiting Semantics (Draft)

> Status: discussion required; implementation not authorized. Side-session notes from 2026-09-06, archived on 2026-09-09: it adds no new outstanding work. Facts below are an investigation snapshot from 09-06; Todo99/100 have since made partial fixes/investigations and Todo101 records a deferred direction, so compare with current code and deduplicate before resuming discussion.
>
> This draft only records the problem; it does not interrupt Todo85 restoration work. No code, tests or commits were performed for it.

## Problem and verified facts

After a successful claim the active page calls `providerSettingsService.refresh()`. That entry point refreshes not only the Account Source but also forces a remote Built-in refresh and then explicitly asks the Registry to recompute, while the Registry already subscribes to Account Source/Config Source changes. So two paths drive downstream work; whether that duplicates computation depends on scheduling and is not assumed to happen every time. `claimManualPlan()` only requests the claim endpoint and returns the result; it does not notify Account Source, so removing the page-level call without replacing post-claim account refresh would be incomplete.

Production entry points found: successful claim (`ManualClaimPlanBanner.tsx`); account-plan query after login and startup recovery (`oauthProviderFamilySelectionRefresh.ts`); root-wide refresh used for login, startup recovery, logout and some login-onboarding checks (`useRootProviderStateRefresh.ts`); purchase completion (`CodingPlanUpgradeDialog.tsx`); manual refresh in Settings (`useModelProviders.ts`). Service chain: `packages/provider/src/facades.ts`, `packages/services/src/model-provider/providerRuntime.ts`, `packages/provider/src/account-provider-service.ts`, `packages/provider/src/registry-service.ts`. Recheck call sites after parallel changes before implementing.

## Preferred principles (design pending confirmation)

```text
claim / purchase / login account change -> notify Account Source to fetch current facts
config save -> update Config Source
          v
Source publishes a consistent snapshot -> unified subscription drives Provider recomputation
          v
Settings / Selection View updates
```

Business notifications are consolidated at a suitable service orchestration / dependency-injection boundary; UI does not access a concrete Account Source implementation or restore the old Provider Store, and pages need not refresh both Source and Registry. Most call sites only need to trigger a reliable update without awaiting downstream results; the few that genuinely need the latest View are identified separately.

## Topics for the next discussion

1. **Is the Settings manual refresh still needed?** Do not decide in advance to keep or remove the button. Reactive propagation only surfaces changes the client already discovered; first check whether events, polling and reconnect handling cover remote claims/purchases, expiration, recovery from transient failures and remote Built-in publication. If automatic refresh is reliable enough, consider removing it; if retained, state exactly which sources the user refreshes, and it must not become a second downstream-computation path.
2. **Which calls need to wait, and how?** Classify each entry as trigger only, await Source, or await derived View (focus on plan selection after login, claim-result queries and any logic reading a View right after `await refresh()`). "Source update completes", "downstream computation completes" and "latest View readable" are different completion points. If the latest View is needed, wait on the corresponding source state through existing revision/snapshot mechanisms, with no recomputation or sleeping; do not treat an old View as the new result, and do not merely wait for the next event (an unchanged refresh may fire none, so check the existing result first). Check how concurrent updates, failures and disposal end the wait, without a premature complex generic waiting framework.
3. **Does claim-entitlement lookup depend unnecessarily on a full Provider refresh?** In fixed staging entitlement lookup and Provider refresh run in parallel; the current query is serialized after the full refresh. Check what account access actually depends on so an unrelated Built-in refresh failure does not block showing the effective date, without bypassing credentials, account identity or correct boundaries for pending entitlements. A successful claim/purchase is a server fact; a later refresh failure must not turn it into a claim/purchase failure.
4. **Scope of consolidation.** Decide whether `Settings.refresh()` is removed, narrowed or turned into a source-refresh request that can be awaited. Review whether save flows, startup initialization and remote Provisioning recomputation/waiting have the same issue, without expanding into a remote-sync rewrite.

## Boundaries and follow-up verification

- Todo83/85 cover restoration of correct account and claim behavior; this draft discusses refresh responsibilities and does not overturn approved product state or architecture.
- Activity-preview stale-response protection, requery after login changes and polling manage active UI requests and stay; they are not conflated with Account Overlay updates.
- No persistent data change or migration; no duplicate account state.
- After the design is confirmed, add distinguishing tests first: account changes trigger downstream updates; a claim does not force a Built-in refresh; unchanged state does not wait forever; flows needing a new View do not read stale data; a later refresh failure does not rewrite claim success. Interaction work uses the agreed MacBook Air validation; do not multiply tests around call counts or implementation details.
