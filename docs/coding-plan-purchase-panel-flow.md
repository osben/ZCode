# Coding Plan purchase/upgrade page flow

## Background

The family provider detail page presents Z.ai / BigModel as user-visible provider
families while still resolving runtime targets by API Key / Start Plan / Coding
Plan provider id. Buying or upgrading a Coding Plan must happen inside the current
family provider context — no jumping to a standalone settings page or external
page that loses the provider context.

The purchase/upgrade entry comes from the family provider's Plan Card:

```text
┌──────────────────────────────────────────────────────────────┐
│ Pro                                      Coding Plan   [on]  │
│ Renews Jun 30, 2026 · Manage · Upgrade                      │
│                                                              │
│ 5h usage             1w usage             Total tokens        │
│ 12.4k / 50k          83k / 500k           1.28M               │
└──────────────────────────────────────────────────────────────┘
```

Clicking `Buy plan` / `Upgrade` / `Change plan` opens the purchase page. The page
is still opened and closed by the family provider detail page, but it is no longer
a centered dialog: it is a page surface covering the settings content and carries
the full Pricing / Plan / Payment state machine without step indicators.

## Goals

- The purchase/upgrade flow stays inside the current provider family detail page
  context — no external navigation, no losing the current family.
- The purchase page shows no step copy like `Step 1/4`; users see only the current
  page title, back, and close.
- The purchase page header is not sticky: it scrolls naturally with the content
  and has no extra top margin; back/close icon buttons use `size-8` and
  `rounded-xl`; there is no fixed bottom footer — page actions live in the content
  area.
- The flow has five states: select plan, select cycle, confirm payment, payment,
  payment success.
- `Personal` and `Team` stack vertically on the plan page instead of using tabs;
  each still enters its own downstream purchase path.
- Payment success and entitlement sync success are two distinct states; the
  success page must be able to express "payment succeeded, entitlement still
  syncing".
- The team plan success page must prompt member assignment: title
  “团队套餐需要分配成员”, body “请先在 BigModel 团队套餐管理页添加自己或其他成员，完成后即可在 ZCode 使用团队额度。”
  The info card offers a “管理团队套餐” entry that opens the BigModel team plan
  management page.
- Closing exits the purchase flow; closing the success page also triggers an
  entitlement refresh.

## Non-goals

- No new provider ids. Runtime identity still uses the existing
  `builtin:zai-start-plan` / `builtin:zai-coding-plan` / `builtin:bigmodel-start-plan`
  / `builtin:bigmodel-coding-plan`.
- Team plans are not forced into the personal payment flow. Teams may later involve
  seats, organizations, invoices, and enterprise payment and should be modeled
  separately.
- No promo badges in family provider navigation, headers, or positions without
  clear plan semantics.
- The existing BigModel Alipay and Z.ai Stripe / PayPal backend protocol is
  unchanged. The Z.ai Coding Plan flow no longer shows a PayPal entry; the existing
  PayPal capability is kept for old-version protocol compatibility.

## State machine

```text
purchasePanel.closed
  -> purchasePanel.planSelect
  -> purchasePanel.billingCycleSelect
  -> purchasePanel.paymentConfirm
  -> purchasePanel.payment
  -> purchasePanel.success
  -> purchasePanel.closed
```

Back and close rules:

- `planSelect`: close only; closing exits the flow.
- `billingCycleSelect`: back goes to `planSelect`; close exits the flow.
- `paymentConfirm`: back goes to `billingCycleSelect`; close exits the flow.
- `payment`: back goes to `paymentConfirm` and cancels the current payment state;
  close exits the flow.
- `success`: no back, close only; closing exits the flow and refreshes
  entitlements.

Closing the panel must not modify the saved provider family mode. Plans/cycles
chosen inside the panel but not yet paid for live only in panel-local state.

## Entry copy

The Plan Card shows a different primary action by current entitlement state:

