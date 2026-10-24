# Marketing Touch client integration

## Banner hover bridge

The banner iframe keeps `pointer-events:none`, inert, not focusable, and ignores in-package actions. The App banner is the sole hover owner: mouse enter/leave over the whole banner is sent through the existing `zcode-cloud-hero-v1` channel as `{type:"hover",instanceId,hovered:boolean}`; no coordinates, clicks, or business events, and no server delivery-field changes.

```text
mouse enter/leave → App banner hovered → send hover after ready → resource animation
pending / blur / page hidden / touch → hovered=false → restore
whole-image click / close → original Controller → original confirm/cancel report
```

No hover before iframe ready; after ready the current value syncs. Reduced motion sends `false`. Removing a resource still uses destroy; replacing the URL creates new state, and an old instance cannot affect a new one. The resource side validates parent/channel/instanceId/boolean; hover only updates animation and never re-renders entitlements. Old ZIPs ignore the new message — a new ZIP version is required to respond to hover inside the App. The hero keeps native interaction; image/video are unaffected; the Web fallback sends no iframe message; touch never triggers hover; task/remote-control chains are unchanged.

Acceptance (MTC-BUNDLE extension): real mouse enter/leave receives hover; click/close still each report once; the iframe still receives no pointer events. Unit tests cover pending, blur, hidden, touch, ready, and reduced motion; the resource browser checks real transforms and restoration.

Status: client implementation complete; macOS App E2E against the locally isolated interface passed. Real server / official-version safety checks and other-platform joint debugging remain to be accepted. The server side follows marketing_touch_design.md; this document fixes the client semantics and replaces the old manual-claim banner's preview-polling constraint. The shared display contract is in cloud-content-dialog.md.

## Contract and responsibilities

### Claim result uses no toast

`claim_zcode_plan` shows no toast on success or failure. Success keeps the server `success_popup` (nothing extra if unconfigured); failure, safety-check cancel, and uncertain results keep the existing failure dialog. The Provider's extra success toast is removed; no new state/timers; the server protocol, entitlement refresh, polling, and confirm/cancel reporting are unchanged. Toasts for non-claim actions (copy success, navigation) remain, shared by desktop and Web.

```text
claim result → Controller → success: success_popup (if any)
                     └→ failure/uncertain: failure dialog
                     neither path triggers an extra toast
```

Regression: no toast on Provider success or on later refresh failure; MTC-03/04/06/08 and MTC-FAIL observe the toast DOM from real claim through the result popup and assert no success/failure toast, keeping the original dialog and report assertions.

### Server protocol alignment

Per `marketing_touch_design.md` §7.3.1, the marketing banner background and popup hero accept only `image / video / bundle`. The unagreed `lottie`, `lottie.dark`, and playback-parameter integration is withdrawn; client-custom fields are not treated as server capabilities. The generic Lottie player stays in the codebase but is not wired to marketing delivery. Unsupported visual types are rejected per the existing single-delivery isolation rule without affecting other legal deliveries in the same batch; polling, resource caching, close, and reporting are unchanged. Earlier Lottie mock tests proved only the custom client chain, not server support.

### Claim failure dialog

`POST /api/v1/zcode-plan/billing/claim` failure responses: the `msg` is never displayed; only `data.message` (already translated server-side) is used as plain text, newlines preserved, HTML/Markdown not interpreted. When message is missing, non-string, or whitespace-only, the App uses a localized generic failure text and no longer derives dates or copy from error codes such as 1005. The claim endpoint accepts numeric and numeric-string codes; a missing code still fails; success still requires code=0 with data.plan present; other endpoints' unwrapping is unchanged.

The Controller is the single error-state source and carries the owning action; only `claim_zcode_plan`'s failure feedback changed from toast to dialog. The dialog has no visible title, hero, or close X; content is the existing Alert + InfoIcon + AlertDescription with a right-aligned 「知道了」 below. A screen-reader-only title is kept; long text wraps and scrolls. The Alert reuses only semantics and text/icon layout — background, border, and padding removed, forming no second visible container; the outer dialog is unchanged. Light/dark themes and narrow screens are supported. Mask/Esc/知道了 only clear the error — no claim retry, no extra confirm/cancel. When an existing marketing popup's claim fails, the original popup is temporarily hidden and restored after dismissing the hint; other action errors keep toasts.

