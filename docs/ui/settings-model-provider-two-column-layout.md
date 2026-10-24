# Settings Model Provider Two-Column Layout

`ModelProviderSection` uses a two-column structure of left navigation + right detail, scrolled vertically as a
whole by the right-hand Settings page.

## Content Height and Scroll Ownership

- CR-01: with long navigation or long detail, save/connectivity feedback must stay inside the visible area of
  the outer main and the detail column, and must not be positioned at the natural content bottom and vanish
  off-screen. Feedback keeps the existing state and auto-dismiss timing and is positioned only by a CSS sticky
  overlay that takes no layout space; ancestors use overflow-clip to keep rounded clipping and create no extra
  scroll container. MP-UI-06 grows the left and right columns separately after real save feedback appears and
  scrolls to top, middle and bottom, verifying the feedback fully visible at 1280x600 and 600x500 without
  changing content height. CR-01's fix boundary is only the SectionLayout clipping, the ProviderDetailFeedback
  positioning and the matching spec/unit/E2E (before the fix MP-UI-06 measured visible=false; after it MP-UI-01/06
  passed 2/2 in desktop-e2e-20260911-130920-521, layout unit tests 3/3, typecheck and lint passed).
- The two-column CSS Grid has a minimum height of 36rem (576px by default) and grows naturally to the taller
  column, with the other column stretching to equal height.
- Navigation and detail drop independent scrolling and edge scroll shadows; title, description, action buttons
  and the whole model settings container scroll together with the outer main. The left Settings navigation
  still scrolls independently.
- The 224px / below-`md` 56px navigation breakpoints, detail padding and bottom feedback whitespace are kept;
  inner text boxes and standalone dialogs can still scroll.
- Height is CSS-only, adding no JS measurement, state or persistence; provider selection, editing, service
  calls and the desktop continuous / mobile replayable boundaries are unchanged.
- MP-UI-01 uses a temporary content-height probe to verify wide/narrow windows, left or right taller, equal
  height and the real wheel driving the outer page; after the probe is removed the original provider
  operations continue. Verified 2026-09-11 (macOS Electron MP-UI-01 at 1280px / 600px, full typecheck, E2E
  typecheck, lint 0 errors, architecture); the narrow window covers responsive CSS and does not stand for
  real phone or Windows/Linux verification.

## Layout Structure

- Outer container: `Card` semantic border, internally `lg:grid-cols-[224px_minmax(0,1fr)]`.
- Left: provider navigation bar in two levels. First level (not clickable): `预制模型供应商` (Preset model
  providers), `自定义供应商` (Custom providers). Second level (clickable): concrete provider names.
- Right: detail area of the selected provider. Preset/custom shows endpoint, masked API Key, model list and
  Claude slot mapping. Selecting `添加供应商` (Add provider) puts the right side into the add form.

## Provider Family vs Connection Mode

- The left navigation only selects a provider family or custom provider. Z.ai / BigModel each take one left
  entry and do not change with the number of Start Plan, personal Coding Plan or team Coding Plan.
- Start Plan, personal Coding Plan, team Coding Plan and API Key are connection modes of one provider family,
  switched only in the "Connection mode" menu at the top of the right detail. There can be several team
  Coding Plans, all shown as menu items, never generating several left navigation nodes.
- `selectedNodeKey` means only the left navigation node; the current right detail item derives from the
  family's connection-mode setting and the saved connection-mode key for the `selectedNodeKey`.
- WelcomeScreen's initial selection first selects the matching family, then picks the right connection mode
  by entry intent.

## Team Plan API Key Unavailable Hint

- The availability of a Team Plan connection item is decided by the warm-up result of the team project API Key
  returned by the enterprise plan. When warm-up fails and the server returns `apiKeyUnavailableMessage`, the
  right status card shows that server text first, e.g. `您当前暂无有效的团队套餐授权记录，无法创建API Key`;
  without server text it falls back to the local fixed text `团队套餐未分配，请联系团队管理员。`.
- This text only affects the status card's unavailable note and does not change the Team Plan connection key,
  provider family, usage query or runtime key projection semantics.

## Personal and Team Entitlement Sources

- Personal Coding Plan requests `GET /api/biz/subscription/list` with the personal API Key and has entitlement
  only when a Coding subscription satisfies both `status=VALID` and `inCurrentPeriod=true`. A missing Key, a
  missing field of the adopted Coding entry or a failed request stays unknown; a successful empty array means
  no entitlement. The subscription list is parsed per entry: irrelevant or unrecognizable entries do not mask a
  valid Coding Plan, and any valid entry confirms entitlement. With no valid entry and a suspected corrupt
  Coding entry it stays unknown, otherwise no entitlement.
- Team entries come from the organization/project membership of `GET /api/biz/customer/getCustomerInfo`; the
  client must not infer entitlement from project existence, active or pricing fill-in.
