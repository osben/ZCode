# Embedded Browser Permission Governance Spec

## Background

A CNVD report, "ZCode embedded browser unauthorized access" (medium risk): the embedded browser lacked default-deny permission control for untrusted pages, so an attacker page could silently obtain sensitive capabilities such as camera/microphone, clipboard, and geolocation without any product dialog.

Verified state (2026-10-08):

- The embedded browser is a standard Electron 41 `<webview>` (`packages/ui/src/browser-use/BrowserViewportSurface.tsx:151`) whose session is the persistent partition `persist:zcode-embedded-browser` (`packages/desktop/src/main/browserDataManager.ts:32`).
- That partition registered no `setPermissionRequestHandler` / `setPermissionCheckHandler` / `setDevicePermissionHandler`; `desktopNetworkPolicy.ts` covers only proxy and certificates. The Electron default is to **auto-approve all permission requests**, so a malicious page's `getUserMedia` / `clipboard.readText` / `geolocation` requests were silently allowed, with no UI and no log.
- The existing hardening (`will-attach-webview` in `desktopWindowChrome.ts`: sandbox / contextIsolation / URL protocol allowlist / window-open routing) only isolates processes, it does not gate capabilities. The plugin sandbox partition already has a permission gate (`pluginSandbox/session.ts` + `permissionGate.ts`); its inflight de-duplication and in-memory consent pattern are reused here.
- For device classes (WebHID/WebUSB/WebSerial/Bluetooth) Electron **silently grants the first matching device by default** when no `select-*` event is listened to; screen sharing fails outright when no `setDisplayMediaRequestHandler` is registered.

## Goals

- Every permission request of the embedded browser partition is no longer auto-approved by default: harmless allowlist entries pass silently, sensitive capabilities go through a product dialog for a user decision, and everything else is explicitly denied.
- Three product dialogs: a permission confirm bubble (four states: allow this time only / allow while visiting this site / deny / close), a screen-share source picker, and a device picker.
- Persisted site consent records plus a settings "Site permissions" management (allow/block/ask).
- Every permission decision emits an audit log (info level, low frequency, kept in production).
- Camera, microphone, clipboard read, geolocation, notifications, MIDI, USB, HID, Serial, Bluetooth and screen sharing are all brought under this governance.

## Non-goals

- No change to the permission behavior of defaultSession, Coding Plan, Rewards, the plugin sandbox or the recording temporary session (scope narrowed to the embedded browser partition only, per the 2026-10-08 decision).
- No change to the partition persistence policy (login state is a product feature; the CNVD advice of a "non-persistent isolated partition" is answered mainly by default permission governance).
- No Chrome-style "remember site device grant" (device classes show the picker every time); no tab-level scope for "allow this time only" (it lasts for the app runtime).
- No macOS system-level (TCC) authorization guidance; after the page layer allows, the system constraints still apply, which is Chromium-layer behavior.
- No effect on the Web client and the mobile remote-control path; permission dialogs exist only in the desktop embedded-browser panel that hosts `<webview>`.

## Architecture and decision chain

The main process gains an `embeddedBrowserPermissionPolicy` module that registers all handlers once on `fromPartition(EMBEDDED_BROWSER_PARTITION)` at app startup (right after `applyDesktopChromiumNetworkPolicies`):

```text
guest page issues a request
  │
  ├─ permission request ──► 1. harmless allowlist? ──yes──► allow + info log
  │                            │no
  │                            ▼
  │                    2. look up consent record (memory sessionAllow → persisted JSON)
  │                       ├─ allow hit (either layer) ──► allow + info log
  │                       ├─ persisted deny hit ────────► deny + info log (no prompt)
  │                       └─ no record ──► Dialog A: confirm bubble
  │                                      allow / this-time / block / X-timeout → write back record + log
  ├─ getDisplayMedia ──► setDisplayMediaRequestHandler
  │                       └─► Dialog B: source picker (ask every time, not remembered)
  ├─ requestDevice (hid/usb/serial/bluetooth) ──► select-* event listener
  │                       └─► Dialog C: device picker (ask every time, not remembered)
  │                       (registering the listener itself blocks the "silently grant the first device" default path)
  └─ permission check ──► consistent with consent records: allow (either layer) → granted, otherwise → not granted
```

Dialog order: the request handler suspends the callback -> main notifies the main-window renderer over IPC -> the dialog renders inside the embedded-browser panel (one dialog per same origin+permission, reusing the pluginSandbox inflight pattern) -> user action or a 20s timeout -> renderer replies to main -> callback -> the page gets the result. When the panel is not visible the dialog cannot be interacted with and the 20s timeout naturally denies it, so pages run by an agent in the background are denied without any special branch.

## Permission tiers