```text
claim response → service reads data.message → Controller error + action
                                   → pending=false → failure dialog
知道了/Esc/mask → clearError → existing delivery/polling logic (no auto claim)
```

MTC-FAIL: service unit tests cover string/numeric codes, msg ignored, message verbatim/missing/blank/invalid; component tests cover the info Alert, no visible title, plain text, close without retry; Controller tests cover pending collapse and error cleanup producing no reports; App E2E runs real banner → safety check → claim failure → dialog → 「知道了」, verifying server copy, light/dark and narrow layouts, claim count, and no confirm/cancel. Desktop and Web share the components and the same Host service mapping; session continuous/replayable boundaries are unchanged.

### VisualBody and formatted text

The banner background and popup hero share VisualBody: image / video / bundle. Video (MP4) reuses prepareMarketingHero's download, digest validation, playable preload, and fallback — no new cache or state source. The banner is a fixed 96px; video is muted, looping, without controls, and never intercepts the whole-image button click; it pauses when the page is hidden or reduced motion is on, and shows the fallback on playback failure. The hero's original video controls are unchanged; ZIP still waits for ready before display.

```text
GET → VisualBody validation → prepareMarketingHero → Controller current delivery → Banner/Hero
text format/content → adapter (formats preserved) → shared safe render → title/description/buttons
```

Plaintext renders verbatim; markdown supports paragraphs, headings, emphasis, lists, quotes, code, links, and tables; HTML embedded in markdown renders as text — use the html format for HTML. HTML and markdown output both pass the same safe tag/attribute rebuild, keeping the existing class/style rules, executing no scripts and loading no embedded images. Titles and buttons use inline mode (block tags become spans); links show text only, producing no nested interaction; http(s) links in descriptions still go through the platform callback. Legacy shared-dialog string title/label stays compatible; the marketing adapter provides formattedTitle/formattedLabel for UI use only, with no new server fields. Text emphasis inherits the button foreground color and must not break primary-button contrast. Button actions, seq, and reporting are unchanged. Desktop and Web share the components; Host, remote-control, and session message semantics are unchanged.

Acceptance: the protocol accepts video; resource failure falls back; component tests verify safe markdown/HTML layout, title/button format preservation, and clicks; MTC-RICH E2E verifies real-App rich text display, close reporting, and the video banner.

### Popup button theme

Popup content buttons always show text only; no share icon, copy-check, or other icon is auto-added per action. Copy-success text feedback, repeated clicks, disabled states, and confirm/cancel reporting are unchanged; the top-right close X is unaffected. Component and MTA-01 E2E cover no SVG before/after copy.

Standalone popup and success_popup `buttons[].theme` supports variant/class/style. variant is default/outline/secondary/ghost/destructive/warning/link; omitted or empty string equals default. An omitted or null theme also uses default — it is no longer derived as secondary for close actions. class/style are optional strings (each at most 512 characters); class merges through the existing `cn` with no class-name whitelist — only classes already compiled into the App's Tailwind take effect; no remote Tailwind compiler runs. style reuses cloudDescriptionStyle's attribute/value validation, allowing colors, text, and limited spacing among the existing properties, and forbidding resource URLs, fixed positioning, and `!important`; the final inline style overrides class, and class overrides base layout and variant. The banner ignores theme (including unknown variants); close/loading styles stay as-is. The popup's top-right X, mask, and Esc are not part of buttons[]; behavior and style unchanged. Text nodes keep only format/content; the legacy text.style is dropped as an unknown field without rejecting historical deliveries. class/style inside HTML text content keep the original parsing.

```text
delivery → popup/success_popup theme validation → adapter → shared Button
     → banner theme ignored
click → original action Controller → original confirm/cancel report
```

MTC-THEME: protocol covers the seven variants, defaults, lengths, legacy-field dropping, and banner ignoring; component tests cover class/style precedence, dangerous-style filtering, and clicks; the MTC-HTML E2E also verifies button theme, light/dark/narrow, and cancel reporting. Desktop and Web share the components; no service-process or remote-sync boundary changes.

