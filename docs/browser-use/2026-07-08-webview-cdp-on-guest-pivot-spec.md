# Embedded browser moves to `<webview>` + CDP-on-guest (drop WebContentsView)

Date: 2026-07-08. Status: implemented (P1-P5 all landed; real-machine end to end verified: both the human tab and the agent handshake do attachGuest cdp=true, navigate/snapshot ok).

## 1. Background

The embedded browser had been moved from `<webview>` to a main-process `WebContentsView` "to avoid the V8 crash of `webview.capturePage()`". That premise does not hold:

- **`<webview>` + CDP-on-guest works**: main manages the guest via `webviewTag` + `will|did-attach-webview`, gets the guest webContents with `webContents.fromId`, and runs `Page.captureScreenshot` and other CDP commands through `webContents.debugger.attach`; no `WebContentsView`/`BrowserView` is needed (spike below).
- A WebContentsView is a **native window layer always composited above the renderer DOM**, so menus/dropdowns/tooltips are covered at the pane and z-index cannot fix it. It also brings manual setBounds/setVisible positioning, DPR/zoom conversion and "second tab won't open" bugs.
- The crash belongs to the **`capturePage()` method only**; CDP `Page.captureScreenshot` avoids it. The webview itself was fine.

Spike evidence (`/tmp/webview-cdp-spike`, host.png): renderer `<webview>` guest -> main `debugger.attach("1.3")` -> `Page.navigate` / `Page.captureScreenshot` all work, and a high-z-index DOM menu **does cover** the webview content (a WebContentsView would be covered).

**Goal**: render the embedded browser with `<webview>` again (composited in the DOM, coverable by DOM), still controlled by CDP on the guest `webContents.debugger`; this fixes menu occlusion and removes the manual positioning/zoom machinery.

## 2. Architecture

```
RENDERER (React UI)
  UnifiedBrowserView: chrome (address bar/back-forward/refresh/DevTools/picker) + <webview partition="persist:zcode-embedded-browser">
    - the webview is positioned by DOM layout (no setBounds/setVisible overlay)
    - on dom-ready getWebContentsId() -> IPC reports { key, webContentsId } to main
    - webview events (did-navigate/page-title-updated/did-fail-load) drive local chrome state
        | IPC: browserViewAttachGuest({ key, webContentsId })
        v
MAIN
  BrowserGuestManager (replaces BrowserViewManager): Map<key, { guest: WebContents, cdpAttached }>
    - attachGuest(key, webContentsId): guest = webContents.fromId(id); guest.debugger.attach("1.3"); store
    - execute(key, command): toControlledView(guest) -> executeBrowserCommandOnView (reused unchanged)
    - the guest provides loadURL/getURL/getTitle/navigationHistory/reload/executeJavaScript/debugger, matching the ControlledView interface
    - guest 'destroyed' / tab close -> detach + clear the table
  host desktopWindowChrome: webviewTag re-enabled + will/did-attach-webview (URL allowlist, popup routed back to internal tab)
```

**Key insight**: the executor (`executeBrowserCommandOnView` + SNAPSHOT/RESOLVE scripts + CDP Input) acts on a `ControlledView` (`{ webContents:{loadURL/getURL/...executeJavaScript}, cdp:{send} }`). The webContents of a WebContentsView and of a webview guest have **the same interface**, so the executor is reused with **zero change**; only the data source of `toControlledView` changes from `WebContentsView.webContents` to the guest webContents.

## 3. Lifecycle of the two tab sources

### Human tab (renderer opens)

1. The user opens a tab; the renderer renders `<webview src=about:blank or initialUrl>`.
2. On `dom-ready` -> `getWebContentsId()` -> IPC `browserViewAttachGuest({key=tab.id, webContentsId})`.
3. Main does `webContents.fromId` + `debugger.attach` and stores it.
4. Address-bar navigation: the renderer calls `platform.browserViewNavigate({key,url})` -> main -> execute (CDP/loadURL on the guest). Routing everything through main execute is preferred for consistency.

### Agent tab (agent opens; the renderer has no webview yet), needs a handshake

1. `agent.browsers.open(url)` -> protocol -> host -> main; main has no guest for that session.
2. Main sends `BrowserViewReady({sessionId})` so the renderer **opens a browser-use tab and mounts a webview** (reusing the existing auto-open-tab chain).
3. The webview `dom-ready` -> report guest id -> main attachGuest.
4. Only then can main run commands on the guest. **Handshake period**: if the key has no attached guest, main's execute waits for the attach (pending, with a timeout such as 10 s) and then executes; on timeout it returns a structured error. (webview attach is asynchronous.)

## 4. Reuse / change / delete

