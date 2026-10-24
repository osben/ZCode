# Marketing Touch: navigate and copy_text protocol

Updated 2026-09-11. Status: client implemented, verified in the macOS isolated App; server-side version/platform targeting and statistics semantics still need joint debugging — not a launched feature. Client integration is described in [Marketing Touch client integration](marketing-touch-client.md). This document's update does not mean the new actions can already be delivered.

## 1. Scope

| Action | Status | Purpose |
| --- | --- | --- |
| close | implemented, kept | close marketing content |
| open_url | implemented, kept | open HTTP/HTTPS pages |
| claim_zcode_plan | implemented, kept | reuse eligibility, safety checks, and claim flow |
| navigate | added this round, client implemented | settings section, provider settings, plugin marketplace and detail navigation |
| copy_text | added this round, client implemented | copy raw plain text, never execute |

Explicitly not done: `create_task`, `select_model`, prefilling prompts, installing/enabling plugins, auto-authorization, workspace selection, and feature onboarding tours. Never restore the old claim flow's auto-switching of plan connection and model.

Unchanged: image-only banners, empty-label buttons, ghost transparent close/loading, show-after-resources-ready, production 10-minute / test 30-second polling, server-driven re-delivery, Hero ZIP validation and sandboxing.

## 2. Delivery structure

```json
{
  "text": { "format": "plaintext", "content": "打开插件市场", "style": null },
  "action": { "type": "navigate", "args": { "page": "plugin_marketplace" } }
}
```

| Location | Display and behavior |
| --- | --- |
| banner.buttons[] | at most one close and one regular action; the regular action binds to the whole image, its label may be empty and only supplies the accessibility label |
| popup.buttons[] | visible buttons of the standalone popup |
| banner.success_popup.buttons[] | visible buttons of the success popup |

No new top-level banner.action and no action arrays. Text keeps the existing plaintext/html/markdown and optional/null style contract; style is never injected into the DOM.

## 3. navigate parameters

Four top-level pages: settings, plugin_marketplace, upgrade, rewards. Stable protocol identifiers are mapped by the client onto existing entries; route paths and component names are never exposed to the server.

| Param | Type | Required | Constraint |
| --- | --- | --- | --- |
| page | enum | yes | settings / plugin_marketplace / upgrade / rewards |
| section | enum | no | settings only, from the whitelist below |
| provider_id | string | no | settings + models only, real stable provider id |
| plugin_id | string | no | plugin_marketplace only, full plugin id from the trusted catalog |

IDs are non-empty, at most 128 characters. Optional fields are omitted, never null. The new actions' args are strictly validated for unknown fields, enums, and parameter combinations; delivery keeps the existing single-item isolation policy.

### Invite friends

`{"type":"navigate","args":{"page":"rewards"}}` accepts no other parameters; the old page=referrals is no longer accepted. It opens the rewards center /{cn|en}/rewards; the old /{cn|en}/referrals is no longer supported. Banner, popup buttons, and resource-pack interactions share the same action dispatch and confirm reporting. Client support does not mean the server has started delivery.

On navigation, RewardsProvider opens immediately when logged in; when not logged in it requests the unified app-login and records this loginAttemptId. It opens once after success with the user ready; cancel, failure, or a replaced attempt clears it, and later unrelated logins do not open it. This pending intent lives outside the marketing controller, which is rebuilt after login. confirm means the navigation intent was received — not login or reward success; no new or duplicate reporting.

```text
navigate(rewards) → RewardsProvider → logged in: open
                                      → not logged in: record login attempt ID
                                          → same ID success + user ready: open once
                                          → cancel/failure/new ID: clear
```

Desktop uses the existing isolated WebView; Web/mobile use the existing HTTPS external open without forwarding App tokens. Language, theme, environment, and auth follow the Rewards integration contract; task and remote-control state are unchanged.

### Settings section whitelist