- The team requests `GET /api/biz/team/subscribe/product/querySubscribeDetail` with the business access token
  carrying `bigmodel-organization` and `bigmodel-project`. Entitlement requires `hasSubscription=true`,
  `status=EFFECTIVE` and `memberGrantStatus=VALID` together; `hasSubscription=false`, `EXPIRED` or
  `EFFECTIVE + UNASSIGNED` mean no entitlement, keeping the not-activated, expired or unassigned semantics
  respectively; other unverified states and missing fields stay unknown. The BigModel valid responses above
  were verified with a production account on 2026-09-17. Z.ai keeps family domain and Bearer auth isolation;
  unsupported endpoints or unrecognized responses stay unknown and must not fall back to guessing entitlement
  from quota.
- `includeSubscription` is kept as a compatibility parameter, but a Coding Plan snapshot always queries and
  returns the subscription summary; the light entry also cannot decide entitlement from quota alone.
- The personal and team `quota/limit` (including `type=2`) are only for quota/usage display. Zero quota,
  missing data, business failure or transport error can neither generate nor revoke a subscription. A usage
  snapshot must not construct a subscription from the quota level nor attach a personal subscription to a team.
- Entitlement, call-credential readiness and usage availability are three independent facts; the team query
  needs no API Key creation/copy. A missing personal Key must not be treated as no entitlement, and a failure
  to fetch the team call Key does not revoke a confirmed entitlement.
- The entitlement owner keeps the existing Account connection service and request-identity validation, adding
  no cache; the existing usage cache upgrades its namespace and ignores subscriptions synthesized from quota
  by older versions. Personal and team are queried independently and the current connection is not switched on
  quota or refresh failure.

```text
account identity -> personal API Key -> subscription/list -> personal entitlement
account identity + org/project -> business token -> querySubscribeDetail -> team entitlement
selected identity -> call Key -> quota -> usage display only
desktop / mobile -> same Host service result; original continuous/replayable boundary unchanged
```

Acceptance: personal valid/non-current-period/empty list/missing Key/error; team valid/not subscribed/unknown
status/missing field/error; isolation of several organization projects; zero quota, no data and a thrown error
of both quotas do not affect a confirmed entitlement; a team subscription does not inherit the personal
product and renewal date.

The personal and team subscription responses keep the existing envelope contract: `code` may be omitted and,
when present, only `0` / `200` are accepted; `success=false` is always rejected. The data part is still
validated by each subscription schema.

## Plan Status Row and Retry

- The plan status row's checking and error states are mutually exclusive: while `checking` only the spinner and
  checking text show, not the previous round's team error icon, orange or server error message; after the
  query completes the hint recovers per the final state. The login button keeps its independent
  actionStatus/loginLoading.
- In team details, an ordinary entitlement query failure or a Project Key fetch failure does not mean OAuth is
  invalid and shows retry rather than connect account. The retry order is: refresh Host account/credentials,
  then force-refresh the current organization and project entitlement; an explicit unassigned plan keeps the
  admin hint, and only explicitly not-logged-in or login-invalid enters the login flow.
- When the team subscription is explicitly `status=EXPIRED`, entitlement is unavailable and the expired
  reason is kept; `EFFECTIVE + UNASSIGNED` is unassigned. Unknown enums and request failures stay unknown and
  cannot be inferred as not activated. The shared entitlement snapshot carries an optional
  teamPlanUnavailableReason under `no_plan`; the UI shows an expired/unassigned hint and not
  connect, fetch-failure or retry. An explicit subscription invalidation takes priority over an old Project
  Key error.

`team subscription response -> service parses an explicit reason -> UsageEntitlementSnapshot -> current team
status row`; the existing service and snapshot remain the only state source, with the desktop/mobile
recovery boundary unchanged.

The team read-only subscription query always uses the family, organization and project identity of the selected
navigation item, unaffected by the execution Provider availability gate; with a missing identity no team
request is constructed.

## Model List Visibility Rules

- When personal and team are explicitly without entitlement, the model list in the detail (including add, edit,
  test and switch) is hidden, while the model settings page entry, the plan status card and the existing banner
  stay and saved configs are not deleted. Personal `notPurchased` and team `not-allocated` / `expired` are
  explicit no-entitlement; querying, query failure and key-fetch failure cannot infer no entitlement and keep
  showing the existing model config. Acceptance covers entitled, no entitlement, failure and querying, plus the
  no-entitlement state without an Effective Provider.
- The Start Plan detail shows no trial-plan promotion banner (including logged-out and no-entitlement states),
  keeping the top plan status card and the existing personal-plan banner; when personal/team is not connected
  the trial promotion banner is likewise not shown and the model list is hidden, keeping the connection status
  card and personal/team plan banners without deleting config.
- When BigModel is logged in but the personal plan is not activated, the purchase area shows both the personal
  and team plan banners from the static catalog. A historical team subscription mark does not hide the team
  purchase entry; prices still come from static catalog products, with no fake products or prices.
