# Coding Plan Quota Reset review and integration record

> Branch: `codex/feat-quota-reset-ui` (based on `staging`)
> Status: branch review record (updated as integration and fixes progress)

## 1. Architecture snapshot (current implementation)

```text
UI components (packages/ui/components/coding-plan-quota-reset/*)
  └─ useCodingPlanQuotaResetUi (hook, 60s polling + inflight dedupe + 1.5s cache)
       ├─ zustand window-shared (codingPlanQuotaResetUiBySource, not broadcast, not persisted)
       ├─ lib/codingPlanQuotaResetUi (state machine pure functions available/processing/completed)
       └─ IUsageStatsService ── BigModelUsageQuotaProvider
            ├─ Authorization: zcode JWT (credentials["zcodejwttoken"])
            ├─ X-Bigmodel-Authorization: MaaS login JWT (credentials["oauth:bigmodel:access_token"])
            ├─ TEAM scope: Bigmodel-Organization / Bigmodel-Project
            └─ GET /status  POST /opportunity  POST /use  POST /history/read
                   base: /api/v1/coding-plan/reset  (snake_case envelope, Unix milliseconds)
```

## 2. Integration contract changes

| Date  | Change                                                                                                                                                | Commit       | Notes                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 08-12 | `X-Bigmodel-Authorization` changed from the Coding Plan API key to the **MaaS login JWT** (`oauth:bigmodel:access_token`, passed directly, no Bearer) | `6a06e7e8dd` | the backend identifies the user by JWT; the provider now only confirms the Coding Plan is configured and derives the Team scope; Team no longer duplicates the project API key |
| 08-12 | envelope business-error messages append ` (x-request-id:xxx)`                                                                                         | `3cc99c4f69` | RPC FAIL logs and UI warns can be reconciled with the backend by request-id; the prefix contract is unchanged; without the header the message stays as-is                      |

## 3. Open issues

Recommended fixes:

1. ~~Spec/implementation drift~~ — fixed: `docs/coding-plan-quota-reset-ui.md` now
   states the facts: the UI keeps no `nextTryAt` or bare-429 local cooldown; when
   no opportunity exists, the next 60-second visibility poll re-evaluates. The
   service keeps the `nextTryAt` mapping as an interface contract and integration
   observability field.
2. **use accepted but unconfirmed within 2.5s → false "reset failed"** —
   `useCodingPlanQuotaResetUi.ts:653-676`: if the backend already redeemed and
   only the status confirmation times out, the failure branch fires (toast +
   back to available), and 60s later polling flips to completed. The
   `useAccepted` branch should differ in copy/duration from the failure branch.
3. **Optimistic 100% overlay duration depends on `onEntitlementRefresh`** —
   `codingPlanQuotaResetUi.ts:272-284`: `quotaOverridePending` clears only on a
   successful refresh; if a caller omits the callback or the refresh chain fails,
   the quota card keeps overlaying 100% remaining (fake data) while completed.
   Verify the wiring of every mounting entry.
4. **"Late completed" from unread old history** — product semantics to confirm:
   `has_unread_history` does not distinguish "seconds ago" from "overnight"; a
   first mount after a night still enters completed (toast + brief 100% overlay);
   the existing lib bugfix only guards pure old history with
   `has_unread_history=false`.
5. **Bare-429 cooldown fallback removed client-side** (`a80ef94c6d`) — needs
   written backend confirmation that the client retrying `/opportunity` every 60s
   with a fresh idempotency key is accepted (the backend absorbs the risk of
   double-issued quota on timeout).

Optional improvements:

6. `buildTypeController` rebuilds its object every render
   (`useCodingPlanQuotaResetUi.ts:686-705`) — currently harmless since consumers
   only destructure fields; consider useMemo or a documented convention.
7. Confetti `zIndex:"100"` is hardcoded (`codingPlanQuotaResetConfetti.ts:30`) —
   not tokenized per DESIGN.md z-index levels.
8. `formatCountdown` hardcodes `locale === "zh-CN"`
   (`CodingPlanQuotaResetOpportunity.tsx:16`).
9. The hook is 700 lines with `eslint-disable max-lines`; add a regression test
   for "polling continues after 429/3301 and terminal states are correct".
10. Clicking use inside the 60s window between a voucher's expiry moment and the
    next status filter's exclusion gets rejected by MAAS (2007 toast).

## 4. Residual-risk integration cases

The main loop closes once the APIs work; these cases remain to verify, in
priority order:

| Priority | Case                                                      | Expected verification point                                                                               |
| -------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| P0       | click "reset" -> send a message now                       | whether newly redeemed quota is immediately consumable (UI-optimistic 100% vs real rate limiting)         |
| P0       | use succeeds but status confirms slowly                   | whether the contradictory "failure toast then completed" feedback reproduces                              |
| P1       | first mount after overnight unread history                | whether the completed verdict and 100% overlay flash match product expectations                           |
| P1       | two windows clicking "reset" at once (2-voucher scenario) | whether MAAS redeeming the earliest-expiring voucher consumes both vouchers; product semantics to confirm |
| P2       | clicking a near-expiry voucher in status                  | toast experience when use is rejected by MAAS at the expiry moment                                        |

## 5. Backend alignment leftovers

1. manual/auto redemption source: the status API cannot distinguish (the MAAS
   query carries no source; ZCODE status does not read the MySQL flow). If the
   product requires showing the source, the approach is "query the latest use
   flow record by scope + exact `used_at` matching + null fallback"; the backend
   calls it hard to distinguish — keep pushing on the real-vs-fake difficulty
   list or degrade to frontend-local inference.
2. 2007 investigation: waiting on the backend to check gateway logs (16:26:28.680 /
   `GET /status` / personal scope); after commit `3cc99c4f69`, reconcile directly
   by the x-request-id in logs. Observed so far: after the JWT fix, requests do
   carry the MaaS JWT (no `maas_jwt_required` guard hits), so 2007 sits in the
   backend -> MAAS chain.
