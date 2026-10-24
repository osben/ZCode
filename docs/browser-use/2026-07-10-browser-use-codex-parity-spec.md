# Browser Use full behavior spec

> Status: target spec; behavior and responsibility isomorphism are the standard, implemented clean-room.
> Scope: backend, object graph, selection, lifecycle, Playwright facade, security and response-meta contracts of Browser Use. Older trajectories are historical background only.
> Priority: get the effect and boundaries right first, then replace/extend backend implementations; never fake an "available" capability.
> Implementation record: Slice A done 2026-07-10; Slice B (IAB scope/generation/lifecycle/response meta) and Slice C (member-level capability manifest) are implemented. The Chrome extension / CDP producers keep only a registration hook and are outside this round.
> DOM-first increment (2026-07-10): default prompt/example echo, screenshot guidance lookup, bounded IAB semantic DOM and contract tests are done; the common `Tab.playwright` object graph and the IAB clean-room executor are in Slice C; cross-origin frame / shadow DOM still need real-page E2E.
> IAB behavior completion (2026-07-10 on): a complete method-name set is no longer "Playwright behavior done". One Playwright injected runtime drives both snapshot and locators, CDP `Input` drives trusted click/type/press, and `BrowserUser`, `Tabs.finalize({ keep })`, real tab identity, URL redaction and backend cancel are IAB completion gates. The Chrome extension and standalone CDP provider keep interfaces only.
> 2026-07-12 semantics: URL, CUA/DOM CUA, Locator media download, undocumented helpers, regex guidance, `networkidle` and `expectNavigation` are re-frozen by the dynamic effective surface; see `2026-07-12-browser-use-codex-runtime-semantics-alignment-spec.md`.
> 2026-07-14 pointer actions: `click` / `dblclick` / `setChecked` no longer rely on a single `checkElementStates()` probe (see the frozen semantics in section 8).

## 1. Product goal

The same browser-use skill/browser-client must work on three backends:

- `iab`: the ZCode in-app browser.
- `extension`: a ZCode-owned Chrome extension + native host controlling the user's Chrome.
- `cdp`: a standalone CDP backend gated by feature/security.

Playwright is a unified `Tab.playwright` facade above the backends, not a backend. The model's selection of `agent.browsers`, the object graph, errors, capabilities, security confirmation, tab lifecycle and response meta are frozen here and identical across the three backends.

## 2. Confirmed boundary decisions

| Decision              | Conclusion                                                                                                          | Reason                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| backend enum          | `iab \| extension \| cdp`                                                                                           | one observable contract for all three                                       |
| Playwright            | a Tab API layer                                                                                                     | do not build it as a fourth backend                                         |
| Chrome assets         | ZCode clean-room                                                                                                    | no third-party private plugin or binary                                     |
| IAB transport         | keep the ZCode Protocol adapter                                                                                     | compatible with the local/remote shared-host architecture                   |
| browser identity      | the descriptor's runtime id, never the type                                                                         | supports several Chrome profiles/windows/peers                              |
| workspace identity    | `workspaceIdentity?.trim() \|\| workspacePath`                                                                      | isolation semantics                                                         |
| client mode           | carried on every request                                                                                            | keeps the desktop continuous / web replayable boundary                      |
| API support           | trimmed dynamically by capability/API manifest                                                                      | no fake methods that always throw                                           |
| low-level result      | protocol keeps a structured result                                                                                  | only the facade direct-returns/throws                                       |
| security              | command/action-time policy independent of the js gate                                                               | one approval must not allow unlimited side effects                          |
| page observation      | ordinary navigation/reading/interaction defaults to visible semantic DOM                                            | DOM is cheaper and gives stable locating evidence                           |
| model screenshots     | only when the user asks for visual results, layout/rendering judgment is needed, or DOM cannot represent the target | no "screenshot after opening" and no snapshot+screenshot double observation |
| documentation loading | screenshot guidance is an on-demand lookup, not in the default full API                                             | avoid reinforcing `emitImage(screenshot())`                                 |
| response meta         | no automatic client preview screenshot; model screenshots are still explicit in the visual branch                   | product choice: avoid large screenshot metadata for ordinary navigation     |
| implementation source | clean-room, no third-party private source copied                                                                    | compliance and maintainability                                              |

## 3. Target layering

```text
Node REPL runtime (generic, decoupled from the browser-use plugin)
  └─ plugin browser-client bootstrap
      ├─ BackendDiscovery
      ├─ BrowserRegistry / selection
      ├─ API manifest interpreter
      ├─ Documentation composer
      ├─ SecurityPolicy / confirmation
      ├─ ResponseMeta collector
      └─ Browser -> Tabs -> Tab common APIs
          ├─ playwright
          ├─ cua
          ├─ dom_cua
          ├─ content
          ├─ clipboard
          └─ dev/capabilities

Backend providers
  ├─ IabBackendConnection
  │   └─ ZCode Protocol -> shared host -> desktop main -> webview guest/CDP
  ├─ ExtensionBackendConnection
  │   └─ native pipe -> ZCode native host -> Chrome extension
  └─ CdpBackendConnection
      └─ native pipe/direct gated host -> CDP targets

Official plugins
  ├─ browser: shared client/API/docs + IAB-oriented entry
  └─ chrome: same shared client/API/docs + extension host/install/diagnostics
```

## 4. Backend-neutral contract

### 4.1 Descriptor

```ts
type BrowserBackendType = "iab" | "extension" | "cdp";

interface BrowserCapabilityDescriptor {
  id: string;
  description: string;
}

interface BrowserBackendDescriptor {
  id: string;
  generation: number;
  type: BrowserBackendType;
  name: string;
  capabilities: {
    browser?: BrowserCapabilityDescriptor[];
    tab?: BrowserCapabilityDescriptor[];
  };
  apiSupportOverrides?: Record<string, boolean>;
  metadata?: Record<string, string>;
}
```

- `id` is the runtime connection identity; several backends of the same type may coexist. `type` only means the backend family.
- `list()` returns only backends that are actually reachable and finished the handshake; the facade must never fake availability.
- metadata contains no secret; Chrome may carry non-sensitive identifiers needed for profile/instance/window selection.

### 4.2 Session context

```ts
interface BrowserSessionContext {
  requestId: string;
  browserId: string;
  browserGeneration: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  turnId?: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  sessionContext: "live" | "cached";
}
```

- `requestId` stays unchanged from browser-client to backend. It is the correlation key of an in-process request lifecycle, not an overwritable latest-value state: while the same host bridge or main manager still has a running entry with that ID, any duplicate request, same-scope or cross-scope, must fail before backend dispatch with `duplicate_request_id` and `sideEffect: "none"`. Random UUID generation does not replace mechanical uniqueness checks at the state owner boundary.
- The timeout, transport failure, result and `finally` cleanup of a pending/running entry must compare-and-delete: delete only when the Map still points to the entry captured by the closure; late cleanup of an old request must not delete state registered later.
- `workspaceKey` is for identity/isolation only; file and command cwd use `workspacePath`. A remote workspace must carry `workspaceIdentity` and `remoteSessionId`.
- AbortSignal/timeout must cancel not-yet-started requests and, as far as possible, abort the backend action; if the action may have happened, the error must state that side effects are uncertain.
- A stale connection/generation cannot receive new requests.