Follow-up fixes (2026-09-12, see [E2E implementation record](testing/marketing-touch-e2e-implementation.md)): `providerSettingsService.refresh("marketing-plan-claim")` is wired with best-effort entitlement refresh; `providerId` navigation matching and the Root error-state icon import are fixed, restoring typecheck. The interaction-bundle popup initially focuses the parent-layer close button so the iframe cannot swallow the first Esc; the user can still enter the hero. On Host exit, cloud resource services exposing only `disposeAllAndWait` are recognized, waiting for lease and this Host's cache directory; the synchronous exit path only starts best-effort cleanup and does not treat it as awaited. The new regressions remain pending; full coverage and platform gaps follow the implementation record — no 95% coverage claim.

### Refresh after task completion

When a mounted workspace observes a session moving from non-complete into `completedSuccess`, refetch `GET /api/v1/marketing/touch` once, updating both banner and popup candidates. It does not depend on the system notification toggle. The first history snapshot, the baseline after workspace switch/reconnect, repeated completed states, failures, and manual interruptions do not trigger. Multiple completions in one batch trigger once; in-flight requests are still merged by the window's single poller into one follow-up query. Hidden pages send nothing and reuse the existing refresh on becoming visible. Popup display stays under the existing occlusion and dedup gates.

```text
CLI task owner → sessions-index read-only projection → workspace hook observes success-completion edge
  → window Marketing Touch poller → query → banner/popup candidates under existing display gates
desktop continuous / mobile replayable: original transport; no new message recovery or task-state owner
```

The workspace hook reuses the endpoint + workspaceIdentity (local fallback workspacePath) registry subscription and stores only the previous observed value; it does not subscribe when RPC is not ready, clears the observation baseline while not live, and releases references on unmount. Acceptance MTC-TASK-COMPLETE: refresh on successful completion; no refresh on history/failure/interrupt; repeat dedup; completion after another run; batch completion merged; baseline reset after reconnect; remote identity; cleanup; hidden/in-flight scheduling.

### Shared bottom-left slot with the Highspeed share card

The sidebar-bottom token-claim marketing banner and the Highspeed share card (global notification `highspeed-share`) collapse into the same display slot. When both hit, the token banner wins and covers on top; only after the banner disappears or is closed does the slot show the Highspeed share card. The arbiter is the read-only projection component `SidebarBottomActivity`: it reads each side's store visibility and renders one, duplicating no state and adding no timers. Banner "visible" reuses the single predicate `isMarketingBannerRenderable` (`banner && resource_position === "banner" && (image || bannerHero)`, still visible during claim `pending`). Full ordering and ownership: [Highspeed card spec §9.5](highspeed/highspeed-card-spec.md).

```text
banner visible → render token banner (covers Highspeed)
banner gone/closed/pending ends with no delivery → same slot renders the Highspeed share card (if still in the 24h window)
```

### Startup request sequence number

`GET /api/v1/marketing/touch?seq=0`: the first real request uses 0 and increments afterwards. The sequence is held in-process by the Marketing Touch service module and shared across service instances; component remounts and workspace, account, or language switches do not reset it. It is not persisted and restarts at 0 with the service process. Each desktop window Host and each standalone Web service process counts separately; mobile reuses the service process's number through the existing service entry — no cross-client sync. The number is assigned after credentials/device/language validation passes and HTTP is about to be called; network failures and response-parse failures also consume it, and concurrent requests never duplicate. Requests never issued, paused polling, and POST actions do not consume it. It is for server-log correlation only and does not change delivery decisions, polling period, dedup, or reporting semantics. This convention overrides the server doc's earlier description of starting at 1.

```text
process start(0) → request validation → GET seq=0 → GET seq=1 → ...
                         failures also increment; service-instance rebuild does not reset
```

Acceptance: service tests cover first call, consecutive/concurrent, failure, validation rejection, login and language changes, service-instance rebuild, new-process module init, and actions not counting.

### Banner border and radius