- No paid entitlement: `Buy plan`
- Start Plan: `Upgrade`
- Paid entitlement with a higher tier available: `Upgrade`
- Paid entitlement whose main action is changing plan or cycle: `Change plan`

The current plan status shows inside the plan card content, not only in button
copy; if the current plan still has a higher cycle available, the card still
allows entering the cycle page. Subscribed users cannot enter a lower-tier plan,
or a same-tier plan with no higher cycle, from the plan page.

The plan entry banner in the family provider detail page differs by provider:
BigModel when unconnected or without entitlements may show Start/personal/team
entries to help choose the domestic personal or team purchase path; Z.ai when
unconnected or connected without entitlements shows Start (only when a remote
preview exists) and personal plan entries, but no team entry. Z.ai has no team
purchase entry.

## Page frame

The flow uses a page-level overlay, not a centered dialog or side sheet. The
overlay's `open` state is controlled by the provider detail page entry; closing
returns to the original detail page position. This turns the purchase experience
into a page while keeping the family provider's auth, current plan, and
entitlement-refresh context. The shared structure:

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back              Pricing / Page title                 ×   │
├──────────────────────────────────────────────────────────────┤
│ Page content                                                 │
│ Page actions live inside the content area                    │
└──────────────────────────────────────────────────────────────┘
```

The initial `planSelect` screen shows no back button and no extra Pricing notes or
More Info external links. The success page shows no back button.

Layout constraints:

- Desktop and wide Web use a full-page overlay; the root container uses
  `bg-background` and `pt-12` and does not itself scroll; an inner scroll wrapper
  carries the header and content; the content area uses `max-w-5xl`, centered.
- Mobile uses the same page overlay with plan and cycle cards in one column; the
  header is likewise not sticky.
- The fixed `48rem x 32rem` frame for planSelect is gone: plan select, personal
  cycle select, and personal payment confirm render at their natural content
  height without forcing full-page fill; immersive or sticky-action states
  (payment, team configuration, success) may still use the remaining height. The
  team configuration's sticky bottom action area uses `bg-background`, and its top
  border only switches color without changing the border box model, avoiding page
  jitter when switching between continuous and one-time purchase. The team
  configuration's service-method title row keeps the auto-renewal authorization
  copy placeholder; switching to one-time only hides the copy without changing the
  row height.

## Page 1: select plan

The plan page shows no extra Pricing notes or More Info links. Content lays out in
order: campaign banner, `For Individuals`, Start Plan card, personal plan list,
`For Teams`, team plan list — no audience tabs; team plans enter the team/enterprise
page and do not reuse the personal cycle and payment pages. Section titles use a
larger size than card titles to form page-level grouping.

The first screen carries only selection actions — no explanatory titles or long
descriptions. Plan cards use a fixed information hierarchy: plan name, current
plan status, starting price, usage quota with the 150% campaign banner icon,
divider, key benefits list, full-width rounded bottom button. The plan name uses
normal body size with medium weight; the price uses a larger size as the visual
anchor; for Chinese prices only the amount itself enlarges, for example `¥49.00`,
with the amount black in light and white in dark, while `人民币 起` stays normal
size in a dimmer text color. Plan cards show no selected state and do not respond
to whole-card clicks; only the bottom button advances. The current plan status is
a badge inside the card, not only in the button; if the current plan still has a
higher cycle available, the button stays an upgrade entry, otherwise it is
disabled. Plan select cards use product marketing copy and do not reuse payment
API entitlement fields; API entitlements and prices remain authoritative on the
cycle page, payment page, and backend preview. BigModel personal plan cards always
show Chinese to match the domestic purchase scenario; Z.ai personal plan cards
always show English to match the overseas scenario. Whether Start Plan shows is
decided by the remote `startPlanPreview`: shown when the preview exists, hidden
when it is off or missing; the Start Plan title prefers the remote `name`.
BigModel's summary quota next to the star icon and the benefit-list values come
from remote `entitlements`; the frontend fixes only the Chinese formatting: the
summary shows `GLM 模型每日 500万 tokens`, and the benefit list shows
`GLM-5.2 每日 300万 tokens` and `GLM-5-Turbo 每日 200万 tokens`; only when the
remote fields are missing does it fall back to local provider copy. The Z.ai Start
Plan card also builds its summary and benefit list from remote `entitlements`,
with the frontend fixing only the English format: summary shows
`5M GLM tokens daily`, and the benefit list shows `GLM-5.2 · 3M tokens daily` and
`GLM-5-Turbo · 2M tokens daily`; the local provider fallback for missing remote
fields uses the same English copy. When the current Start entitlement is valid it
is marked current; when the user is logged in but has no valid Start entitlement,
only the status badge and button mark it expired — no status note next to the star
icon, and the expired state does not lower the whole card's opacity, so the
benefit list never looks disabled. BigModel and Z.ai use separate copy sources;
BigModel's Alipay/agreement copy and Z.ai's PayPal/Stripe/overseas subscription
copy are never shared.

The 150% quota campaign info dialog takes `infoTitle` and `infoBody` from the
current-language node of the remote `codingPlanBillingDiscount`; `infoBody` uses
Markdown. The frontend keeps no local campaign-rules body; if either field is
missing, the info entry is not shown, avoiding stale or incomplete rules.

Only the `unavailable` status changes display semantics in plan select: the button
label uniformly shows “立即订阅” but stays disabled, and hover or keyboard focus
shows “当前套餐不可购买，查看详情”; “查看详情” must be an actionable link, with
4px spacing between tooltip and button. Z.ai opens `https://z.ai/subscribe`;
BigModel opens `https://bigmodel.cn/glm-coding`. The disabled button receives
tooltip events through a focusable wrapper; other disabled states (current plan,
already included, sold out, subscription service busy) keep their existing copy
and behavior. Personal and team plans share these unavailable rules.

