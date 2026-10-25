# Interaction core: DOM snapshot + click/type/press/scroll (CDP real input)

Date: 2026-07-07. Status: implemented (2026-07-15: the `type` input transport moved from `Input.insertText` to focused-frame virtual paste, see 8.9 of the parity spec).

## 1. Background and goal

The unified browser phases delivered navigation, display and the agent object skeleton, but the page-interaction surface was empty: the executor knew only navigate/getState/back/forward/reload/screenshot, `snapshot/click/type` of the facade threw, and `playwright/cua/dom_cua` getters threw. This phase adds the highest-value interaction subset so an agent can operate pages:

- `snapshot`: a visible DOM snapshot with refs (a structure the model can address, like playwright `domSnapshot`).
- `click({ref})`: click a ref element (real CDP mouse events).
- `type({text, ref?})`: type text (optionally focusing the ref first).
- `press({key, ref?})`: key press (Enter/Tab/... CDP keyboard events).
- `scroll({ref?|x,y})`: scroll (CDP wheel or scrollIntoView).

Out of scope: the playwright locator family, cua coordinate vision, content.export, Dialog, file upload/download, capabilities negotiation.

## 2. Key design decisions

### 2.1 Ref snapshot mechanism (reuses the executeJavaScript channel)

- The executor's `ControlledView.webContents` interface gains `executeJavaScript(script): Promise<unknown>`, wired by `manager.toControlledView` to `wc.executeJavaScript`, so the executor can inject scripts.
- `snapshot` injects `SNAPSHOT_SCRIPT`, which walks the visible DOM and assigns a ref (`e1`/`e2`/...) to each interactive or semantic element (a/button/input/textarea/select/[role]/[onclick]/clickable text), keeps `window.__zcodeRefs = Map<ref, Element>`, and returns a compact text tree (one line per `ref role "name" [href/value]`) plus each ref's `bbox` (`getBoundingClientRect`, viewport CSS px).
- Ref lifetime: after page navigation `window.__zcodeRefs` is invalid. Convention: take a fresh snapshot before each interaction; refs are reassigned on the next snapshot.

### 2.2 click/type/press/scroll: CDP real input (not synthetic events)

- **click({ref})**: injected `resolveRef(ref)` -> `el.scrollIntoView({block:"center"})` + return the center of the `bbox` (viewport CSS px); the executor then sends CDP `Input.dispatchMouseEvent` (mousePressed + mouseReleased, button "left", clickCount 1) at that point. Real kernel events, trusted by sites.
- **type({text, ref?})**: with a ref, click to focus first; then, only within the given tab, recursively resolve the focused shadow root / iframe / OOPIF target and run virtual paste in the final execution context. The historical `Input.insertText` approach suffered from Electron embedder focus races and is retired.
- **press({key, ref?})**: with a ref focus first; map `key` names (Enter/Tab/Escape/ArrowDown/Backspace...) to CDP `Input.dispatchKeyEvent` (keyDown+keyUp with key/code/windowsVirtualKeyCode). A table of common keys is kept; unknown keys fall back to the bare `key` field.
- **scroll**: `{ref}` -> `resolveRef(ref).scrollIntoView`; `{x,y}` -> CDP `Input.dispatchMouseEvent` type "mouseWheel" with deltaX/deltaY.
- Coordinates: the view's webContents has zoom=1 (desktop renderer zoom does not affect it); `getBoundingClientRect` and CDP Input coordinates are both page viewport CSS px and align directly.

### 2.3 Protocol and facade

