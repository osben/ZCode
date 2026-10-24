# Coding Plan purchase telemetry

## Events

The purchase funnel carries two minimal events:

- `purchase_pay_ck`: the user confirmed continuing to payment and entered the
  payment-submission chain for the current purchase attempt.
- `purchase_result`: the same purchase attempt ended in success, failure,
  cancellation, or timeout.

Both events share one `purchase_attempt_id`. It is generated when continue-payment
is clicked and stored in the current attempt context of the purchase hook; the
result report must not regenerate it.

## Reporting chain after the WebView migration

Entry clicks are reported once by the App's
`CodingPlanUpgradeDialogProvider.openCodingPlanUpgrade` as
`coding_plan_upgrade_ck`, reusing the existing platform telemetry outlet. (The
WebView migration had removed the call from the native panel, leaving the App
entry event missing; page load must not be counted as an entry click.)

```text
user clicks entry -> App reports coding_plan_upgrade_ck (no network wait)
                  -> opens the WebView, injecting the same purchase_funnel_id and entry_plan_list
                  -> the site reports only purchase_*, reusing the entry context
refresh / re-render / login recovery -> not through the entry callback -> no new entry event
```

Each explicit entry call reports once; the same click creates no second funnel id,
and nothing is reported from effects. Internal calls without a funnelContext never
fake a source. Network failures follow the helper's warn-and-swallow semantics —
they never block opening the dialog and are never re-reported by the site.
Desktop reports through IPlatformService; Web/mobile reuse the platform adapter's
existing capability, adding no main/host or realtime state.

Release-order constraint: the site branch that deleted its own entry reporting
must be published before this App change; an old site would double-count with the
App's entry report. Un-upgraded Apps combined with the new site can miss entry
events during the migration window — flag it in the release notes. The site also
keeps `entry_plan_list` on the product, cycle, payment, and result events. The App
injects through `__zcodeReportContext__`, not URL query.

MR !2508 compatibility: an App purchase context with a funnelContext must also
inject `purchase_entry_reporter: "app"`, passed through the existing window,
localStorage, and bridge sync paths and preserved across refresh and login
recovery. Without a funnelContext, do not declare App takeover — that would
suppress the site's legacy entry report. A compatible site reads the marker and
skips its own entry report; an old site that does not recognize it must still be
upgraded or hot-fixed — injecting the marker alone does not remove the duplicate
count for that combination. No new remote switches or platform-reporting changes
are introduced.

Acceptance: one click produces one App entry event with fields matching the
WebView context; a refresh adds none; a second click reports again; exceptions do
not block opening; re-renders and recovery never double-report.

## Reporting outlet

The App-native panel (`CodingPlanPurchasePanel` and
`packages/ui/src/lib/codingPlanPurchaseTelemetry.ts`) has been deleted; there is
no native App reporter for `purchase_pay_ck` / `purchase_result` anymore — the
purchase-process events are reported entirely by the site's webview page (relying
on the funnel context the App injects via `__zcodeReportContext__`).

The site reaches the same event gateway through `ReportService.report(...)`.
The current primary outlet:

```text
https://zcode.z.ai/api/v1/event/report
```

Historical requirement copy mentioned the misspelling `/evnet/report`. Confirm
the final gateway path with the server before launch; until the server switches
explicitly, the client keeps the existing `event/report` capability rather than
bypassing the unified telemetry outlet for one business event.

The Web fallback is a no-op; Desktop auto-fills `device_mid`, `app_version`,
system, screen, language, and timezone. The UI helper builds business fields only
and swallows reporting exceptions so it never blocks the payment flow.

## Event fields

`eventExtraDetail` values must all be strings; empty values are empty strings —
never `undefined` / `null`.

Common fields:

| Field | Meaning |
| --- | --- |
| `purchase_funnel_id` | funnel id shared from entry through the purchase flow; prefer the App WebView-injected value |
| `entry_plan_list` | plans the user already had when entering the flow; dynamic keys, comma-joined |
| `purchase_attempt_id` | UUID shared by the click and the result |
| `purchase_audience` | `personal` / `team` |
| `provider_family` | `bigmodel` / `zai` / `unknown` |
| `channel` | BigModel defaults to `MaaS`, Z.ai to `Z_AI` |
| `product_id` | current product id |
| `product_name` | display or backend name |
| `plan_tier` | `lite` / `pro` / `max` / `team_standard` / `team_advanced` / raw value |
| `billing_period` | `month` / `quarter` / `year` / `unknown` |
| `purchase_method` | `continuous` / `one_time` / `unknown` |
| `payment_method` | method of the final submitted payment: `alipay` / `paypal` / `stripe` / `unknown` |
| `seat_count` | team seats; empty for personal |
| `duration_months` | team one-time purchase duration; empty for personal and continuous |
| `currency` | backend or product currency |
| `cashAmount` | personal: single-product preview `cashAmount`; team: trial calculation `balanceDeductAmount` |
| `giveAmount` | personal: single-product preview `giveAmount`; team: trial calculation `giveDeductAmount` |
| `thirdPartyAmount` | personal: single-product preview `thirdPartyAmount`; team: trial calculation `thirdPayAmount` |
| `refundAmount` | personal: single-product preview `refundAmount`; empty when the team API has no field |
| `residualAmount` | personal: single-product preview `residualAmount`; empty when the team API has no field |
| `totalOriginalAmount` | team trial-calculation original order price; empty for personal |
| `campaignDiscountAmount` | team trial-calculation campaign discount; empty for personal |
| `totalPayAmount` | team trial-calculation post-discount payable total; empty for personal |

The ambiguous `amount` is no longer reported. Amount fields keep the backend's
composition semantics — never pass `payAmount` off as `thirdPartyAmount` and never
derive missing amounts client-side. Numbers become two-decimal strings; an
explicit zero is `"0.00"` and an absent field is an empty string.

### Amount snapshot timing

```text
personal pay/preview / team order/calculate
  -> freeze the Amount snapshot for this purchase
  -> purchase_pay_ck
  -> submit payment and poll for the terminal state
  -> purchase_result reuses the same Amount snapshot
```

A team payment-success order status response carries no amounts. The team flow
must freeze `totalOriginalAmount` / `campaignDiscountAmount` / `totalPayAmount` /
`giveDeductAmount` / `balanceDeductAmount` / `thirdPayAmount` after a successful
`order/calculate` and never recalculate after payment succeeds.

Result fields:

| Field | Meaning |
| --- | --- |
| `failure_stage` | failure stage; empty on success |
| `error_code` | stable error code; empty on success |
| `error_message` | normalized short error text; uploading HTML, schema, tokens, card data, or other sensitive content is forbidden |
| `order_status` | raw backend payment status; success normalizes to `SUCCESS`, timeout to `TIMEOUT` |
| `biz_id` | personal payment check id |
| `order_no` | team order number |
| `elapsed_ms` | time from clicking continue-payment to reporting the result |

## Result mapping

`purchase_result` has no separate `result` field; the outcome is expressed by
`order_status` + `error_code`:

| error_code | failure_stage | order_status | Flow | Meaning |
| --- | --- | --- | --- | --- |
| empty string | empty string | `SUCCESS` | personal / team | payment succeeded |
| `create_sign_failed` | `create_sign` | `FAIL` | personal BigModel | first-purchase signing failed |
| `update_sign_failed` | `update_sign` | `FAIL` | personal BigModel | plan-change signing failed |
| `paypal_setup_failed` | `paypal_setup` | `FAIL` | personal Z.ai | PayPal setup failed |
| `paypal_subscribe_failed` | `paypal_subscribe` | `FAIL` | personal Z.ai | PayPal subscribe failed |
| `stripe_pay_failed` | `stripe_pay` | `FAIL` | personal Z.ai | Stripe payment failed |
| `create_order_failed` | `create_order` | `FAIL` | team | order creation failed |
| `continue_order_payment_failed` | `continue_order_payment` | `FAIL` | team | continuing a pending order failed |
| `payment_status_failed` | `terminal_status` | `FAIL` | personal / team | backend failure terminal state |
| `payment_status_closed` | `terminal_status` | `CLOSED` | team | backend closed terminal state |
| `payment_status_cancelled` | `terminal_status` | `CANCELLED` | personal / team | cancelled terminal state |
| `payment_check_timeout` | `timeout` | `TIMEOUT` | personal / team | polling timed out |
| `user_cancelled` | `user_cancel` | `CANCELLED` | personal / team | the user closed or went back, ending the attempt |
| `unknown_error` | `unknown` | `FAIL` | personal / team | unclassified exception |

The purchase security check is a `pay/preview` pre-validation. Only when the
preview succeeds and the payment-submission chain is entered are
`purchase_attempt_id` generated and `purchase_pay_ck` reported; a user canceling
the security check therefore reports no `purchase_result`.