The whole-image button for images, ZIP, and fallback uses `h-24 border border-border rounded-xl overflow-hidden` uniformly (fixed 96px including border, 1px theme border, 12px radius clipping), width adaptive, no added background or shadow. This rule supersedes the historical borderless and proportional-height conventions. Images fill with object-cover; the ZIP viewport fills the 94px content area; height is no longer computed from a 236:100 ratio — bundles must respond to variable width and fixed height. Close/loading remain sibling overlays, keeping ghost/rounded-full, their original position, and the keyboard focus ring. Desktop, mobile Web, and light/dark themes use the same component; ready/cache/action/report state is unchanged. MTC-03 and MTC-BUNDLE check fixed height, computed border, radius, overflow, and corner hit areas, with existing click/close/loading/report regressions kept.

### Banner ZIP resource bundle

`banner.background` supports `image | bundle` (no video/lottie). The bundle shares `{type:"bundle",bundle:{bundle:{src,sha256},entry:"index.html",fallback?:{src,sha256}},args?:{...}}` with the popup hero. Legacy image deliveries stay compatible; banner button rules and success_popup are unchanged. ZIPs use the existing host authorization, SHA-256 verification, safe extraction, and lease/cache — no new download entry.

Background example (URL/hash are placeholders; replace with real resources and SHA-256 at publish time):

```json
{
  "type": "bundle",
  "bundle": {
    "bundle": {
      "src": "https://cdn.example.com/weekend-banner.zip",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "entry": "index.html",
    "fallback": {
      "src": "https://cdn.example.com/weekend-banner.png",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  },
  "args": { "planName": "Weekend Build", "amountValue": "300,000,000", "amountUnit": "Tokens" }
}
```

```text
GET -> shared Schema -> resource authorization -> prepareMarketingHero(background)
                                      -> ZIP lease -> isolated iframe -> init(args/theme/locale)
                                                                   -> ready -> banner display
                                                                   -> error/5s -> fallback / hidden
App whole-image button/close -> original Controller -> safety check/claim -> confirm/cancel
```

The banner width adapts to the sidebar; the bundle must respond to that viewport at the fixed height. The iframe is transparent, not focusable, and receives no pointer events; the App's whole-image button takes clicks and keyboard, with close and loading overlaid on top. The bundle renders only visuals and its own animation; in-package action messages never execute business, and no in-package click/drag interaction is provided. The `zcode-cloud-hero-v1` init/theme/visibility/destroy/ready/error messages keep being used; args pass through the existing plan-display mapping into data, raw args fields are kept, and no credentials are included. Resize keeps the fixed height.

The Controller stays the single owner of delivery/actions; components hold only the iframe-ready state. The iframe is mounted off-screen with clipping after download/extract complete; nothing is shown or enabled before ready. Errors use the validated, decoded fallback; otherwise the banner hides with no report. Replace/withdraw/close/identity switch discards late resources by the existing generation mechanism and releases the lease; success_popup and banner resources are held separately and released together. Identical deliveries do not remount; resources are reused via the existing cache; no campaign dedup is added. Web never requests the desktop loopback and shows only the fallback; without a fallback it hides. Shared components cover theme/language/narrow screens; task continuous/replayable and remote-control attachment are unchanged.

Acceptance: MTC-BUNDLE unit tests cover schema, authorization, data mapping/lease, ready/forged messages/error/timeout, remount, pending controls, and ignoring in-package actions; App E2E uses a real ZIP to verify ready-then-show, dimensions, data, theme, click/close reporting, and same-SHA cache reuse. The original image E2E is kept; platforms not verified must be listed in the completion record.

### New actions

See [navigate and copy_text protocol](marketing-touch-actions.md): the client has integrated settings-section, plugin management/marketplace/detail navigation, and plain-text copy; no task creation or model switching. Navigation closes the content and reports confirm after the target component confirms; copy keeps content and reports confirm per real copy, and closing the banner/standalone popup afterwards still reports cancel. Neither triggers success_popup.

HTML descriptions support class without a class-name whitelist filter and inline style after attribute/value validation; full rules in [HTML styling](cloud-content-html-styling.md). Only packaged Tailwind CSS applies; the outer description.style is unchanged; server content must be trusted — no layout isolation is promised for arbitrary classes.