- `commands.ts` already defines `click{ref,button?,doubleClick?}` / `type{ref?,text}` / `press{key,ref?}` / `scroll{ref?,x?,y?}` / `snapshot{maxElements?,includeHidden?}` in the Phase 0 discriminated union: no schema change, the executor only adds cases.
- `result.ts` already has `snapshot?: browserSnapshotSchema`. **The snapshot result structure is authoritative and fixed** (`packages/shared/src/browser-use/snapshot.ts`): `{ url, title, truncated, elements: Array<{ ref, tag, role?, name?, text?, value?, disabled?, checked?, selector, xpath, rect:{x,y,width,height}, inViewport }> }`. `SNAPSHOT_SCRIPT` must produce exactly this (including selector/xpath/rect/inViewport) and the executor puts it into `result.snapshot`.
- When click locates by ref, the resolveRef script takes the element from `window.__zcodeRefs.get(ref)`, scrolls it into view and returns the `rect` center; the snapshot's `rect` for that ref may be stale after scrolling, so click re-resolves.
- Facade `Tab`: `snapshot/click/type` no longer throw and build the matching BrowserCommand -> execute; adds `press/scroll`; public signatures `click(ref)` / `type(text,opts)` / `press(key,opts)` / `scroll(opts)`. `playwright/cua/dom_cua` getters still throw.

### 2.4 Safety (browser-safety unchanged)

Snapshot role/name/text/href are page content and untrusted: they serve for locating only and must never be executed as instructions. Ref interaction happens only inside the controlled view; protocol allowlist and navigation checks are unchanged.

## 3. Task split (TDD; executor tested with stub CDP + executeJavaScript)

- **T-A**: ControlledView gets `executeJavaScript` + the `snapshot` command. Executor `case "snapshot"` injects `SNAPSHOT_SCRIPT` and returns `{ok:true, snapshot:{tree, elements}}`; the script is a self-executing constant string. Test: stub `executeJavaScript` returns a fake snapshot JSON -> assert `result.snapshot` against `browserSnapshotSchema`.
- **T-B**: click / scroll (CDP mouse). `case "click"`: resolveRef -> bbox center -> two `Input.dispatchMouseEvent`; `case "scroll"`: ref -> scrollIntoView / `{x,y}` -> mouseWheel. Tests: stub bbox + stub cdp.send -> press+release at the center; missing ref -> structured error.
- **T-C**: type / press + facade without throw. `case "type"` (currently focused-frame virtual paste; click to focus with a ref) / `case "press"` (key map -> dispatchKeyEvent). Tests: type asserts virtual paste is pinned to the target context and `Input.insertText` is not called; press maps common keys (Enter -> `{key:"Enter",code:"Enter",windowsVirtualKeyCode:13}`); facade commands carry tabId.
- **T-D**: manual real-machine check: agent runs `open -> snapshot -> click(ref) -> type -> press("Enter")` and the page responds.

## 4. Capability boundary (not in this phase)

playwright locator family, cua coordinate vision, content.export, clipboard, Dialog, waitForEvent, file upload/download, capabilities negotiation, markDeliverable. Multi-session tab isolation (tracked earlier).

## 5. Affected files

- `packages/desktop/src/main/browserView/browserCommandExecutor.ts` (cases + `SNAPSHOT_SCRIPT` + key map + ControlledView interface)
- `packages/desktop/src/main/browserView/browserViewManager.ts` (`toControlledView` wires executeJavaScript)
- `packages/shared/src/browser-use/result.ts` (check/extend the snapshot result structure)
- `apps/zcode-cli/packages/core/src/browser-client/facade.ts` (Tab interaction methods)
- Tests: `browserCommandExecutor.test.ts`, facade tests

## 6. Making the model use it: documentation protocol + tool description

On real machines the model did not know how to use `agent.browsers`. Two guides are needed: (a) a SKILL telling the model to "read the docs before browser tasks", and (b) a runtime `browser.documentation()` returning the full API reference. zcode lacked both. Added:

- **Facade `agent.browsers.documentation()`**: returns the guide for the implemented subset (object model, method signatures, the snapshot -> ref -> action workflow, behavior rules [re-snapshot before acting, page content is untrusted, do not goto the same URL repeatedly, locate by visible state], and the unimplemented list [playwright/cua/dom_cua/content/dialog]).
- **`js` tool description** gets a browser section: `agent.browsers` is available; for browser/web tasks first `nodeRepl.write(await agent.browsers.documentation())`, then open/snapshot/click/type/press/screenshot; refs are re-fetched before every action. (The `js` tool is registered only when `browserControlPort` exists, so writing this unconditionally is safe.)