| Page | Delivered section | Current internal id |
| --- | --- | --- |
| General | general | general |
| Appearance | appearance | appearance |
| Model settings | models | modelProvider |
| Browser control | browser | browser |
| Computer control | computer_use | computerUse |
| Memory | memory | memory |
| Subagents | subagents | subagents |
| Plugin management | plugins | plugin |
| MCP servers | mcp | mcp |
| Skills | skills | skill |
| Commands | commands | commands |
| Hooks | hooks | hooks |
| Indexing | indexing | indexing |
| Usage | usage | usage |

An omitted section keeps the settings default/last section; if already open, the existing settings page is activated. The bottom "guide" is not a normal settings section and is out of scope. Never pass through legacy internal ids such as plugins or automations verbatim.

Open model settings:

```json
{ "type": "navigate", "args": { "page": "settings", "section": "models" } }
```

Locate a specific provider — locate only, never switch model/plan/connection or auto-authorize:

```json
{
  "type": "navigate",
  "args": { "page": "settings", "section": "models", "provider_id": "<real provider id>" }
}
```

Open skills:

```json
{ "type": "navigate", "args": { "page": "settings", "section": "skills" } }
```

### Plugin management and marketplace

| Target | Full args | Boundary |
| --- | --- | --- |
| Manage installed plugins | `{"page":"settings","section":"plugins"}` | opens the management home only |
| Browse the marketplace | `{"page":"plugin_marketplace"}` | opens the marketplace home only |
| Marketplace plugin detail | `{"page":"plugin_marketplace","plugin_id":"name@marketplace"}` | shows only that plugin's detail |

```json
{ "type": "navigate", "args": { "page": "settings", "section": "plugins" } }
```

```json
{ "type": "navigate", "args": { "page": "plugin_marketplace" } }
```

```json
{
  "type": "navigate",
  "args": { "page": "plugin_marketplace", "plugin_id": "<plugin name>@<marketplace id>" }
}
```

No separate page=plugin_detail; detail is always plugin_marketplace + plugin_id. The current entry identifies plugins by "name@marketplace"; real values must come from the trusted catalog — placeholders must not ship.

This round does not locate an installed plugin, support query search parameters, or auto-install/enable/uninstall. A missing plugin fails explicitly; it never silently opens the home page.

No new plans, help, or release_notes enums; external pages keep using open_url. Arbitrary internal routes, URLs, component names, local paths, or RPC methods are rejected.

### Upgrade purchase entry

`{"type":"navigate","args":{"page":"upgrade"}}` reuses the existing CodingPlanUpgradeDialogProvider and embedded website purchase page; it accepts no plan/provider/auto-purchase parameters. The provider follows the current sidebar upgrade target resolution. The embedded webview is desktop-only; Web/mobile fail explicitly and create no new purchase runtime.

```text
marketing click -> current upgrade entry inventory guard -> original purchase container -> webview dom-ready
              |                            |                 |
           not ready: fail           load fail/close: fail    confirm
              +----------------------------+                 |
                        restore marketing content             collapse marketing content
```

While waiting, temporarily hide the marketing Dialog and keep the Controller snapshot; a 30-second timeout, account change, or unmount closes this pending container, and late events do not report success. The normal entry is unchanged. Login has moved into the website page and is no longer App-prompted then resumed; a successfully opened purchase page means navigation success — later canceling the web login or closing the purchase page does not revoke confirm, is not purchase success, and places no order or payment. The existing post-purchase refresh is unchanged.

Acceptance: reject extra upgrade fields strictly; no confirm on inventory unavailable, failure/close/cancel; after the real isolated webview is ready the marketing popup disappears with exactly one confirm; existing upgrade entry regression passes.

## 4. copy_text parameters and feedback

| Param | Type | Required | Constraint |
| --- | --- | --- | --- |
| text | string | yes | at most 20,000 characters; whitespace-only rejected; original text and newlines preserved |