### 4.3 Port

```ts
interface BrowserBackendPort {
  list(context: BrowserDiscoveryContext): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    context: BrowserSessionContext;
    command: BrowserCommand;
    signal?: AbortSignal;
  }): Promise<BrowserCommandResult>;
  turnEnded?(context: BrowserSessionContext): Promise<void>;
  closeSession?(context: BrowserSessionContext): Promise<void>;
}
```

The first slice registers only the IAB adapter, but the protocol, facade and registry must not depend on a single IAB constant.

### 4.4 IAB scope and generation freeze

IAB visibility, default tab, active tab, pending requests and cleanup are isolated by this scope:

```text
(browserId, browserGeneration, windowId, workspaceKey, remoteSessionId?, sessionId, clientMode)
```

- `tabId` is an opaque runtime id allocated by main; `sessionId` or a renderer pane id no longer stands in for tab identity.
- A renderer attach must hit a tab already registered by main, in the same `windowId`, with an unexpired generation; closed/stale/cross-window attaches are rejected.
- After the descriptor generation changes, old Browser/Tab objects must fail and not drift to the new connection.
- `BrowserViewReady` is the only authority for the renderer to create or restore a logical shell, and a replayable create/ready request: it may be sent again while the guest has not attached; `BrowserViewAttachGuest` is the ready ack. `visibility=show` is not an alias for ready and has no create/restore authority.
- `list/get/selected` observe only tabs of the current scope.
- A human IAB tab belongs to `windowId/workspaceKey/sessionId` from renderer attach on; only the owner session can discover and claim it through `BrowserUser.openTabs()`; empty URLs and exactly `about:blank` do not enter user-tab results. Releasing control keeps the original session ownership and cannot be published to other conversations. Full boundary: `docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`.

### 4.5 IAB lifecycle freeze

- `tabs.new()` must allocate a tabId through the backend, ask the renderer to create a guest and return after the ready ack.
- When `BrowserViewReady` arrives the renderer must idempotently create or restore the matching `browser-use` logical shell by the identity carried in the event `(workspaceKey, remoteSessionId?, sessionId, browserId, browserGeneration, tabId)`, and must not backfill ownership from the active workspace/session at arrival time. If the origin session is still the current scope, activate the tab and expand the right sidebar so the user sees the IAB in use; if the user has switched to another session/workspace, only create and mount the `<webview>` in the background so `dom-ready` can produce the ready ack, without taking over the current right sidebar, and restore display after switching back to the origin session. Whether the panel content is mounted must not depend on visibility alone, otherwise a background ready would time out without an attach ack.
- `visibility=show` is only a selection signal for an existing logical shell. The renderer may activate only a shell whose scope, generation and `tabId` all match; on a miss it must ignore it and not create, restore or mount a shell. `visibility=hide` may only hide the currently active shell of the same scope/generation. Attaching an inactive guest must not replay scope visibility as a show of that tab; scope visibility and tab active are separate states.
- The ordered create/selection boundary:

  ```text
  main creates logical tab
      |
      v
  BrowserViewReady(scope + generation + tabId)  -- replayable until attach ack
      |
      v
  renderer idempotently creates/restores shell + mounts webview
      |
      v
  BrowserViewAttachGuest                         -- ready ack
      |
      v
  visibility=show/hide                           -- only selects/hides an existing shell
      |
      v
  close                                           -- terminal
      |
      +--> delayed visibility must be ignored; never rebuild the shell
  ```

  The same sender must deliver Ready before the first visibility; even when the renderer receives both in one React batch it must update lifecycle state in receive order and not depend on a ref refreshed only by the previous render. When renderer state is lost or must be restored, the producer must replay Ready first and then visibility, never restore a shell with visibility alone. Visibility of an old `browserGeneration`, a different `remoteSessionId` or an already closed tab is ignored.

- ZCode's product semantics: browser use is visible to the conversation that owns it; the visibility capability only controls show/hide of an existing logical shell and does not restore logical shells.
- `close()` marks the tab closed, detaches CDP, cancels waiters and notifies only the owner window; a late attach must not revive the tab.
- `finalize()` marks a tab deliverable; IAB pages stay visible for the session lifetime.
- `turnEnded()` cancels the turn's unfinished requests/waiters; actions already dispatched return with uncertain side-effect semantics. ZCode IAB uses in-process default persistence: all agent-created active/handoff tabs stay visible and controllable and must not close automatically because the model forgot to call finalize, because a handoff exists, or because a turn succeeded/failed. Explicit deliverable and claimed user tabs are released to the user at turn end but stay visible.
- `tabs.finalize({ keep })` applies `handoff`/`deliverable` only to tabs listed in `keep`; unlisted tabs keep their lifecycle and omission has no close semantics. Only an explicit model `tab.close()` or a manual user close closes a single tab.
- `closeSession()` cancels the scope's pending requests, clears session-level config and releases still-alive IAB tabs to the original session's user-tab set; it closes no webview and no other session may enumerate or claim them. Process lifetime: `docs/browser-use/2026-07-12-browser-tab-process-lifetime-spec.md`; conversation isolation: `docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`.
- Window close additionally runs window-scope cleanup so no owner/guest remains in the main singleton.
- Both the host bridge and the main manager must be covered by same-scope and cross-scope concurrent duplicate requestId regressions, asserting the duplicate is not dispatched and the original request's result/cancel/turn/session cleanup association is unchanged.
- Renderer lifecycle tests must go through the real hook subscription and cover adjacent events: in the same batch `Ready(A) -> Ready(B) -> visibility(B)` keeps two shells and activates B; `close(B) -> delayed visibility(B)` must not rebuild B; visibility of an old generation or a different remote session must not change the current active tab. Main tests must cover that `attachGuest({ active: false })` produces no show event.

## 5. Discovery and selection

BrowserRegistry refreshes descriptors when needed or by TTL/peer event. Selection rules:

### 5.1 `get(idOrType)`

- Exact id first; then type alias; with several instances of one type use the preferred-instance rule, otherwise stably the first.
- No match throws `BrowserBackendUnavailableError` listing the currently available descriptors; never silently degrade to another backend.

### 5.2 `getDefault()`

1. IAB. 2. Preferred extension instance/window. 3. Any extension. 4. The first remaining backend. 5. An empty list throws unavailable.

### 5.3 `getForUrl(url)`

- A single backend returns directly. local/file targets prefer IAB.
- Match existing IAB/extension tabs by exact -> origin+pathname -> hostname -> hostname hierarchy. Several candidates: IAB first, then preferred extension. Fallback: IAB -> extension -> the rest.
- With one backend take the fast path; with several backends a URL parse failure errors explicitly and the raw string is not sent to any backend.
- `file:` is only a selection hint: it may make multi-backend selection pick IAB, but `Tab.goto()` still allows only http/https/about:blank.

All selection rules need pure-function unit tests, covering several same-type backends, peer disappearance and preferred-instance changes.

## 6. Browser-client and plugin boundary

Final state:

- Node REPL is a generic runtime and does not disappear when the browser-use plugin is disabled.
- The browser/chrome plugins carry the browser-client, API manifest and docs manifest of the same build artifact.
- The skill explicitly imports and runs setup once in a fresh kernel; repeated setup is idempotent.
- ZCode may keep an internal auto-bootstrap for migration compatibility, but model docs and the stable contract follow plugin assets; after the migration period the core private facade implementation is removed.
- Disabling a plugin only removes the corresponding skill/client/backend product entries and must not break the generic Node REPL.
- All four official-asset staging chains (SEA/Desktop/remote/prebuild) must include `scripts` and the needed platform assets.

## 7. API manifest and object graph

A clean-room manifest covering the full observable signatures is required. At runtime:

1. Build the base support set from the backend `unsupportedByDefaultIn`.
2. Merge backend overrides, capabilities and product feature gates.
3. Hide unsupported members from the object graph.
4. Generate the effective API documentation for the current backend.
5. Conditionally assemble security, upload, Chrome, IAB and capability guidance.
6. Automatically test that manifest, facade, docs and backend command mapping do not drift.

This round's manifest is member-level; each item has at least `name/kind/signature` and optionally `command`, `unsupportedByDefaultIn` and `requiresCapabilities`. The interpreter merge order is frozen:

1. `unsupportedByDefaultIn` sets the backend-family baseline.
2. `requiresCapabilities` checks the descriptor's browser/tab capability ids.
3. `apiSupportOverrides["Object.member"]` is the final connection-level override.
4. An unsupported member is hidden from the runtime proxy, from `in` results and from the effective documentation.

The manifest no longer declares a backend as always available, and the docs must not list methods already hidden from the runtime object graph.

Required object families:

- Browsers/Browser/BrowserUser/Tabs/Tab.
- Playwright API, Locator, FrameLocator, Download, FileChooser.
- CUA/DOM_CUA.
- Content, Clipboard, Dev logs, Dialog.
- Browser/tab capability collections and documentation.

## 8. Locator pointer action frozen semantics

`click`, `dblclick` and `setChecked` (when it needs to toggle state) share this pointer-target pipeline:

1. Strictly resolve the selector in the Playwright isolated world: zero matches enter the routine wait; multiple matches are an immediate strict violation and must not be disambiguated by `first()` / `last()` / `nth()`.
2. Non-`force` operations check `visible` and `enabled`; `force` skips only these two actionability states and the final receives-events rejection, not selector uniqueness, the clickable rect, frame identity or trusted input.
3. After scrolling with a candidate scroll alignment, observe at least two consecutive animation frames; proceed to the click only when the bounding rect is identical. If the element detaches, re-resolves to a different node, or the execution context is destroyed, re-resolve until the routine timeout.
4. The target must carry the actual CDP target/session/frame identity. Local coordinates in child frames are mapped layer by layer to the top level, every iframe owner runs a hit-target check, and within one frame Playwright's injected `expectHitTarget` continues to be used. An OOPIF must not rely only on accumulated `getBoundingClientRect()` offsets.
5. The final action produces trusted input only through CDP `Input.dispatchMouseEvent`; target/context invalidation before or after the click must return a structured error with explicit recovery guidance and must not pretend success.
6. Successful `Runtime.evaluate` / `DOM.*` responses must pass runtime payload validation. A response missing `result.value`, `count`, coordinates or frame owner is a backend execution error and must not be downgraded to "locator not found".

Acceptance must include real Electron/CDP pages, not only mocked `Runtime.evaluate`: ordinary link/button, link nested in a heading, continuous animation, overlay, same-origin iframe, OOPIF, navigation/context-destroyed race, empty payload and malformed payload are all required states.

## 8. Playwright facade

### 8.1 Semantics

- A restricted Playwright-like API; no arbitrary Playwright BrowserContext/process is exposed.
- Wait APIs belong to `tab.playwright`, not the `Tab` root; the exact fixed-wait signature is `waitForTimeout(timeoutMs: number): Promise<void>`, so adding a `tab.waitForTimeout(...)` compatibility alias on `Tab` is forbidden.
- `waitForTimeout` accepts a non-negative integer, first verifies the target tab still belongs to the current scope, then runs a cancelable fixed wait; the transport command budget is `timeoutMs + 2000ms`. A fixed sleep is only for cases with no more specific page state to wait for; the normal flow still prefers a fresh snapshot or a targeted wait API.
- Locator construction is a pure description; a backend command is dispatched only when an action/query is called.
- The latest relevant `domSnapshot()` is the only fact source for locator construction and failure recovery. A label, accessible name, placeholder, text, attribute or selector not present in the snapshot must not be guessed, and a guessed locator must not be used as a page probe.
- Before click/fill/press/select/check, if the selector itself cannot prove uniqueness, call `count()` first; with `count() === 0` do not keep waiting or execute that locator, take a new snapshot and rebuild from the new facts; with more than 1 tighten the scope and never mask ambiguity with `first()/last()/nth()`.
- After a locator timeout, strict-mode or selector parse failure, never retry the locator unchanged; take a fresh snapshot first and then use a more stable role/name, `data-*`, `href` or scoped selector.
- Routine Playwright operation timeout is frozen: default 3000 ms, and an explicit timeout is at most 3000 ms; the download event is the exception, default 3000 ms, max 120000 ms. `waitForTimeout()` is a fixed wait the user asked for and is not bound by the routine operation timeout cap.
- Locator strictness, frame scope, timeout, load state, download/file chooser and navigation wait have unified semantics.
- `evaluate` runs the given script in the page context; the caller controls the script scope and verifies the expected result.
- Locator/action errors must carry actionable information without leaking backend secrets; when the client adds operation context it must not append the original error message/stack again.

### 8.2 Backend adapter

- IAB: DOM snapshot, Runtime, and DOM/Accessibility/Input/Page combinations built on webview guest CDP.
- extension: forwards the same controlled CDP/DOM command contract through `chrome.debugger`.
- cdp: executes allowlisted CDP commands directly.
- The simplified ref API of the IAB DOM snapshot must not pose as the full Playwright locator.

### 8.3 Current Playwright delivery boundary

IAB delivered the following **method-name object graph** for the frozen static interface this round:

- `PlaywrightAPI` 16 members: DOM snapshot, coordinate element info / annotated screenshot, page-script evaluate, navigation/load/URL/fixed wait, download/filechooser events, and locator/frame-locator builders.
- `PlaywrightLocator` 32 members: builders/filters/collections, strict actions, reads, state, select/check, evaluate and media download.
- `PlaywrightFrameLocator` 7 builder members, `PlaywrightDownload.path()`, `PlaywrightFileChooser.isMultiple()/setFiles()`.

Locator builders only compose selectors and only terminal operations cross the protocol; IAB `waitForEvent("filechooser")` and `setFiles` keep explicit unsupported behavior; downloads create a tab-scope-bound download object through the guest session's `will-download` lifecycle.

The 2026-07-10 deep audit confirmed this proves only **the interface set and part of the client-side contract**; it must not be written as "common object graph behavior aligned". The executor was still an in-page clean-room selector/runtime, not the CDP DOM/Accessibility/Input/Page combination required by 8.2, with at least these open items:

- Locator click/press/fill/check/select used synthetic DOM events/property mutation, without trusted input and full actionability.
- role/accessible name was a hand-written subset; it did not pierce shadow DOM and could reach only same-origin iframes.
- Current IAB explicitly rejects `networkidle`. `expectNavigation` without a URL may be satisfied immediately when the old page has already finished load; with a URL it proves navigation by target URL + waitUntil. Current IAB behavior must not be written as an upstream Playwright guarantee.
- `evaluate` runs the given script in the page context; root `Tab.evaluate` and Playwright evaluate are both capabilities that run page scripts.
- Root `screenshot({ref})` accepts a ref but the executor ignores it; this is not an implemented capability.

Therefore cross-origin iframe, shadow DOM, AX, trusted input, actionability, navigation wait, page-script execution and real download must be verified through contract/E2E; until those pass, only "the Playwright method-name set is complete" may be claimed.

### 8.4 DOM-first observation and screenshot fallback

Observation follows "the cheapest evidence that can answer the next question":

1. For ordinary open, navigation, reading, search, form locating and state confirmation, the locator flow returns `playwright.domSnapshot()` first; only the ref/dom_cua compatibility flow returns `snapshot()` first. Opening a page is not a reason for a screenshot.
2. REPL examples must make the observation the last expression (by default e.g. `await tab.playwright.domSnapshot()`; the compatible ref path may use `await tab.snapshot()`) or explicitly `nodeRepl.write(...)`. Merely assigning the result to a local variable does not count as the model having observed.
3. By default, DOM observation (`playwright.domSnapshot()` or compatible `snapshot()`) and `screenshot()` must not both be called in one observation unit; if DOM already answers the question, do not confirm again with a screenshot.
4. Only three cases enter a model image block: the user explicitly asks for a screenshot/visual check; layout, style, pixels or image content must be judged; DOM snapshot cannot represent the target (canvas, custom-drawn controls) and a visual coordinate fallback is needed.
5. The screenshot option tutorial is not in the default documentation and is looked up by name only in those visual branches; but the output contract "a screenshot result must enter an image block" stays in the default tool description and API semantics. Once the model decides to call `screenshot()`, it must use `nodeRepl.emitImage(await tab.screenshot())` in the same JS cell; it must not make `screenshot()` the final expression or feed a `Uint8Array` back to the model.
6. The IAB compatible `snapshot()` keeps actionable `elements/ref` and also returns bounded visible semantic DOM nodes covering at least heading, paragraph, list, landmark, table, image alt and stable locating attributes. It does not replace the Playwright AI/ARIA string contract of 8.5.
7. `dom_cua.get_visible_dom()` reuses the same rich DOM observation and must not merely be DOM by name while returning only interactive elements.
8. ZCode does not auto-capture a client preview screenshot after navigation/click. Response meta of an ordinary browser command carries only the marker, backend, browserId, tab/open-tab, sessionEnded and redacted URL; screenshots are explicitly called by the model in the visual branch. `tab.screenshot()` produces internal PNG bytes only; the model must write `nodeRepl.emitImage(await tab.screenshot())` and only that path becomes a model image block.
9. Images produced by `nodeRepl.emitImage(...)` enter the provider-visible image block and must also enter the tool card through bounded `ToolResult.display` image metadata. The UI renders the image directly in both live `desktop-continuous` events and `web-remote-replayable` snapshot/replay, no longer showing only `[Attached image/*: MCP image]`; that placeholder is for the model text projection only and the tool card hides it when it has the real image. Display image payloads must bound single image, total size and count so they cannot bypass the tool-result budget into unbounded protocol messages; relay/main still only pass through and neither store nor interpret image business state.
10. A browser screenshot produced by `nodeRepl.emitImage(...)` must obey a 200 KiB base64 per-image budget before entering the model through the MCP bridge: within budget keep the original; over budget reuse the unified `ImageProcessorPort` to produce a visible image block within the 2000 longest edge, 153600 B decoded binary and 204800 B base64 budgets. Only if compression fails is the original saved as an artifact and a text reference returned; never expand a `Uint8Array` into numeric JSON, and never lose browser use's visual observation because of the generic MCP threshold.
11. When the model explicitly calls `tab.screenshot()` and returns it through `nodeRepl.emitImage(...)` per item 5, the tool result must contain both the image block and the absolute file path text of the original screenshot artifact. The path text must be an independent provider-visible text block, so that non-multimodal models can still hand the path to an image-recognition MCP; the file keeps the original PNG bytes returned by the browser backend and is unaffected by the compression policy of item 10. The screenshot source must be explicitly marked in the Node REPL result, and an ordinary `nodeRepl.emitImage(...)` must not write extra files. A failed screenshot creates no empty file or fake path. The automatic end-of-turn screenshot belongs to the UI display chain, does not enter the model conversation, is not counted in tokens and generates no artifact path text of this item.

Boundary between explicit screenshot and end-of-turn display:

```text
model js cell
  -> tab.screenshot()
  -> Browser backend returns the original PNG
  -> nodeRepl.emitImage(PNG)
  -> Node REPL marks the image index
  -> core artifact store saves the original PNG
  -> model tool result: [absolute path text] + [bounded image block]

turn ended
  -> automatic screenshot
  -> UI display only
  -X-> Node REPL / MCP model content / artifact path text
```

This boundary comes from a 2026-07-10 trajectory regression: while "visiting baidu.com" the model called both `snapshot()` and `screenshot()`, but the snapshot was only assigned and not echoed, so the final tool result was `(no output)` + image and the model had to rely on the screenshot. That behavior was classified as `bug-candidate` and the target behavior as `accepted`. A same-prompt runtime recheck after the fix produced only `navigate + snapshot`, no `screenshot`/`emitImage`, and 0 image blocks in the final provider request; the Baidu snapshot returned 30 action elements and 54 semantic DOM nodes, and large-result previews show `dom` first and then `elements` in schema order.

### 8.5 `playwright.domSnapshot()` contract

`tab.snapshot()` is a structured interface z-code keeps for the early ref/action workflow and is not part of the common Playwright API. The fact source of the locator workflow must be `tab.playwright.domSnapshot(): Promise<string>`; the two must not share one "snapshot contract" wording.

IAB `playwright.domSnapshot()` is frozen as:

1. Generate a Playwright `mode: "ai"` ARIA semantic tree from `document.body || document.documentElement`; returning `outerHTML`, whole-page `textContent` or hand-written role/name guesses is forbidden.
2. Use a fixed-version Playwright injected runtime executed in a CDP isolated world, so the page overriding native objects or modifying globals cannot pollute the snapshot.
3. Expand only iframes that the Playwright ARIA snapshot rendered, that are not `aria-hidden` and are visible; when a child frame fails keep the iframe itself and do not let one cross-origin/OOPIF frame fail the whole snapshot.
4. The total IAB iframe expansion budget is 1000 ms and 500 ms per child frame; frames at the same level are read concurrently and recursive results are inserted indented in place of the iframe row of the original ARIA tree.
5. Before returning to the model remove Playwright's internal `[ref=...]` and `[cursor=...]`; delete `img` rows without own semantics; flatten anonymous `generic` / `listitem` / `group` that serve only structure while keeping their children.
6. The public API gains no `maxElements` / `includeHidden` parameters. A top-level failure goes through the existing structured `execution_error`; abort/timeout reuse the browser command lifecycle.
7. `tab.snapshot()` keeps providing `elements/ref` compatible actions; the default locator docs and retry decisions use `playwright.domSnapshot()`, and `tab.snapshot()` is only called when entering the ref/dom_cua compatibility path.