Upgrade purchase uses `{"type":"navigate","args":{"page":"upgrade"}}`: desktop only, reusing the existing embedded website purchase page and sidebar provider selection, accepting no plan or auto-payment parameters. While the page readies, the marketing popup hides; failure/cancel/timeout restores the content with no confirm; one confirm after the page is ready means open success, not purchase success. Login and payment stay with the original purchase page.

The close control uses `ghost + rounded-full`, transparent by default with the existing hover style; loading likewise has no background, avoiding color flashes on state changes. Neither adds `bg-card`. Display-layer only; the same component is shared across themes/desktop/mobile; action and report state unchanged. MTC-03/04 verify the transparent computed styles of close and loading.

### Banner protocol naming

Per the new server doc, the resource position is uniformly `resource_position: "banner"` with content field `banner`; the legacy `card` protocol is no longer accepted and an unknown legacy position is rejected independently without affecting a legal popup in the same response. Components, public types, Controller state/actions, tests, and testids all use Banner/banner. The migration changed names only: plain images, empty button labels, close/loading, resource validation, success popup, polling, and reporting semantics are preserved, with no extension of banner background types. The Controller remains the single state owner; desktop and mobile share the path; task continuous/replayable boundaries unchanged. Common Card style tokens and entitlement-card naming were out of scope.

### Text, API shape, and banner rules

The text `style` is optional metadata: omitted, `null`, or object are all legal; omitted/null uses the client default style, and an object is still never injected into the DOM. This applies uniformly to banner buttons, popup title/description/buttons, and success_popup; it does not loosen business-parameter validation such as action.args.plan_id.

`GET /api/v1/marketing/touch` returns data.server_time, language, deliveries; each delivery uses the banner or popup field per resource_position, with no content wrapper. `POST /api/v1/marketing/touch/action` sends only campaign_id and action_type (confirm/cancel). Both carry X-Device-Mid, X-Client-Language, X-ZCode-App-Version, and optional Authorization.

The banner is the bottom-left image or ZIP slot. Buttons allow at most one close and one non-close; close reuses the top-right X; the regular action binds the whole image; there is no banner.action. Unknown layout/action, multiple regular actions, or a banner background outside image/bundle is rejected independently without affecting the other slot. The popup hero may be empty; it supports image/video/bundle; the server has no lottie for now. Text uses the existing plaintext/html/markdown rendering (an empty banner-button format is treated as plaintext; markdown currently renders raw), and remote style is ignored. Button text is extracted as safe plain text for labels.

"Banner" is the API resource-position name, not the client card appearance. The whole-image button follows the current border/radius rule above; the top-right close/loading controls keep their existing style and position, and the whole-image button keeps the keyboard focus-visible hint. Desktop, mobile Web, and all themes use one rule; this display-layer change does not affect polling, resource preparation, action, or report state.

Banner button labels may be empty (including whitespace and empty-after-extraction HTML): a close action shows the X, a non-close action enables the whole-image click, and action existence is never inferred from label truthiness. ConnectedBanner derives hasAction/hasClose from the actions and uses localized common.open/common.close for empty labels — aria-label/image alt text only, adding no visible copy. Without the corresponding action, the whole-image button stays disabled and the X stays hidden; during pending, the whole image stays disabled and the X becomes loading. MTC-04/08 cover empty-label click, close, and reporting; other delivery/remote semantics unchanged.

`banner.buttons` `text.format` additionally allows the empty string `""`; the shared schema normalizes it to `plaintext` regardless of content and does not reject the delivery. This applies only to banner.buttons — standalone popup and success_popup titles, descriptions, and buttons still require plaintext/html/markdown; unknown, missing, or null formats are still rejected. The original parse → resource preparation → display/action-report path, state owners, and desktop/mobile chains are unchanged. MTC-01 unit-tests the scope and illegal values; MTC-03/04/08 HTTP fixtures use empty format and content to verify whole-image action, close, loading, and reporting.