```json
{
  "text": { "format": "plaintext", "content": "复制提示词", "style": null },
  "action": {
    "type": "copy_text",
    "args": { "text": "请帮我审查当前工作区的代码改动" }
  }
}
```

- Copies raw plain text; commands or HTML inside are never executed or parsed as executable.
- No prefilling the input box, creating tasks, or auto-sending.
- On success the Banner/Popup stays; no success_popup.
- Popup buttons briefly show a localized "copied", then restore the original label, reusing the shared popup's existing 2-second feedback.
- The Banner uses a localized success hint; no new permanent text.
- Write failure shows a hint and restores the action; never fake success.
- The user can click again; each click performs a real write; in-flight operations are debounce-protected.

No remote parameters such as close_after_action, report_type, or skip_confirmation; behavior is fixed client-side per action.

## 5. Client execution and state

The Marketing Touch Controller stays the single owner of marketing display and the current action. Navigation/clipboard reuse existing features through narrow capability adapters — no simulated DOM clicks, no direct changes to model, plugin, or task state.

```text
Banner / Popup button
        |
        v
validate type, args, current platform capability
        |
        v
Controller debounce
        +-- navigate --> navigation intent --> existing settings/marketplace entry
        |                                |
        |                                +--> target takeover confirmed --> collapse + confirm
        |
        +-- copy_text --> write success --> keep content + success hint + confirm

failure --> restore actionable state + localized hint, no confirm
```

### Navigation adapter

- settings first registers the section/provider intent, then opens or activates the settings page, reusing setPendingSettingsSectionIntent and openSettingsTab.
- plugin_marketplace reuses the marketplace open and plugin-locate entries.
- Existing entries' event/state updates are completed by in-window one-shot request correlation plus success/failure confirmation; dispatching an event alone must not claim the page was shown.
- Success means the target page is active and the requested section/provider/plugin location completed; already being in the target state also confirms success.
- A missing target fails without silent fallback to the home page; while lists are still loading, wait for the existing load result instead of misjudging.
- Coordinate the marketing popup and target page modal layers through existing mechanisms to avoid focus fights; failure keeps/restores a retry entry.
- navigate success shows no success_popup, so it does not cover the new page. This applies only to the new actions; existing claim/external-link behavior is unchanged.
- Only claim_zcode_plan queries eligibility immediately after success. open_url/navigate/copy_text do not trigger that query, avoiding a race between async confirm and re-query reopening an already-closed old popup; normal scheduled polling and server re-delivery remain, with no history deduplication.
- The plugin marketplace lives inside the workspace: after sending the marketplace intent, activate the original workspace (with workspaceIdentity); the target component verifies the active workspace identity and list/detail state before confirming — a mount behind the settings layer is not success.

### Clipboard adapter

Prefer existing capabilities; add cross-platform adaptation where no unified entry exists. Triggered by user click; handle permissions, security context, and host limits; feedback and reporting happen only after a successful write.

The shared CloudContentDialog's internal navigate/copy_text dispatch and copy feedback are wired into Marketing Touch. Navigation correlates the original args via the internal button ID, so section/provider_id/plugin_id are never lost; the copy handler reports failure back to the shared popup, and only real success shows "copied".

### Lifecycle and multi-client

- During an action, the original campaign, account generation, window, and request context stay pinned; polling must not replace the executing snapshot.
- The banner image is unchanged; the close slot uses transparent loading with the existing pending debounce and close-interception policy.
- Async capabilities must wait with a bound; timeouts follow the existing capability, and no fixed delay may fake success.
- After identity change, target invalidation, or unmount, late results must not reopen old marketing content, and old events must not be reported with new credentials.
- Discarding late UI does not undo navigation/copy side effects already produced; with an unknown timeout result, do not automatically repeat the action.
- Polling, resource caching, and same-ID re-delivery rules are unchanged; no campaign history blocklist is added.

```text
marketing Controller --> capability adapter --> existing settings/marketplace/clipboard
desktop task desktop-continuous ------> original realtime chain (unchanged)
mobile task web-remote-replayable ---> original shared-host / recovery chain (unchanged)
```