Acceptance must cover ARIA role/name/state, hidden nodes, open shadow root, same-origin iframe, cross-origin/OOPIF degradation, ref/cursor cleaning, anonymous container flattening, empty image deletion, child frame timeout and large DOM not returning an HTML dump. The extension/CDP backends later reuse the same Playwright command/result and normalization function; no backend-specific return format.

The 2026-07-10 comparison of the injected runtime string sets and real-page behavior across Playwright `1.57.0`-`1.61.1` showed that representative role/name/state/shadow DOM output on `playwright-core@1.59.1` meets this contract; `1.61.1` additionally outputs `[invalid]`, so IAB pins `1.59.1` and does not follow newer versions. A recheck with the real `webContents.debugger` of Electron `41.0.3` and Chromium site isolation showed the main-document heading, the button inside an open shadow root, and the heading/button inside a cross-site OOPIF all enter the same ARIA text; hidden text, HTML dumps and internal refs do not. The recheck also found a race where, on OOPIF navigation, target registration lags behind the iframe node frameId; IAB now refreshes the target by the same aria-ref and retries, expanding child frames stably in two consecutive real runs.

### 8.6 Locator evidence and failure-budget regression

In a 2026-07-10 Bilibili trace, the first `domSnapshot()` showed only a nameless `textbox`, yet the model guessed `getByPlaceholder("搜索")`. The real placeholder is a dynamic recommendation, so the selector correctly returned 0 nodes, but the old IAB polled on the 30000 ms default budget, and the same timeout message was then printed twice by the client stack wrapper. The model then used `getByRole("textbox")`, which the snapshot clearly supported, and succeeded, proving that the issue was not a missing placeholder selector API but three independent defects: locator evidence discipline, timeout budget and error wrapping.

Frozen acceptance:

1. Default docs and the browser skill must explicitly forbid guessing locators and give the immediate rebuild flow for `count() === 0`.
2. IAB locator, URL/load-state wait and evaluate routine timeouts all go through a 3000 ms normalizer: explicit values above 3000 ms are truncated, values below are kept.
3. After the locator client wraps an error, the original timeout message appears only once in `message/stack` while the operation context is kept.
4. The fix is not made by adding fuzzy matching or a success fallback for dynamic placeholders; failing to match when the page has no `placeholder="搜索"` is correct semantics.

### 8.7 IAB locator/action execution contract

IAB locators and `domSnapshot()` must share the fixed-version Playwright injected selector runtime; maintaining a second hand-written role/name/text/label selector is forbidden:

1. `parseSelector/querySelectorAll/elementState` run in a CDP isolated world; observation and locating results for an open shadow root must be consistent; frame locators resolve segment by segment at frame boundaries, and same-origin frames and OOPIFs each use their own execution context, never relying on the main world's `iframe.contentDocument`.
2. click/check actions repeatedly check strictness, visible, stable, enabled and hit target within the full routine timeout; an element that exists but is still covered, animating or unavailable keeps waiting instead of failing falsely and at once. fill/type check only visible/enabled/editable, do not wait for stable and do not use click's hit-target/receives-events condition.
3. click/dblclick and press for non-clipboard shortcuts use CDP `Input` to produce browser trusted input; type and the `needsinput` branch of fill resolve the current focused frame inside the given tab and dispatch a virtual `paste` in that CDP target / execution context. Top-level `Input.insertText` must no longer be used, because the Electron embedder's composer may regain app focus between the click and type commands, sending text across the guest boundary. DOM mutations that Playwright itself lets the injected script do, such as `selectOption`, must still reuse the injected runtime and verify the final state.
4. Locator query and evaluate execution contexts follow their own API contracts; the page overriding native objects, polluting globals or CSP must not change selector results.
5. Selector parse, strict, timeout and abort keep returning unified structured errors; a cancel after the action was dispatched must be marked `sideEffect: "uncertain"`.
6. Selector resolve rules for single-element action/query/frame locators: 0 raw matches keeps "not found"; exactly 1 raw match is used directly; more than 1 allows only "exactly one visible element" as the unique fallback. Zero or several visible elements must stay strict violations, and automatically choosing `first/last/nth` is forbidden. Collection operations `count()` / `allTextContents()` keep returning the raw matching set and do not apply this fallback.
7. A strict violation must reuse the fixed-version injected runtime's `strictModeViolationError`, so the model sees a bounded candidate DOM preview and recommended selectors; returning only `resolved to N elements` and leaving the model to guess is forbidden. The element selected by the fallback must carry through actionability, DOM mutation/read and frame owner resolution; a visible element probed must not later fall back to the first element of the raw set.

Acceptance corresponds to BCP-066/067/094/095/096/190/191; until the real shadow DOM, same-origin iframe, OOPIF, overlay, disabled, animation and `event.isTrusted` cases pass, IAB Playwright behavior must not be declared done.

### 8.8 fill timeout and kernel reset

In a 2026-07-14 z.ai trace, `count()` had proved the input exists uniquely, but `fill()` kept waiting inside injected `checkElementStates(["stable", ...])`. That single CDP probe was not interrupted by the locator's 3000 ms budget and finally hit the outer MCP 30000 ms hard timeout with `AbortError: aborted`. The Node REPL rebuilt the kernel, but the error did not tell the model the old bindings were cleared, so it kept using `browser` / `zaiTab` and produced consecutive `ReferenceError`s.

Frozen fix boundary (confirmed by the user):

1. Only split the actionability of fill/type from click/check; click/check keep their stable and receives-events semantics, and click safety is not relaxed in the name of "fixing fill".
2. Every async probe of locator actionability must be bounded by the remaining locator budget; the underlying `Runtime.evaluate.timeout` cannot replace a host-side deadline race. A single stuck probe must return a locator timeout within at most 3000 ms and not spill into the MCP 30000 ms timeout.
3. The stability constraint of pointer actions applies to the visible target geometry currently hit by the locator, not to the DOM node identity of the first hit. When a responsive table or similar replaces an old node with an equivalent new node in adjacent animation frames, the probe must re-resolve the same selector; as long as the new target remains unique, visible, enabled, geometrically stable and passes hit-target, trusted CDP input continues. It must not return zero matches repeatedly for the full 3000 ms because the old node detached.
4. An AbortSignal timeout must keep `signal.reason`, so MCP hard timeout and user cancel are distinguishable. After a cancel or timeout causes a kernel reset, the current tool error must explicitly state that the kernel was reset and old bindings cleared and tell the model to re-establish the browser/tab bindings; it must not reset silently and let the model keep using stale variables.
5. Acceptance combination: fill works under continuous animation; a covered but editable input can still fill; disabled / readonly still fail; click under animation/overlay still waits; an undecided probe times out structurally within 3000 ms; after the MCP hard timeout the error explicitly includes kernel-reset recovery guidance.

