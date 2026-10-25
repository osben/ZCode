# Plugin page host layer click-through fix

## Cause and rule

After a handshake timeout the webview is removed, but the sidebar host container keeps its overlay area and `pointer-events: auto`; the empty container blocks the host reload button.

The shared page host layer only positions; it always uses `pointer-events: none`, while the webview inside it explicitly uses `pointer-events: auto`. No new lifecycle states, timers, or error branches.

```text
webview present: mouse → webview → plugin content
webview absent:  mouse passes through the empty container → host reload button
```

MCP Apps and Gen UI share this host layer, so inline, sidebar, and popover previews follow the same click rule. Existing anchor migration, instance cleanup, handshake deadline, and reload flow are unchanged.

## Display boundary for the keep-alive sidebar

Plugin pages are independent overlays under `body`; they must not inherit the host sidebar's opacity, clipping, or ancestor page-hidden state. The collapsed width lock and DOM retention across tab switches keep anchors connected and sized; geometry intersection alone must not decide visibility.

The single source of display state is the host: workspace visible, chat main view, sidebar expanded, and current tab all hold at once. `WorkspaceShellLayout` projects page visibility, `AnimatedSidePanePanel` merges the current tab, and the result flows `PluginUiSidePane` → model → view → card. The card synchronously unbinds the hidden anchor in a layout effect — no waiting for animations or observer callbacks — and does not delete tabs or the instance owner.

```text
workspace visible ∧ chat page ∧ sidebar expanded ∧ current tab → bind display anchor
any condition off → synchronous unbind → inert background surface → same guest keeps running
conditions restored → rebind → same guest and in-memory edit state shown again
```

The hidden non-zero-size background surface follows the [background execution contract](plugin-ui-background-execution.md): MCP pages are not paused or reclaimed while hidden, and plugins are not required to report private state. Re-showing does not repeat the handshake.

## Verification

- In real Electron, trigger the 15-second handshake timeout with a test page that fails to start, wait for the webview to be removed, then click the host reload button: exactly one callback fires and one running instance is rebuilt.
- For a normal page, host hit-testing must land on the webview; confirm plugin buttons and inputs work via Chromium mouse and keyboard events.
- Inline, sidebar, and popover previews stay interactive after switching, keeping the same guest.
- In real Electron, collapse the sidebar with the mouse, switch tabs, leave the chat page, and switch workspaces. Keep the real card DOM; assert the background surface is not hit-testable, is inert, and the page is no longer visible; two-frame work still completes, edit state and guest identity persist, restore is interactive with no new registration. Cover light and dark themes.
- A sidebar hidden from the start binds no anchor; page-hidden state reaches the sidebar in both the desktop and mobile shells. Web/remote capability fallback continues to be verified.
- Do not substitute DOM `.click()` for mouse hit-testing. The failing page is a controlled fixture; passing it does not prove startup issues of original user plugins are fixed.
- No layout, theme, copy, or platform-capability changes; Web/mobile/remote unsupported fallbacks stay as-is, and continuous/replayable message semantics are untouched. Runtime evidence is judged on the platform actually executed.

Regression entry points: `node packages/desktop/scripts/mcp-apps-host-e2e.mjs --managed-only` (timeout reload and lifecycle) and `--storage-only` (real guest interaction in inline, sidebar, and preview).