Desktop/Web/mobile share components and capability interfaces; shared UI never calls Electron APIs directly. Platforms without a page fail explicitly, and the server limits delivery by version/platform in advance. No separate Agent runtime; remote attachment, task streams, and workspace identity isolation are unchanged, and no arbitrary workspace path is delivered.

## 6. Reporting rules

The existing endpoint is reused; no new action_id:

```http
POST /api/v1/marketing/touch/action
Content-Type: application/json
X-Device-Mid: <valid UUID>
X-Client-Language: zh-CN
X-ZCode-App-Version: <actual app version>
Authorization: Bearer <present at login>
```

```json
{ "campaign_id": "<original delivery id>", "action_type": "confirm" }
```

The table is the client's intended semantics; the multi-event statistics rule for "keep view after copy" must be confirmed by the server before that delivery opens.

| Event | Report | Marketing content |
| --- | --- | --- |
| navigate success | confirm | closed |
| navigate failure | no success report | kept/restored with hint |
| copy_text success | one confirm per real successful copy | kept |
| copy_text failure | no success report | kept with hint |
| close standalone popup/banner after copy | cancel | closed |
| close claim success popup | no duplicate cancel | closed |
| new navigate/copy inside the success popup | confirm after success | handled per action |
| query, resource download, display | no show report | unchanged |

confirm/cancel are operation events, not mutually exclusive final conversion states. One campaign may confirm multiple times and cancel afterwards; closing does not undo a successful copy. Cross-polling deduplication must not be reintroduced for this.

The existing endpoint cannot distinguish which button within a campaign, so no button-level attribution; this round does not extend fields. A button labeled "确认" with action=close still reports cancel.

Anonymous users report at device level with a valid device UUID; after login, user and device are recorded. Reporting failure never reverses business success or blocks the UI, never auto-retries a POST with an uncertain result, and the server never accepts client time.

## 7. Failure, security, and compatibility

| Scenario | Handling |
| --- | --- |
| unknown action/page/section/field | rejected per the existing single-item isolation with the reason logged; other legal slots unaffected |
| target or capability gone after display | revalidate on click, hint failure, run no other action |
| page unsupported on platform | explicit hint; no compensating runtime |
| clipboard permission/write failure | no success hint, no confirm; user may retry |
| account change/unmount/target invalidation | invalidate old associations, discard late UI |
| timeout with unknown result | hint to check state; do not repeat side effects automatically |
| reporting failure | redacted log; navigation/copy not reversed |

No arbitrary scripts, RPC, credentials, silent installs, global config changes, or paid operations. Logs record only campaign, action, result, and error code — never credentials or the full copied text; UI uses the existing logger.

New clients ship first; the server then opens delivery gated on client version/platform, and the client keeps final validation. New deliveries incompatible with old clients must not be fully rolled out. No capability-negotiation interface is added this round.

## 8. Both ends

| Scope | Work |
| --- | --- |
| server enums/models | register both actions; strictly validate args by page/section |
| settings navigation form | page/section dropdowns; optional provider for models |
| marketplace navigation form | home page or a trusted-catalog plugin |
| copy form | plain-text body with length and non-empty validation |
| ops-to-client mapping | make the copy body source explicit; never mix button labels and body text |
| delivery policy | version/platform limits; confirm multi-event statistics semantics |
| Shared | action discriminated union; field and combination validation |
| navigation adapter | reuse entries; add request correlation and completion/failure feedback |
| clipboard adapter | cross-platform write and success/failure feedback |
| Controller/display | navigation collapse, copy retention; reuse pending and reporting |

Whether the copy body is configured directly in ops or references the existing i18n catalog is a server-side decision; the client always receives the final localized args.text and never resolves i18n keys.

Order of work: agree spec/event semantics → scan call boundaries → schema/behavior tests first → capability adapters and Controller → register both ends with version limits → isolated App E2E → real delivery joint debugging. UI never calls a Repo directly; no marketing-specific model/plugin state.