| Tier | Permissions | Memory policy |
| --- | --- | --- |
| silent allow | `clipboard-sanitized-write`, `fullscreen`, `pointerLock`, `mediaKeySystem` | none |
| Dialog A: confirm bubble | `media` (camera/microphone marked by `details.mediaTypes`), `clipboard-read`, `geolocation`, `notifications`, `midi`, `midiSysex`, `idle-detection`, `speaker-selection`, `window-management`, `storage-access`, `top-level-storage-access`, `keyboardLock`, `fileSystem` | see the four states of Dialog A |
| Dialog B: source picker | `display-capture` (screen sharing) | ask every time, not remembered |
| Dialog C: device picker | `hid` / `usb` / `serial` / bluetooth | ask every time, not remembered |
| explicit deny | `openExternal` (external-protocol window opening already has its own "open in default browser" route), `unknown`, `deprecated-sync-clipboard-read` | — |

Any permission string not in the table is explicitly denied with a warn log (fail-closed, against enums newly added by later Electron versions).

## Dialog interaction

### A. Confirm bubble (below the address bar, left side, inside the embedded-browser panel, auto-pops)

```text
┌──────────────────────────────────────┐
│ example.com wants to use         [X] │
│  camera                              │
│ ╭──────────────────────────────────╮ │
│ │ ●  Allow while visiting this site │ │
│ ╭──────────────────────────────────╮ │
│ │ ●  Allow this time only           │ │
│ ╭──────────────────────────────────╮ │
│ │ ●  Do not allow                   │ │
│ ╰──────────────────────────────────╯ │
└──────────────────────────────────────┘
```

UI strings (zh-CN): "访问此网站时允许" (allow while visiting this site), "仅本次允许" (allow this time only), "不允许" (do not allow).

The bubble pops up as soon as the request arrives (Chrome-style anchored bubble, a `w-80` popover card: `rounded-xl` + `bg-popover` + `border-popover-border` + `shadow-md`). The header is the origin title and a close X; the body is a per-row capability icon list (camera/microphone/clipboard, reusing the `BrowserPermissionIcon` glyphs); the three options are vertical pill buttons (`rounded-full` secondary, left aligned, may wrap). Finalized from the 2026-10-08 measurement: there is no "block permanently" button, because after a mis-click a site misbehaves and cannot self-heal; persisted deny is kept only for management in the site permission settings (the dialog layer does not offer it). The X close and "Do not allow" are both a deny for this time without memory.

| Action | Semantics | Storage |
| --- | --- | --- |
| Allow while visiting this site | persistent allow, never asked again | persisted layer `origin+permission → allow` |
| Allow this time only | allowed for the current app run, invalid after restart | main memory `Map<origin, Set<permission>>` |
| Do not allow / 20s timeout | denied this time, not remembered, asked again next time | none |

### B. Source picker dialog (screen sharing)

A `desktopCapturer.getSources()` thumbnail list (whole screens / windows) -> selecting one shares that source (`callback({ video: source })`); cancel/timeout -> `callback({})` and the page gets `NotAllowedError`.

### C. Device picker dialog (WebHID/USB/Serial/Bluetooth)

Requesting site name + device list (name/vendor/serial number) + allow/cancel -> `event.callback(selected device)` or `callback(undefined)`.

All three dialogs follow `DESIGN.md`, are bilingual and dual-theme, and account for both desktop and mobile remote display.

## Data model and persistence

- Persisted layer: an independent JSON (`embedded-browser-site-permissions.json`, read/written atomically by main) shaped `{ [origin]: { [permission]: "allow" | "deny" } }`; no record = ask. It does not enter the global settings, to avoid coupling with cross-window broadcasts.
- Memory layer: main-process `sessionAllow` ("this time only") + `inflight` (same origin+permission de-duplication).
- Scope of "this time only" = the current app runtime.

## Site permission data clearing

The settings "Embedded browser" section **no longer provides** a "Site permissions" block (2026-10-09 decision: the edit entry converges to the site permission settings tab, avoiding two entries). The "Clear data" action still clears the site permission JSON together with the embedded partition storage (this also fixes the side issue that `desktopCommandHandlers.ts` cleared only defaultSession and missed the embedded browser partition).

## Site permission settings tab (added in the 2026-10-09 integration)

The only product entry for editing site permissions, inside the browser panel:

- **Entry**: a permanent slider icon to the left of the address input (does not change with permission requests; hidden when focus-editing the URL, and settles no pending request). Clicking pops a small bubble showing the current site origin and the single action "Permission settings", which enters an independent settings tab.
- **Settings tab**: an independent settings tab inside the sidepane, reused per workspace/conversation scope (opening again in the same scope reuses the same tab). It creates no webview, does not count as a live site page, and is not exposed to the Agent as an operable web page.
- **Page capabilities**: shows each permission state of the site persisted in main, each settable to ask/allow/block (ask = delete the record back to ask-every-time); supports a whole-site reset (main-side `resetSite(origin)`, clearing all persisted decisions of that origin); the transient "this time only" state is not shown.
- **Single data source**: all reads and writes go through the main site permission store (`getEmbeddedBrowserSitePermissions` / `setEmbeddedBrowserSitePermission` / `resetEmbeddedBrowserSitePermission`); the page holds independent read-failure/write-failure states with explicit retry and does not guess the post-change grant, add an authorization cache, auto-retry or an operation queue.
- The address-bar URL is centered when not editing, and left-aligned with the left icon hidden when focus-editing.