The service DTO is separate from CloudContentPayload; the adapter creates internal button IDs and the instance revision, and the content-change identifier is not a delivery batch. hero.args provides display data through an explicit mapping, carrying no credentials and triggering no host business. All URLs/hashes are validated before use.

```text
Touch Service -> App Shell Controller -> Banner / Popup queue -> CloudContentDialog
                       |                    |
                       |                    -> Asset Service -> verify -> decode/extract -> ready
                       -> registered action -> safety check -> claim -> confirm report
                                                           -> success_popup
```

The service owns HTTP/credentials/file IO; the stable Shell Controller is the window's single owner of display state and polling. Switching workspaces does not spawn a new delivery instance; remote workspaces use local App capabilities. main/relay/Agent hold no marketing business state. Shared components and mobile layouts are reused; the desktop-continuous/web-remote-replayable task message chains stay isolated. A resource lease is not a task owner lease.

## Resource and action sequencing

Banner images download, SHA-256 verify, and decode before display; failure hides. Popups prepare resources before opening; if the main resource fails, the fallback is prepared; without a fallback, degrade to body text and close. Videos download fully and are verified; ZIPs are safely extracted to obtain the controlled entry, and a ready-handshake timeout degrades. The ZIP size declaration is optional; actual bytes/expansion are always capped — forged sizes are forbidden. The existing ZIP 8MiB / expanded 32MiB limits apply. Trusted sources are host-configured; arbitrary addresses and redirect bypasses are rejected. Web does not use the desktop loopback; a bundle without safe hosting shows only the fallback.

After a banner arrives, the success_popup is prepared in the background; business actions are never pre-executed. Resources are reused by hash; cancel/identity switch/unmount release references; late results never reopen content.

```text
ready -> login -> verifying -> submitting -> success-preparing -> result
                    |              |
                    -> cancelled   -> failed / uncertain
                           |               |
                           -> ready        -> reconcile or explicit feedback
```

During verify/submit/waiting-for-result the image is unchanged, there is no mask, and the top-right X becomes loading; a sync lock prevents double-clicks, with localized aria-live text. The safety-check interaction entry stays available. Cancel or a clearly retryable failure restores the X. Requests pin the campaign/action/success_popup snapshot; background polling cannot replace the banner being operated on. A successful claim is an immediate fact; entitlement/provider refresh runs in parallel, best-effort, and never reverses success. Timeouts never auto-resend write requests; without query/idempotency support, show explicit result-pending feedback. All waits are bounded. Without success_popup, use local success feedback.

## Polling and display

Production build plus `ZCODE_ENV=production` polls every 10 minutes; test or dev builds every 30 seconds. Random jitter is removed; failure backoff and event-triggered immediate refresh are kept. The old ManualClaimPlanBanner/ResultDialog and their dedicated helpers and tests were deleted; the input-box model-selection guidance, shared failure copy, hero HTML/ZIP, and test fixtures are kept.

```text
query done -> production build + production env ? 600s : 30s -> next query
hidden -> stop timer; foreground resume / success events -> merged into one immediate query
```

A single poller replaces the Banner Billing Preview scheduled request. Startup/visible resume/identity change/language change/network recovery/business success trigger refresh; identical in-flight requests merge, and the next query is scheduled via setTimeout after completion. Hidden pauses; resume queries immediately. A successful empty array clears candidates; failure briefly keeps the last valid banner (at most 10 minutes) — a network failure is never treated as an empty snapshot. Identity generations invalidate old responses; account switches clear the current operation view.

A standalone popup opens automatically once its resources are ready, the page is visible, and no modal/safety-check layer is up. The result popup outranks a pending standalone popup; a waiting popup that gets withdrawn is cancelled; opened content is pinned until closed and never changes with polling. While the same popup is showing, it is not re-queued; after closing, a subsequent GET re-delivery can open it again. Closing a popup does not affect the banner.

The server is the sole owner of delivery eligibility; the client keeps no processed/shown/reported sets keyed by campaign_id and uses no broadcast claim or processed events to suppress other windows. Each window displays per its own latest GET; the same ID and content may be shown again on later delivery, needing no new ID or batch fields. campaign_id only correlates the current delivery with action reporting — it is not a client blocklist.

