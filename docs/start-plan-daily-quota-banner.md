# Start Plan Quota Bucket Reminder

## Confirmed Behavior

- Remove the 50% / 20% reminders. Calculate `remaining_units / total_units` independently for each valid quota bucket for the current model; show a reminder when `0 < ratio <= 10%`.
- Do not combine active and daily buckets when calculating percentages. Daily quota copy: “{model} daily quota remaining: {percent} ({remaining} tokens).” One-time promotion copy: “{model} promotional quota remaining: {percent} ({remaining} tokens).” Use neutral “plan quota” for other periods; do not guess the period type.
- Show each `bucket_id + period_start + period_end` only once. The record does not include balance, model, task, or local date. Multiple models served by the same bucket do not trigger duplicates. A new bucket or period may show again; do not require the balance to recover above 10% first.
- The 10% reminder can be dismissed, and the upgrade entry point remains. The visible reminder may update with the balance, but it must not reappear after dismissal, task/model switching, or remount. If the balance rises and then drops below the threshold again in the same period, do not show it again. Show multiple eligible buckets in server order; an already-shown bucket must not block other buckets without a reminder.
- Store reminder records in this client's localStorage (one record per period key; do not store tokens or plaintext account data). Keep them across tasks and client restarts. Each client records independently; cross-device sync is not guaranteed. If storage is unavailable, deduplicate in the current Renderer memory only. Use the same `snapshot.serverTime` (or `generatedAt` when missing) for reading, recording, and expiring display records and for determining bucket validity. Do not use device `Date.now()` or advance a cached snapshot's clock separately. Dismissal ends the display owner's already-recorded reminder; it does not recalculate period expiration.
- Show “{model} has no available quota. Switch to another model or upgrade your plan.” only when every valid bucket for the current model is exhausted. Do not report model exhaustion because a promotional bucket is exhausted while a daily bucket still has quota.
- Show “Your trial plan has no available quota. Upgrade your plan or wait for the quota to reset.” when every valid bucket for every model is exhausted. Overall exhaustion takes precedence over model exhaustion. Server error 1005 continues to directly indicate overall exhaustion; existing concurrency/rate-limit/MCP branches remain unchanged. None of these notices blocks sending.

## Data and Boundaries

`GET /api/v1/zcode-plan/billing/balance` now returns real `bucket_id`, `user_plan_id`, `period_start`, `period_end`, and `expires_at` values in `balances[]`. The Service adds optional fields to the existing `UsageQuotaLimit`; convert all times consistently to milliseconds. Derive period-copy type from `plans[].entitlements[]`, matched by `user_plan_id` (or `plan_id` for legacy data) and `entitlement_id`.

Read model-usage buckets only; exclude non-model quotas from reminder and exhaustion calculations. Exclude model-usage buckets known to be expired or not yet effective. Determine validity using `snapshot.serverTime` (or `generatedAt` when missing) to match the server snapshot; do not guess from the device date. Missing or non-finite values must not be misclassified as 0. If a legacy snapshot lacks `bucket_id` or a valid period, do not trigger a one-time low-quota reminder, but a clear remaining value may still be used to determine exhaustion. Period end and bucket expiration are separate concepts; do not use `expires_at` as a substitute for period identity.

## State Ownership

The old dismissal key included `remainingTokens` / `remainingPercent`, so every balance change could show the reminder again. The old model check also used only the first bucket, causing false model-exhaustion reports.

Pure evaluation remains owned by `sessionQuotaBannerState`; display-once records are owned by a separate Start Plan reminder store. The existing `sessionQuotaBannerDismissalStore` continues to handle only other session-scoped dismissals and does not own period persistence. Mark a reminder as shown only when the Banner is actually visible; hidden pages, overlays from other errors, and state-only evaluation do not consume the display.

```text
balance -> Service maps bucket/period/copy type -> single-bucket 10% candidate
                                                    |
                                           Banner actually visible -> persist period as shown
                                                    | Same display instance: retain and update balance
                                                    | New task / dismissal / restart: do not repeat
                                                    | New bucket/period: reminder may appear
Valid buckets for current model -> all exhausted? -> model/overall exhaustion (independent of reminder records)
```

Shared React UI covers desktop and mobile Web, Chinese and English, and light and dark themes. Only entitlement data and Renderer display state are added; do not change the Agent protocol, queue, owner, snapshot recovery, or host attachment.

```text
desktop continuous -> existing real-time path -> shared reminder UI
mobile replayable -> existing recovery path -> shared reminder UI (client-local record)
```

## Verification

- A single bucket at 50/48/47/20/10.1 does not trigger a reminder; 10/9 does. Compare the calculated percentage before rounding.
- A 300M promotional bucket and 5M daily bucket trigger reminders independently. Exhausting one bucket does not report model exhaustion while another bucket for that model has quota; retain separate model- and overall-exhaustion behavior.
- Period deduplication is unaffected by balance, ordering, task, or model changes. New periods and buckets are independent. Verify actual display, dismissal, remount, restart recovery, and StrictMode.
- Missing/invalid numbers, unknown periods, expired buckets, and not-yet-effective buckets must not produce false low-quota or exhaustion notices.
- Cover Service mapping, pure state, and store with unit tests; use real browser hook/Banner interactions for desktop/mobile, light/dark themes, and Chinese/English. Use a test entitlement service in place of the backend and do not write real account data.

### CR-01 Regression for Period-end Time Baseline

When the device clock is ahead/behind, or the cached snapshot's period end has passed according to local time, if the current snapshot still considers the bucket valid, the reminder must be recordable. Dismissal takes effect immediately, and task switching or Renderer reload must not show it again. A new-period snapshot may show it again. Use a single snapshot time source; do not add a second dismissal state or timeout fallback.