**Reuse (control plane, almost untouched)**: `browserCommandExecutor.ts` (executeBrowserCommandOnView + SNAPSHOT_SCRIPT + RESOLVE + CDP Input + `Page.captureScreenshot` + settleNavigation) with zero change; protocol `BrowserCommand` / `tabId` / `list` / result, agent object model / facade / documentation, node_repl top-level persistence, element-picker (executeJs through the guest); the chrome part of `UnifiedBrowserView` (BrowserToolbar / BrowserEmptyState) and `embeddedBrowserHelpers`.

**Change**:

- `UnifiedBrowserView.tsx`: placeholder div -> `<webview>`; drop bounds/visible reporting; add dom-ready -> report guestId, webview events driving chrome, address bar/buttons navigating.
- main: `BrowserViewManager` -> `BrowserGuestManager` (attachGuest / execute reusing executeBrowserCommandOnView / detach / list / handshake pending); `toControlledView` takes the guest webContents.
- New IPC `browserViewAttachGuest({key, webContentsId})` (renderer -> main).
- `desktopWindowChrome`: re-enable `webviewTag` + `will/did-attach-webview` (URL allowlist + popup routed back to internal tab).
- AnimatedSidePanePanel: both human and agent branches render the webview-based UnifiedBrowserView.

**Delete (WebContentsView positioning)**: `browserViewSetBounds` / `browserViewSetVisible` IPC + renderer reporting + manager setBounds/setVisible/ensureView(addChildView) + `browserViewBounds.ts`; the zoom conversion in preload setBounds (`webFrame.getZoomFactor()`); the diff-effect reclamation of `browserViewLifecycle.ts` (webview unmount + guest 'destroyed' now reclaim naturally); `browserViewManager.ts`.

## 5. Migration phases (each with its own spec/commit; spec before code)

- **P1 main guest base**: `BrowserGuestManager` (attachGuest + execute reusing the executor + detach + handshake pending) + `browserViewAttachGuest` IPC + host webviewTag/will|did-attach-webview restored. Tests: execute goes to the guest after attach; pending/timeout when not attached.
- **P2 renderer webview component**: `UnifiedBrowserView` becomes `<webview>` + dom-ready guestId report + webview events driving chrome + navigation buttons. Switch the human tab; real-machine check that menus are no longer covered plus navigation/screenshot/element-picker.
- **P3 agent handshake**: agent open -> BrowserViewReady -> renderer opens a webview tab -> reports guestId -> main attaches -> completes the pending command. Real check of agent open -> snapshot -> click.
- **P4 delete WebContentsView positioning assets** (setBounds/setVisible/bounds/zoom conversion/diff-effect/browserViewManager).
- **P5 regression**: menu occlusion, multi-tab, zoom, resize, element-picker, full agent chain on a real machine.

## 6. Risks

- **Agent handshake asynchrony**: main must wait for the renderer to build the webview and report the guestId before the first command. Mitigation: pending + timeout + clear error; the human tab has no such issue (webview exists first).
- **guestId timing**: `getWebContentsId` may be invalid before dom-ready; use the dom-ready event. After a webview crash/reload the guestId changes, so re-attach (listen to destroyed/did-attach).
- **CDP attach conflict**: one debugger per guest; opening DevTools takes it, so attach failure needs structured handling.
- **`<webview>` is not recommended long term by Electron**: still supported in Electron 41 and it is the way for page content to participate in DOM compositing and be covered by menus; accepted.
- **Partition login state**: the webview sets `partition="persist:zcode-embedded-browser"` explicitly, as before.

## 7. Popup / new-tab creation-time contract (added 2026-07-20)

When a page requests a new page through `<a target="_blank">`, `window.open()` or `form target="_blank"`, main's `setWindowOpenHandler` must intercept it, validate the protocol and route it to an internal ZCode Browser tab; it must not be silently swallowed nor allowed to create a `BrowserWindow` detached from ZCode.

`allowpopups` is a **creation-time capability** of an Electron guest and must be output as an attribute when React creates the `<webview>` DOM node. It must not be added later in a ref, effect, `dom-ready` or `did-attach-webview`: by then the guest is attached, and although the host DOM eventually shows the attribute, Chromium swallows the new-window request at an earlier popup permission boundary and main's `setWindowOpenHandler` never receives the event. `will-attach-webview` keeps doing security hardening and fixing parameters a second time but cannot replace the renderer's creation-time declaration.

```text
React creates the <webview allowpopups=""> node
  -> Electron creates/attaches the guest (popup capability frozen here)
  -> main did-attach-webview installs setWindowOpenHandler
  -> the page clicks target=_blank
  -> the handler validates http/https and sends OpenBrowserUrl
  -> the renderer creates and activates a Browser tab in the currently visible workspace
```

Regression baseline: the renderer static creation markup must contain `allowpopups` (not only assert the final DOM after mount); main handler unit tests keep covering internal tab, system-browser modifier and illegal protocols; Electron real machine/CDP clicks `target="_blank"` in a real guest and verifies the webview target count goes from 1 to 2 with the new target URL equal to the requested URL.
