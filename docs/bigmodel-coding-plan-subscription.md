# BigModel Coding Plan subscription purchase integration

## Scope

The BigModel / Z.AI Coding Plan settings-page plan list is driven by `codingPlanStaticProducts` from the remote `GET https://zcode.z.ai/api/v1/client/configs`. The remote config carries plan identity, name, description, period, entitlements, currency, and static price snapshots; real prices, current period, purchasability, sold-out, and disabled states stay authoritative at runtime `POST /pay/batch-preview`.

If `batch-preview` fails, the user is not logged in, or a static `productId` is missing from the response, the list still shows the static plan info and static price snapshot; without a real preview state, clicking subscribe goes through the login/connect flow first — real purchasability is never inferred.

Z.AI Coding Plan reuses the same `/api/biz` protocol set with the host switched to `https://api.z.ai`.

## Plan config

Plan config is grouped by provider and fetched by `codingPlanSubscriptionService.getStaticProducts()` from the ZCode client config. The frontend only does a one-day memory cache, Start free-SKU merging, and `batch-preview` live-state merging; Lite / Pro / Max descriptions are never hard-coded locally:

- `productId`: backend product id, aligned with `batch-preview`, `preview`, and the purchase APIs.
- `productName`: plan name, used for Lite / Pro / Max grouping and card titles.
- `productSmallTitle`: plan subtitle.
- `equity`: plan entitlement summary array, each element `{ text, tooltip? }`, rendered as one starred line.
- `description`: plan entitlement copy array, each element `{ text, tooltip? }`, one line below the divider; consumers keep accepting legacy strings.
- `productEquityList`: optional legacy entitlement structure; new configs no longer require it.
- `priceUnit`: billing period, `month` / `quarter` / `year`.
- `displayOrder`: static ordering field, kept aligned with `/product/info`.
- `priceCurrency`: currency — BigModel `CNY`, Z.AI `USD`.
- `originalAmount`: static original-amount snapshot from `batch-preview`.
- `discountAmount`: static discounted/discount-related amount snapshot, keeping the API's original semantics.
- `payAmount`: static payable-amount snapshot, display reference only.
- `monthlyOriginalAmount` / `monthlyRenewAmount`: static monthly-average snapshots.
- `monthlyPayAmount`: static monthly-average payable snapshot, for quarter/year plans.
- `renewAmount`: static renewal-amount snapshot.

### Data adaptation for the current plan-selection card

`codingPlanStaticProducts` adapts to the existing card information hierarchy and adds no fields for a new layout:

- Keep the two provider groups `builtin:bigmodel-coding-plan` and `builtin:zai-coding-plan`.
- Keep an independent `productId` per Lite / Pro / Max plan per `month` / `quarter` / `year`.
- Plan name stays `productName`, period `priceUnit`, currency and static prices the existing price fields.
- Starred entitlements go to `equity: Array<{ text: string; tooltip?: string }>` — one line for personal plans, up to two for team plans; plain notes below the divider go to the same-shaped `description`. Send `tooltip` when explanation is needed, otherwise omit. New configs do not resend `productEquityList`; string arrays, string `description`, and `productEquityList` stay readable by consumers.
- Copy and static prices follow one data-source principle: when `equity`, `description`, or Start Plan copy is missing, stay empty — never fall back to frontend hard-coded copy.
- BigModel uses Chinese entitlement copy, Z.AI English; the same tier across periods reuses the same copy.
- Personal-plan `description` keeps the full pre-migration card copy (Lite three lines, Pro four, Max three); migrating remote product identity and prices must not overwrite this card copy with the remote simplified description.
- The config never changes card layout, information order, or interactions.

A publishable full response example: [`packages/desktop/test/e2e/fixtures/coding-plan-client-configs.json`](../packages/desktop/test/e2e/fixtures/coding-plan-client-configs.json).

Config fields intentionally align with `/product/info` display fields, but price fields take only same-named `batch-preview` snapshots — not `salePrice` / `originalPrice` product-detail prices — so non-realtime detail amounts are never treated as the real payable price.