```text
GET -> resources ready -> display -> click success/close -> hide current instance and report
                                            | discard in-flight responses from before the operation
next GET -> server still delivers same ID -> resources ready -> display again
         -> server does not deliver      -> no display
```

Only the Controller's current pending debounce, popup mutual exclusion, and generation late-response protection are kept. On operation completion, old queries/resource preparations are invalidated and the old deferred banner released — a pre-operation snapshot never restores just-hidden content; new requests are unrestricted by historical operations. After success, one refresh triggers once the current operation closes; claim requests are never auto-resent. Re-display and re-operation after close/success require fresh reporting — events are never swallowed per campaign.

## Reporting

User closes a banner/standalone popup → cancel for the owning original campaign_id; explicit business success or a host-accepted external link → confirm. Closing the success result again does not re-report cancel; safety-check cancel, explicit business failure, poll withdrawal, and download failure report no confirm. There is no live show event. One local operation produces one event: close the UI first, then report asynchronously. The server has no idempotency; POSTs with uncertain results are never retried. Report failures are logged and never block closing; old-account events are never sent with new credentials.

Server-delivery authority regressions (2026-09-10): same-ID banner re-display and re-report after success/close, popup re-display, no stacking of the current popup, and discarding of pre-operation query/resource/deferred snapshots are covered by Controller/Poller/Adapter/Resources unit tests and macOS App delivery E2E, with the fixture withdrawing and re-delivering while keeping the same ID — never bypassing client filtering by changing IDs. Tests stay manual-review/pending and do not represent live claim, real safety checks, multi-window, or Windows/Linux/mobile device acceptance.

## Implementation and acceptance

Order: P0 spec/fixture → P1 DTO/service/adapter → P2 assets → P3 controller/poll → P4 banner/actions → P5 popup/report → P6 E2E/migration.

| Case   | Scenario and assertion                                                              | Layer            |
| ------ | ----------------------------------------------------------------------------------- | ---------------- |
| MTC-01 | both slots parse independently; a bad banner does not affect the popup; unknown action/layout rejected | unit             |
| MTC-02 | GET/POST required headers and original IDs; account switch rejects late reports; POST never retried | service          |
| MTC-03 | banner hidden before validated decode; wrong hash rejected; same hash cached and reused | integration/E2E  |
| MTC-04 | rapid double-clicks produce one claim; X→loading; safety-check cancel restores       | unit/E2E         |
| MTC-05 | polling content changes never replace the pending action snapshot; late responses isolated | unit/E2E      |
| MTC-06 | success fact never reversed by refresh failure; preload/failure degradation/no result popup | unit/E2E    |
| MTC-07 | standalone popups never stack; same-ID re-delivery reopens after close; withdrawn candidates cancel | unit/E2E |
| MTC-08 | close cancel, success confirm, result close not re-reported; failure never blocks    | unit/E2E         |
| MTC-09 | hidden pause/resume, serialization, failure backoff, empty array, language/identity generation | unit      |
| MTC-10 | no cross-window history blocking; narrow/theme/keyboard; Web bundle degradation      | integration/E2E  |
| MTC-11 | same-ID banner re-displays and reports after close/success; old responses cannot revive an instance | unit/E2E |

Fixtures use a local controlled endpoint, real ZIP/hashes, and a request ledger, claiming no live plans. Required: architecture:check, typecheck, lint, related unit tests, and App E2E; platforms/paths not actually run are listed as gaps. Test and completion states are backfilled separately; old mock tests never stand in for real integration passes.

## Current implementation boundaries

### Temporary App Mock removed

The "content mock" entry, preview components and copy, the CloudContentService debug RPCs (status/load/clear), the fixed mockOrigin, and the dev source-authorization bypass are removed. In every environment the App obtains deliveries and resource authorization only through Marketing Touch. The hero ZIP, HTML source assets, packaging, and automated-test fixtures are kept; the test server is not mounted into the App's normal startup chain.

```text
App -> Marketing Touch GET -> URL/hash authorization -> ZIP prepare/release -> Dialog
test runner -> standalone fixture server (not an App fallback entry)
```

