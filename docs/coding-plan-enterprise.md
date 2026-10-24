# Enterprise coding plan integration

## Scope

The BigModel coding plan purchase panel in Settings switches between
`Personal / Team`. The personal page keeps the personal Coding Plan purchase-panel
state machine; the Team page reuses the same panel and runs the enterprise purchase
loop as `planSelect -> billingCycleSelect -> paymentConfirm -> payment -> success`,
no longer opening the old secondary confirmation and QR dialogs.

## Enterprise page rules

- Product sources:
  - `planSelect`'s team list shows only base plan cards, reading public pricing:
    `GET /campaign/partner/enterprise/pricing`
  - `billingCycleSelect` (plan configuration) enters the purchase flow and re-reads
    logged-in pricing for the same `tier`:
    `GET /subscription/enterprise/v2/pricing`
  - Plan configuration has no public-endpoint fallback; on logged-in pricing
    failure it shows loading/error and must not reuse the list page's public data.
- Tiers display as returned by the API; the frontend does not restrict the visible
  set of `LITE` / `PRO` / `MAX`.
- `subscribePeriod` still maps to monthly/quarterly/yearly groups; a quarterly
  return may be displayed, but the UI does not invent a quarterly entry.
- `subscribeMode` is shown as the purchase method:
  - `CONTINUOUS`: 连续包月 / 连续包年
  - `ONE_TIME`: 按月采购
- One-time yearly products are no longer sold; the frontend must filter
  `ONE_TIME + YEARLY` — not shown and not selectable even if the API returns it.
- The right-side purchase-method switch dedupes by `subscribeMode +
subscribePeriod`; button labels use only the API-provided `purchaseMethodName`;
  display order is fixed as 连续包月, 连续包年, 按月采购. On desktop width the three
  options sit in a row; narrow screens wrap adaptively.
- Plan configuration layout is fixed: plan seats, service method, balance
  deduction, continue payment; when neither grant credits nor cash balance has
  usable data, or both are unselectable, hide the balance-deduction area.
- Plan seats merge the step-1-selected Team Standard/Team Advanced, the API price,
  and the seat count: plan name and per-seat monthly price on the left; a
  seat-count stepper input with an input-box boundary on the right, using a corner
  radius one size smaller than the plan cards. The configuration page offers no
  plan switching — the user must go back to step 1 to change plans. No locally
  hard-coded entitlement copy is shown.
- Seat count ranges `2~10000`, default `2`. Manual input is allowed and not
  intercepted while typing; validation happens on blur — below the minimum snaps
  back to `2`, above the maximum to `10000`, and empty or non-numeric reverts to
  the previous valid value.
- Service method shows 连续包月, 连续包年, 按月采购 by `subscribeMode +
subscribePeriod`; yearly plans show a renewal-discount badge when one exists.
- The `ONE_TIME + MONTHLY` purchase duration always shows at the right of the same
  row as the "按月采购" tab, as a small ghost dropdown — visible even when 按月采购
  is not selected. Only `1 / 3 / 6 / 12` months are allowed, default `1`. The
  dropdown trigger shows only the current month; changing the month while 按月采购
  is unselected also selects it, and the chosen `duration` joins the trial
  calculation and ordering. Arbitrary month input is not allowed, and the duration
  control is not shown separately below the service-method options. The
  12-month 10%-off promotion is not live yet; its menu/title badge stays hidden
  until launch.
- The auto-renewal authorization copy on the right of the service method shows
  only when `CONTINUOUS` is selected; not for `ONE_TIME` 按月采购.
- The plan configuration page reads `GET /subscription/enterprise/v2/balance` and
  lets the user choose whether to use grant credits and cash balance. The frontend
  passes the selected available amounts to the trial calculation; actual deduction
  follows the returned `giveDeductAmount` and `balanceDeductAmount`. When neither
  grant credits nor cash balance is usable, clear the selected deduction state so a
  hidden panel cannot leak the old selection into trial calculation or ordering.
- The "去充值" link next to the cash balance opens the BigModel finance center:
  `https://bigmodel.cn/finance-center/finance/pay`.
- The continue-payment area wraps the configuration summary and the continue
  button in one square-cornered bottom-docked container. When floating, a divider
  shows at its top; when scrolled back to natural position, the divider hides. The
  container always stacks vertically: configuration summary and price above, the
  full-width continue button below, so amount and button keep a stable tap area on
  desktop and narrow screens. The summary's left side shows "plan · service method
  · seats · one-time duration", for example “团队标准版 · 按月采购 · 2 席 · 1月”, in
  normal body color; the right-side amount uses the plan-card price format — the
  amount large, the currency and “起” small — preferring the trial calculation's
  `thirdPayAmount`. While calculating, show “试算中”; without a result, compute a
  placeholder from the current unit price, seats, and duration.