### Start Plan config

Start Plan is not a payable SKU and keeps its own `configs.startPlanPreview`, outside `codingPlanStaticProducts` and `codingPlanStaticTeamProducts`. The protocol is provider-neutral; BigModel and Z.AI share one free-quota definition:

- `planId`: Start Plan identity.
- `name`: remote plan name.
- `entitlements`: per-model free quota with `grantUnits`, `meter`, `period`, `showName`, `unitType`.

The card's quota summary and details are computed from `entitlements` (BigModel Chinese formatting, Z.AI English), so no derivable `equity` / `description` is duplicated in the config. Without `startPlanPreview`, no Start Plan renders.

### Team plan config

Static team-plan card data lives in `configs.codingPlanStaticTeamProducts`, grouped by provider like personal plans:

- `builtin:bigmodel-coding-plan`: BigModel team plan array.
- `builtin:zai-coding-plan`: Z.AI team plan array; currently empty and explicitly sent as an empty array.

Each team plan keeps the enterprise pricing's `productId`, `tier`, `subscribeMode`, `subscribePeriod`, purchase method, and static prices, plus the display fields the current card needs:

- `productName`: Chinese display name — `PRO` is “标准版”, `MAX` is “高级版”.
- `equity`: starred quota entitlement objects; the team card uses two lines for the 5-hour and weekly quotas.
- `description`: plain entitlement objects below the divider.

The static team config is the data source for config-service publishing and client static cards; the current enterprise product runtime stays driven by the pricing APIs. With the static fallback in place, purchasability, subscription state, and live prices still follow `/campaign/partner/enterprise/pricing` or `/subscription/enterprise/v2/pricing`, never inferred from static snapshots.

### Test environment

To verify test data locally, start the app with `ZCODE_ENV=test`. The client requests `https://zcode.z.ai/api/v1/client/configs` with `app_version` and `platform` appended automatically. There is no separate client-config mock command or dedicated env var.

## API chain

- BigModel API main domain follows the environment: `https://bigmodel.cn` in production and under `ZCODE_ENV=test`.
- `POST /api/biz/pay/batch-preview`: visible plan prices and purchasability for the current account.
- `GET /api/biz/product/info?productId=...`: manual pull of product display fields for maintaining the static catalog only; the runtime plan list no longer depends on it.
- `POST /api/biz/pay/preview`: trial calculation on plan click, returns `bizId`.
- `POST /api/biz/pay/create-sign`: first purchase or renewal purchase.
- `POST /api/biz/pay/product/update/sign`: plan change with an existing subscription.
- `GET /api/biz/pay/check?bizId=...`: post-payment result polling.
- `GET /api/biz/pay/check-pending-orders`: unfinished-order check before purchase.

Z.AI uses the same paths on `https://api.z.ai` (`/api/biz/pay/batch-preview`, `/api/biz/product/info`, `/api/biz/pay/preview`, `/api/biz/pay/create-sign`, `/api/biz/pay/product/update/sign`, `/api/biz/pay/check`, `/api/biz/pay/check-pending-orders`).

## Authentication

Purchase APIs use the brand's OAuth login state.

BigModel:

```http
Authorization: <oauth accessToken>
Content-Type: application/json
```

Do not add the `Bearer` prefix. `Bearer` is only for model/API-key endpoints, not BigModel `/pay` and `/api/biz` login-state business APIs.

Z.AI:

```http
Authorization: <zai business accessToken>
Content-Type: application/json
```

After a Z.AI login, the OAuth access token is exchanged at `POST https://api.z.ai/api/auth/z/login` for a business token that is persisted directly to `oauth:zai:access_token`. All later `/api/biz/*` and `/api/pay/*` calls read that single persisted business token — no separate cache key, no fallback to the raw OAuth token. Z.AI monitor usage APIs keep using the provider API key's `authorization` header; do not mix the two chains.

## UI behavior

