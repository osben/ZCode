# Model Provider Coding Plan

Model Providers separate manual API Key access from account-based Coding Plan access.

## Entries

- `Z.AI - API Key` and `BigModel - API Key` keep the existing provider form: API Key, endpoints,
  models, model mappings.
- `Z.AI - Coding Plan` and `BigModel - Coding Plan` are independent entries using their own
  `*-coding-plan` provider credential to query the usage quota entitlement API and derive whether
  the account has Coding Plan access.
- Provider ids are intentionally separate:
  - `builtin:zai` => `Z.AI - API Key`
  - `builtin:zai-coding-plan` => `Z.AI - Coding Plan`
  - `builtin:bigmodel` => `BigModel - API Key`
  - `builtin:bigmodel-coding-plan` => `BigModel - Coding Plan`
- The provider sidebar groups presets into provider cards: `Z.AI`: `Coding Plan`, `API Key`;
  `BigModel`: `Coding Plan`, `API Key`.

## Coding Plan States

- Not connected: the matching Coding Plan provider is not configured; the page shows the
  lightweight account connection card and vertical Lite / Pro / Max plan cards.
- Connected but not subscribed: provider configured, but the quota entitlement API returns
  `no_plan` or no usable plan data; the page keeps the plan cards and shows only the subscribe
  action.
- Subscribed: provider configured and the API returns subscription or quota data; the page shows
  name, Coding Plan status card, endpoints, models, model mapping — no API Key or Connection Mode
  fields.

Status refreshes after provider load, manual refresh, and saving `builtin:zai-coding-plan` or
`builtin:bigmodel-coding-plan`. Users who need to paste a key manually use the API Key entries.

While an entitlement refresh is in flight, the settings page keeps the existing valid paid Coding
Plan quota snapshot for that provider — matching the sidebar usage entry: cached valid entitlement
stays the visible state until the background refresh returns, never temporarily falling back to
Start Plan or an empty checking state.

Manual refresh in Model Provider settings is an account entitlement refresh, not just a provider
catalog refresh: it must refresh OAuth-derived Coding Plan API keys, personal Coding/Start
entitlement snapshots, and authenticated Team Plan pricing/customer project data — covering users
added to or removed from a team and team purchases completed while the app is open.

The purchase success page keeps a single `Done` action (no separate immediate refresh button).
`Done` runs the outer purchase-complete refresh chain, then closes the panel; that chain makes the
new personal or Team Plan entitlement visible in Model Provider settings.

## Pricing Cards

- Provider-specific catalogs: Z.AI USD Coding Plan; BigModel CNY GLM Coding. BigModel wording is
  not reused from the Z.AI catalog.
- Visible periods: `Monthly`, `Quarterly`, `Yearly`. Non-monthly periods show the billed period
  amount plus the monthly equivalent.

## Signed-out Purchase Choice

When BigModel account-based access is disconnected, the purchase choice banners show For
Individuals and For Teams entries before the full purchase panel opens. Each entry includes the
same price hierarchy as the plan list, between title and description:

- For Individuals: `¥49.00 人民币 起`
- For Teams: `¥598.00 人民币 起`

Amounts reuse the shared Coding Plan amount formatter so all locales keep the same currency
semantics as the package list.

When `client/configs.codingPlanBillingDiscount` is active, the activity is announced by the
purchase panel banner and upgrade action only:

- The settings Plan Card title shows no separate 150% quota badge; the banner is the single source
  of campaign promotion.
- The compact Coding Plan usage panel inside a conversation renders no 150% badge — it prioritizes
  quota values, reset timing and reset actions; promotion stays on Model Provider and purchase
  surfaces.
- The signed-out banners are acquisition entries, not Plan Card status: the signed-out For
  Individuals and For Teams entries both show the compact 150% badge next to the title. Logged-in
  not-subscribed and logged-in enterprise team group entries do not.

When Z.ai account-based access is disconnected with no Start/Coding entitlement yet, the same
signed-out surface shows only the Start entry (when `startPlanPreview` exists) and For Individuals;
For Teams is hidden for Z.ai.

The purchase panel follows the same boundary: when the selected provider does not support For Teams
(e.g. Z.ai), it renders the Individuals plan content directly without Individuals/Teams audience
tabs, and the no-tabs branch still fills the panel body height so plan cards keep the stretched
layout of the tabbed BigModel view.

When disconnected, clicking For Individuals or For Teams starts the provider login flow first; the
full purchase panel opens from these entries only after the provider has an authenticated,
not-subscribed purchase token.