- The confirm-payment page matches the personal confirm page style, stacked as
  amount card, agreement checkbox, continue-payment button, with the same `px-3`
  inset as the personal page on both sides of the agreement area; the button is
  not separately docked; Team shows fixed content only. The amount card's top shows
  the purchased plan (the step-1 Team Standard/Team Advanced); the amount details
  are fixed in order: seat count, service method, original order price, discount,
  divider, actual payment; original price takes `totalOriginalAmount`, discount
  takes `totalOriginalAmount - totalPayAmount`, actual payment takes
  `thirdPayAmount`, with the amount format matching the plan list cards. Payment
  requires checking “团队套餐购买协议”; the agreement links to
  `https://docs.bigmodel.cn/cn/terms/subscription-agreement-team`.
- The payment success page uses one summary-card style for personal and Team.
  Personal shows plan, service method, service period, actual payment, and status;
  Team shows plan, seat count, service method, service period, actual payment, and
  status. A Team one-time purchase's service period shows as "count + period
  unit", for example `3月`; continuous subscriptions show “每周期自动续费”. The
  payment amount takes the actual third-party payment amount from the payment
  confirmation context, formatted like the plan-card amounts.
- When a Team plan card is clicked, pending orders must be queried first. Without
  a pending order, plan configuration opens normally; with one, a dialog says
  “您有一笔尚未支付的订单，是否继续？” with “取消订单” and “继续支付”. “取消订单”
  calls the cancel API and then enters the configuration for the plan just
  clicked; “继续支付” goes straight to the confirm page showing the pending
  order's product, seats, and amount, and finally calls the continue-payment API
  for the QR code — no new order is created.
- After a Team order enters the payment page, if the user returns to the confirm
  page and then clicks back to plan configuration, the pending-order prompt must
  appear — no silent return to configuration. Choosing “取消订单” calls
  `POST /subscription/enterprise/v2/order/{orderNo}/cancel` and, on success, cleans
  the current order-recovery state and returns to configuration; choosing
  “继续支付” stays on the confirm page, and the next continue-payment reuses the
  already-created order instead of creating a new one.

## Purchase loop

Enterprise purchases default to 2 seats; `ONE_TIME` defaults to a 1-month
duration. Plan configuration does not use balance/grant deduction by default; once
the user enables it, the trial calculation and the order carry the corresponding
`giveAmount` and `balanceDeductAmount`.

Flow:

1. On selecting a team plan, first call `GET /subscription/enterprise/v2/orders/pending`.
2. Without a pending order, enter plan configuration and read grant credits and
   cash balance via `GET /subscription/enterprise/v2/balance`.
3. Trial-calculate with `POST /subscription/enterprise/v2/order/calculate`.
4. After the user confirms, place the order with `POST /subscription/enterprise/v2/order`.
5. The order echoes `totalOriginalAmount`, `totalPayAmount`, and `thirdPayAmount`
   from the trial calculation, plus the `giveAmount` and `balanceDeductAmount`
   used.
6. With a pending order, show the prompt dialog; choosing “取消订单” calls
   `POST /subscription/enterprise/v2/order/{orderNo}/cancel` and enters plan
   configuration.
7. Choosing “继续支付” goes directly to the confirm page using the pending order's
   `productId` and `seatCount`; after confirmation it calls
   `POST /subscription/enterprise/v2/order/{orderNo}/pay`, whose response matches
   order creation.
8. After a newly created order enters the payment page, returning to the confirm
   page and then clicking back to configuration shows the prompt; canceling the
   order returns to configuration, continuing payment stays on the confirm page
   and reuses the created order.
9. The payment QR content prefers `payUrl`; `alipayJumpSchema` is only a fallback
   for mobile direct Alipay jumps, never the first choice for PC QR scanning.
10. Poll payment status with `GET /subscription/enterprise/v2/order/{orderNo}/status`.
11. `SUCCESS` means paid; `FAIL`, `CLOSED`, `CANCELLED` mean failed or closed.
12. On success, refresh enterprise pricing and the personal Coding Plan
    entitlement snapshot.

## Purchase telemetry amounts

Team purchases use one frozen trial-calculation amount snapshot for both
`purchase_pay_ck` and `purchase_result`, preserving all Amount semantics from
`order/calculate`:

- `totalOriginalAmount` takes `totalOriginalAmount`.
- `campaignDiscountAmount` takes `campaignDiscountAmount`.
- `totalPayAmount` takes `totalPayAmount`.
- `giveAmount` takes `giveDeductAmount`.
- `cashAmount` takes `balanceDeductAmount`.
- `thirdPartyAmount` takes `thirdPayAmount`.
- The team API provides no `refundAmount` / `residualAmount`; both report empty
  strings.

A successful order status response carries no amounts; the result event must reuse
the snapshot frozen before payment and never re-calculate after success. A
historical pending order can only confirm `pendingOrder.amount`, recorded as
`thirdPartyAmount`; other unconfirmable amount fields stay empty strings.

## Not included yet

The first version does not implement subscription cancellation/renewal
restoration/renewal, a full pending-order list page, or enterprise member seat
management, and does not support manually entering balance or grant deduction
amounts. The team purchase entry only handles the interception, cancellation, and
continue-payment recovery of a single pending order.
