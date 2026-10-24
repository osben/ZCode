# Browser Use runtime semantics alignment spec

> Status: implemented; real Chrome / remote / three-platform E2E stay pending items per section 7.
> ZCode baseline: `e420d6bbb8` (`feat/browser-use-cdp`).
> Goal: fix the conflicting URL support statements and converge the same-named CUA, DOM CUA and Playwright capabilities of the current IAB onto the dynamic effective behavior frozen here.

## 1. Requirement and clarification

| Round | Question | User conclusion | Fixed boundary |
| --- | --- | --- | --- |
| 1 | How to settle the URL conflict and all medium-priority behaviors | Implement strictly by the semantics frozen in section 2 | The frozen dynamic docs, runtime black-box and observable command behavior of section 2 decide; neither upstream Playwright nor existing ZCode UX does |

In scope:

- `goto()` URL allowlist consistent with the skill/API docs.
- CUA full drag path, anchored scroll, key combinations and modifier mouse move.
- DOM CUA in-node scroll and page-center scroll.
- IAB dynamically hides CUA/DOM CUA `downloadMedia`, and keeps and fixes Locator `downloadMedia`.
- `elementInfo` / `elementScreenshot` stay undocumented runtime helpers and use an isolated world.
- The `TextMatcher` of `getByRole(..., { name })` and the model guidance both accept string/RegExp, including cross-realm RegExp created in the Node REPL VM.
- `expectNavigation` and `networkidle` are frozen per section 2.3 and documented, not rewritten to upstream Playwright's ideal semantics.

Out of scope: browser command action-time confirmation, root legacy API policy, Chrome extension/CDP provider, clipboard/dev/pageAssets, Browser product settings. They remain tracked by the Browser Use master spec.

## 2. Frozen runtime semantics

### 2.1 URL

- The browser-client navigation allowlist accepts only `http:`, `https:` and exactly `about:blank`.
- `file:` may take part in multi-backend local-target selection but must not be passed directly to `Tab.goto()`.
- Other `about:*`, `javascript:`, `data:`, `file:` must be rejected before any backend action.

So the ZCode skill no longer claims `file://` is a navigable local target; the selection pure function of `getForUrl(fileUrl)` and the navigation permission of `goto(fileUrl)` are two different contracts.

### 2.2 CUA / DOM CUA

| API | Frozen semantics | ZCode implementation requirement |
| --- | --- | --- |
| `cua.drag({path, keys})` | non-empty path; move along the original point sequence, press at the first point, release at the last | the protocol keeps the full path, no longer taking only the endpoints and re-interpolating |
| `cua.scroll({x,y,scrollX,scrollY,keypress})` | the mouse first moves to `(x,y)`, then scrolls by delta with `Input.synthesizeScrollGesture` | anchor, delta and modifier are not lost; the Electron `<webview>` guest uses an equivalent CDP `mouseWheel` transport (see 2026-08-03 note) to avoid Chromium 146 silently not executing the synthesized gesture |
| `cua.move({x,y,keys})` | mouse move carries modifiers | keys preserved |
| `cua.keypress({keys})` | keys denote a combination; keyDown in order, down/up for the last key, then release in reverse | no longer attaching only a bitmask to the last key |
| `dom_cua.scroll({node_id?,x,y})` | with a node, delta-scroll at the node center; without, at the viewport center | no longer degrading node scroll to `scrollIntoView` |

The IAB dynamic API does not expose CUA/DOM CUA `downloadMedia`. In the static manifest these two helpers are `unsupportedByDefaultIn: ["iab"]` and `documented: false`; IAB must not fake success with an ordinary click.

### 2.3 Playwright