### 8.9 Input target ownership and virtual clipboard

A 2026-07-15 runtime log recorded a type executed about 501 ms after a successful click on the same IAB tab; that gap allowed the ZCode composer's requestAnimationFrame autofocus to take Electron window focus back. The old executor then called `Input.insertText` without re-resolving the page's active element, frame target or input identity, so text could really leak into the embedder's main input.

The input contract of the type and fill `needsinput` branches is frozen:

1. `cua_type` and `dom_cua_type` share a type handler that does not call `Input.insertText`; the handler first builds browser-scoped clipboard items and then runs a virtual paste inside the given `tab_id`.
2. The focused target starts from the current document's `activeElement` and recursively crosses open shadow roots and same-origin iframes; on an OOPIF it switches to the corresponding CDP target/session, and on a same-process frame it creates an isolated execution context for that frame.
3. The paste builds `DataTransfer` and `ClipboardEvent("paste")` only in the final target/context. If the page does not handle the event, the fallback updates input/textarea by selection, or inserts text into a contenteditable and dispatches `input`. No branch calls the OS clipboard or sends keyboard text to the embedder renderer.
4. When Playwright fill/press focuses a locator it writes a one-time target token on the actual input element; before the virtual paste it must verify the current active element still holds the same token. If the target has drifted, fail explicitly and never send the text to the new focus.
5. CDP attached OOPIF sessions, isolated worlds and object handles must be released after the command; a frame cycle, an uninspectable focused frame or an invalid Runtime result returns a structured execution error and never falls back to top-level `Input.insertText`.

State and timing:

```text
embedder composer autofocus                 browser command(tabId)
          │                                            │
          │                                   resolve tab guest
          │                                            │
          └──── takes no part in browser input ──► activeElement
                                                       │
                                     shadow root / iframe / OOPIF
                                                       │
                                             target + context
                                                       │
                                     locator token check (if present)
                                                       │
                                               virtual paste
```

Acceptance covers plain input, textarea, contenteditable, open shadow root, same-origin iframe, OOPIF, locator target token drift, no editable focus, and "the host composer has regained focus but type can still modify only the guest page". Desktop and phone remote share the same shared-host executor; this change adds no runtime and does not change `desktop-continuous` / `web-remote-replayable` or the workspace identity boundary.

A 2026-07-15 recheck with Electron `41.0.3` real `BrowserWindow + <webview> + webContents.debugger`: when the guest input first got DOM focus and the host composer then regained app focus, old `Input.insertText("OLD")` gave `guest="" / host="OLD"`, while the new virtual paste gave `guest="NEW" / host=""`; same-origin iframe and cross-site OOPIF gave `frame="FRAME" / host=""` and `frame="OOPIF" / host=""`. The first OOPIF attach also reproduced the race where the `DOM frameId` precedes `Target.getTargets` registration; the implementation now waits boundedly for the target to appear before attaching and detaches after the paste.

## 9. IAB adapter rework

The existing BrowserGuestManager is only an internal implementation of the IAB provider. Required fixes:

- Guest keys add browserId/window/workspaceKey/session/tab ownership; a global activeKey must not hit across windows.
- list/get/selected return only tabs visible to the current context.
- `tabs.new()` truly creates and waits for the guest ready ack.
- Close notification runs through main -> preload -> platform -> UI, and a closed tab can never be re-attached.
- finalize/handoff/deliverable and session/turn cleanup.
- ready uses request/ack or replayable state, not a one-shot broadcast.
- Session close releases the REPL, pending requests, dialogs and guest/lease.
- screenshot(ref), live url/title, complete wait/capability and documentation stay consistent.

The IAB desktop-continuous main chain stays direct continuous; phone web remote uses the same IAB provider only through shared-host attachment and keeps the replayable boundary.

## 10. Extension backend

ZCode-owned content:

- MV3 Chrome extension with its own extension id.
- Native messaging manifest installers for three platforms.
- Own signed native host and a versioned registry.
- framing/JSON-RPC, reconnect and heartbeat between native host and extension.
- Chrome profile/instance/window preference.
- debugger attach/detach, tab lease/claim/group/finalize.
- Authorization and minimal-privilege reading of user tabs/history.
- downloads/file chooser/clipboard/dev logs.
- install/upgrade/remove/stale-process reconcile of plugin, extension and native host.
- Diagnostic commands and product UI for install/permission/run/profile.

Forbidden: using any third-party extension/native host id; distributing or launching third-party signed binaries; copying third-party service worker / native host / browser-client source.

## 11. CDP backend

- A standalone backend, not "IAB happens to use CDP internally". ZCode prefers building it as a pluggable remote/cloud provider rather than renaming a Playwright process to CDP.
- Feature-gated by default; connects only to explicitly configured/authorized endpoints.
- Target/context lifecycles are managed independently.
- Raw full CDP is a separate capability governed by allow/block policy and enterprise/product gates.
- Without the full CDP capability, the common Playwright/CUA APIs still use only the controlled command contract.
- It must not auto-scan and take over arbitrary local debugging ports.

## 12. Security model

Security checks sit at the browser-client/backend command boundary, independent of the `js` tool gate.

### 12.1 Confirmation required

- Outbound communication, form submission, publishing externally.
- Purchase, payment, ordering, financial transactions.
- Deleting data, canceling services, permission/account/key/extension changes.
- Uploading local files, transmitting sensitive or personal data.
- Logging in or using saved identity to perform side-effect actions.
- Browser permissions such as camera/mic/location/notification.

### 12.2 Allowed or pre-authorizable by policy

- Page reads, DOM snapshot, ordinary screenshots.
- User-requested navigation and side-effect-free queries.
- Whether a download needs confirmation is frozen by product policy, but it must be named safely, path-isolated and auditable.

### 12.3 Anti-bypass

- After a policy deny, raw CDP, evaluate, another backend, CUA or page scripts cannot bypass the same intent.
- Web content cannot grant permissions or tell the model to ignore policy.
- When credential UI injects a secret, the secret must not be returned to the model or logs.

## 13. Response meta and observability

Every browser command updates the tool response meta:

- the browser-use marker, backend type, browserId, openTabIds, the current URL;
- no screenshot attached by ordinary actions; an image result is returned only when the model explicitly calls the screenshot API;
- tab ownership/lifecycle state where needed.

Internal normalized fields are frozen as `browserUse/backendType/browserId/browserGeneration/openTabIds/tabId/currentUrl/lifecycle`; when the Node REPL exposes them to the model/client it must also form the outer markers `browser_use`, `zcode/browserUse` and `zcode/toolSurface`. `currentUrl` must have credentials, query and hash removed before entering meta. Failure results also carry meta without sensitive data. A cancel before the backend action was dispatched marks the error `sideEffect: "none"`; after dispatch, when it cannot be proven the action did not happen, mark `sideEffect: "uncertain"`.

