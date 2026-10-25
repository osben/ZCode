# Embedded Browser Address-Bar Actions and More Menu Spec

> Status: implemented (2026-07-31)
> Scope: the `packages/ui` unified embedded browser chrome; no change to the Browser Use protocol, guest lifecycle or remote-control message flow.

## 1. Goal

The embedded browser offers "open in default browser" to the right of the address bar and reduces action density in a narrow side pane.

The address input is fixed at `h-7 rounded-lg` (28 CSS px high, 8 CSS px radius); the outer toolbar stays `h-12` (48 CSS px) and vertically centers the address box and the action buttons.

A newly created browser tab immediately shows the empty state; the underlying `<webview>` is only mounted, not shown. Until Enter, the address bar content is an uncommitted draft: typing, pasting or clearing the draft must not close the empty state or show the `<webview>` early. Only after a valid URL is submitted, an existing URL is restored, or an external navigation request is received does the view enter the navigated state and show the `<webview>`.

The `<webview>` node itself always uses a `#FFF` background, regardless of loading state or the ZCode light/dark theme. The empty state still mounts the guest early, but the node uses both inline `visibility:hidden` and `display:none` from creation, so the Electron guest surface cannot composite a white first frame before the CSS class takes effect; the hiding is released after navigation is confirmed. No extra overlay and no CSS injection into the guest page; page-declared backgrounds paint normally over the white base.

Full address-bar action priority:

```text
free size -> select element -> open in default browser -> debug
```

The actual chrome keeps only the first two actions permanently; the third slot is a fixed "More" menu:

```text
+---------- address ----------+ [free size] [select element] [more]
                                                       |
                                                       +-- open in default browser
                                                       +-- debug
```

## 2. Interaction contract

- "Free size" and "Select element" keep their existing icons, active state, disabled state and order.
- "More" is the third permanent icon button to the right of the address bar and opens with mouse and keyboard.
- The menu shows the two collapsed actions in priority order:
  1. Open in default browser.
  2. Open DevTools.
- "Open in default browser" uses the currently loaded page URL, never the uncommitted address-bar draft.
- External open is allowed only when the current page is `http:`, `https:` or `file:` and the guest is ready; `about:`, `data:`, empty page and not-ready state stay disabled.
- "Open DevTools" keeps the existing guest-ready gate and `webview.openDevTools()` behavior.
- Clicking any menu item closes the menu; errors or a detached guest keep using the existing safe call and UI logger diagnostic boundary.

## 3. Platform and state boundary

External open reuses `IPlatformService.openExternal`:

```text
  BrowserToolbar menu
  -> UnifiedBrowserView reads the current guest URL and validates http/https/file
    -> IPlatformService.openExternal(url)
      -> Desktop: Electron shell
      -> Web fallback: window.open
```

- No new UI direct access to `window.zcode`.
- No new Desktop main / host process business state and no synchronous IO.
- The stream, snapshot, queue and owner/lease semantics of Desktop `desktop-continuous` and mobile `web-remote-replayable` are unchanged.
- Web currently exposes no embedded-browser capability; the shared component keeps platform-injection compatibility.

## 4. Verification

- A component test constrains the permanent actions to "free size, select element, more" and checks the DOM order.
- A menu test constrains "open in default browser" to come before "debug".
- Clicking external open on an `http/https` current page calls `platform.openExternal(currentUrl)` exactly once.
- An uncommitted address-bar draft cannot overwrite the current page URL.
- For `about/data` and a not-ready guest, external open is disabled and the platform is not called; every `file:` page may call the platform.
- The debug menu item still calls the current guest's `openDevTools()`.
- Run targeted Vitest, `pnpm typecheck` and `pnpm lint`.
