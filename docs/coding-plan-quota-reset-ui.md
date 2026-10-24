# Coding Plan five-hour/week quota reset — client integration spec

## Summary

The client ships UI for reset opportunities, manual reset, and auto/ops reset-completed notices, backed by the ZCode Server reset API. Server state is authoritative for both Personal Coding Plan and Team Plan.

Backend doc: `coding_plan_reset_mechanism_design.md` (2026-08-11 version).

Product semantics: **the server judges and grants reset opportunities; the client never judges local eligibility.** `POST /opportunity` triggers one server-side eligibility check; it is not a user "request an opportunity" interaction. Client calls:

- `GET /api/v1/coding-plan/reset/status`
- `POST /api/v1/coding-plan/reset/opportunity`
- `POST /api/v1/coding-plan/reset/use`
- `POST /api/v1/coding-plan/reset/history/read`

`GET /status` only reads already-granted opportunities; it creates none. The client calls `POST /opportunity` when status has no valid opportunity (FIVE_HOUR or WEEK) and no newly discovered completed history. `/opportunity` is scope-level: one call covers both five-hour and week opportunities. The server decides by usage, time window, and daily count. The client shows no "request opportunity" button and never judges or grants from local quota thresholds.

## Scope

- Only Personal Coding Plan or Team Plan scopes enter eligibility; the reset entry is shown only when server `status` returns a valid opportunity.
- Five-hour and week quotas each carry their own manual reset and auto/ops completed notice; the opportunity badge is merged into one, counts summed, countdown from the earliest expiry. The 「重置」 buttons next to quota titles in Settings → Usage, the model provider status card, and the input Context usage panel only open the unified reset dialog — they never redeem directly and never filter by click type; the actual `/use` is triggered only by the per-type 「重置」 button inside the dialog. Week manual reset sends `reset_type: "WEEK"` and, on success, optimistically rewrites the next reset time by 7 days.
- Personal and Team use full source scope isolation; a Team key must include organization + project, never provider id alone.
- Manual reset shows processing while in flight; on success, refresh status and real entitlement/quota.
- Auto/ops reset is detected by polling when `latest_five_hour_reset_history.used_at` or `latest_week_reset_history.used_at` changes, then shows completed. The backend has no processing field; business decisions and quota correction rely only on server `used_at`. The Composer trigger synthesizes a brief "resetting" visual (~1 s) before switching to "reset"; that synthesized stage is purely visual and never rewrites server state.
- Completion time uses server Unix-ms `used_at`, never client `Date.now()`.
- `observed_at` only records when the client first observed the current `used_at`; it exists so the short notice still plays fully after the 5-minute poll discovers an auto/ops reset. Hover/focus display and business decisions still use only server `used_at`.
- After `has_unread_history=true` is written into client state, report history read.
- Support desktop, Web, mobile `/remote`, light/dark, zh/en, and reduced motion.

Out of scope:

- Client-side eligibility or quota-threshold judgment.
- Server-side processing/SSE/WebSocket; the backend provides no such contract.
- Writing reset state into relay, desktop main, Agent runtime, or session/task realtime streams.

## Service and process boundary

```text
Desktop renderer / Web remote renderer
              |
              | hook call; no credential reads, no direct fetch
              v
       IUsageStatsService (existing Host RPC)
              |
              | read zcode JWT + current Coding Plan credential
              | build Personal/Team scope headers
              v
       ZCode Server /api/v1/coding-plan/reset
              |
              | status / opportunity / use / history-read
              v
       Zustand window-local reset state
         |             |             |
         v             v             v
   Composer       Provider settings  Usage page
```

- Desktop local windows keep the window-scoped Local Host.
- Mobile `/remote` reuses the desktop's existing host service via shared-host attachment; no separate Agent, local host, or remote runtime.
- This feature does not touch task/session stream, snapshot, queue, owner/lease; the desktop `continuous` and Web remote `replayable` boundaries are unchanged.
- UI reaches `IUsageStatsService` only through hooks; the Service layer never references a concrete Runtime implementation.

## API contract

### Scope request

```ts
interface CodingPlanResetScopeRequest {
  preferredProviderId: string;
  organizationId?: string | null;
  projectId?: string | null;
}
```

The Service builds from the scope:

```text
Authorization: Bearer <zcode_jwt>
X-Bigmodel-Authorization: <current_provider_business_jwt>
Bigmodel-Target-Type: PERSONAL | TEAM
Bigmodel-Organization: <TEAM only>
Bigmodel-Project: <TEAM only>
```

Constraints:

- JWT comes from the credential service's `zcodejwttoken`.
- `X-Bigmodel-Authorization` carries the business JWT for the current Coding Plan provider family, passed raw without `Bearer`, and is **not** the Coding Plan API key: Z.ai family uses credential service `oauth:zai:access_token`, BigModel family uses `oauth:bigmodel:access_token`. The two credentials must never fall back to each other, so provider identity and server-side verification identity are not mixed (2026-08-14 Z.ai reset auth fix).
- Coding Plan provider resolution confirms the plan is configured, selects the business JWT matching the provider family, and derives the Personal/Team scope; Team scope is carried entirely by `Bigmodel-Organization` / `Bigmodel-Project` headers — the client no longer copies a team project API key into reset requests.
- Credential values must never be logged, enter UI stores, or be persisted.
- URLs use `buildRuntimeZCodeApiUrl(env, path)` and follow test/production/custom endpoint settings.