ZCode **does not** auto-screenshot after a successful navigation/click/type or other side-effect cell, and does not put a screenshot into `zcode/toolSurface` for tool-panel preview: ordinary page actions must not call screenshot, and an explicit screenshot result must not be auto-copied into preview meta. This trade-off affects only the tool-panel preview and does not change DOM-first observation, explicit visual screenshots or tab lifecycle.

### 13.1 Provider-visible IAB ambient context

Frozen after reviewing two Turing-community trajectories on 2026-07-12:

1. Before each ordinary input enters the agent runtime, the desktop shared host reads, with a read-only command, a summary of the current window/workspace's IAB tabs. The attachment-free main path of `feat/web-app` is collected by v4 `command/sendText` and carried in the payload; the attachment path still in the compatibility period keeps going through legacy `session/send`. Both merge at least the current session's controlled tabs and claimable user tabs, dedupe, and keep only the tab count and current URL; they must not read cookies, storage, page body or sensitive form values.
2. The result is passed through a strict `browserAmbientContext` field, bounded and optional. The v4 handler must pass the field on to `sendInput`, and core projects it into this turn's provider input only; moving the main send chain to v4 must not silently lose it. Desktop uses `desktop-continuous`; phone remote still uses `web-remote-replayable` through shared-host attachment and keeps carrying `workspaceIdentity` / `remoteSessionId`; no separate browser runtime is started for the phone.
3. Core projects it only into this turn's provider-visible user content:

   ```text
   <in-app-browser-context source="ambient-ui-state">
   This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.
   # In app browser:
   - The user has the in-app browser open with N tab(s).
   - Current URL: ...
   </in-app-browser-context>

   ## My request for ZCode:
   <actual user input>
   ```

   The session store, UI message, title generation, input history and repo snapshot sidecar keep using the actual user input and neither save nor show the ambient wrapper. On read failure, no IAB backend or no tab, it is not injected; failure does not block the prompt and the full URL is not logged.

4. The ambient context is a fact, not a browser-selection instruction. The model still decides whether to use Browser from the user text; once it needs to continue the current page, before operating it should reuse an existing browser binding, check `tabs.list()`, then check `browser.user.openTabs()` and claim. This step-by-step flow is only for choosing the target tab before operating; if an action may open a popup/new tab and the source tab shows no expected effect, the same observation cell must unconditionally read and return both controlled/user tab states together, and the model must not decide again between two queries.
5. Model docs, skill and the `js` tool description must consistently forbid looping through guessed URLs/paths/resource IDs. One focused URL directly derived from the user's conditions is allowed; if it fails or cannot be verified, switch to a fresh DOM, in-site search, or a purpose-built connector/API/CLI, and verify the target page directly once an authoritative ID/URL is obtained.
6. App and Agent may briefly be version-skewed. When an old Agent returns `-32602` for `browserAmbientContext`, the App must recognize both `Invalid params` and `Invalid params — ...` with a field summary, confirm from the structured Zod issues that only degradable fields are involved, then delete the field and retry once; the compatibility error must not surface as a failure of the user's second send. `dev:local-cli` must rebuild the desktop agent bundle before starting, and must not prefer an outdated protocol implementation just because an old `dist/zcode.cjs` exists in the repo.

### 13.2 Electron navigation already committed

When a site redirects `www` to a mobile domain or an SPA takes over routing, Electron `<webview>` `loadURL()` may reject with `ERR_ABORTED (-3)` while the guest has already committed the new document. The navigation result is decided in this order:

1. Non-`ERR_ABORTED` errors, timeouts, cancels and real network errors keep the original structured failure semantics.
2. Only for `ERR_ABORTED` do a bounded re-check: the current URL must no longer be the pre-navigation URL; the current document's `location.href` must equal the webContents current URL with `readyState` at `interactive | complete`; and the target URL must equal the final URL, or differ only by a supported `www.` / `m.` host alias with the same path/search.
3. If the re-check passes, return success with the final state; otherwise still return `execution_error` + `sideEffect:"uncertain"`. Swallowing a failure based only on the error text or only because the URL changed is forbidden.

## 13.3 Trajectory acceptance sequence

IAB must support the following sequence:

1. After establishing the browser runtime in a fresh kernel, the skill must uniformly bind the current selection to `globalThis.browser`: explicit IAB uses `get("iab")`, a target URL uses `getForUrl(url)`; neither may first create an `iab` alias and then call `browser.*`. After binding, read the full `browser.documentation()` once; extra documents are read through `agent.documentation.get(name)`. The model-visible result budget of `js` is at least 64 KiB, and the current effective API documentation must not turn into an artifact preview within it.
2. `tabs.new()` automatically expands and activates IAB; only when the task explicitly needs to hide or show the browser again, read and call `browser.capabilities.get("visibility").set(false | true)`.
3. `browser.user.openTabs()` returns only user tabs not controlled by the current run. Every new batch of logical tab operations must first return the complete `browser.tabs.list()` result to the model in a separate JS call to inspect id/url/title/active; only the next JS call matches by stable id or explicit URL/title and calls `tabs.get(info.id)`. A silent list inside the SDK or hiding the result in the same cell does not count as the model having observed; with several tabs, guessing the target by array position is forbidden.
4. `tabs.get(info.id)` is not just creating an agent binding: the backend must make the target the only active tab of that scope and notify the renderer. Only when the origin workspace/session is currently in the foreground is it expanded and shown; a background conversation only updates its own selected/preferred tab and must not switch the user's current conversation or right sidebar. After a JS timeout/reset, recover with list -> match -> get; do not treat `TabInfo` as a tab, and do not create a duplicate tab before checking controlled tabs and user tabs.
5. When an action may open a popup/new tab and the source tab shows no expected URL/title/state, one JS observation cell must read both states with `Promise.all([browser.tabs.list(), browser.user.openTabs()])` and return `{ controlledTabs, userTabs }` as the final result; the model judges the effect once on the full result and then runs `tabs.get` or `user.claimTab` in the next cell. Returning the controlled list first and then deciding whether to query user tabs is forbidden.
6. After successful navigation use `playwright.domSnapshot()` to get the AI/ARIA page state; do not take a screenshot proactively.
7. `tabs.finalize({ keep: [{ tab, status: "deliverable" }] })` may mark delivery/handoff state; ZCode IAB no longer cleans up tabs not listed in `keep`. Whether or not the model calls finalize, all tabs not explicitly closed by the model or the user stay for the lifetime of the current ZCode process; restore after quitting ZCode is not promised.
8. All browser commands carry session/turn/sessionContext and return redacted browser-use meta; ZCode attaches no automatic preview screenshot.
9. The model-visible errors of stale/missing tab, locator strict violation and locator timeout must give executable, bounded recovery actions: first refresh the DOM or enumerate and re-obtain the tab, then rebuild the locator; never retry the same locator, mask ambiguity with `first/last/nth`, or guess a selector without snapshot evidence. The JS tool prints the error title and message once, and the stack only appends frames; the same error body must not be repeated twice.
10. Every browser-use command that maps to a real tab sends an operation event with `workspaceKey + sessionId + browserId + browserGeneration + tabId` to the origin renderer. Within 5 seconds of the event the matching browser-use tab replaces its favicon with a mouse icon and runs a 900 ms opacity + scale breathing animation on the icon's outer container (a generic SVG `animate-pulse` alone gives a 14 px icon only a slow opacity change the user cannot perceive). Subsequent operations on the same tab refresh the 5-second deadline. After the deadline restore the cached real page favicon (globe icon as default fallback); the status hint must not overwrite or clear the favicon. The animation must respect `prefers-reduced-motion`, and events of a background workspace/session must not mislabel other tabs with the same path.
11. If IAB is still visible on the second real user turn, the provider request must carry a bounded ambient context; the model should not treat the empty `tabs.list()` after finalize as a backend disconnect, and should not guess a detail-page ID without evidence.
12. `goto()` with `ERR_ABORTED` whose final document committed to an equivalent redirect/SPA URL returns success; the same error that still stays on the old page returns failure.

