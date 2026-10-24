# Usage Remaining Refresh Policy

Date: 2026-06-13 (updated 2026-08-14 to refresh on access)

## Background

The footer plan badge, the Coding Plan remaining quota in the composer context panel, and the Start Plan
balance all come from `useUsageEntitlement`. This data affects whether a user can keep starting tasks, so
a unified refresh policy is needed to keep entry refresh timing consistent and to avoid amplifying quota /
billing requests when several components mount at once.

## Policy

1. Remaining usage is uniformly "cache first + correct on user access": conversation Context triggers on
   hover/open; the model provider plan card and the Usage page Coding Plan tab trigger on open. The
   sidebar footer plan badge is a resident entry and triggers the same access probe on visible/mount,
   without depending on another entry to warm up first.
2. The three entries echo the cache snapshot of the same account/plan scope on the first frame, and
   background correction does not block panel display; loading shows only when there is no cache.
3. Automatic access refresh shares a 1-minute freshness window by `usageStatsService + providerId +
   organizationId + projectId + provider credential fingerprint`. Once any entry has just requested,
   repeated hovers or opening another entry within 1 minute do not request again.
4. Usage refresh must follow the entitlement scheduling state:
   - `unknown` / `active` / `none` / `unavailable` all allow user-access-triggered correction, subject to
     the shared 1-minute freshness window.
   - Manual refresh by the user, login/token/provider fingerprint change and purchase success may force
     bypassing the freshness window to re-probe `none` or `unavailable`.
5. When one brand account has both a Coding Plan and a Start Plan entry, entitlement scheduling must be mutually exclusive:
   - As long as the Coding Plan provider is configured, query Coding Plan first.
   - When the Coding Plan already has quota / subscription / remaining, handle only Coding Plan and no
     longer query or show the same brand's Start Plan balance.
   - Only when the Coding Plan provider is not configured, or the server explicitly returns `no_plan`, may
     the same brand's Start Plan serve as the fallback entry.
   - Coding Plan querying, network errors, token expiry or `unavailable` state cannot degrade to Start
     Plan, so "temporarily cannot query" is not misjudged as "no Coding entitlement".
6. Remaining usage is no longer refreshed on task start, completion, failure or stop, and the 5-minute /
   idle-30-minute polling and the `nextResetTime` timer no longer run.
7. Each time Context goes from closed to open it calls `reason=access`, `silent=true`; repeated hovers
   must not reset or extend panel display, and only the shared freshness window decides whether a request is sent.
8. The model provider plan card, the Usage page Coding Plan tab and the sidebar footer call the same
   `reason=access`, `silent=true` on open/visible; Usage trend data also uses the same 1-minute access
   freshness window by the same scope.
9. Manual refresh by the user, login success, token/provider fingerprint change and purchase success may
   re-probe the `none` state; these explicit actions handle the case of a just-completed purchase or a
   just-restored login.
10. After a request failure, back off 30 s, 60 s, 120 s, 300 s and reset to zero on success.
11. The same service instance, the same provider request parameters and the same provider fingerprint
    share one latest snapshot; after any entry refreshes successfully, the other mounted entries show it in sync.
12. Identical concurrent requests keep reusing the in-flight Promise to avoid duplicate concurrent requests.

## Boundaries

- The quota of the Coding Plan Usage panel is core data: a quota network failure errors the whole panel;
  activity / usage-detail / model-performance-day are optional data surfaces, where a single network/HTTP
  failure only clears the corresponding area and logs a warn at the service layer without dragging down
  the whole panel. An HTTP 200 with a failing business envelope (such as token expired) still throws as a
  whole, so an auth error is not disguised as empty usage.
- `nextResetTime` is the quota reset time, not the data generation time.
- `UsageEntitlementSnapshot.generatedAt` is the time the snapshot was generated locally.
- A cached `no_plan` may be used to stop automatic, polling and task-lifecycle refresh, but must not
  permanently block manual refresh, a login/token/provider fingerprint change or re-probing after a purchase success.
- The open-time automatic refresh of the Usage page Coding charts is bound by the 1-minute access
  freshness window; a user click on refresh still forces a fetch.
- Desktop and Web both trigger service-layer dependency injection through the UI hook and do not access local files or credentials directly.
- Desktop `desktop-continuous` and mobile `web-remote-replayable` are both triggered only by user access
  in their own renderer. Quota state stays in the UI / shared host service, does not sink into the relay
  or desktop main, and does not change either side's stream recovery boundary.