### status mapping

```ts
interface CodingPlanResetStatusSnapshot {
  availableFiveHourResets: Array<{ expireAt: number }>;
  availableWeekResets: Array<{ expireAt: number }>;
  latestFiveHourResetHistory: { usedAt: number } | null;
  latestWeekResetHistory: { usedAt: number } | null;
  hasUnreadHistory: boolean;
}
```

The Service layer must runtime-validate the envelope and fields; remote JSON is not trusted, and the client must not branch on `msg`.

### opportunity judgment and idempotency

```ts
interface CodingPlanResetOpportunityRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
}

interface CodingPlanResetOpportunityResult {
  granted: boolean;
  nextTryAt: number | null;
}
```

Request body is fixed:

```json
{
  "idempotency_key": "<uuid>"
}
```

- Each new server eligibility check generates a fresh UUID, max 64 characters.
- Concurrent calls for the same service + scope are merged client-side by single-flight; one network request uses one idempotency key.
- After `granted=true` with `nextTryAt=null`, force-refresh `/status` immediately and honor the returned opportunity content; the Coordinator waits at least 10 minutes before the next eligibility check.
- Business code `3301` must return `granted=false` plus a Unix-ms `next_try_at`; the Service maps it to `nextTryAt`, the Coordinator stores that server time and polls only status until it expires.
- Without a valid server `nextTryAt`, use a 10-minute fallback; past times are pushed at least 5 minutes out to avoid rapid repeat checks. Holding one opportunity kind never permanently blocks the scope-level check — after expiry the server may still evaluate the other kind.
- `granted=false` / `3301` keeps the entry hidden with no error toast; transient errors (`code=2007`, network loss, timeout) retry after a fixed 5 minutes, reusing the failed request's idempotency key.
- On request flooding / card-lock contention the backend may return a bare HTTP 429 (no 3301 envelope, no `next_try_at`). The Service maps it to the stable error `coding_plan_reset_opportunity_throttled`; the Coordinator cools down a fixed 10 minutes before generating a new key. Auth, business-rejection, and protocol-parse errors are also stable errors: wait 10 minutes with a new key, avoiding high-frequency empty polling without credentials and warn spam in production.
- The client must never skip or fake a grant based on local thresholds such as five-hour usage below 80%; the backend is the only source of eligibility.

### use idempotency

```text
new user click        -> generate new UUID (<= 64 chars)
same request failed   -> keep UUID
user clicks retry     -> reuse the original UUID
used=true success     -> clear UUID
```

Request body is fixed:

```json
{
  "idempotency_key": "<uuid>",
  "reset_type": "FIVE_HOUR"
}
```

## State model

```text
                status: no opportunity, no new history            opportunity: granted=true
HIDDEN / IDLE ------------------------------> CHECKING ------------------------+
     |                                                                         |
     | status: valid FIVE_HOUR opportunity                                     v
     +------------------------------------------------------------------> AVAILABLE
     ^                                                            |
     | opportunity: false / 3301 + next_try_at                   | page button opens dialog; reset clicked in dialog
     | (cooldown polls status only, no more POST opportunity)     v
     |                                                      LOCAL_PROCESSING
     |                                                            |
     |                                     use failed (key kept)  | use used=true
     |                                      +---------------------+
     |                                      |                     v
     |                                      +--------------- REFRESH_STATUS
     |                                                            |
     |                             status latest used_at updated   v
     +-------------------------------------------------------- COMPLETED
                                                                  |
                                                                  | after the completed notice
                                                                  v
                                                          history/read
```

COMPLETED is orthogonal to the opportunity balance (the same status snapshot carries both):

```text
completion axis  used_at / observed_at / quota_override_pending / next_reset_at
                 └─ "reset" notice, 100% optimistic override, reset-time fallback
opportunity axis opportunity_count / opportunity_expires_at (remaining valid opportunities in the same snapshot)
                 └─ badge count, 「重置」 next to quota titles, dialog row count + countdown, reset() gating

COMPLETED(0 remaining) ── "已重置" next to title; dialog row collapses after success feedback
COMPLETED(N remaining) ── 「重置」 next to title; row kept with N and the next countdown
      │
      └─ reset clicked again in dialog ─> LOCAL_PROCESSING ─> /use ─> new used_at in status ─> COMPLETED(N-1)
         (no need to wait a poll to yield back to AVAILABLE, no need to reopen the dialog)
```

Rules:

- AVAILABLE comes from unexpired server `available_five_hour_resets` / `available_week_resets`, each using its earliest valid `expire_at` as countdown; five-hour and week quotas do not affect each other.
- `has_unread_history` is a single shared cursor for five-hour and week, but `latest_{five_hour,week}_reset_history` are independent. A kind "owns" the unread marker and enters completed only when its `used_at` is the newest of the two: `ownsUnread = has_unread_history && latestUsedAt != null && (otherUsedAt == null || latestUsedAt >= otherUsedAt)`. So a week reset flipping the shared marker never misreads a stale five-hour history as just completed (and vice versa).
- The button next to a quota title only opens the unified reset dialog; it never enters LOCAL_PROCESSING and never calls `/use` directly. LOCAL_PROCESSING is triggered only by the per-type 「重置」 button inside the dialog; the dialog button shows loading/disabled.
- The title-adjacent action takes its state from "still redeemable": if the kind still has redeemable opportunities it shows a clickable 「重置」 (opens the dialog); otherwise COMPLETED shows 「已重置」 with the server completion time. On auto/ops completion with remaining opportunities of the same kind, the panel has no 「已重置」 anchor, the catch-up confetti is skipped (the arm stays until cleaned up after the completed state yields), and the completion feedback is carried by the Composer trigger tooltip.
- Manual reset entering COMPLETED from LOCAL_PROCESSING: the button first shows a 600 ms success checkmark and one confetti burst, then switches to "已重置"; no "resetting" or "已重置" tooltip.
- The manual redemption trail is shared per service + scope across UI entries. After any entry clicks reset, other entries observing the same new `used_at` must also recognize it as manual — the input entry must not misfire as an auto/ops reset notice.
- Auto/ops reset has no server processing signal: on polling discovering a new `used_at`, go straight to COMPLETED. The Composer trigger synthesizes a brief "resetting" (~1 s, purely visual) then switches to "已重置"; that tooltip stays until the user hovers the trigger and the quota panel expands, then collapses.
- COMPLETED uses server `used_at`; the synthesized "resetting" for auto/ops starts from the `observed_at` of the first observation of that `used_at` — repeated polls of the same history must not replay or extend it. When hovering expands the quota panel, one confetti catch-up plays from the panel's 「已重置」 row (same position as manual), deduplicated by `used_at`, played once. The 「已重置」 action and hover/focus times keep using server `used_at` until a later status/quota correction.
- The auto/ops confetti arm may only be consumed when the panel's 「已重置」 DOM is mounted and the confetti function actually called; if the anchor is not ready when the overlay opens, keep the arm and play on mount — never mark played early.
- The Root Store records the **first observation** of an auto completion per source + kind as `(used_at, auth_session_seq)`. Later polls with the same `used_at` must not rewrite the record to the current auth session. If the settings or Usage page wrote the completed state first within the **same auth session**, a later-mounted Composer must still show that new auto reset. Only when the user left login and re-entered (changed `auth_session_seq` with the same `used_at`) is `observed_at` cleared, avoiding replay of old tooltips/confetti after logout/login. Refreshing user info or connecting extra providers while logged in does not advance the seq; an async status writeback from a previous auth session must be atomically rejected by the Store.
- The auto-completed notice plays **only once across windows of the same desktop app** (bugfix: `has_unread_history` cursor cleanup has a seconds-level lag, and per-window independent polling would replay it). A status write only means "observed the completion"; non-Composer entries (settings, Usage) must not consume play eligibility from it. Before the Composer shows a tooltip/confetti it must request a tokened temporary reservation from the BroadcastHub keyed by `(sourceKey, reset_type, used_at)`; only when the component confirms it is still mounted, source/candidate still match, and display is imminent does it commit the reservation to a permanent claim, write played, enter the synthesized processing/completed tooltip, arm the confetti, and broadcast played. If the component unmounts, switches source, or the candidate goes stale while waiting, the winner must release with the token; Main must also reclaim uncommitted reservations on host unregister or TTL expiry. A claim-busy result only means another window is preparing to show: the loser must not write played or clear `observed_at`, and may only wait for the real played broadcast or retry after the temporary reservation is released/expired. The BroadcastHub stores only bounded opaque reservations/claims and no Coding Plan business state; Web / no-parentPort environments get the same semantics from the broadcast service's in-process reservations. The played broadcast lets other windows collapse observed-but-unplayed notices; its merge must be monotonic by `used_at` — a late old broadcast must not overwrite a newer record.
- Opportunities hide immediately on expiry; the next status poll corrects.
- While a kind holds any unexpired valid opportunity, all three entries (opportunity badge, title-adjacent 「重置」, dialog reset row) must show it with the remaining count; quota at 100% is not a hide condition. Bugfix: redemption optimistically rewrites that quota to 100% (see below); hiding entries by "no gain at 100%" would hide remaining opportunities right after one is used, looking like a lost card. Opportunities are user assets; whether to redeem at full quota is the user's call, and 「重置」 stays clickable. Entries disappear only when opportunities are exhausted or all expired.
- COMPLETED holds within the same `used_at` cycle (repeated polling does not clear the completed state); but if the backend re-issues valid opportunities within the same cycle, the completed state yields back to AVAILABLE (a new cycle), otherwise new opportunities stay permanently masked. A just-discovered unread completion still takes precedence over new opportunities for one round; manual `/use` processing reconciliation is unaffected.
- COMPLETED also carries the remaining valid opportunities from the same status snapshot (count and earliest `expire_at`). "Still redeemable" has one definition: not LOCAL_PROCESSING, count > 0, and earliest expiry later than now; both AVAILABLE and COMPLETED use it for badge count, title-adjacent 「重置」, dialog row, and `reset()` gating. Remaining opportunities in completed state can be redeemed again directly (COMPLETED → LOCAL_PROCESSING with a fresh idempotency key); cross-entry double-redemption reconciliation still applies. Bugfix: the old implementation zeroed count/expiry on entering COMPLETED, so remaining cards waited for the next status (≤5-minute poll, or an immediate correction from reopening the dialog / remounting an entry) to return; meanwhile the dialog row rendered empty expiry as 「0 分 0 秒后过期」 and a second click was silently ignored by `reset()` yet still played success feedback. The dialog's local count reconciliation kept to work around this was a second data source and was removed.
- On completed, the UI may first optimistically override that quota to 100% with `quota_override_pending=true` and force-refresh entitlement; the flag clears when the real quota refresh succeeds, repeated polls of the same `used_at` must not re-enable the override, and the server quota wins. The optimistic next-reset time is per kind: five-hour `used_at + 5h`, week `used_at + 7d`.