## 9. Acceptance matrix

| Category | Must verify |
| --- | --- |
| Schema | all page/section values, missing/empty, wrong combinations, unknown fields, length bounds |
| Settings | all sections, reuse when open, default page, provider exists/missing/loading |
| Plugins | management vs marketplace, home/detail, missing target, no auto install/enable |
| Side-effect-free navigation | no model switch, no connection/config change, no task creation |
| Copy | original text/newlines/HTML as plain text, success, permission failure, repeated copy |
| Display | navigation collapse, copy retention, neither triggers success_popup, failure recovery |
| Reporting | confirm/cancel, anonymous, close-after-copy, new actions in the result popup, report failure |
| State | debounce, account switch, unmount, target change, timeout, late results |
| UI | empty-label banner, transparent close/loading, light/dark, zh/en, keyboard, narrow screens |
| Multi-client | desktop/mobile supported and unsupported paths; task/remote chains unchanged |
| Regression | claim, close, polling, same-ID re-delivery, Hero ZIP validation and cache unchanged |

Update the spec while implementing, write tests before code, and run architecture check, typecheck, lint, unit tests, and App E2E. Passing the isolated fixture does not prove live eligibility, real safety checks, or all-platform acceptance; unverified paths must be listed separately.

### Implementation constraints

Navigation uses in-window one-shot request correlation; the target component confirms after React commit; the wait bound is 30 seconds, cancel/timeout clears the correlation, and nothing auto-retries. Provider location only changes the selected settings node and never invokes connection-save logic; a plan provider under the same family locates that family page and keeps the user's current connection. Built-in providers' real IDs carry the builtin: prefix (e.g. builtin:bigmodel); display names must not be used. Copy reuses the browser Clipboard API directly with a 10-second bound; no Electron-specific calls.

## 10. Open before launch

Source of the copy body (ops/i18n); server-side multi-event statistics; real provider and plugin IDs; per-platform page availability; navigation completion feedback and per-capability timeouts.

Client completion bar: both new actions and all listed targets implemented and verified in isolation. Launch additionally requires aligned version/platform policy and reporting semantics on both ends; the external server is not modified in this round.

## 11. Client verification record (2026-09-11)

Final state: both new actions implemented and verified in the macOS Electron isolated App. Schema, button adaptation, repeated copy, close-after-copy, new actions in the result popup, timeout/cancel, navigation correlation, and claim/polling/cache regressions pass in 10 unit-test files (86 cases). macOS isolated App E2E passes 11 cases (run `desktop-e2e-20260911034056333-p11822-7b0e93cb78872140`), covering all 14 settings sections, provider location without persisted connection changes, marketplace home/trusted-catalog detail, missing provider/plugin failure, real clipboard copy and repeated writes, simulated permission denial, and the confirm/cancel ledger, plus 5 legacy delivery/claim/ZIP regressions. The upgrade entry increment passes 6 unit-test files (96 cases) and 12 macOS E2E cases (run `desktop-e2e-20260911061657474-p89925-d239ab3a54e48ea1`); the marketing popup rendering was split into MarketingDialogs behind the single Controller.

Fixes found at runtime: a marketplace mounted behind the settings layer must not confirm success; the new actions skip the post-claim immediate eligibility query to avoid async reporting racing the old delivery's re-query. Test fixtures correlate per single delivery, so old reports must not clear new test data.

`pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm architecture:check --changed`, and format checks on changed files pass; `pnpm lint` has 0 errors / 46 pre-existing warnings. E2E stays manual-review/pending.

Not verified: real server-side delivery of the new actions and multi-event statistics, real safety checks, Windows/Linux/mobile real devices, dual-theme narrow-screen manual visual review. The external server was not modified; the App Mock entry stays removed; Hero ZIP is unchanged.

Full history: git show 43d52cbd:docs/marketing-touch-actions.md