Logging:

- High-frequency command, CDP and stream traces use debug.
- Backend connect/disconnect, session create/close and extension host lifecycle use info.
- retry/degrade use warn; handshake/crash/security invariant failures use error.
- Credentials, sensitive input and full private page content are not logged.

## 14. Multi-end, workspace and remote constraints

- `workspaceKey = workspaceIdentity?.trim() || workspacePath` is used for backend cache, tab ownership, queues, request correlation and persistence.
- `workspacePath` is only for cwd, files and path display.
- A remote workspace's browser context must carry workspaceIdentity + remoteSessionId.
- Desktop `desktop-continuous` does not splice web replayable runtime recovery.
- Mobile `web-remote-replayable` cannot bypass snapshot/gap recovery and blocking confirmation.
- relay/main hold no browser task/stream/queue business state; the backend registry/lease belongs to the shared host/provider.
- owner/lease still serve running tasks, cross-host commands, blocking interactions and stale-run protection.

## 15. Delivery slices

### Slice A: Backend foundation

- shared/contracts define descriptor/type/context/list result.
- BrowserControlPort supports real list/discovery and browserId-aware execute.
- ZCode Protocol adds a strict-schema browser list; execute carries browserId/context.
- services/host expose the IAB adapter descriptor; the facade goes through the registry and no longer hard-codes IAB.
- Implement the section 5 selection pure functions with unit tests.
- Only IAB is discovered for now; extension/cdp availability is not claimed.

Result: done. During the compatibility period the execute context is optional but the new broker always sends it; `remoteSessionId` is only reserved in the schema because the existing session workspace ref has no such field, and its end-to-end threading moved to Slice B. The desktop IAB descriptor's runtime id is stable for the host lifetime, and a stale id is rejected before reaching main.

### Slice B: IAB correctness

- workspace/window/session isolation, real tabs.new/close/finalize, ready ack, cleanup.
- requestId/turnId/AbortSignal/clientMode threading.
- response meta and command logging fixes.

Result: the IAB provider has scope/generation, real tab ready/close, explicit user-tab claim, agent-created and claimed-user lifecycles, `Tabs.finalize({ keep })`, handoff/deliverable, turn/session/window cleanup, abort reverse cancel, browser-use outer meta and URL redaction. After a kernel reset a monotonic runtime generation rejects old bindings while the backend keeps controlled tabs for the new runtime to recover. Per section 13 the product explicitly generates no automatic preview screenshot. extension/CDP keep only the descriptor/registry/manifest extension hooks.

### Slice C: Manifest + common API

- Clean-room API manifest/interpreter/proxy/docs.
- Default documentation loads only included guidance; visual notes such as screenshots are looked up on demand.
- IAB snapshot adds bounded visible semantic DOM; model prompts and examples enforce DOM-first and echoing the observation.
- Playwright locator/wait/download/file chooser, clipboard/dev/content/capabilities.
- action-time confirmation.

Result: the member-level manifest/interpreter/runtime proxy/docs are dynamically bound to the current IAB capabilities, completing the common Playwright method-name set, locator/frame locator, trusted CDP input and the IAB download object; IAB file chooser is explicitly unsupported. `playwright.domSnapshot()` uses AI/ARIA output and the 3000/1000/500 ms top-level/iframe budgets; navigation wait and `expectNavigation` use concurrent-wait semantics; `networkidle` is explicitly rejected per the IAB implementation. `tab.snapshot()` remains the z-code ref/action compatibility entry but does not enter the effective common manifest; clipboard/dev/content/pageAssets/raw CDP and others are not claimed by the IAB descriptor, and future backends may expose them via capability/override only after real implementation.

### Slice D: Plugin/runtime decoupling

- Standalone Node REPL, decoupled from the browser-use plugin.
- The shared browser-client artifact enters the browser/chrome plugins and the four packaging chains.
- Fresh-kernel explicit bootstrap, lazy/deferred tool surface.

### Slice E: Extension

- ZCode Chrome extension/native host, install/upgrade/diagnostics/profile selection.
- user tabs/history/claim/finalize and security confirmation.

### Slice F: CDP

- P0: CLI explicit `--browser-use=headless` creates a managed CDP provider; after a real launch/handshake the backend is discovered, BrowserContext is isolated per session, tabs are kept across turns, and the Chromium it launched is reclaimed on session/app close.
- P0 claims only the really implemented navigation/DOM/Playwright/CUA/screenshot/viewport/dialog subset; user profile/history/claim, file chooser/download, clipboard/dev/raw CDP and others are hidden through manifest overrides.
- P1: gated external CDP attach, target lifecycle, full CDP capability/security; external browser ownership and managed launch are defined separately, and attach mode must not close the user's browser.

### Slice G: Completeness wrap-up

- Three-backend E2E, cross-backend black-box contracts, desktop/mobile/remote regressions.
- API/docs/capability contract snapshots.
- Plugin lifecycle/upgrade/disable/extension removal regressions.

## 16. Non-goals and forbidden stopgaps

- No backend named `playwright`.
- `get("extension")` never returns IAB or a stub.
- Never report a backend that has not handshaken in the list.
- Never use workspacePath in place of a remote workspace identity.
- Never start the phone remote browser runtime standalone in relay/main.
- Never fake the Playwright API quickly through unrestricted evaluate.
- Never copy or vendor any third-party private asset.

## 17. Definition of done

"Browser Use fully delivered" may be claimed only when all of the following hold:

- Descriptor/discovery/selection of the three backends pass cross-backend black-box contract tests.
- Every observable API interface/member declared by the manifest is implemented or conditionally hidden by capability; there is no public member that always throws NotImplemented.
- Playwright/CUA/DOM_CUA, tabs/user/content/clipboard/dev/dialog/capability behaviors pass contract tests.
- action-time confirmation and anti-bypass cases pass.
- response meta, timeout/kernel reset, turnEnded/finalize/cleanup pass.
- Desktop local, remote workspace and mobile replayable all pass isolation and recovery verification.
- browser/chrome plugin install/disable/upgrade and the extension/native-host state machine pass.
- `pnpm typecheck`, `pnpm lint` and the related unit/integration/E2E all pass.

Until then release notes must state the slices completed and the capabilities not implemented, and must not say "Browser Use is fully delivered".