Acceptance: no preview entry or debug RPC in the App; unauthorized ZIPs rejected; authorized ZIP download/cache/iframe-ready and confirm/cancel keep passing. Preview-panel-only cases were retired; Marketing Touch E2E gained an entry-not-present assertion. Task/remote sync and ZIP contents unchanged.

The claim-failure copy function is a standalone pure module; Marketing Touch no longer pulls the local mock payload through the old banner. The old banner component and its tests are deleted; only the standalone hero test fixture remains.

- Allowed download media: PNG/JPEG/WebP (8 MiB), MP4 (16 MiB); SVG/arbitrary HTML are not accepted as images. The resource whitelist is granted only by host-verified GET responses as URL + SHA-256; with the dev mock entry closed in production, authorized ZIPs still load. Images/video are consumed as data URLs after validation; ZIPs go through the separate safe resource service. Network requests are capped at 30 seconds and decoding at 10 seconds; stale results are dropped and leases released — already-delivered server-side business requests cannot be canceled.
- Cache directory: `cache/content-bundles/<host-instance-uuid>/` under the host app config dir; safe extraction and reference counting reuse the existing ContentBundleCache; nothing is written into the workspace, and ZIP entries are never used as arbitrary disk paths.
- No cross-window marketing claim or processed broadcast; safety checks and business requests promise only the current Controller's synchronous debounce. The server eligibility check is the authority for cross-window claim facts — without a backend idempotency key, global exactly-once cannot be promised.
- Web reuses components and host services; bundles use the fallback; the desktop loopback is never accessed. A standalone Web/server without a host deviceMid rejects the query before HTTP and never fabricates a device identity; remote host attachment and task realtime chains are unchanged.
- Later deliveries of the same campaign fully follow the server, needing no batch identifiers. Theme, i18n, cross-platform resource policy, and desktop-continuous/web-remote-replayable message semantics are unchanged.

## Verification record

Final state: all client behaviors above are implemented and covered by dedicated unit tests and macOS Electron App E2E against locally controlled fixtures (real HTTP/ZIP/iframe-ready, suspended-claim loading, confirm/cancel ledgers, no preview requests). Entitlement E2E keeps entitlement refresh and Start/Individual and subagent selection linkage.

Promoted 2026-09-12: the three specs (delivery, entitlement, anonymous) live in `packages/desktop/test/e2e/ui-shell/`. Rerun: `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/ui-shell/marketing-touch-*.test.ts'`, no MANUAL_REVIEW switch needed. Fixtures auto-provide banner, standalone popup, ZIP hero, suspended/released claim, and the report ledger, without touching real plans. Local Electron, no Docker. Latest evidence and coverage boundaries: `docs/testing/marketing-touch-e2e-implementation.md`.

Open/unverified: live campaigns and claims, the real safety-check service, multi-window on real machines, Windows/Linux, mobile Web, and dual-theme narrow-screen visual acceptance — local fixtures never stand in for these. Typecheck, E2E typecheck, and architecture checks pass; lint reports 0 errors with ~46 pre-existing warnings.

Full history: git show 43d52cbd:docs/marketing-touch-client.md

## Push regression-fix constraints

When the full gate hits a native SIGSEGV in the Node 24/macOS threads pool, `ZCODE_TEST_POOL=forks` can switch regular cases to a two-process isolated mode; the test set, assertions, and existing serial isolation groups are unchanged, and threads remains the default. (Crash evidence: node-2026-09-11-200243.ips; the specific V8/native-module defect is not yet identified.)

Marketing integration must not delete or roll back existing non-marketing translations; new marketing copy is kept. The test server mounts marketing fixtures only when marketingTouch is explicitly enabled; old plan tests do not take the marketing release handshake. The Root isolation test replaces the marketing business subtree at the Provider boundary, avoiding incomplete dependencies and first-round module-import timeouts; marketing business stays covered by dedicated unit tests and App E2E, with production selection logic unchanged.

```text
old plan test -> default server -> claim responds directly
marketing E2E -> explicit marketingTouch -> claim waits -> release -> respond
```