## Integration decision record (2026-10-09)

The `fix/missing_tool` branch (ZP-20260916-09, spec `2026-09-24-embedded-browser-permissions-spec.md` on that branch) and this spec (CNVD) are parallel implementations of the same permission governance. Conclusion:

- **Logic follows this spec**: main decision chain, permission tier table, three dialog semantics, 20s timeout, fail-closed, persisted layer structure and audit log are all kept; the main-side implementation and protocol wiring of `fix/missing_tool` are dropped.
- **Dialog visuals follow the fix branch**: confirm bubble card structure, capability icon list, vertical pill buttons and X close; the interaction remains this spec's auto-pop + three-state semantics (the third button is "Do not allow, this time", not the fix branch's persistent "never allow").
- **The site permission settings tab follows the fix branch**: address-bar slider entry + independent settings tab + sidepane scope reuse, with the data layer adapted to this spec's main store. The original settings-page "Site permissions" block was removed afterwards (user's final decision on 2026-10-09: a single entry to avoid drift between two edit surfaces); its dedicated i18n keys and dead tests were deleted, and the `clearEmbeddedBrowserSitePermissions` protocol stays (the "Clear data" chain and whole-site clearing remain on the main side).
- The fix branch's "address-bar icon changes with the request, click to expand the request bubble" interaction is not adopted (the request bubble auto-pops); its iframe-level cancel, request lifecycle refactor and MessagePort handshake (main-side enhancements) are not adopted (they belong to the dropped logic side).

## Audit log

```text
[embedded-browser-permission] decision=granted|denied origin=… permission=… source=allowlist|site-setting|session-allow|user-prompt|prompt-timeout|device-picker|source-picker|default-deny
```

info level (low frequency, kept in production); log volume of the dialog paths is of the same (very low) order as permission requests.

## Compatibility impact (verified item by item)

| Chain | Impact |
| --- | --- |
| agent browser-use (CDP screenshots, virtual clipboard) | none: screenshots use `Page.captureScreenshot`, paste uses synthetic `ClipboardEvent` + `execCommand` (`browserVirtualClipboardPageScript.ts`); neither triggers a permission |
| page copy buttons / DRM video sites / page fullscreen | unaffected (allowlist) |
| `window.open` / new-tab routing / "open in default browser" | unaffected (existing independent `setWindowOpenHandler` mechanism) |
| screen sharing | from silent failure to a controllable, usable dialog, gated by the source picker |

## Test requirements

- A permission E2E must first start the page request without waiting for it to finish, then click the product confirm bar, and finally read the page result. `executeJavaScript` waits for the returned Promise; start `getUserMedia` with `void` so that the test itself does not wait on the user decision and cannot click. Order: start request -> confirm bar visible -> click allow/deny -> assert the result and the second-request behavior.
- Unit tests: full enumeration of the decision table (allowlist / record hit / no record with no dialog capability denies / unknown permission fail-closed), check/request consistency, persisted layer read/write and atomic write, `sessionAllow` lifecycle, inflight de-duplication, 20s timeout denial, deny callbacks of `select-*` and displayMedia.
- Desktop e2e: the confirm bubble appears -> page-side result and second-request behavior for each of the three buttons and X; persisted memory takes effect after restart; a state changed in the settings takes effect; after picking a source in the source picker `getDisplayMedia` succeeds and cancel fails; `requestDevice` shows the device picker, with a negative assertion that "when no device is selected the first device is no longer silently granted".

### Origin consistency between permission query and request

After fixing the test's own deadlock waiting on the permission Promise, `browser-permission-prompt.test.ts` still failed its `permissions.query('camera')` assertion after a persisted allow. Runtime records showed `getUserMedia` returned `ok` while the query remained `denied`: the grant was written under the standard origin, while the Electron check callback passed an origin with a trailing `/` that was queried as-is and missed. Evidence is local under `packages/desktop/.e2e-artifacts/desktop-e2e-accountless-diagnosis-20261014b/`. Both request and check normalize with URL.origin and query the same record; persisted allow and this-time allow both follow this. Unit tests cover bare origin, trailing slash, page path, and protocol, site and permission isolation; the E2E keeps the `granted` assertion after authorization.

## Delivery order (four steps, each independently verifiable)

1. Main policy module: request/check/device handlers + full registration of `select-*` / displayMedia listeners; before the dialogs exist, sensitive items are denied with a log (a closed security loop that can ship alone to plug the hole).
2. Dialog layer: confirm bubble + source picker + device picker (IPC + UI + de-duplication + timeout).
3. Persistence + settings page: site permission list + clear-data linkage.
4. Unit/e2e completion and doc wrap-up.

## Acceptance criteria

- Any web page cannot obtain camera, microphone, clipboard read, geolocation, notification, MIDI, device or screen-sharing capability without user confirmation (no auto-allow path exists).
- Every decision for a sensitive permission is auditable; allowlisted permissions cause no functional fault (copy, fullscreen, DRM playback work).
- Existing agent browser-use regressions (CDP screenshots, virtual clipboard paste, tab lifecycle) are not affected.