- The avatar menu's "Upgrade" entry follows the currently selected Coding Plan or usage source; in API-key mode with no Coding Plan entitlement to derive from, it must fall back by `providerFamilyDomain`: the BigModel domain shows BigModel plans, the Z.AI domain shows Z.AI plans; cross-brand fallback is forbidden.
- Not connected to BigModel: show the connect entry.
- Connected and loading: show the static plan list with a loading state.
- `batch-preview` load failure: no extra "connect to see plans" card — keep the static list and price snapshots; subscribing enters the login/connect flow.
- `batch-preview` missing a static `productId`: that plan shows its static price snapshot; subscribing enters the login/connect flow.
- Empty static catalog: show the empty state.
- On purchase click, call `preview` first; if the backend returns a security-verification requirement, the official build's security check completes it and retries the same `preview` automatically.
- When `preview`, order trial, or payment APIs return an HTML/WAF page, non-JSON, or unparseable response, the UI never shows the raw response and uniformly shows “系统繁忙，请稍后再试。” (system busy, please try again later).
- After `create-sign` / `update-sign` returns the Alipay `sign`, the UI renders the full `sign` as a QR code and polls `pay/check`.
- After successful payment, refresh Coding Plan entitlements and model provider config.
- Z.AI not logged in or API unavailable: keep the static plan list with static price snapshots; subscribing enters the login flow.
- Z.AI `batch-preview` success: the static list merges the returned real prices and button states and uses the API purchase chain.

## Purchase telemetry

The personal Coding Plan payment chain reports `purchase_pay_ck` and `purchase_result`. `product_name` uses the 「plan name / billing period」 format — `GLM Coding Lite / month` in English, `GLM Coding Lite / 月` in Chinese — with one display rule for BigModel and Z.AI. The plan name prefers the single-item `preview`, falling back to the merged static `productName`, so a missing `productName` in `/pay/batch-preview` never degrades telemetry to `productId`. `billing_period` stays the machine-parseable enum `month` / `quarter` / `year`. Amount telemetry no longer reports a vague `amount`; it freezes the single-item `preview`'s `cashAmount` / `giveAmount` / `thirdPartyAmount` / `refundAmount` / `residualAmount`, with missing fields kept as empty strings and never back-filled from other amounts.

## Z.AI overseas payment confirmation page

Z.AI overseas Coding Plan uses a single-page confirmation checkout; PayPal/Stripe payment actions are no longer attached directly to payment-method buttons.

- The top `Payment` trial area uses amounts from the same `preview`: payable prefers `thirdPartyAmount`, campaign discount comes from `campaignDiscountDetails`, existing-plan residual value prefers `refundAmount` / `residualAmount`, falling back to "original − discount − payable" when missing.
- `Payment Method` only selects the method: PayPal or Credit Card / Debit Card.
- The Stripe card list comes from `/stripe/query`. The main page shows only the selected card and the `Add card` / `Change card` entries.
- `Add card` / `Change card` opens the card-management dialog: pick an existing card, delete a card, or add one via Stripe Elements. Adding a card only calls `/stripe/bind`; it never charges.
- Payment runs only after the user ticks the recurring-charge authorization and clicks `Confirm`: the PayPal branch runs setup/subscribe; the Stripe branch calls `/stripe/pay` with the selected `paymentMethodId`.
- The Stripe publishable key prefers `VITE_ZAI_STRIPE_PUBLISHABLE_KEY`, falling back to the key Z.AI's official payment page exposes publicly, so default builds can render Stripe Elements.
- Stripe.js initializes lazily by overseas-payment state. App startup, resident plan-page rendering, and `overseasPaymentDialog=null` must not load Stripe.js nor create `js.stripe.com` / `m.stripe.network` iframes; initialization is allowed only after the user enters Z.AI overseas payment and `overseasPaymentDialog` is created, so Electron does not spawn extra cross-origin renderer processes before payment.
- Stripe Elements (card number, expiry, CVC) mount only while the card-management dialog is open. Closing the payment flow unmounts the app-side payment components; whether Stripe.js's risk-control iframes persist is up to the Stripe SDK — proactively destroying third-party global state is not the payment flow's job.