## Verification requirements

- Clicking continue-payment reports `purchase_pay_ck` exactly once.
- The click and the result of one purchase share `purchase_attempt_id`.
- User cancel, closing the payment dialog, payment failure, and polling timeout
  all report `purchase_result`.
- `purchase_pay_ck` and its `purchase_result` must carry the same
  `payment_method`.
- `purchase_pay_ck` and its `purchase_result` must carry the same Amount
  snapshot.
- `eventExtraDetail` no longer contains `amount`.
- Missing amounts and explicit zeros report as empty string and `"0.00"`
  respectively.
- Successful flows have empty `error_code`, `failure_stage`, `error_message`.
- Team orders carry `order_no`; personal flows carry `biz_id`; never mixed.
- Reporting failures only log a warn and never affect UI or payment state.

Known limitation: production dual-end gateway reception, Windows/Linux, and real
mobile devices are not yet regression-verified.

## entry_plan_list snapshot semantics

`entry_plan_list` means all plan connections the user currently holds, not the
clicked card. The unified purchase entry aggregates BigModel/Z.ai Start Plans,
personal plan entitlements, and subscribed=true team products from authenticated
pricing. Inactive-but-valid connections are included; unpurchased, expired,
plain API keys, and custom providers are never faked as plans. Entries are
classified by each snapshot's owning provider/team identity, not by the entry's
entry_plan_status for the whole list. Deduplicate and sort stably. The entry's
source/status/level still describe the click position and are not overwritten by
other plans.

```text
existing entitlement hooks (per-provider caches) + authenticated team subscription query
  -> all known valid plans -> dedupe and sort
  -> explicit purchase entry freezes the snapshot -> App reports and injects the same list into the WebView
  -> later entitlement refreshes never modify an already-open funnel
```

Reuse the existing query/cache capabilities: no new business cache or persisted
state, and no dependence on the currently selected connection. The purchase entry
must wait until all queries of the round complete successfully — partial results
never pass. Unconfigured sources are not queried; a no_plan from a configured
source is a successful empty result, while an exception or missing snapshot is
not an empty list. The unified state is held by useCodingPlanEntryPlanList, the
Provider also guards clicks, and all buttons/menus read the same state. While
querying, entries are disabled with a loading hint; a query failure shows the
entry as “套餐查询失败，重试” — retry only refreshes the data, never auto-opens
the purchase page or reports an entry. After full success, the user must click
explicitly again. An account or connection change immediately invalidates old
results; old async responses never admit a new query round; already-open funnels
are not changed by background queries. Desktop/Web use the same aggregation; the
continuous/replayable and remote-control host boundaries are unchanged. The site
reporting protocol is unchanged and still receives `entry_plan_list` as a string.

Button gating (MR !2508 follow-ups, implemented):

- SG-01: when an unpurchased snapshot exists and single-card login/sync is still
  pending, Subscribe stays disabled and shows the same spinner as Upgrade; the
  spinner is removed on completion. Global inventory loading/error copy keeps
  priority; gate and retry semantics are unchanged. Desktop and mobile share the
  component, theme, and translations.
- SG-02: the entry builder builds only source, plan status, and the funnel id;
  entryPlanList starts empty. The Provider fills in the unique all-connections
  snapshot from an explicit click after all queries succeed. The old list builder
  that inferred audience from English names (and its parameters) is deleted.
- SG-03: per user decision, the existing proactive query is kept; query timing
  and caching are unchanged.

```text
single-card sync -> Subscribe disabled + spinner -> restored when sync completes
entry context (list pending) -> Provider full snapshot -> App report + WebView injection
```

Acceptance: holding Start Plan + Lite simultaneously reports the same list from
both entries; team products are classified explicitly by team; unsubscribed team
items and expired items are excluded; duplicates dedupe; switching entries does
not change the list; App and WebView fields match. During slow responses, none of
the settings card, personal/team purchase banners, avatar menu, session quota,
Start usage, and off-peak purchase entry can open the purchase page. A failed
retry only reads plans and emits no entry event; only after full success does a
click produce one App event with the complete list. State chain: account/
connection change -> loading -> ready or error -> retry -> loading; a confirmed
no-plan also enters ready. The Provider is the entry's single execution point —
no waiting click queue, no auto-replay of intercepted clicks. Development logs
use UI logger.debug with `[purchaseTelemetry] 套餐入口查询状态` and never output
credentials.