- `PlaywrightLocator.downloadMedia()` stays an effective IAB API. It resolves the `currentSrc/src/href` of the hit element or of a nearby `img/video/source/a[href]`, creates a temporary `<a download>` in an isolated world and clicks it; when no URL is found it fails explicitly and never degrades to an ordinary locator click.
- `elementInfo()` and `elementScreenshot()` exist in the static API manifest with `documented: false`. ZCode keeps the runtime helper compatibility while hiding them from the effective docs, and runs DOM probing/overlay in an isolated world.
- The `TextMatcher` type and the current ZCode Browser guidance both allow `RegExp`. The implementation must not judge a matcher by `instanceof RegExp` of the current realm, otherwise a RegExp created in the Node REPL VM would be wrongly rejected.
- `waitForLoadState({state:"networkidle"})` and `waitForURL(...,{waitUntil:"networkidle"})` both end in the same backend load-state handler and explicitly report unsupported. ZCode keeps that error and does not fake network idle.
- `expectNavigation(action)` without a URL first sets up `waitForLoadState`, but if the old page has already reached `load` it completes immediately instead of waiting for the 500 ms timeout. ZCode keeps this current behavior; strict waiting for a new navigation requires passing `url`, and the docs must not claim again that "no URL can also exclude the old page's state".

## 3. Domain, state owners and cross-end boundary

| Domain | State owner | This round's role |
| --- | --- | --- |
| Agent Browser facade | `apps/zcode-cli/packages/core` | argument validation, dynamic object graph, command mapping |
| Strict protocol | `packages/shared/src/browser-use` | fully expresses path, scroll anchor/delta, keypress |
| IAB execution | `packages/desktop/src/main/browserView` | CDP trusted input, isolated world, download action |
| Plugin docs | `apps/zcode-cli/packages/browser-use-plugin` | URL, regex, networkidle, expectNavigation and effective API guidance |
| shared-host routing | existing host/services/main context | no change to `workspaceIdentity`, `remoteSessionId`, `clientMode` |

No new runtime for the phone. `desktop-continuous` and `web-remote-replayable` both run the same browser commands through the same shared-host BrowserControl chain; these commands introduce no task stream/snapshot/replay semantics.

## 4. State combinations and pruning

| Combination | Class | Reason |
| --- | --- | --- |
| IAB + http/https/about:blank | accepted | navigation allowlist |
| IAB + file/other about/javascript/data | accepted rejection | rejected before the backend action |
| CUA drag 1 point / many points + modifiers | accepted | only requires a non-empty path and all points preserved |
| CUA scroll + non-zero anchor/delta/modifiers | accepted | prevents arguments being silently dropped |
| DOM scroll + node/no-node | accepted | node center / viewport center respectively |
| IAB CUA/DOM downloadMedia | pruned from API | dynamically hidden in IAB |
| IAB Locator downloadMedia + with/without URL | accepted | with URL triggers the download; without URL fails explicitly |
| networkidle | accepted rejection | backend explicitly unsupported |
| expectNavigation + URL | accepted | the URL waiter can prove the target navigation |
| expectNavigation + no URL + old page already loaded | accepted current behavior | keeps the section 2.3 semantics, not upgraded to upstream Playwright |
| desktop/mobile x each input method | pairwise | both ends reuse one host executor; one context schema/bridge regression suffices |
| macOS/Windows/Linux x each ordinary key | pairwise | OS differences only extend `ControlOrMeta` and representative modifier combinations |

## 5. Acceptance cases