On wide screens the plan cards spread horizontally inside the content area, with
Start Plan as the first card of the personal section; the personal section's
responsive column count goes `4 -> 2 -> 1` from wide to narrow: one column below
`xs`, two from `xs` (480px), four from `md`. Breakpoints switch the column count
early without capping card width, letting cards fill the content area naturally.
Paid plan cards share equal height but do not force-fill the page; Start Plan is
the free tier, showing only benefits and current/previously-held status and never
entering the personal paid cycle and payment flow. Team plans render as many cards
as the remote returns; the team section uses a fixed 4-column grid on wide screens
— with only 2 team plans, only the first two columns show cards and the rest stay
empty. Team cards show no hover or selected visual state; clicking goes straight
to the team configuration page. Narrow screens keep scrolling at natural content
height. Plan cards use `bg-card` to separate from the page background.

```text
┌──────────────────────────────────────────────────────────────┐
│ Pricing                                                  ×   │
├──────────────────────────────────────────────────────────────┤
│ 150% quota banner                                         │
│ For Individuals                                           │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────┐│
│ │ Start Plan   │ │ Lite         │ │ Pro          │ │ Max    ││
│ │ $0           │ │ $20+         │ │ $100+        │ │ $200+  ││
│ │ Included     │ │ Choose       │ │ Current      │ │ Choose ││
│ └──────────────┘ └──────────────┘ └──────────────┘ └────────┘│
│                                                              │
│ For Teams                                                   │
│ ┌──────────────┐  ┌──────────────┐                         │
│ │ Team Pro     │  │ Team Max     │                         │
│ └──────────────┘  └──────────────┘                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

The plan page compares only capabilities and benefits — no month/quarter/year
choice here. Prices may show a soft hint; Chinese prices split visually into a
large amount plus normal-size currency and `起`; English uses `{price}+`, for
example `CN¥49.00+`, the whole segment large, black in light and white in dark;
the real payable amount is authoritative on the cycle and payment pages.

Plan card copy:

| Plan | Chinese short position | Chinese key benefits                                                                            |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| Lite | 基础用量额度           | 适合小型 Repo 轻量级迭代；逐步开放最新旗舰模型及功能；支持多款编程工具                          |
| Pro  | 5x Lite 额度 + Lite 权益 | 适合中型 Repo 日常开发；优先体验最新旗舰模型及功能；覆盖多款精选 MCP 工具；更快生成速度       |
| Max  | 20x Lite 额度 + Pro 权益 | 适合高阶用户中大型 Repo 深度开发；首发接入最新旗舰模型及功能；高峰期专属资源优先保障          |

| Plan | English summary     | English key benefits                                                 |
| ---- | ------------------- | -------------------------------------------------------------------- |
| Lite | Base usage included | Small repo iteration; Latest models over time; 20+ coding tools      |
| Pro  | 5x Lite usage       | Mid-sized repo development; Priority model access; Curated MCP tools |
| Max  | 20x Lite usage      | Mid-to-large repo work; First model access; Peak-time priority       |

### Team section

The team section's core constraint is showing team plan entries directly: a fixed
4-column grid on wide screens, one card per remote team plan, later columns left
empty when fewer than four. Team plans currently serve only the BigModel domestic
purchase scenario — team card names and descriptions are fixed Chinese and do not
switch to English with the app locale; the later team configuration, confirm, and
payment pages keep their own amount formats and flow copy rules. Clicking a team
plan still enters the team's own configuration, confirmation, and payment chain —
never the personal cycle and payment model.

## Page 2: select billing cycle

The cycle page handles only the selected personal plan's billing cycle and shows
no "current plan/new plan" summary row. Personal cycle cards render at natural
content height, equal-height but not forced to fill the page; narrow screens
scroll naturally. Cycle cards use `bg-card`; the cycle title is normal-size
medium. Chinese payable prices keep two decimals and the currency name tightly
attached to the cycle unit, for example `¥538.00 人民币/月`; the amount is large,
black in light and white in dark, while `人民币/月` stays normal size in a dimmer
color; English payable prices keep the whole segment large in black/white.
Original price, price unit, and the second-line note use a dimmer text color; the
monthly second line shows “按月灵活订阅”, and quarterly/yearly show the effective
monthly price. Cycle cards show no selected state and do not trigger purchase —
the right-side badge button is the action entry; if the login state or purchase
token has expired, clicking enters the connect/login recovery flow instead of the
payment page. Subscribed users cannot buy down: for products below the current
tier, or same-tier with a cycle not higher than the current one, the button shows
the existing entitlement/current plan and is not clickable.

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back                         Pro Plan                  ×   │
│ Choose billing cycle                                         │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Monthly                                                  │ │
│ │ $20                                                      │ │
│ │ Flexible monthly billing                                │ │
│ │                                            Subscribe      │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Quarterly                                                │ │
│ │ ¥132.30 人民币  ~~¥147.00 人民币~~ /季                  │ │
│ │ 折合 ¥44.10 人民币/月                                  │ │
│ │                                             Upgrade       │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Yearly                                                   │ │
│ │ $180 / year                                              │ │
│ │                                            Current        │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Effective time, remaining-value deduction, and renewal amounts show only what the
backend preview can confirm. When the backend returns no explicit semantics, do
not write “立即生效” or “下周期生效”.

## Page 3: confirm payment

The confirm page calls `preview({ productId, ... })` for the payment amount
details and shows the provider's renewal/account/agreement confirmations, but
generates no QR code and starts no Stripe/PayPal payment action. The personal
confirm page renders at natural content height. While the preview is loading or
the amounts are unavailable, show only a loading/unavailable notice — no renewal
policy, account rules, agreement confirmation, or continue-payment button. The
user checks agreement and confirms before entering the payment page. The confirm
page shows no extra plan/cycle summary; the amount details are a standalone card
with at least plan original price, campaign discount, current-plan deduction, and
amount due; discount/deduction lines the backend did not return are not shown.
Campaign discount and current-plan deduction collapse by default into one
`抵扣费用` / `Deductions` row showing the total deduction on the right; clicking
expands each campaign and the current plan's remaining value. The BigModel
personal confirm page uses fixed Chinese page title, amount labels, cycles,
renewal policy, account rules, and agreement copy to match the domestic Alipay
signing scenario; Z.ai keeps `overseasPayment.*` copy — terms, deduction channels,
and account rules are never shared. Changing the cycle requires going back one
page; changing the plan requires going back two.

BigModel's renewal policy shows amounts per the selected cycle, but "amount due
now" and "future renewal amount" stay separate. The amount card's due amount is
the preview's current settlement result, affected by first-purchase offers,
campaign discounts, current-plan deduction, grant credits, balance, and
third-party payment splits; the auto-charge amount in the renewal policy may use
only an explicit backend renewal semantic such as `renewAmount`. Without an
explicit renewal amount, do not show a fixed charge — instead say renewal follows
the selected cycle and the actual charge follows the renewal invoice.

- With an explicit renewal amount: `续订将按照「￥{renewAmount}/{月|季|年}」发起自动扣费。`
- Without: `后续将按所选套餐周期自动续费，实际扣费以续费时账单为准。`
- `扣费优先级：优先扣除赠金，再扣余额，再采用支付宝扣费。`
- `{每月|每季|每年}将持续定期扣款，直至您根据我们的服务条款取消服务。`
- `您可在续费日前至少3天，前往「个人套餐概览页」关闭自动续费。`

The BigModel account usage rules render as a collapsible module, collapsed by
default showing the general clause, expanding into restrictions, risk handling,
and refunds:

- 总则：`仅限订阅人在官方许可的产品范围内使用。严禁将账号出借、转让或以任何形式提供给第三方使用，亦不得用于非正当或违反法律法规及平台规则的行为。如发现平台将限制或封禁账号，且不予退款。`
- 专享限制：`套餐仅限订阅人个人在 Coding 工具中使用。若发现账号出现多人使用等异常情形，用于非编程开发、非正当的或违反法律法规及平台规则的用途，将限制账号权益。`
- 风控处置：`违反《用户协议》、《服务协议》、《订阅服务协议》及平台上其他相关规则及约定的，将触发限流或冻结。累计 3 次违规将被永久封禁。`
- 退款说明：`因违规使用导致账号被封禁的，已支付的套餐费用一律不予退款。`

Information below the amount differs by provider:

- BigModel: the Chinese renewal notes and account-rules block from the old Alipay
  payment dialog, plus the bottom 《服务协议》《订阅及自动续费协议》 agreement
  checkboxes; refund text appears only inside the expanded account rules and is
  not repeated in the bottom agreement area.
- Z.ai: fixed-English Renewal Policy, Account Usage Policy, and card/subscription
  authorization checkboxes; even when the app locale is Chinese, the Z.ai confirm
  page and overseas terms stay English.

The Z.ai Renewal Policy likewise never treats the current Amount due as the
future recurring charge. A fixed renewal amount shows only when `renewAmount`
exists; otherwise the fallback copy makes no amount promise.

- With an explicit renewal amount: `{renewAmount} will be charged automatically per {month|quarter|year}.`
- Without: `Future renewals will follow your selected subscription cycle. The actual renewal amount is subject to your renewal invoice.`
- `Payments will be deducted first from bonus credits, then from your account balance, and finally via credit card.`
- `Please note that a small minimum applies when charging your credit card. If the remaining amount is less, we will round up the deduction to meet this minimum.`
- `{Monthly|Quarterly|Yearly} charges will continue on a recurring basis until you cancel in accordance with our Terms of Service.`
- `You may disable auto-renewal at least 1 day before the renewal date in your subscription setting.`

Z.ai Account Usage Policy copy:

- `The GLM Coding Plan is strictly limited to use by the subscriber within officially supported products. Any sharing, resale, transfer, or third-party access is strictly prohibited. Any improper, unauthorized, or policy-violating use may result in immediate account restriction or suspension with no refunds. Please comply with our Terms and Policy.`

Z.ai card/subscription authorization checkbox copy:

- `You agree that Z.ai will charge your card the above amount now and on a recurring basis according to your subscription plan until you cancel in accordance with our [terms](https://docs.z.ai/legal-agreement/subscription-terms).`

The payment page inherits the confirm page's `preview` and does not refetch the
amount details, but it does not show the amount card. It uses the preview's due
amount only in the payment-control copy and continues the payment APIs: BigModel
generates the QR signing content from the same `bizId`; Z.ai shows and submits the
Stripe card form from the same `bizId`.

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back                         Confirm payment           ×   │
├──────────────────────────────────────────────────────────────┤
│ Confirm purchase                                             │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Plan price                   US$54.00                    │ │
│ │ Deductions >                 -US$14.80                   │ │
│ │ Amount due                   US$39.20                    │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ Renewal policy / 续费说明                                    │
│ • Uses provider-specific legacy payment policy copy.         │
│ • BigModel shows Alipay renewal/account/agreement details.   │
│ • Z.ai shows Renewal policy/account policy/card auth terms.  │
│                                                              │
│ ☑ Provider-specific agreement / authorization confirmation.  │
│                                                              │
│                                           Continue to payment│
└──────────────────────────────────────────────────────────────┘
```

## Page 4: payment

The payment page shows the real payment channel and no longer allows changing the
plan or cycle. The BigModel Alipay QR and the Z.ai overseas main checkout must
embed directly in the purchase panel content area — no extra outer card/border
wrapper and no second main payment dialog; only payment-method subflows like
adding/managing a credit card may keep a standalone dialog.

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back                         Payment                   ×   │
├──────────────────────────────────────────────────────────────┤
│ Payment method                                               │
│                                                              │
│ ● Credit Card                                                │
│   Visa ending in 4242                         Change         │
│                                                              │
│ ☑ I authorize recurring billing.                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Z.ai overseas payment keeps the confirm-style checkout, but the payment method
entry shows only Credit Card / Debit Card (Stripe) — no PayPal. Only the UI entry
is removed; the existing PayPal service, deep-link callbacks, and protocol
definitions stay. The actual charge happens after the user clicks `Pay` /
`Confirm`. The Z.ai payment page's `Payment method` title, error hints, and card
content sit directly in the content area with no extra section/card wrapper. The
main buttons of the Z.ai payment page and the add-card subflow match the rest of
the purchase panel: `h-10`, `rounded-full`, `text-ui-base`; saved cards and the
add-card form use `rounded-xl`; the add-card dialog header has no divider.

When the plan page's plan preview returns "system busy", keep the on-page busy
notice, but the Plan Card's primary button still shows “升级” / `Upgrade` and
stays clickable. Clicking must not enter the cycle page with the failed preview;
instead it reuses the original logged-out upgrade flow to log in again. After a
successful login it reopens only the personal plan page — the specific plan
clicked before login is not restored; the user reselects from the refreshed plan
state.

### BigModel Alipay payment

The BigModel Alipay QR is one payment state on the payment page. On wide screens
it uses a left-right structure without an outer card wrapper: the QR and the
right-side copy group center in the dialog's remaining space; the left QR sits in
its own `rounded-xl` container of at most about `24rem`, the QR filling it and the
container height following the image; the right side takes the remaining width
with the subscription plan title, the Alipay scan amount, and the
waiting-for-confirmation state; the content must fill the payment page's remaining
height so the dialog does not scroll. On narrow screens the right-side copy comes
first and the QR follows.

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back                         Payment                   ×   │
├──────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────┐  GLM Coding Pro 连续包月计划 │
│ │                            │                              │
│ │          QR Code           │  [Alipay] 请使用支付宝扫码支付│
│ │                            │            ¥1,412.44 人民币  │
│ │                            │                              │
│ └────────────────────────────┘  正在等待支付确认             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

When the QR expires, stay on the payment page and show a refresh action — do not
fall back to the cycle page.

## Page 5: payment success

Payment success must enter a standalone success page, not just a toast. The
success page confirms the purchase result and covers entitlement-refresh delay.

```text
┌──────────────────────────────────────────────────────────────┐
│ Payment successful                                       ×   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Payment successful                                           │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Current                      Pro                         │ │
│ │ Status                       Active                      │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│                                                    Done      │
└──────────────────────────────────────────────────────────────┘
```

After close / Done:

1. Close the purchase panel.
2. Trigger a Coding Plan entitlement refresh.
3. Refresh the provider registry / the current family provider Plan Card.

### Payment successful but entitlement syncing

Payment success and entitlement sync success are separate. When the payment check
has confirmed success but the entitlement refresh is unfinished or failed, the
success page still shows:

```text
┌──────────────────────────────────────────────────────────────┐
│ Payment successful                                       ×   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Payment successful                                           │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Payment                     Successful                   │ │
│ │ Plan status                  Syncing                     │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│                                      Refresh now     Done    │
└──────────────────────────────────────────────────────────────┘
```

The success page wraps the “支付成功” title in no extra container and shows no
"closing the panel will refresh entitlements" copy. On wide screens the success
content centers vertically in the dialog content area with larger horizontal
padding, separating the “支付成功” title from the status content below. When the
entitlement refresh fails, the payment status must never be changed to failed.
The UI only hints that plan status has not refreshed and offers manual
`Refresh now` or `Done`; `Done` behaves like the top-right close.

## Auth and recovery

When the purchase flow hits OAuth required or an expired business token, the
panel must not become an error page. The current page switches to a connect
state:

```text
Connect Z.ai to continue
```

When an unauthenticated user clicks a personal or team plan on plan select, the
panel must first record the login attempt initiated by this click, then close the
purchase panel and open the unified login page. The login page must not overlay a
still-open purchase panel.

```text
Plan Select (unauthenticated)
  -> record { loginAttemptId, provider, audience }
  -> close Coding Plan purchase panel
  -> open WelcomeScreen / OAuth
  -> OAuth succeeded for the same loginAttemptId
  -> consume pending intent once
  -> reopen Coding Plan purchase panel at Plan Select
```

Only a login attempt from that same plan click reopens the panel automatically.
Canceled, failed, or superseded attempts must drop the pending intent; a normal
successful login must not open the purchase panel. The reopened panel stays on
plan select and restores the personal/team audience, but does not auto-advance to
the cycle or payment page, so an OAuth return never continues a purchase before
the user confirms the latest prices.

Re-authorization after a business token expires on the cycle or payment page
keeps the current page's local selections; that recovery does not use plan
select's close-and-reopen rule. Closing the panel discards the recovery state.

## Responsive constraints

- Desktop: prefer a wide dialog or side sheet with a scrollable content area and
  no fixed footer.
- Mobile Web: a full-screen sheet; plan and cycle cards in one column; payment
  summary and method stacked.
- All buttons and titles must reserve internationalized text length — never rely
  on short English copy.
- Theme colors use existing semantic tokens per `DESIGN.md`; no large brand-color
  backgrounds are introduced for the purchase flow.

## Implementation notes

- Panel states are named `planSelect` / `billingCycleSelect` / `payment` /
  `success` — never UI names like `step1` / `step2`.
- The personal purchase flow is named `personalPlanPurchaseFlow` so a future team
  payment is never forced to reuse personal assumptions.
- Never promise real payable amounts, discounts, deductions, or effective times
  before the backend preview returns.
- Entitlement-refresh failures on the success page log through
  `packages/ui/src/logger.ts`.