```text
manual click: AVAILABLE -> LOCAL_PROCESSING -> SUCCESS(600ms) -> COMPLETED
UI feedback:   reset btn    btn loading         success check + btn confetti   "已重置"
Tooltip:       closed       closed              closed                        closed

auto/ops:      HIDDEN/AVAILABLE ----poll finds new used_at----> synthesized "resetting" (~1s) -> COMPLETED --hover trigger--> collapse tooltip
UI feedback:                                                trigger spinner                  persistent trigger "已重置"   confetti catch-up at the manual position in the panel
Tooltip:                                                    "resetting"                      "已重置" (persistent)        closed
```

## Polling, sharing, and timing

Within one Renderer there is one shared Coordinator keyed by `authSessionSeq + usageStatsService + preferredProviderId + organizationId + projectId`. The Composer trigger, Composer HoverCard, settings provider card, and Usage page only subscribe; they create no timers and never drive periodic requests themselves. Personal/team scopes poll separately; no cross-window frontend leader election this cycle — server idempotency and rate limiting are the backstop.

```text
Composer Trigger ───┐
Composer HoverCard ─┤
Provider Card ──────┼── subscribe ──> scope Coordinator
Usage Page ─────────┘                     |
                                         | document visible: immediate first + every 5min
                                         v
                                  GET /reset/status
                                         |
                          processing / new completion this round?
                              | yes              | no
                              |                  v
                              |          now >= nextOpportunityAt?
                              |             | no       | yes
                              |             |          v
                              |             |   POST /reset/opportunity
                              |             |          |
                              |             |     granted / next_try_at
                              |             |          |
                              |             |     update shared schedule
                              |             |          |
                              |             |   granted=true forces GET status
                              v             v
                             Zustand shared state projection
```

```text
subscribers 0 --first entry mounts--> 1: bind visibility + start the single 5min timer + immediate correction
subscribers N --other entries mount--> N+1: subscribe only, no new timer, no amplified network burst
subscribers 1 --last entry unmounts--> 0: stop timer + remove visibility binding; keep scope schedule
subscribers 0 --entry remounts------> 1: immediate status; no opportunity before nextOpportunityAt
```