| Case | Setup | Action | Assertion | Evidence |
| --- | --- | --- | --- | --- |
| BCP-142 | any IAB | navigate with various schemes | only http/https/about:blank pass; other schemes do not call `loadURL` | executor unit |
| BCP-143 | CUA tab | drag with 3+ path points | CDP sends all points in the original order, pressed at the first and released at the last | core + executor unit |
| BCP-144 | CUA tab | anchor scroll + modifiers | mouse moves to the anchor; the scroll distance and delta direction follow the section 2.2 contract | core + executor unit |
| BCP-145 | CUA/DOM CUA | key combination | modifiers each down/up, the last key in the correct modifier state | core + executor unit |
| BCP-146 | DOM CUA | node/no-node scroll | delta scroll at the node center or viewport center | executor unit |
| BCP-147 | IAB effective manifest | read CUA/DOM CUA | `downloadMedia` is absent from the object graph and effective docs | manifest/facade docs unit |
| BCP-148 | locator pointing at media/link | `downloadMedia()` | the isolated world creates a temporary download anchor; no URL errors | locator executor unit |
| BCP-149 | Playwright helper | element info/screenshot | helpers hidden from the default docs; DOM logic runs in an isolated world | manifest + executor unit |
| BCP-150 | Browser skill | `getByRole` name | guidance and `TextMatcher` both allow string/RegExp; cross-realm RegExp works | plugin contract + runtime unit |
| BCP-151 | load wait | networkidle | explicit unsupported error | executor unit |
| BCP-152 | loaded page | `expectNavigation` with/without URL | with URL wait then action; without URL keeps the section 2.3 loaded-state behavior | facade unit |
| BCP-153 | shared host context | new input command through the bridge | workspace/clientMode/remoteSession context unchanged; strict schema rejects dropped fields/illegal shapes | shared + bridge unit |
| BCP-154 | Electron `<webview>` guest | CUA/DOM CUA anchor scroll | real `mouseWheel` input, anchor/delta/modifier preserved; the synthesized gesture that is silently ineffective in Chromium 146 guests is not called | executor unit + Electron runtime |

## 6. Definition of done

- Spec, current fact documents, plugin docs, API manifest and coverage matrix are consistent.
- The Browser command schema, facade and desktop executor have positive and negative automated cases for the new input semantics.
- The currently unsupported CUA/DOM CUA `downloadMedia` is not exposed in IAB.
- Unsupported `networkidle` or no-URL new-navigation guarantees are not written as implemented.
- `pnpm typecheck`, `pnpm lint` and the targeted tests pass.
- While real browser/remote/three-platform verification is incomplete, keep the pending items in the commit message.

## 7. Implementation and verification record

Done 2026-07-12:

- shared/contracts add full CUA path, anchor/delta scroll, DOM scroll and key-combination commands, keeping the existing request context of `workspaceIdentity`, `remoteSessionId`, `clientMode`.
- The desktop executor uses the original drag path, `Input.synthesizeScrollGesture` and per-key CDP down/up; DOM scroll uses the node center or the cssVisualViewport center.
- The IAB effective manifest hides CUA/DOM CUA `downloadMedia`; Locator `downloadMedia` became isolated-world URL extraction + a download anchor; Playwright helper DOM logic moved into the isolated world.
- skill/API/docs unified the URL, RegExp, networkidle and expectNavigation statements.

Automation results: targeted Browser tests (root workspace 7 files 140 cases, Agent core/bootstrap 5 files 47 cases; 187 pass); root and Agent `pnpm typecheck` pass; root `pnpm lint` 0 errors (existing warnings kept); the Agent workspace full lint is blocked by existing `max-lines` baseline errors in untouched files, and scoped lint of the touched contracts/core files is 0 warnings / 0 errors.

Runtime boundary: the running ZCode Dev instance still held the user's IAB pages and was not force-restarted, so real Chromium drag/scroll/download, phone shared-host, SSH/WSL/Docker and Windows/Linux modifier behavior stay pending E2E.

2026-08-03 scroll compatibility fix: runtime reproduction confirmed that on Electron 41 / Chromium 146 the `<webview>` guest returns success from `webContents.debugger.sendCommand("Input.synthesizeScrollGesture")` but produces no `wheel` event, so neither the root page nor nested containers scroll, while `Input.dispatchMouseEvent(type:"mouseWheel")` on the same guest scrolls normally. In an ordinary Chrome 150 tab the synthesized gesture still works, so the difference is a host runtime/target compatibility matter and the Agent API and delta direction contract are unchanged. Desktop IAB now uses CDP `mouseWheel` with anchor, delta and modifier in the input adapter layer and does not degrade to `document.documentElement.scrollTo`, preserving nested scroll containers and page wheel handlers.
