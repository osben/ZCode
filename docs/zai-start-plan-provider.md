# Z.AI / BigModel Start Plan Provider

## Current Provider architecture (Todo154: Start is independent)

Account selection keeps saving `providerFamilyDomain` and `providerFamilyConnectionSelections`; no
migration is added. Each round the Account Source publishes both the account state
(availability/current/effectiveAt) and the Config Overlay (entitled / dynamic model members), and
Settings and Registry consume the same revision. Off-Peak keeps its static hidden and sets no
current; ordinary Personal/Template Providers are not restricted by current.

```text
account query + Family selection
  -> Account state + Overlay (same round)
     -> Settings: can view available/pending
     -> Registry: matches current account access context + entitled + complete, enabled models
```

- The Start balance query is independent of the personal Coding Plan query. Team needs a concrete org/project identity; a team is never guessed.
- Pending is `pending`/`entitled=false` and keeps the Unix-seconds `effectiveAt`. Effective but with no models is still `entitled=true` with empty model members and does not reuse the old allowlist. An unknown query keeps only the last successful result of the same account/Team.
- An invalid connection only prompts and returns to an actionable settings entry; it does not rewrite the saved Family selection or replace the session model.
- A claim result opens model settings by default and does not switch to Start. The earlier automatic "use now" is not default staging behavior.
- Start follows the current App login and needs no separate connection. `current` means matching the account access context: Start and the current personal/team plan of the same brand may both be true; Start's connectionKey does not include the paid-plan selection. Expiry, unknown state and disabled models still follow the original entitlement and Registry checks; login does not auto-claim.
- Settings lists a standalone `Start Plan` beside the "智谱" (Zhipu) group. Both brands share the user-provided Z icon (`model-provider-start-plan.png`, same original image for light and dark themes) and keep the original `account:*` ids; personal/team plans keep their brand icons. Start detail keeps entitlement, quota, claim and model management, and drops connect/disconnect and the paid-connection dropdown; browsing and claiming never change the paid connection.
- In the model picker, both brands' trial-plan group title is `Start Plan` with a pill label ("免费" in Chinese, "Free" in English). Chat, scheduled tasks, subagents and Wiki use the same display rule. The group keeps the real model list and capability tags and does not change Provider/model selection values.
- A saved Start selection resolves exactly by original Provider id, model and options, never across brands and never falling back to paid quota. Personal/team still map by the current single paid connection. Historical sessions, tasks, Automation, Subagent, Bot and Wiki are not batch-rewritten; Session keeps its write-back after a successful run. The legacy `kind: start-plan` is still read, but startup no longer activates Start by writing it.
- In-conversation model-switch dividers, first-use hints and the matching toast label BigModel/Z.ai account-plan models as `<model name>(<plan type>)` with plan types 个人套餐 (personal), 体验套餐 (trial), 团队套餐 (team), e.g. `GLM-5.3(团队套餐) → GLM-5.3(体验套餐)`, so same-name models stay distinguishable by quota source. The type comes from the hint's recorded before/after Provider ids, never the current global connection or composer draft; built-in plans are still recognized when the Provider is no longer in the current catalog. Plan names are translated with the UI language, ordinary custom providers keep the original naming rule, desktop and mobile share the display logic, and history needs no migration.
- Recommendation: on submitting a new message, saving a scheduled task after creating/changing its model, manual Wiki generation, and saving an explicit Subagent model, if the effective selection is a paid model and Start has the same, thinking-compatible, executable model with a clear positive quota, recommend the trial plan. Unknown quota or query failure skips it, and submission never waits for a forced quota refresh. "切换套餐" (switch plan) remembers the Start selection for that entry at the original submit/save boundary; "不了" (no thanks) continues with the original selection; closing keeps the draft and does not run the action.
- The recommendation dialog footer puts "不再提示" (don't show again) on the left and the "不了 / 切换套餐" button group on the right, vertically centered on one row; when narrow screens or longer translations lack room, the button group wraps as a whole and stays right-aligned.
- `startPlanRecommendationDismissed` is a unified persisted preference of the current App/Host. Ticking "不再提示" and confirming either button only turns off the recommendation; each entry keeps using its own saved model. Closing the dialog does not save the tick. Another entry, or a mobile phone connected to the same Host, rereads the preference on its next submit. Real quota/auth errors still show; no cross-Host account cloud sync is added.
- Not prompted: Bot, background execution, task-list "run now", dequeue of an existing queue, retry, Wiki failure-page fill-in, Subagent inherit / thinking-only or text-only edits. The global account-connection-invalid hint observes only paid connections; Start keeps its own quota and unavailable feedback.

Full boundaries and acceptance SIP-01..21: [Todo154](working-memory/provider-refactor/steps/todo-154-start-plan-independent-provider.md).

`builtin:*` ids in the legacy interface notes below are the pre-migration identity; they now correspond
to `account:*`, and the old Provider Store must not be restored.

## Provider ids, endpoint and balance API

Start Plan is represented by dedicated built-in model provider ids:

```txt
builtin:zai-start-plan
builtin:bigmodel-start-plan
```

Both intentionally reuse the same `zcode-plan` runtime endpoint and free model set. OAuth preset
sync derives each Start Plan provider from its own brand login domain, so runtime model calls use the
same `zcode-plan` endpoint while credentials stay isolated by provider id.

Status checks are separate from paid Coding Plan checks. `builtin:zai-start-plan` reads the active
free plan identity and the daily quota bucket renewal time from one balance request:

```http
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>
Authorization: Bearer <zcodejwttoken>          # Z.AI
Authorization: Bearer <zcodejwttoken>          # BigModel
X-Device-Mid: <telemetry-state.json deviceMid>  # required; missing -> 400 {"code":3001,"msg":"parameter error"}
```

`X-Device-Mid` is required by the backend for this endpoint even though it is optional in the generic
source-header rules. Every runtime that issues this request (Desktop host, remote `zcode-server`,
CLI) must ensure its own `deviceMid` exists before the first balance query; see
`docs/zcode-endpoint-device-mid-header.md`. A `400 parameter error` here is classified as `unknown`
availability and disables executable Start models, so a missing header must never be treated as a
backend outage.

`billing/current` is deprecated for Start Plan. The `balance` response must include `data.plans` for
active-plan detection and subscription metadata, plus `data.balances` for quota/remaining display.
Clients must not call `current` before `balance` or issue a second `balance` request for the same
snapshot. `app_version` always uses the current app `ZCODE_VERSION`, including development builds.

`zcodejwttoken` is the OAuth backend JWT saved during Z.AI or BigModel login. BigModel passes the
one-time callback `code` directly to `https://zcode.z.ai/api/v1/oauth/token` with `state`,
`redirect_uri` and `provider: "bigmodel"` to save the same JWT shape used by Z.AI Start Plan. Paid
Coding Plan providers keep using `/api/biz/subscription/list`; monitor quota APIs stay reserved for
Coding Plan usage/limit views.

## Independent Selection And Availability

Start is a permanent Provider entry for the current login brand, independent of the paid connection
selection. No active entitlement, a failed query or pending activation changes the status panel, not
the existence of the entry. The executable model menu stays controlled by Account Source and
Registry; an unavailable Start never falls back to paid quota.

- Composer quota follows the effective Provider/model in that composer. Start does not require a saved `kind: start-plan`; paid quota still uses the exact personal/team scope.
- Unresolved legacy team identity blocks that paid access only; it does not stop Start entitlement discovery.
- Paid connection selection uses the saved/pending family selection and exact org/project/product identity, not a copied navigation item's `provider.current`. No matching choice displays the normal placeholder; a sole unselected option remains actionable.
- Start details reuse the existing loading text/spinner, active/pending subscription cards, quota buckets, zero-balance presentation, reset time and model management. There is no new skeleton, exhausted warning, persistent refresh-failure overlay or status-dot color system.
- Signed-out Start offers login; conclusive no-plan shows no available trial plan and the existing introduction/eligible campaign. A first query failure offers retry, explicit auth expiry offers login, and configuration-unavailable is reserved for actual missing configuration. Silent refresh retains existing data only under the existing cache/error rules.
- Claim success remains success if the subsequent refresh fails. The settings action is "查看套餐 / View plan"; no automatic model guide or implicit model/paid-connection mutation remains.

### Recommendation freshness and account changes

Recommendation, settings and composer balance use the same Start request/cache identity for the same
Host/account/Provider. Reuse the existing Provider entitlement fingerprint, refresh events and
UsageEntitlement cache; do not introduce another balance owner. Settings refresh publishes new quota
to the recommendation consumer.

Page entry and interactive submission perform an access refresh check with the existing 60-second
throttle, in-flight merging and error backoff. Account/claim changes use the existing auth/purchase
refresh path. No idle polling is introduced.

Only a successful snapshot sampled at most 60 seconds ago can support a recommendation. Reading or
remounting does not renew its age. At submission time, add elapsed local time since sampling to the
server reference time before checking bucket expiration. An expired bucket never supports a
recommendation, even in a fresh snapshot. Missing/stale quota triggers a background refresh and this
submission proceeds with its original selection, without waiting or later resending. Query failures
skip recommendations and do not extend old positive quota validity. This limit applies to
recommendation decisions, not to automatic clearing of visible plan cards.

```text
account/claim change -> existing entitlement refresh -> shared quota snapshot
page entry/submit  -> access freshness check -----------^
submission -> fresh snapshot + valid bucket + compatible same-model quota?
  yes -> existing recommendation/choice -> original owner commit
  no  -> original selection commits; quota refresh stays in background
```

### Side conversation first input

`/side <text>` is also an interactive first submission. Resolve the child-inherited effective model
before recommendation; never substitute an unsubmitted parent composer draft.
`createSelectionSideSession.firstInput` accepts an optional complete `modelSelection`, used for the
child creation and first input, preserving reasoning options. Old text-only payloads keep their
existing inheritance. Cancel keeps the inherited selection; closing the recommendation leaves the
draft and sends no create command. Empty `/side` only opens a child and does not recommend.

The existing atomic creation/first-input command, command id, admission and ACK own execution and
deduplication. Parent model/queue and global paid connection remain unchanged. Desktop continuous and
mobile replayable still use the same owner and original recovery paths. Accepted regressions
SF-01..SF-19: [Todo156](working-memory/provider-refactor/steps/todo-156-start-plan-followup-final-decisions.md).

## Settings status panel

The settings status panel uses the Start Plan provider identity to present a free-plan state with a
paid Coding Plan upgrade entry. The panel projection is multi-plan aware:

```text
billing/balance (server priority order)
  plans[] -------------------------------> one card per active plan
     | plan_id                                  | title / plan expiry
     |                                          v
     +---- balances[].plan_id ------------> only this plan's quota buckets
                                                | bucket expires_at
                                                v
                                           bucket-local reset time

  balances[].capabilities ----------------> model id union
                                                |
                                                v
                                      read-only Models section at the bottom
```

Field contract (server guaranteed, no legacy fallbacks on the client):

- every `plans[]` entry carries `plan_id`, `status` and `ends_at`
- every `balances[]` entry carries `plan_id` and `expires_at`
- every `balances[]` bucket belongs to an active `plans[]` entry: the server must not return buckets whose `plan_id` is missing or maps to a non-active plan. The provider logs a tripwire warn (`warnOnUnattributedStartPlanBuckets`) when this is violated, because the settings multi-card path silently drops such buckets while the chat input bubble still shows them.
- Plan card grouping uses `plan_id`; reset labels use `expires_at`, without falling back to `period_end`. Bucket reminders additionally preserve `bucket_id`, `user_plan_id`, `period_start` and `period_end`: the bucket and period identify a single reminder, while `user_plan_id` joins the entitlement period label for the exact user-plan instance. See `start-plan-daily-quota-banner.md`.

Presentation rules:

- Active plans render in the exact order returned by `data.plans`; the client must not sort again because the server applied product priority.
- Every plan reuses the existing Plan Card surface and shows its own remote name, `ends_at` and quota buckets.
- A bucket belongs to a card only when its `plan_id` matches that plan. A bucket without a matching `plan_id` attaches to no card; the client must not fall back to plan-less buckets, or the same bucket would be copied into every card.
- Each quota bucket formats its own `expires_at` as its reset time; a plan-level or earliest reset time is never copied to sibling buckets. Start Plan cards render no plan-level renew time. The chat input toolbar context balance bubble follows the same rule: every meter reads only its own bucket's `expires_at` (`limit.nextResetTime`), never the aggregated `remaining.nextResetTime` or the plan-level renew time. Reset time formatting is aligned with Coding Plan through the shared `formatQuotaResetTime({ format: "adaptive" })`: same-day resets render `HH:mm` only, other-day resets render the date only.
- The read-only Models section stays outside all plan cards at the bottom of the provider detail. Its content is the case-insensitive union of model capabilities from all returned buckets, in first-occurrence order.
- This presentation does not change balance fetching, provider selection, runtime routing or model synchronization. The entitlement snapshot only preserves the plan/bucket identity already in the same balance response.

Telemetry identity: `subscription.details` carries all active plans in server priority order, so the
`plan_product_id` reported by `send_btn` telemetry reads `details[0]`, the highest-priority active
plan. Server-side reordering intentionally flips this id. See `docs/monitoring/business-monitoring.md`.

Shared Plan Card behavior:

- title: `{provider} - Start Plan`
- purchased metadata: `Start Free` badge and the plan expire time from `balance.data.plans[].ends_at`, rendered as a date only (year omitted for the current year). Bucket reset times come only from each bucket's `expires_at`.
- the upgrade button is shown; pricing cards stay hidden until the user clicks upgrade
- manage and unlink actions are both hidden for Start Plan plan cards: the free tier has no management page and the login state is managed at the family connection level; the card keeps only the expiry date and the upgrade-to-Coding-Plan action (with its billing-discount badge)

The settings detail form exposes no manual connection fields for Start Plan. `Base URL`, `API Format`
and `API Key` are replaced by a Start Plan card, because OAuth/preset sync maintains those values and
they must not look user-editable.

The Start Plan model catalog stays managed jointly by `billing/balance` and
`client/configs.builtinModels`; users cannot add, delete or rename models, nor change server-owned
model facts such as max output tokens or input/output modalities. A model row opens only two local
operations:

- Edit the context window; the saved user value must survive provider refresh and be passed to the runtime registry.
- Test the model's connectivity; the test keeps using the current Start Plan credential and the fixed endpoint.

So Settings keeps model ids read-only, hides add/delete entries, and renders only the context-window
field in a restricted edit dialog. Remote refresh may still update the model list and metadata other
than context; a model no longer in the authoritative entitlement list is removed as usual and not
kept because its context was edited locally.

## Signed-out Preview

When a user opens either Start Plan entry before logging in, the settings panel shows the free Start
Plan preview followed by the paid Coding Plan pricing cards:

```tsx
<StartPlanCard />
<CodingPlanPricingCards />
```

Both read from the same unauthenticated client config endpoint, and the service layer must share one
`client/configs` payload between the preview card, pricing cards and any other client-config
consumers in the same provider instance:

```http
GET https://zcode.z.ai/api/v1/client/configs?app_version=<ZCODE_VERSION>&platform=<platform>-<arch>
```

`StartPlanCard` uses `configs.startPlanPreview`:

```ts
interface StartPlanPreviewConfig {
  planId: string;
  name: string;
  entitlements: {
    grantUnits: number;
    meter: string;
    period: string;
    showName: string;
    unitType: string;
  }[];
}
```

The current payload is provider-neutral, so Z.AI Start Plan and BigModel Start Plan both show the
same preview. The provider-specific difference is the paid pricing list underneath:

- `builtin:zai-start-plan` preview card: `configs.startPlanPreview`; pricing cards: `configs.codingPlanStaticProducts["builtin:zai-coding-plan"]`
- `builtin:bigmodel-start-plan` preview card: `configs.startPlanPreview`; pricing cards: `configs.codingPlanStaticProducts["builtin:bigmodel-coding-plan"]`

If `configs.startPlanPreview` is missing, the signed-out Start Plan surface must not render the Start
free preview or the free Start SKU / 体验套餐 content. Paid Coding Plan pricing cards may still render
from `codingPlanStaticProducts`; the free Start content is controlled only by `startPlanPreview`, not
by a local hard-coded fallback.

The BigModel signed-out purchase choice banner follows the same rule. The Start Plan entry renders
only when `configs.startPlanPreview` exists and has displayable `model_usage` entitlements. Its title
uses `startPlanPreview.name`, its large quota metric is calculated from the entitlement `grantUnits`,
and its description lists the remote entitlement model names and quota groups. When the preview is
missing, the personal/team purchase entries may remain visible, but the Start Plan entry and all
Start-specific copy must be absent.

When the user unlinks the active Z.ai / BigModel OAuth session while the same family still has an API
key, the family domain remains selected, but the current Start/Coding detail returns to the signed-out
Start view. This preserves the family settings context and re-shows the Start preview plus pricing
cards when `startPlanPreview` is present, instead of leaving the user on a disconnected Coding Plan
card with no next action.

## Manual claim banner

The workspace sidebar queries `GET /api/v1/zcode-plan/billing/preview` with the current client
version/platform. A ZCode JWT is attached when available; signed-out preview is sent without
Authorization. It renders one banner directly above the profile footer only when `data.plans` contains
a claimable plan. Multiple plans resolve by descending `priority`, then ascending `plan_id` for
deterministic display. An empty response or a request failure renders no banner on the first read. A
transient refresh failure preserves the last successful preview; an authoritative empty response
removes it. Reading preview never claims or activates a plan.

The `data.server_time` of `preview`, `claim` and `balance` is the business authority for time fields
within that response, in Unix seconds on the wire; the Service converts to milliseconds for the
Renderer. The client must not substitute `generatedAt` for `server_time`: the former is still the
local snapshot generation time, the latter is used to compare `starts_at`, `ends_at`, `effective_at`
and `expires_at` within the same response. For older servers a missing field is allowed and falls
back to `Date.now()`; an invalid value counts as missing; an old `server_time` is never reused across
endpoints. `server_time` is not an activity batch id and does not change the 10 min / 30 s polling
cycle; the next round of activity is still determined by the claimable result of the new preview.

### Manual claim interaction

`preview` is a public exposure endpoint: signed-out requests carry no Authorization, signed-in ones may
carry the ZCode JWT. `claim` requires login; official builds also run a security check before claim
(`verifying` below). State machine after a Banner click:

```text
idle -> checking-auth -> verifying -> claiming -> success-dialog -> refreshing -> hidden/idle
                                \-> failure-dialog ---------------------------> idle
```

- Clicking while signed out only starts login; it calls neither the security check nor claim. After login the user confirms the claim again.
- Clicking the Banner's top-right close button must not hide the Banner immediately; first show the standard confirmation dialog whose title warns the user will miss a claim chance and states that the chance is limited and may be missed after closing. The confirmation text must not describe Start Plan as an "activity" nor assert it cannot be claimed again. "确认领取" (confirm claim) closes the dialog and reuses the same claim state machine; "关闭" (close) hides the Banner for the current render cycle. Escape, backdrop click or any other cancel only closes the confirmation, neither hiding the Banner nor starting claim.
- At most one claim request exists at a time; the Banner ignores repeated clicks while pending.
- In official builds, claim is called only after the pre-claim security check succeeds; failure, cancel or total interaction timeout ends pending and shows the claim-failure result. The Banner never spins indefinitely.
- `POST /api/v1/zcode-plan/billing/claim` uses the current ZCode JWT, body `{ "plan_id": plan.planId }`; the official-build security check result is passed in a request header.
- Success shows a Start Plan result dialog; failure reuses the standard `AlertDialog` template.

Success dialog layout:

- Top: a theme Hero showing the entitlement, `4:3` and scaling responsively with dialog width (480 x 360 px at 480 px wide), with a ticket-style plan card. Bottom: description and action area, height following content, spacing and padding. Full desktop dialog width is `480px`, total height not fixed, shrinking to the viewport safe area on narrow screens.
- Hero content is generated by `createWeekendPlanResultDialogMock()` per the future cloud protocol. The starfield, ticket, entrance, idle press, pointer tilt, dynamic lighting, click flip and Replay live in a standalone `weekend-plan-hero.html` resource, loaded by `CloudDialogHero` in an iframe sandboxed with only `allow-scripts`. The resource receives theme, language, reduced-motion and this entitlement data only through instance-id `postMessage`, and must not access the Renderer DOM, Node, preload or business Services. The current phase requests no real cloud content; the mock resource URL is bundled by Vite. Real cloud integration, resource signing and cache contract: `docs/cloud-content-dialog.md`.
- Except for the Banner (a marketing-visual exception), the claim dialog follows the root `DESIGN.md`: app UI fonts use only `text-ui-*`; dialog, bottom status area, inputs, buttons and menus use semantic colors and existing UI components, compatible with Zai Light / Zai Dark. The Ticket back plate shares `bg-primary` with the front (black on Zai Light, white on Zai Dark); this marketing visual rule must not spread to ordinary controls and body text.
- Bottom result: title `text-ui-xl`, description `text-ui-base/relaxed`, titles and descriptions centered, no extra success icon, on `bg-popover` with uniform `p-6` padding; the second row's read-only input and "获取图片" (get image) outline button use `bg-background` on their own (the input keeps it when focused).
- Title: "You now have access to {plan}" in English, "{plan} 领取成功" in Chinese, where `{plan}` is the real plan name from this claim result, without extra quote marks.
- Description (immediate or pending) must not use a fixed `Start Plan`: it reads the entitlement `show_name` of this claim. Immediately available: "`{showName}` 已可使用" / "`{showName}` is ready to use". Pending: read the `show_name` of the entitlement that determines the wait: "`{showName}` 将于 `{time}` 生效" / "`{showName}` will be available on `{time}`". Rendered with a real `<b>` and `font-semibold text-foreground`, not by parsing translated HTML. The full time is an unbreakable inline whole (date and time never wrap separately), emphasized with a dashed underline, default mouse cursor, no clickable semantics, and no undefined color token. With several entitlements at the same effective time, names are deduped and joined per language. Pending text uses `text-foreground-subtle`, with the plan name and formatted time in `font-semibold text-foreground`. No model-settings link in the description.
- Pending detection: the dialog reads only `plan.entitlements[].effective_at` of this Claim response. If any entitlement shown on the Ticket is not yet effective, use the latest `effective_at` as the full-entitlement start time; if that is later than the same response's `data.server_time`, the entitlement is claimed but not started and the pending description is used, formatted by current language and local time zone. `effective_at = 0` is the server sentinel for "effective immediately": it is not the Unix Epoch, not treated as missing, never shows a 1970 time, and shows no pending text. The dialog must not read the post-claim balance, nor infer effectiveness from the Claim response's `plan.starts_at`. A Claim lacking a valid `effective_at` gets the immediately-available feedback. The post-claim balance refresh only updates Model Settings plans, quota and Provider state and never overwrites the claim result already shown.
- Actions: side-by-side `h-10 min-w-32 rounded-full` primary and secondary buttons with `gap-2`. Primary "模型设置 / Model settings" (both immediate and pending) closes the dialog and navigates to the provider section of model settings; it does not write the Start Plan connection settings or trigger model-entry guidance. Secondary "复制分享 / Copy & share" copies the share text directly without opening a secondary panel; on success it briefly shows "内容已复制 / Text copied" in place (or "✓ 已复制" on the share panel's copy button); copying an image uses the global Toast. Clipboard or image-generation failure shows a failure Toast, never just a log. Title and description form a centered status area with `gap-3`; the outer gap between status area and action area is `gap-6`.
- Share text: localized by current language, contains only the model entitlement, `#ZCode` and `@zcode_ai` (no plan name, total quota or start/end time), e.g. Chinese `我在 ZCode 领取了 {权益明细}。#ZCode @zcode_ai`. It must include the `https://zcode.z.ai` entry and invite the recipient to download ZCode and claim; the Chinese link takes the last line alone, the English link follows the full sentence directly; neither language uses a colon to introduce the link, and the link sits at the end so social platforms do not take following text as part of the URL.
- Ticket content: one line per `model_usage` entitlement (different periods are not merged): gift icon, `show_name`, that entry's `period` and `grant_units`; `daily` shows "每日" (daily), `one_time` shows no period. The visual area shows only `plan.ends_at`, centered on one line as "有效期至 / Valid until + time" in the current language and local time zone, with heavier weight and size on the deadline; a missing field shows a placeholder, and preview time is never used to infer the real entitlement term. The Ticket time area does not repeat the start time. The middle dashed divider is `h-px` (1px) with long dashes.

Ticket and Hero motion (marketing visual; summarized rules):

- Pointer over the ticket (desktop): light 3D press, dynamic highlight and outline shadow by pointer position relative to center; pressing sinks further; a click flips 360° around Y toward the pressed side (left half `-360°`, right half `+360°`, split at the card's geometric center), passing the back (mirror-free text, same-color theme plate), then returns to front. Without a hovering pointer the ticket simulates an invisible pointer circling top-left, top-right, bottom-right, bottom-left with smooth transitions and synchronized pressure, highlight, tilt and shadow; a real pointer stops the auto motion immediately and follows, resuming the corner loop on leave. Flips use one continuous single-segment speed curve without mid-frame pauses. `cursor-default`; no link hand cursor. Spatial transforms are disabled under `prefers-reduced-motion`. The feedback never changes claim behavior.
- Entrance (once only; does not replace later click flips): the ticket starts as a small front face in deep depth of field, approaches, flips vertically around X for `2` turns, and lands on the front within about `0.9s`, with ease-in-out (slow start and landing, fast middle). All back phases show only an independent, opaque theme background identical to the front `bg-primary`; opacity of the whole ticket is never lowered to show distance (distance is conveyed by depth, scale and rotation). Front and back use independent compositing layers offset by a tiny Z distance to avoid coplanar z-fighting; the back pre-rotation axis is X, matching the entrance, with explicit opaque `--color-primary` and `backface-visibility`. To work around Chromium occasionally ignoring back-face hiding under mask and nested 3D, the entrance gates visibility by rotation interval: `180°` and `540°` show only the theme back; `360°` and `720°` show only the front; switches happen when the card is edge-on to the camera. Gating ends when the entrance completes. During gating the theme back temporarily allows double-sided painting (only inside the entrance animation; `backface-visibility: hidden` is restored afterwards); implementation uses an entrance-only double-sided theme-color mask (shown in back intervals, hidden in front intervals) and fully hides the ordinary 3D back plate during the entrance. The automatic corner press starts only after the entrance completes, so two 3D/shadow computations do not run together on the first frame.
- Replay: a circular icon button at the Hero's top-left restarts the whole Hero (galaxy and star trails, ticket entrance from the distant theme back, corner-press timer reset); the Replay control is excluded from the exported share image. It reuses the Dialog close button's `Button` spec (`ghost + icon-sm`, `top-4`, circular, no-drag), only moved from top-right to top-left. Both float over the fixed dark Galaxy Hero, a local exception to theme semantic colors: always translucent white icon, faint white hover background and white focus ring regardless of system theme.
- Hero background: deep-space galaxy with a bright core, elliptical nebula disc and spiral arms, plus low-density central radiating stars and short light-trail loops; the animation layer receives no pointer events, never covers ticket content, and is hidden under reduced motion.

Failure dialog and codes:

- Failure uses the standard `AlertDialogContent`, Header, Title, Description, Footer and Action; shows only a failure title, a business-code-localized explanation and a confirm button. No status icon, close button, Hero, Ticket, starfield, Replay, share text or image actions; no dedicated size, centered layout or custom button shape; the confirm button reads "知道了 / Got it". The failed state starts no Ticket animation frame and builds/runs no share flow.
- Copy is localized by business code; unknown and network errors use the generic failure copy and never expose internal server errors. `1005` means the day's claim quota is exhausted: the claim failure response must keep `data.plan.ends_at`, judged in the user's local time zone: if the activity ends today show "今日领取名额已用完，欢迎下次再来"; if it ends tomorrow or later show "今日领取名额已用完，请明天再来"; if the field is missing or invalid show only "今日领取名额已用完". `1001`, `1002`, `1003`, `1004`, `3001`, `3007` and login expiry keep their own stable copy; only unknown codes fall back to the generic failure copy.

Settings Start Plan card (pending state):

- If the plan entitlement's `effective_at` is later than now, the status row shows "待生效 `{date} HH:mm` · 过期时间 `{date} HH:mm`" / "Pending `{date} HH:mm` · Expires `{date} HH:mm`". When the effective date is today or tomorrow in the client's local date, the date is simplified to "今天 / Today" or "明天 / Tomorrow" (e.g. "待生效 明天 22:00 / Pending Tomorrow 22:00"); farther dates show month and day. Both use ordinary meta style, the effective time is not a badge; the effective-time text uses the semantic success color, the separator dot and the expiry time keep the secondary text color.
- When the scheduled time has arrived but balance has not returned a quota bucket with the matching `plan_id`, the status row shows a compact "刷新权益 / Refresh access" outline pill button plus the expiry time: success-color outline, translucent success background and success text, an outline-style refresh icon before the text; during refresh the icon switches in place to a spinning loading icon and the button is disabled. The button reuses Model Settings' existing provider, entitlement and quota refresh chain and disappears once the plan's quota bucket arrives, leaving only the expiry time.
- An `effective_at = 0` or unscheduled immediately-effective entitlement never shows the button. The balance area still appears only after balance returns a quota bucket with the matching `plan_id`.

Post-claim sequence:

- On success the dialog is shown at once, and while it is shown the client concurrently rereads preview, refreshes billing balance and Account Source / provider/model; it must not wait until the dialog is closed.
- Claim success is an irreversible business fact; all post-claim refreshes are best-effort. A refresh failure only logs a degradation, never rewrites success as a claim failure, and never blocks closing the dialog or opening model settings. A successful preview refresh independently updates the Banner, even if the entitlement or provider refresh fails.
- Until the entitlement returns, the success dialog is already visible but the primary action is temporarily disabled; once the snapshot completes or fails, the pending state updates in place and "查看套餐 / View plan" is enabled. The success dialog's top-right close only closes the dialog.
- Since 2026-09-06 default behavior matches pinned staging: the historical "Start using" switch is off, the claim flow does not write `providerFamilyConnectionSelections` and dispatches no Composer auto-model-select instruction. Provider/entitlement refresh goes through the current ProviderSettingsService and UsageEntitlementService; the old Provider Store is not restored. The historical auto-model guidance and its dedicated consumer are retired; a successful claim dispatches no model-switch request.

Banner layout:

- The top-right close button only hides the Banner for the current render cycle: it starts no claim, does not modify the server preview and is not persisted as a permanent close. The whole Banner is the claim trigger, supporting mouse click and keyboard Enter/Space. The model subtitle and the right-side claim-state pill share one row with `gap-1.5`. The pill is only decoration and loading display, not an independent button: library `outline`, `xs` standard style with `rounded-full`, `text-xs`, theme-following `border-foreground`, aligned to the far right of the content area; only the top title row reserves space for the top-right close button. While claiming, the pill text is replaced by a `size-3` spinning loading icon, repeated claims are disabled, and the close icon stays unchanged but temporarily disabled.
- The top is laid out as `ZCode icon and wordmark SVG [gap-1.5] plan.name`, with no separator dot. To avoid repeating the brand, a standalone `ZCode` (case-insensitive) and extra spaces are removed from `plan.name` before display. The activity name uses normal foreground color (not blue) and truncates in the remaining width. The original server `plan.name` is also the plan name on the claim-result Ticket.
- Minimum height `96px`, inner `gap-1.5`, content vertically centered in the container, growing naturally with taller content. The main title takes the largest `grant_units` among all `model_usage` entitlements, adds digit grouping for the current locale and shows the full Token count without converting to `Million` or "亿", with `Tokens` as a smaller unit after it, e.g. `300,000,000 Tokens`. The subtitle shows only `show_name` model names separated by `·`; it shows no period information (daily, one-time, Daily, One-time, bonus) and no lightning icon; with enlarged UI font, model names truncate in the remaining width. The Banner uses fixed `10px / 18px / 12px` font sizes and does not scale with the global UI font size.
- The Banner must support Zai Light and Zai Dark: the light container uses `bg-neutral-50`, `border-card-border` and `shadow-md/5`, main text and the ZCode wordmark use `text-foreground`, secondary text uses `text-foreground-subtle`. Dark restores the activity Banner's original `neutral-950` black base, faint white border, inner highlight with deep shadow and neutral gray text through `.dark`; the close button and claim-state pill likewise keep light semantic colors and their original dark look. An ordinary dark `bg-card` must not replace the activity Banner's deep dark texture.

## Test and coverage contract

State dimensions, pruning decisions, Desktop E2E candidates and the branch-coverage basis of the manual
claim experience are recorded in
[`docs/testing/start-plan-manual-claim-e2e-coverage.md`](testing/start-plan-manual-claim-e2e-coverage.md).
Coverage for this feature must use the common commit `ebae2814f5` before the first merge as its diff
baseline; because the feature commits are already in `staging`, using an empty diff against the
current `origin/staging` to claim completion is forbidden. Acceptance requires newly added executable
production source lines to reach at least 95% in focused unit/component standard Istanbul line
coverage; Desktop E2E coverage is separate cross-process evidence, and statement ids from different
instrumentation must not be merged to inflate coverage.