- While the document is visible the Coordinator queries `/status` immediately the first time, then every 5 minutes; hidden stops network requests; returning to visible corrects immediately.
- One polling owner per service + auth session + scope; `/status` and `/opportunity` each still merge in-flight requests, and manual-reset reconciliation may bypass status freshness to force a refresh.
- Each round reads status first. Skip opportunity while a manual redemption is processing or a completed history was just discovered this round; otherwise (including while one kind still holds opportunities) keep making the scope-level check after the shared schedule expires, so a long-lived week opportunity does not starve five-hour eligibility.
- On `granted=false` with a valid server `nextTryAt`, store it as that Coordinator's `nextOpportunityAt`; until it expires poll status only, never re-trigger eligibility. Past times are pushed at least 5 minutes out to prevent rapid repeat checks.
- After `granted=true`, bypass status freshness to force reconciliation, then wait at least 10 minutes before checking opportunity again.
- Without a valid server `nextTryAt` use the 10-minute fallback; 429 uses a fixed 10-minute cooldown.
- Network/dependency errors retry after a fixed 5 minutes, no exponential backoff; retries reuse this round's opportunity idempotency key, clear it once a definite business result arrives, and the next eligibility check generates a new key.
- On `authSessionSeq` change, use a new Coordinator key; cooldowns, idempotency keys, and polling from the old session must not leak into the new one.
- The Coordinator stops its timer when subscribers reach zero but keeps the scope schedule, so reopening a HoverCard does not immediately re-call opportunity.
- On manual `/use` start, record the service + scope trail and the pre-click `used_at`; when a new `used_at` arrives, bind it as the completion time so Composer, settings, and Usage all recognize it. A later different `used_at` clears the old trail and is treated as an auto/ops reset.
- LOCAL_PROCESSING enters COMPLETED only when status returns a `used_at` **different from the pre-click baseline** (the trail bound to a new completion time). If status still reads the baseline `used_at` — even with `has_unread_history` still true (the previous card's history/read not yet effective) — stay in LOCAL_PROCESSING and keep reconciling; if 4 reconciliations after `/use` see no new `used_at`, run failure recovery. Bugfix: the old check only required processing plus a non-empty `used_at`. Redeeming again from COMPLETED(N remaining) makes the baseline the previous card's `used_at` from seconds ago, so a slightly lagging server read would treat the old history as this completion on the first reconciliation: the dialog plays success feedback before server confirmation, the in-row count stays at the pre-consumption snapshot, and the next click is silently ignored by the unbound trail while playing success feedback again.
- On clicking reset, if a manual redemption trail already exists for the same service + scope + kind (started by another entry in this window), first force reconciliation: if the other `/use` is still in flight, or after reconciliation this entry is no longer available (quota already redeemed), do not start a second `/use` — that would be a duplicate redemption with a new idempotency key. Only if still available after reconciliation (a new opportunity was granted) is a new redemption allowed. Multi-window and mobile `/remote` do not share this trail; cross-window concurrency is backstopped by server-side opportunity redemption.
- After a manual success, bypass freshness and refresh status immediately.
- After a new `used_at` is discovered, play the completion animation once per source and force-refresh entitlement/quota.
- On observing a `has_unread_history` completion, report history/read **immediately**, without waiting for the entitlement refresh (bugfix: the old implementation awaited a seconds-long entitlement refresh before marking read, stretching the server cursor cleanup and widening the multi-window replay window; a failed refresh must not block the read report).

```text
Window A Composer             Main BroadcastHub              Window B Composer
      | status(T)                    |                             | status(T)
      | write observation only       |                             | write observation only
      | acquire(key=T) ------------->|                             |
      |<-- reservation(token=A) -----|<------------- acquire(key=T)
      |                              |------------- busy(retryable) ->|
      | mounted/source/candidate OK  |                             | keep observed_at
      | this component about to show |                             | wait for played or retry later
      | commit(token=A) ------------>|
      | write played(T) + broadcast  |
      | show Tooltip / arm confetti  |
      |---------------- played(T) ---------------------------------->|
      |                              |                             | write played / observed_at=null

Window A unmounts or switches source while waiting on acquire
      | acquire(key=T) ------------->|
      |<-- reservation(token=A) -----|
      | mounted/source/candidate stale
      | release(token=A) ----------->|
      |                              | delete the uncommitted reservation
      |                              |<------------- Window B retries acquire
      |                              |------------- reservation(token=B) ->|
      |                              |                             | commit + played + show

Non-Composer (settings page / Usage page)
    status(T) -> write observation / completed state / quota refresh only, no acquire
```

```text
Settings discovers the auto completion first (same login session)
    status(new used_at) -> Store(entry + auth_session_seq=N)
    Composer mounts later -> seq still N -> keep observed_at -> play normally

Logout then login again
    setUser(null) -> setUser(user) -> auth_session_seq=N+1
    Composer/status read the same used_at
        -> Store record is still N
        -> mute the old observed_at, advance the observation record to N+1
    later new used_at -> completedAt differs -> play normally
```

## Error handling

| Scenario                                            | Client behavior                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 401                                                 | No opportunity shown, log warn, wait for login/credential recovery                                           |
| 400 / code 3001                                     | Hide the errored scope's entries, never rewrite the scope automatically                                      |
| 403 / code 3101                                     | Show reset failed, wait for account binding/credential fix                                                   |
| 429 / code 3002                                     | Back to retryable, keep this idempotency key                                                                 |
| 500 / code 2001/2002/2007                           | Back to retryable, keep this idempotency key                                                                 |
| malformed response                                  | Protocol error, never enter completed                                                                        |
| status failure                                      | Keep the last shown state, background polling corrects                                                       |
| opportunity `granted=false` / code 3301             | Save `next_try_at`; poll status only until due, then re-check with a new key on the first visible poll       |
| opportunity `2007` / network / timeout              | Keep status; retry after a fixed 5 minutes reusing this round's key                                          |
| opportunity 429                                     | Keep status; fixed 10-minute cooldown with a new idempotency key                                             |
| opportunity auth / business reject / protocol error | Keep status; fixed 10-minute cooldown with a new key, avoiding high-frequency empty polling on stable errors |

For non-2xx responses that still carry the unified envelope, the client must extract `code` first and map it to the stable error identifier `coding_plan_reset_api_error:<code>`, never depending on `msg` wording. That way a test environment returning `HTTP 403 / code=3101` does not reduce logs and retry logic to the unstable `coding plan is required` string.

## 2026-08-10 test-environment finding

The legacy client runtime only reached the reset status endpoint, and status itself grants nothing: the root cause was the missing `POST /opportunity` call, so the backend never received an eligibility check and `/status` kept returning empty opportunities (`available_five_hour_resets=[]`). The fix added the opportunity call; the client still must not fall back to a plain API key, personal key, or locally fabricated opportunities.

Logging:

- Service lifecycle/failures use `createServiceLogger("usage-stats")`; tokens and API keys are never logged.
- UI high-frequency polling detail uses `debug` from `packages/ui/src/logger.ts`; failures use `warn`.

## UI and responsiveness

- Reuse existing `Button`, `ControlHintTooltip`, Lucide icons, and usage chart tokens.
- All font sizes use `text-ui-*`; no new hardcoded theme colors.
- Processing disables the button with a spinner to prevent double submits; the manual flow shows no processing tooltip.
- Confetti on the button plays only after `/use` succeeds and status returns server history; the success checkmark lasts 600 ms before showing "已重置"; the manual flow shows no completed tooltip and no confetti on failure.
- Auto/ops reset: the Composer trigger first synthesizes ~1 s "resetting", then switches to a persistent "已重置" tooltip kept until the user hovers the trigger; hovering expands the quota panel, collapses the tooltip, and plays one confetti catch-up from the panel's reset row (same position as manual).
- "已重置" hover/focus shows the server completion time.
- With exactly one opportunity, keep the compact entry: show "1 次重置额度" (one reset quota) with that opportunity's countdown, plus the single "重置" action next to the quota bar.
- When the Composer shows a reset-opportunity reminder, clicking the trigger or the reminder keeps it shown; clicking elsewhere marks the current stage read and closes it. An outside click at the initial stage does not prevent the same opportunity from showing the urgent reminder again once inside its last three minutes.
- With more than one valid opportunity, the merged entry becomes a clickable "获得 N 次重置额度" (N reset opportunities gained), N = total valid opportunities; the entry itself shows no countdown and opens the "可重置额度" (resettable quota) dialog on click. Both Settings Usage and the Composer HoverCard keep a "重置" button next to the five-hour/week quota titles, allowing direct redemption of that kind without entering the dialog.
- The multi-opportunity dialog uses current server state as its only data source: the title keeps only "可重置额度" copy (no opportunity count summary); "剩余用量" (remaining usage) shows current five-hour, week, and tool quotas; "可重置额度" lists only the `FIVE_HOUR` / `WEEK` kinds that are genuinely redeemable and beneficial to reset, each calling the existing `reset()`.
- Each reset row in the dialog shows that kind's earliest-opportunity countdown independently; when one kind holds multiple opportunities the row shows an "N 次" (N times) count pill next to the kind name (same accent color as the badge) and marks the countdown copy as "最快 …" (earliest …) so it is not read as a shared deadline; a single opportunity shows no pill and keeps the plain countdown copy. Manual redemption still succeeds only on a new `used_at` in status differing from the pre-click baseline; on success, one confetti plays from the clicked button and no auto/ops tooltip fires. When the success feedback (600 ms) ends, the latest server projection decides the row's fate: if the kind still has redeemable opportunities the row stays, showing the remaining count and next countdown with 「重置」 clickable again — no close or reopen needed; only when opportunities are exhausted does the row collapse, leaving the countdown cell empty during the collapse animation instead of rendering 「0 分 0 秒」. The dialog keeps no local count reconciliation.
- Opening the dialog from the Composer HoverCard keeps the HoverCard mounted; the HoverCard collapses only after the dialog closes, so the Dialog portal does not flash-close when its parent overlay unmounts.
- Mobile Web dialog width stays within `calc(100vw - 2rem)`; remaining-usage cards stack vertically, buttons stay focusable and clickable, no horizontal overflow.
- Reduced motion skips confetti and non-essential animations.

Multi-opportunity interaction states:

```text
server status
    |
    +-- total valid opportunities = 1
    |      └─ compact badge + single-opportunity countdown
    |             └─ single "重置" next to the quota bar -> reset(type)
    |
    +-- total valid opportunities > 1
           ├─ "获得 N 次重置额度" (no entry countdown)
           │      └─ click
           │          └─ 可重置额度 Dialog
           │              ├─ FIVE_HOUR row -> resetUi.reset()
           │              └─ WEEK row      -> resetUi.week.reset()
           └─ Settings Usage and Composer HoverCard keep direct actions next to quota titles
                  ├─ five-hour "重置" -> resetUi.reset()
                  └─ week "重置"      -> resetUi.week.reset()

Reset clicked in the dialog
    -> POST /use
    -> forced status reconciliation
    -> server used_at updated
    -> button success feedback + confetti (no auto-reset tooltip)
    -> latest projection decides the row's fate
         ├─ N remaining of that kind -> row kept, shows N and the next countdown, button back to 「重置」 (redeemable again)
         └─ 0 remaining              -> row collapses (countdown cell empty during collapse)
```

## Acceptance cases

| ID        | Scenario                                                                                                                       | Expected                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QR-INT-01 | Personal status returns 1 FIVE_HOUR opportunity                                                                                | All three entries share the display of 1 opportunity and its expiry countdown                                                                                                                                                                                                    |
| QR-INT-02 | Team status query                                                                                                              | Request carries TEAM, organization, project; state isolated by full source key                                                                                                                                                                                                   |
| QR-INT-03 | No subscription                                                                                                                | Empty opportunities/history, no reset entry shown                                                                                                                                                                                                                                |
| QR-INT-04 | Reset clicked                                                                                                                  | Button processing; no tooltip; request body has FIVE_HOUR and a new idempotency key                                                                                                                                                                                              |
| QR-INT-05 | Retry after a use dependency failure                                                                                           | Back to clickable; retry reuses the original idempotency key, no confetti                                                                                                                                                                                                        |
| QR-INT-06 | use success                                                                                                                    | Force-refresh status + entitlement; completion by server used_at; 600 ms success check + confetti, then "已重置"; no completed tooltip                                                                                                                                           |
| QR-INT-07 | Auto/ops reset                                                                                                                 | Poll finds a new used_at; trigger synthesizes ~1 s "resetting" then a persistent "已重置"; hovering collapses the notice and plays one confetti catch-up at the manual position in the panel                                                                                     |
| QR-INT-08 | has_unread_history                                                                                                             | history/read called after the completed state is written                                                                                                                                                                                                                         |
| QR-INT-09 | Multiple entries mounted together                                                                                              | Status requests for the same scope merged, no 3-4x burst                                                                                                                                                                                                                         |
| QR-INT-10 | Opportunity expiry                                                                                                             | Entry hides when the local countdown ends; polling corrects afterwards                                                                                                                                                                                                           |
| QR-INT-11 | Mobile `/remote`                                                                                                               | Reuses the shared host service; no new runtime; replayable recovery unaffected                                                                                                                                                                                                   |
| QR-INT-12 | zh/en / both themes / reduced motion                                                                                           | Copy, colors, interactions, and motion follow DESIGN.md                                                                                                                                                                                                                          |
| QR-INT-13 | Auto reset `used_at` older than 5 minutes before discovery                                                                     | Synthesized "resetting" runs from `observed_at` then persistent "已重置"; hover times still use server `used_at`; repeated status does not replay the synthesized stage or catch-up confetti                                                                                     |
| QR-INT-14 | HTTP 403 envelope with `code=3101`                                                                                             | Client error is `coding_plan_reset_api_error:3101`, no branching on `msg`                                                                                                                                                                                                        |
| QR-INT-15 | status has no opportunity, no new history                                                                                      | opportunity called; `granted=false`/3301 keeps entries hidden, no toast                                                                                                                                                                                                          |
| QR-INT-16 | opportunity `granted=true`                                                                                                     | Force-refresh status immediately; show entries from the returned valid FIVE_HOUR opportunity                                                                                                                                                                                     |
| QR-INT-17 | Four entries mounted on the same scope                                                                                         | One 5-minute poll per auth session + service + scope; the first round sends status/opportunity exactly once                                                                                                                                                                      |
| QR-INT-18 | status already has one kind of opportunity or a just-found completed history                                                   | A single-kind opportunity does not block the scope check after expiry; opportunity is skipped in the round that just completed                                                                                                                                                   |
| QR-INT-19 | opportunity 3301 with a future `next_try_at`                                                                                   | Entries stay hidden, no toast; Coordinator polls status only until due, then re-checks with a new idempotency key on the first visible poll                                                                                                                                      |
| QR-INT-20 | Manual reset on settings/Usage, Composer polls the new history                                                                 | All entries recognize it as manual per service + scope; Composer shows no auto-reset tooltip and no trigger confetti                                                                                                                                                             |
| QR-INT-21 | Reset clicked while another entry of the same window has a manual redemption in flight or just completed                       | Forced reconciliation instead of a second `/use`; no duplicate redemption or extra consumption; clicks after a new grant proceed normally                                                                                                                                        |
| QR-INT-22 | Settings discovers the auto completion first, Composer mounts later in the same login session                                  | `observed_at` kept; Composer plays that "resetting → 已重置" and confetti normally; the shared Store is not misread as old-login history                                                                                                                                         |
| QR-INT-23 | Logout/login again, status still returns the same `used_at`                                                                    | `auth_session_seq` changed, old completed state muted; a later different `used_at` plays normally                                                                                                                                                                                |
| QR-INT-24 | Exactly one valid opportunity                                                                                                  | All three entries keep the single-opportunity countdown; no multi-opportunity dialog                                                                                                                                                                                             |
| QR-INT-25 | More than one valid opportunity                                                                                                | All merged entries show the clickable "获得 N 次重置额度" without countdown; Settings Usage and Composer HoverCard keep per-kind "重置" buttons next to the five-hour/week titles for direct redemption or opening the dialog via the merged entry                               |
| QR-INT-26 | Multi-opportunity dialog data                                                                                                  | Title does not summarize counts; a kind with multiple opportunities shows the "N 次" pill and "最快" countdown, single ones show neither; only FIVE_HOUR/WEEK with real quota and valid opportunities are listed (including at 100%); remaining usage and bars use current quota |
| QR-INT-27 | Reset of one kind clicked in the dialog                                                                                        | Calls only that kind's reset; after server used_at confirms: success feedback, confetti, row collapse; no Composer auto-reset tooltip                                                                                                                                            |
| QR-INT-28 | Multi-opportunity dialog opened from the Composer HoverCard                                                                    | HoverCard stays mounted while the dialog is open; dialog stays interactive, HoverCard collapses after close                                                                                                                                                                      |
| QR-INT-29 | Multi-opportunity dialog on mobile Web                                                                                         | Width within viewport minus 32px, quota cards stacked vertically, reset list scrollable, no horizontal overflow                                                                                                                                                                  |
| QR-INT-30 | Composer unmounts, switches source, or the candidate changes while waiting on a reservation                                    | No played write, no broadcast, no display; the tokened reservation is released (or reclaimed on host unregister/TTL); other valid windows may still compete and complete the display                                                                                             |
| QR-INT-31 | acquire returns busy, no played broadcast yet                                                                                  | Keep `observed_at` and the candidate; busy is not played; temporary reservations may retry, permanent claims only wait for the real played broadcast or local played-cursor suppression                                                                                          |
| QR-INT-32 | HoverCard reopened after closing                                                                                               | Reuses the original Coordinator schedule; status may correct immediately, but opportunity is not re-called before `next_try_at`                                                                                                                                                  |
| QR-INT-33 | opportunity network/dependency error recovers                                                                                  | Retry after a fixed 5 minutes reusing the failed request's key; the next round generates a new key after a definite business response                                                                                                                                            |
| QR-INT-34 | opportunity returns 429                                                                                                        | No opportunity request for 10 minutes; status polling unaffected                                                                                                                                                                                                                 |
| QR-INT-35 | Logout/login on the same provider/scope                                                                                        | `auth_session_seq` isolates the old Coordinator; the new session runs its own immediate first correction                                                                                                                                                                         |
| QR-INT-36 | opportunity auth, business reject, or protocol error                                                                           | No opportunity request for 10 minutes; new idempotency key after cooldown; status polling unaffected                                                                                                                                                                             |
| QR-INT-37 | HoverCard unmounts and remounts while an old entry's refresh is unfinished                                                     | The new entry immediately reuses the shared in-flight/cache to finish its own projection, without waiting for the next 5-minute tick and without new opportunity requests                                                                                                        |
| QR-INT-38 | After redeeming one, quota at 100%, same kind still has opportunities                                                          | All three entries keep showing that kind with the remaining count (including exactly 1); 「重置」 stays clickable; entries hide only when exhausted or all expired                                                                                                               |
| QR-INT-39 | Multiple opportunities of one kind; redeem one without closing the dialog                                                      | The row immediately shows remaining count and next countdown (never 「0 分 0 秒」), clickable 「重置」 next to the title, badge counts the remainder; the next click really sends `/use` and completes; the row collapses when exhausted                                         |
| QR-INT-40 | Redeem again from COMPLETED(N remaining); status after `/use` still returns the previous card's `used_at` (unread not cleared) | Stay processing, no success feedback; complete only after a new `used_at` is read and show the remaining count from the new snapshot; run failure recovery if 4 reconciliations see no new `used_at`; never succeed silently                                                     |

Verification records:

- 2026-09-28 (QR-INT-39): lib / hook / dialog / title-adjacent actions unit tests plus existing related tests — 18 files, 429 cases passing. macOS Electron ran the full `coding-plan-team-usage.test.ts` (26 cases, no skips, no retries, incl. new QR-E2E-14 and QR-E2E-03 after the dialog-state helper change), run `desktop-e2e-20260928035551264-p84306-4690b59ecaa7b158`. typecheck (incl. e2e tsconfig), lint (0 errors; 62 pre-existing warnings untouched), `architecture:check --changed` pass; Windows/Linux and real mobile devices not run.
- 2026-09-30 (QR-INT-40): new lagged-snapshot lib cases, hook cases "read lags twice (unread uncleared / cleared)" and "failure recovery after 4 lagged reconciliations" — 4 failing before the fix, 45 lib + hook cases passing after; 12 related UI test files, 156 cases passing. macOS Electron added QR-E2E-15 (mock `/use` result visible in status only after a 600 ms delay): failing before, five-hour row stuck at 「1 小时 59 分后过期 / 重置」 clickable; after the fix `coding-plan-team-usage.test.ts` full file 27 cases passing, no skips, no retries, run `desktop-e2e-20260930-032927-012`. typecheck, lint (0 errors), `architecture:check --changed` pass; Windows/Linux and real mobile devices not run.
- 2026-09-11 (settings overlay below): two new component regressions failed then passed; 19 related unit tests passing. macOS Electron QR-E2E-09/10 passing, no skips, run `desktop-e2e-20260911-042939-508`, verifying portal disappearance, no false read on settings clicks, and restore on return using real settings navigation state. typecheck, typecheck:e2e, lint pass (44 pre-existing warnings); Windows/Linux and real mobile devices not run — full quota-flow coverage is not claimed.

## Integration risks

1. Backend status has no processing field; the Composer trigger's "resetting" is a purely synthesized visual (~1 s) — not a real server processing stage. Business decisions and quota correction still rely only on server `used_at`.
2. `/opportunity` triggers the server judgment; it is not a client request or local judgment. If the backend later switches to scheduled proactive grants, this trigger call must be removed in step.
3. `history/read` is a cursor shared across all the user's scopes; reporting from any entry clears unread for other scopes too. That is the current backend contract.
4. If the test environment's CORS does not allow the `X-Bigmodel-Authorization` and similar headers, Web fails; the Desktop host connects directly and is not subject to browser CORS.

## Composer reminders under the settings overlay

- The workspace stays mounted while a settings tab is open, but its portal reminders must not bleed through the settings page. First-opportunity, expiring, and reset-status tooltips share the workspace-visibility gate.
- While in settings, pause the Composer reminder's outside-click read listener; hidden is not read. On return, decide by current valid opportunities and the existing read state. The settings page's own opportunity badge/dialog is unaffected.
- Reason: workspace opacity/inert does not apply to tooltips portaled to body, and the old display condition checked only business state. Reuse the same active-settings-tab check as Root; no change to service requests, reset execution, desktop continuous, or mobile replayable paths.
- Regression: extended QR-E2E-09/10 — after the first/expiring reminder appears, switch to settings, click settings content, return to the workspace; verify the overlay disappears in settings, is not falsely read, and restores on return. Unit tests cover first opportunity arriving during settings, not unmounting on tab switch, and read-listener restore.