- Start Plan validity fallback: the shared balance read takes the HTTP Date as this response's time, else a
  valid JSON server_time, and only then local time; an active plan that reached ends_at is normalized to
  expired and balance buckets owned only by the expired plan are removed. Entitlement validation and the usage
  snapshot consume the same result. With no valid plan and an expired plan present, the snapshot carries
  startPlanExpired, and the UI shows "体验套餐已过期" (Trial plan expired), hides the balance and model list, and
  keeps the existing upgrade/purchase entries. A valid plan among multiple plans still shows; a missing/invalid
  end time is not presumed expired.
- The purchase banner of the Start Plan detail also checks personal/team valid entitlements on the same account
  platform: when a status=purchased personal or team connection exists, the personal and team purchase banners
  hide, and the Start expired state still shows. Historical subscribed, expired, unassigned, query failure and
  other-platform entitlements cannot trigger hiding; the purchase rules of the personal/team detail itself are
  unchanged. When a valid personal or team plan already exists on the same platform, the Start Plan card's
  "升级 · 150% 配额" button and its activity note hide together, reusing the purchase banner's valid-entitlement
  judgment; the balance and model list of valid/pending Start multi-cards keep their original display.
- The left Zhipu navigation of the settings page restores brand naming: BigModel / Z.ai, with the standalone
  trial entry shown as Start Plan; zh and en both keep these names. Icons, status dots, navigation keys,
  connection modes and the right provider brand title are unchanged.
- The settings-page matching identity of a team connection is platform, organization and project. When the
  saved product ID differs from the product ID currently from the subscription endpoint, the same
  organization/project stays selected; neither the initial entitlement snapshot nor later product lists may
  therefore show "connection unavailable" or an empty option. The product ID stays plan metadata; display
  matching does not write back to selection nor change request auth or execution eligibility; different
  platforms, organizations and projects stay isolated.

## State Model

- `selectedNodeKey`: the currently selected second-level node on the left.
- `editingId`: whether the right side is in edit state.
- `isAdding`: whether the right side is in the "add provider" form state.

State sync rules: entering the add state forces selecting the `custom:add` node; entering the edit state syncs
the left selection to that provider node; when the selected node becomes invalid (e.g. after delete) it falls
back to the first selectable node.

## Interaction Constraints

- First-level titles are only group labels and do not respond to clicks.
- Clicking any second-level provider node makes the right side show only that node's detail.
- `添加供应商` is a second-level node of the custom group and drives the right content by selection like the
  other nodes.
- The refresh, save and delete chains are kept; official codex/claude/gemini OAuth is no longer a model
  provider settings entry.

## Narrow-Window Responsiveness

- On narrow windows the left navigation shrinks from `224px` to a `56px` icon rail while the right detail area
  stays `minmax(0, 1fr)`, so the left column does not squeeze the main form. Response order: the outer Settings
  sidebar collapses at `lg`, then the model provider navigation at `md`, and the Plan/Usage cards switch to
  vertical last at `sm`.
- The compact state shows only provider icon, loading state and status dot, with square icon-button entries;
  provider name, connection-mode badge and group titles hide visually. All clickable navigation items keep the
  wrapped `ControlHintTooltip`, showing the provider name on the right on hover/focus so the current entry stays
  identifiable when collapsed. Drag sorting stays at the icon position of custom provider entries without
  changing provider id sorting semantics.
- Below `sm`, the right Coding Plan / Start Plan card may switch from horizontal to vertical so main info,
  status and action buttons do not squeeze each other. In an activated plan, the usage summary cards stay
  side by side on wide screens and stack vertically below `sm`, keeping each card's title, model note,
  percentage and progress bar. The price info and purchase button of the plan purchase card stack top to bottom
  below `sm`, with the button width following the container so long or localized text does not break the card.

## Visual Alignment (Reference z-work)

- Left navigation: width narrowed from `280px` to `224px` with unified group/item spacing; group titles are
  inline titles in `text-ui-base + font-semibold`; nodes use a "border selected state" instead of a pure
  background one: selected `border-primary + text-foreground`, unselected `border-transparent +
hover:border-border-hover/60`. A provider icon is added at the node's left: preset providers use the OAuth
  provider logo (`Z.AI` / `BigModel`), custom providers the generic `Package` icon, and add provider keeps the
  `Plus` icon in `text-primary` for discoverability. The right status dot is a `CircleIcon`, blue
  (`text-sky-500`) when available and gray (`text-gray-400`) otherwise.
- Right detail: cards unified as `rounded-2xl + border + bg-background/50` panels; title weight stays
  `font-semibold` with size narrowed from `text-lg` to `text-ui-lg`; field labels unified as `text-ui-base
font-medium text-foreground-subtle`; inputs and read-only displays unified as `rounded-lg + bg-input`,
  consistent with other settings forms; the model list "add model" button is a `secondary` button with hover
  background; placeholder card body text unified as `text-ui-base text-foreground-subtle`.
