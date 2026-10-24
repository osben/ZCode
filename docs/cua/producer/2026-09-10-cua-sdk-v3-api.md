# ZCode CUA SDK v3 API design (model-visible surface, CUA only)

> Status: Draft, pending review. Date: 2026-09-10 (v3.1).
> Upstream plan: "ZCode CUA refactor: from 30 MCP tools to node_repl code execution" (internal doc).

v3.1 rule: the model-visible members are the existing 17 interaction-surface members plus
`requestAccess` and `stop`. A new capability must first ask whether it can be deleted; if it cannot be
deleted or replaced by composition, it may appear only as an optional option key or a trailing optional
parameter. Capabilities replaceable by composition or SDK mechanisms are removed from the tool layer
with no escape hatch, and broker methods and native implementations that lose their consumers are
deleted with them (no "just in case" primitives). `zoom` is deleted. Separately, compact output always
carries `actions` and `detail` is removed. Tool surface **30 -> 14**, broker protocol **63 -> 49**
(§3). Review accepted two capability contractions: "hold -> observe -> release" and clipboard reading.

Scope: the model-visible API of the `@zcode/cua` SDK, its internal layering, and one explicit slimming
of the tool surface and broker protocol. Unchanged: Helper authentication (M1), Helper lifecycle (M2), AX
normalization (M3), the node_repl MCP tool surface. The broker IPC protocol version **is bumped** (1 -> 2)
to delete methods that lost consumers, via M2's existing fail-closed `version_mismatch` path (§7.3).
**Browser Use is not merged:** `agent.browsers` / `browser-use-plugin` have zero changes.

---

## 0. TL;DR

### 0.1 Target shape

The model sees a camelCase `cua` global (no browser half). Signatures, option names and return types
are in §2:

```js
const state = await cua.getState();            // show app list
const app   = await cua.getApp("Notes");       // bind + show initial full AX tree
await app.click(42);
await app.typeText("hello");
await app.pressKey("Return");
await app.getAXState();                         // shown automatically; returns string
```

The model-visible surface is two safety methods plus four optional option bags, with no extra members.

### 0.2 Counts

| Dimension | Before | v3.1 |
|---|---|---|
| Model-visible tools / methods | 30 MCP tools | 19 SDK members (17 interaction-surface members + `requestAccess` + `stop`) |
| Underlying tool surface (`cua.computer`) | 30 | **14** (16 deleted, §3.2-3.5) |
| Broker protocol methods | 63 | **49** (15 deleted + `paste` added; 6 more test probes removable -> 43, §3.6) |
| Extra model-surface members | n/a | **0** |
| Extra model-surface options | n/a | 4 option bags, 5 keys (`modifiers` / `strategy` / `holdSeconds`) |

### 0.3 Two special semantics (must be stated in the model docs)

1. **Worker lifecycle:** every node_repl `js` is a fresh Worker (2026-07-28 stateless spec), so
   `const app` does not survive to the next cell and the docs must not teach `const` handles across
   calls. Mitigation in §5.1.
2. **`possibly_sent` replay protection:** actions are publicly `Promise<void>`; the "may have been
   dispatched" information does not take a signature slot and lives in the error object (§5.2).

---

## 1. Model-surface minimization principles

> **R1 | Model-visible members are fixed.** The existing 17 interaction-surface members + `requestAccess`
> + `stop`. No "better names", no extra positional parameters, no return-type changes.
>
> **R2 | For a new capability, first ask whether it can be deleted.** The test is not "is it useful" but
> **"can two lines of JS, one composed call, or an SDK-internal mechanism replace it"**. If yes, delete
> it. If not, with supporting evidence, it may appear only as an optional option key or trailing optional
> parameter on an existing method.
>
> **R3 | Safety semantics are hidden, never deleted.** `state_id` strict validation, exact frame raster,
> `possibly_sent`, controller lease and kill switch all stay, as internal fields or typed errors, not
> signature slots.

R2 is the core change from the v3 draft. The earlier version pushed every ZCode-only capability into the
`cua.computer` escape hatch because it costs the model nothing, but each tool costs the codebase a schema,
a handler, a tier-table entry, an annotation, an e2e oracle and one act-verify scenario per platform. Half
of the 30 tools are artifacts of the MCP era, where each extra round trip cost a model turn; under code
execution those parameters and tools are pure maintenance burden.

---

## 2. Model-visible surface

### 2.1 Full TypeScript declaration

`// + ZCode` marks an R2 addition (only optional keys / trailing optional parameters).

```ts
// ───────────────────────────────────────────── scalars
type Vec2 = [x: number, y: number];
type Direction = "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
type MouseButton = "left" | "right" | "middle" | "l" | "r" | "m";
type SelectionType = "text" | "cursor_before" | "cursor_after";

interface ObservationOptions {
  /** Display the observation to the model. Defaults to true. */
  emit?: boolean;
}
interface StateOptions extends ObservationOptions {
  disableDiffing?: boolean;
}                                                   // ← detail removed (§3.3)
interface ClickOptions {
  mouseButton?: MouseButton;
  clickCount?: number;
  modifiers?: string;                               // + ZCode ("cmd+shift")
  strategy?: "auto" | "a11y" | "event";             // + ZCode (default auto)
}
interface SelectTextOptions {
  prefix?: string;
  suffix?: string;
  selectionType?: SelectionType;
}
interface PasteOptions {
  format?: "text" | "md" | "html";
}                                                   // ← restoreClipboard removed (§3.4)
interface StateAndScreenshot {
  state: string;
  screenshot?: Uint8Array;
}
interface PressKeyOptions {                         // + ZCode (the whole second parameter is an addition)
  holdSeconds?: number;                             //   > 0 uses hold_key
  strategy?: "auto" | "a11y" | "event";
}                                                   // ← repeat removed (§3.4)
interface ScrollOptions {                           // + ZCode
  strategy?: "auto" | "a11y" | "event";
}                                                   // ← amount removed (§3.4)
interface DragOptions {                             // + ZCode
  modifiers?: string;
  strategy?: "auto" | "a11y" | "event";
}

// ───────────────────────────────────────────── interaction surface (12 members)
/** The shared interaction surface of an explicitly bound app. */
interface Target {
  /** Display and return the current accessibility state. */
  getAXState(options?: StateOptions): Promise<string>;
  /** Display and return the screenshot. */
  getScreenshot(options?: ObservationOptions): Promise<Uint8Array>;
  /** Display and return accessibility state and its screenshot, when available. */
  getAXStateAndScreenshot(options?: StateOptions): Promise<StateAndScreenshot>;

  paste(text: string, options?: PasteOptions): Promise<void>;
  click(target: number | Vec2, options?: ClickOptions): Promise<void>;
  drag(from: Vec2, to: Vec2, options?: DragOptions): Promise<void>;
  pressKey(key: string, options?: PressKeyOptions): Promise<void>;
  scroll(target: number | Vec2, direction: Direction,
         pages?: number, options?: ScrollOptions): Promise<void>;
  selectText(elementIndex: number, text: string,
             options?: SelectTextOptions): Promise<void>;
  setValue(elementIndex: number, value: string): Promise<void>;
  typeText(text: string): Promise<void>;
  performSecondaryAction(elementIndex: number, action: string): Promise<void>;
}
// ← Target.zoom removed (§3.2). Extra members: 0.

/** No additional documented members. */
interface App extends Target {}

// ───────────────────────────────────────────── data
interface AppInfo {
  // listApps passes the producer's list_applications wire shape through (no tool-layer mapping).
  pid: number;
  name: string | null;
  bundle_id: string | null;                         // macOS bundle id / Windows AUMID
  active: boolean;                                  // frontmost
}
interface State {
  apps: AppInfo[];
  // ZCode does not merge BUA: that key does **not exist** (§5.3).
}

// ───────────────────────────────────────────── root object
declare const cua: {
  getState(options?: ObservationOptions): Promise<State>;
  getApp(target: string): Promise<App>;
  listApps(options?: ObservationOptions): Promise<AppInfo[]>;
  computer: Computer;                               // see §3.5

  /** + ZCode: safety surface. Deliberately top level, not hidden in the escape hatch. */
  requestAccess(capabilities?: string[]): Promise<AccessStatus>;
  stop(reason?: string): Promise<void>;
};
```

### 2.2 Members and option differences

All 12 `Target` members share name and signature; differences are only in option bags:

| Member | Difference |
|---|---|
| `getAXState` / `getScreenshot` / `getAXStateAndScreenshot` | none |
| `paste` | none |
| `click` | `ClickOptions` adds `modifiers` / `strategy` |
| `drag` | adds trailing optional `DragOptions` |
| `pressKey` | adds trailing optional `PressKeyOptions` |
| `scroll` | adds trailing optional `ScrollOptions` (`strategy` only) |
| `selectText` / `setValue` / `typeText` / `performSecondaryAction` | none |

On the `cua` root: `getState` / `getApp` / `listApps` / `computer` form the base surface, `State` has no
`browsers` key, plus `requestAccess` / `stop`. The browser half (`browsers` / `getBrowser` /
`createBrowserTab` / `getTab` / `listBrowsers` / `listTabs`) **does not exist**.

### 2.3 Semantic rules (not only signatures)

Model-visible semantics follow `apps/zcode-cli/packages/zcode-cua-plugin/docs/computer-use.md` and are
not changed casually:

- **Observation methods display their result automatically**; action methods do not. `{emit:false}`
  disables it.
- **Bind means observe:** `cua.getApp(...)` shows the app's **full** AX tree before returning.
- **AX text is a diff by default;** `{disableDiffing:true}` returns the full tree. "If a standalone
  `getAXState()` reports no change, do not immediately repeat it without an intervening action."
- **Built-in settle; the model must not sleep** (about 1s, increasing to 5s on loading signs).
- **Index freshness:** re-run `getAXState()` after an action before deciding the next step.
- **Batching:** deterministic actions plus one trailing `getAXState()` in the same cell.
- **Fail by throwing:** actions are `Promise<void>`, success returns nothing.
- **First-use docs are progressively disclosed:** the first call of any kind shows the full API doc.
- "Attempting an action is not completion: verify that the returned UI state visibly shows the requested
  result" is kept verbatim.

---

## 3. Tool-surface slimming: 30 -> 14

### 3.1 Test

Each tool is asked two questions; it stays only if both answers are no:

1. Can one composed call replace it?
2. Can two lines of JS or an SDK-internal mechanism (settler / binding / paste composition) replace it?

### 3.2 Whole-cluster removal: full-screen pixel subsystem (5 tools)

`screenshot` (full screen), `zoom`, `list_displays`, `switch_display`, `cursor_position`.

These five are an interlocking cluster inherited from the 19-tool pixel-CUA era: `screenshot` captures
"the screen selected by `switch_display`", `cursor_position` returns `selected_display`
(`electronNativeBackend.ts:1036`), and `zoom` crops from the retained raster.

Key evidence that they can go: **per-app capture does not depend on the selected display.**
`axReadOnly.ts` / `axSkyshot.ts` have no `selectedDisplay` reference; the display-selection state is
consumed only by `screenshot` and `cursor_position`. Removing the cluster does not affect `getApp` /
`getAXState` / `app.getScreenshot()` (per-app path).

`zoom` is not a capability but a **compensation for lossy self-compression**: ZCode screenshots use a JPEG
quality ladder and chain-shrink the size when the byte budget is not met (`jpeg-budget.ts:124`), so small
text blurs and needs a magnified retake. Deleting it has an extra benefit: `frame-registry.ts:31` states
exact raster bytes are "retained **only** for frame-bound zoom", so the frame registry no longer needs to
keep every delivered raster in memory.

**Internal facilities that stay:** `display-topology` / `display-provenance` are used by `axReadOnly.ts`
and `electronInputHandlers.ts` for DIP coordinate conversion and input dispatch. Only the "selected
display" state layer is deleted (`selectedDisplayId` in `electronDisplaySelection.ts`, the same-named
state in `session.ts`). Whether the `screen_size` broker method stays is to be checked at implementation
time (`electronNativeBackend.ts:999`, suspected internal/diagnostic use only).

**Accepted cost:** the model loses "see the whole desktop". The replacement is `listApps()` + `getApp()`;
on macOS the menu-bar extras, Notification Center and Dock are AX-bearing processes that `getApp` covers.
On multiple displays, per-app capture works per the window's screen without selecting a display.

### 3.3 Remove `detail`; compact always carries actions (independent defect fix)

`detail:"full"` adds only two things over compact: `bounds` and `actions` (`format.ts:135-139`). But:

- `bounds` is something the model is **forbidden to use**. `SKILL.md:465`: bounds are global screen-point
  diagnostics, not raster pixels, "**never** copy them into a coordinate target".
- `actions` is the **only** legal source of `performSecondaryAction` values, and the SKILL requires using
  only the actions an element declares, not guessing.

The default tier is compact, so the default hid data required by semantic actions, and obtaining it
required switching to a tier that also dumps the forbidden field. That is the wrong shape for a switch.

Change: compact always carries `actions`, never `bounds`; the `detail` parameter is removed entirely
(tool layer and `StateOptions`). This can land first as a small independent PR.

### 3.4 Folded into options: 4 click variants + hold_key (5 tools)

| Removed tool | Replacement | Broker side |
|---|---|---|
| `double_click` | `click(t, {clickCount: 2})` | `click` already carries button + clicks, no change |
| `triple_click` | `click(t, {clickCount: 3})` | same |
| `right_click` | `click(t, {mouseButton: "right"})` | same |
| `middle_click` | `click(t, {mouseButton: "middle"})` | same |
| `hold_key` | `pressKey(key, {holdSeconds})` | `hold_key` / `hold_key_to_app` stay as primitives |

**Parameters** removed in the same batch:

- `key` `repeat`: `for (let i = 0; i < 3; i++) await app.pressKey("Down")` replaces it. It carried three
  special rules (negative rejected, `0` no-op, clamp to 1..100) with dedicated branches and messages in
  `keyboard-runtime.ts`.
- `scroll` `amount`: `pages` is more semantic.
- `paste` `restoreClipboard`: paste semantics **are** restore-after-paste; a switch would let the model
  pollute the user's clipboard.

### 3.5 Tools removed together with broker methods (6 tools)

| Removed tool | Why | Broker method |
|---|---|---|
| `wait` | with a settler, calling wait fights the SDK; built-in settle forbids sleeping | none (local sleep) |
| `read_clipboard` | content AX cannot read is a fallback of a fallback | `read_clipboard` **deleted** |
| `write_clipboard` | replaced by `paste` | `write_clipboard` **deleted** |
| `mouse_move` | hover tooltips are rare | `move_to` **deleted** |
| `left_mouse_down` | an unpaired press has an input-hold leak surface | `mouse_down` **deleted** |
| `left_mouse_up` | same | `mouse_up` **deleted** |

The only real combined use of `mouse_move` + `left_mouse_down` + `left_mouse_up` is "hold -> observe ->
release" (hover-expand folder while dragging, slider fine-tuning). **v3.1 exposes no hold-style
primitives**; `drag(from, to)` is the only drag entry.

Side benefit: the model can no longer obtain an unpaired `left_mouse_down`, so the **model-side leak
surface** of `InputHoldRegistry` + `pointerHoldGuard` disappears (`hold_key` survives, so internal cleanup
keeps `cancel_input_holds`).

**Accepted capability contractions (review-confirmed):** hover-expand drag-and-drop, slider fine-tuning
and clipboard reading are abandoned. No broker primitive is kept "just in case"; restoring one means
re-adding the method, the native implementation and bumping the protocol version (cost listed in §9).

### 3.6 Broker protocol slimming: 63 -> 49

After the tool layer shrinks, some broker methods lose all consumers. Review decided to delete them
together, keeping no primitives.

- **Already dead (6):** `screen_size`, `get_skyshot` (per-app screenshots use `capture_app`),
  `click_element_at_point` (coordinate-to-AX uses `element_at_point` + `element_press`, see
  `target-utils.ts`) have zero call sites in src; `key_down` / `key_up`
  (`electronInputHandlers.ts:4284-4301`) and `type_text_into_current_focus` (`:4208-4223`) have only
  Helper-side implementations and no caller.
- **Losing consumers with the tool deletion (9):** `screenshot`, `list_displays`, `set_display`,
  `cursor_position`, `move_to`, `mouse_down`, `mouse_up`, `read_clipboard`, `write_clipboard`.
- **Added (1):** `paste`, a native implementation (NSPasteboard save / write / send paste key / restore
  inside the Helper), see §6.6. Not a host-side composition of clipboard primitives.
- **Optional cleanup (6 test-only probes):** `pip_live_probe_start_test_panel` / `_window_bounds` /
  `_drag_panel` / `_move_test_panel` / `_sample_ownership` / `_initial_hit_surface`. Their only consumers
  are `scripts/pip_live_*` and `test/pip-live-*`; they exist only for tests but live in the production
  broker protocol. Move them behind a DEBUG build gate or drive the panel from a test-only entry. Doing so
  takes 63 -> 43.

**The protocol version bump is an in-design operation:** the `ipcVersion.ts` comment states that semantic
changes (**method additions/removals**, request/response shapes, auth model) must bump, and mismatches go
through `version_mismatch` (no retry, prompt to upgrade). `CUA_BROKER_IPC_VERSION` goes from `1` to `2`.

### 3.7 The 14 surviving tools (`cua.computer`)

```
list_apps  open_application  list_windows  get_app_state
left_click  scroll  left_click_drag
type  set_value  select_text  key
perform_action
request_access  stop_computer_control
```

`cua.computer` exposes the **platform-specific low-level computer API** (semantics in
`apps/zcode-cli/packages/zcode-cua-plugin/docs/computer-use.md`); the model docs mention it in one
sentence.

ZCode-only capabilities that live here: **window addressing** (`list_windows` + `app_ref.window_id`,
§4.1), **exact pid selection**, **`open_application` `activate` / `confirm_focus_steal` / `new_instance` /
`urls`** (a prerequisite of the strategy=event flow; `cua-14-tool-e2e-validity.md` says the file panel
needs "confirmed open_application followed by a fresh observation"), and the **`select_text` range form**
(internal implementation of text matching, §6.3).

### 3.8 Three capabilities that must stay, with evidence

| Capability | Evidence |
|---|---|
| `strategy: "event"` | `cua-14-tool-e2e-validity.md`: Finder rename (M01/M04), TextEdit character style (M08-M10) and Chromium keyboard navigation (C16) **require** `strategy=event` + exact `window_id`, otherwise AX returns success while the document model is unchanged (responder-chain reality). "Do not steal the user's focus" is a core ZCode selling point and costs this escape hatch |
| Window addressing | same doc: M01 / M04 / M08-M10 / C16 all bind an exact window. The tool description at `observation.ts:1008-1011` teaches the model to fill `window_id` back |
| `modifiers` | cmd+click (open in new tab) and shift+click (range select) cannot be composed; modifiers must be active at the moment of press |

`strategy: "a11y"` (force AX, fail closed when no action is available) is rarely used but free as an
option key and the only way to prevent silent degradation to coordinates, so it stays.

---

## 4. Three dispositions that need explanation

### 4.1 Window addressing

ZCode's tool surface uses one naming across three platforms (a core decision of AGENTS.md §2), and
`getApp` works on all three; it is not split into two binding shapes per platform. R1 wins:

- **Documented surface:** `App` has no window member. `getApp` binds the main / key window.
- **Escape hatch:** `cua.computer.list_windows({app_ref})` plus putting `window_id` back into `app_ref`.
- **Undocumented member:** `cua.getWindow(app: string, windowId: number): Promise<App>` returns an `App`
  bound to that window (same `Target` interface). Not in the SKILL, not in `documentation.get()`.

**Correctness gain kept:** today a stale `window_id` makes the Helper silently fall back to the frontmost
window, returning only `window_id_fallback: true` and a note (`axReadOnly.ts:1235-1244`) that models easily
miss, then act on the wrong window. `cua.getWindow()` **throws** `STALE_STATE` on fallback.

**Known gap:** single-window foregrounding (`activate_window`). The native capability exists
(`activateWindow(pid, bundleId, windowId)` at `electronNativeBackendTypes.ts:352`: atomic raise + focus +
activate + identity re-check) but is not exposed as a broker method and is called only inside
window-scoped raw input (`electronInputHandlers.ts:963-970`). S5 adds an `activate_window` broker method
and enables it.

### 4.2 Structured AX view

R1 requires `getAXState(): Promise<string>`, which has a real cost: the SKILL taught "observe -> find
elements structurally -> act" in a single cell, which a string return cannot do; with unknown indexes,
discovery costs an extra round trip.

The documented surface returns `string` per R1; `app.elements(): Promise<AppElement[]>` keeps the
structured view; S4 gray-release measured round trips and pass rates of both with GUI eval.

**S4 conclusion (2026-09-16, the reversal took effect):** `elements()` is promoted to a **documented
member**. The criterion is not tokens or round trips but "when the tree is pruned the model has no other
way out": `targeting/format.ts` selects elements by priority past the limit and restores ancestor chains,
with the note `indices are sparse; N hidden` (736 -> 300 on a real machine). The indexes of hidden elements
then do not appear in the tree text at all and the model can only guess, whereas the structured table
returned by `elements()` is always complete ("text may be a diff, structure must be complete") and is the
only reliable way out. It therefore appears in the SKILL Keyboard section and the API section of
`computer-use.md`; the implementation keeps it `enumerable: false` (R2 constrains the **enumerable**
surface and does not forbid named escape hatches).

The accompanying safety statement is mandatory: `elements()` observes without displaying, so like
`bindApp` / `getScreenshot` it must pass `tree_shown_to_model: false` and clear the SDK-side `treeSeen`
(otherwise the next `getAXState` would diff against a tree that was never shown). The 2026-09-16 review
found both missing; they are fixed with a regression test (z-code `tests/sdk.node-test.mjs`,
"every silent observation declares...").

Removing `state_id` from the model surface is a net gain independent of the structured view: indexes are
resolved by the SDK with the target's current `stateId` (§5.5), so the model cannot write a wrong
`state_id` and stale is always fail-closed, stricter than today. The z-code 2026-08-25 hardening
"structured AppState is the Worker's only source of truth" assumed the model assembles `{state_id,index}`
itself; in v3.1 that premise is gone and it becomes an **internal** invariant: the bridge still throws
`CUA_STRUCTURED_STATE_UNAVAILABLE` when a response has no structured AppState, but no longer has to expose
it to the Worker.

### 4.3 One explicit thaw of a frozen contract

`TOOL_NAMES` (30) + `TIER_TABLE` + `TOOL_REGISTRY` + the cross-repo evaluator manifest form a 4-way drift
gate (`manifest.ts` comment + `test/manifest.test.ts`). `docs/cua-14-tool-e2e-validity.md` is the
normative regression contract, where `protocol.all_30_tools_have_passing_oracles` requires all 30 names to
have passing oracles.

The gate exists to **prevent accidental drift**, not to forbid deliberate deletion. The v3.1 tool deletion
is a **deliberate thaw** and must be stated in both the commit message and that normative doc: the
deletion list, each item's replacement path, and the new tool count. The gate stays (14 paths still agree
four ways); only the baseline number changes from 30 to 14.

---

## 5. Special semantics and boundaries

### 5.1 Stateless Worker and cross-cell state

ZCode follows the 2026-07-28 stateless spec: each `js` is a disposable Worker and `const app` does not
survive to the next cell.

Mitigation: `stateId` / `frameId` / diff baseline / first-use-doc flag are all held by the **shared host's
runtime session**. In the next cell `await cua.getApp("Notes")` **re-binds without re-observing**: when the
app's latest `stateId` is available it shows only one line `reattached: Notes (stateId=…)` instead of
dumping the full tree. The model docs do not claim "state is persistent across calls"; they give a
per-cell bootstrap template (§7.6) and state "bindings do not cross cells, but UI state does".

### 5.2 `possibly_sent` replay protection

Actions are publicly `Promise<void>`; failure throws `ComputerUseError{code, errorName}` (string codes).
"The action may have been dispatched" takes no signature slot. ZCode's `action_sent` / `dispatch_status`
are incident-driven: a click may already have landed and a blind retry would double-click. R3 says hide,
do not delete:

```ts
declare class ComputerUseError extends Error {
  readonly code: ComputerUseErrorCode;   // string code, mapped from BrokerErrorCode
  /** Whether the action was dispatched. Only false allows safely retrying the same non-idempotent action. */
  readonly actionSent: boolean;
  readonly dispatchStatus?: "accepted" | "possibly_sent";
  readonly retry: "reobserve" | "retry" | "never";
  readonly details: Readonly<Record<string, unknown>>;
}
```

| runtime receipt | v3.1 behavior |
|---|---|
| `action_sent:true, dispatch_status:"accepted"` | resolve (void) |
| `action_sent:true, dispatch_status:"possibly_sent"` | **reject**, `actionSent:true`, `retry:"reobserve"` |
| `action_sent:false` | reject, `actionSent:false`, `retry` per code |

Error codes: `PERMISSION_DENIED` `NOT_AUTHORIZED` `APP_NOT_FOUND` `AMBIGUOUS_APP` `LAUNCH_FAILED`
`INVALID_APP` `ELEMENT_UNAVAILABLE` `STALE_STATE` `NOT_SETTABLE` `NOT_SELECTABLE` `ACTION_UNAVAILABLE`
`FOREGROUND_REQUIRED` `CONTROLLER_BUSY` `CONTROL_STOPPED` `SCREEN_LOCKED` `HELPER_UNAVAILABLE`
`VERSION_MISMATCH` `TIMEOUT` `STRUCTURED_STATE_UNAVAILABLE` `INTERNAL`.

Second kept guarantee: the **exact frame raster contract**. ZCode's `frame-contract/` +
`official-frame-integrity-v1` must stay, fully internalized: `getScreenshot()` returns a bare
`Uint8Array`, the SDK records `frameId` on the target, coordinate actions bind it internally, and the model
never sees or passes it.

### 5.3 No BUA merge

- `cua` has **no** `browsers` / `getBrowser` / `createBrowserTab` / `getTab` / `listBrowsers` /
  `listTabs`; `State` has **no** `browsers` key.
- `Target` is implemented only by `App`; it shares no type or implementation with browser `Tab`.
- `agent.browsers` stays independent in Browser Use; CUA neither reads, writes nor overrides it.
- The `agent.documentation.get(name)` delegation chain stays: CUA handles only `"computer-use"`.
- The two plugins' `computer-use-client.mjs` stay independent; this round changes only the CUA one; the
  shared bridge is unchanged.

### 5.4 Explicitly out of scope

Audio recording, organization-level app denylists and per-app approval popups (ZCode covers the same need
with controller lease + kill switch + one-time high-risk approval on the outer `js`; the upstream plan
decided no per-action approval on the inner layer).

### 5.5 Resolving indexes and coordinates

```ts
function bindTarget(t: number | Vec2, ctx: TargetSession): ResolvedTarget;
// number → {type:"element", state_id: ctx.stateId!, index: t}
//          stateId missing → throw STALE_STATE (message gives `await app.getAXState()`)
// [x,y]  → {type:"coordinate", frame_id: ctx.frameId, x, y}
//          frameId missing → throw STALE_STATE (message gives `await app.getScreenshot()`)
```

**No automatic re-observation.** Auto re-observing would turn "the model thinks it clicks A but hits B"
into a silent error. `drag(from, to)` binds both ends independently.

---

## 6. Internal layering and implementation

### 6.1 Layers

```
Worker (model code)
  globalThis.cua / App                     ← rewritten: scripts/computer-use-client.mjs
       │  bridge.call(method, input)        ← unchanged (Symbol zcode.node-repl.computer-use-bridge)
       ▼
shared host: CuaRuntimePool                 ← unchanged
  └─ ComputerUseRuntime.execute({toolName, arguments, context})
       ├─ withActionPolicy (§6.2)
       ├─ ActionSettler (§6.4)
       ├─ TargetBinder (§5.5)
       └─ TargetSessionStore (§6.5)
       ▼
  14 surviving handlers (observation/pointer/keyboard-runtime/semantic)
       ▼
  BrokerClient → signed Helper
```

S0-S4 make **zero Helper protocol changes:** deleting the tool layer does not require deleting broker
methods. Dead-method cleanup on the Helper side is a separate PR (§7.3) to avoid tangling with M1
signing / M2 lifecycle.

### 6.2 `withActionPolicy`

Cross-cutting concerns scattered across handlers become one decorator:

```
killSwitch.ensureRunning()          // today withKillSwitchPreflight
  → setAppDisplaySideband(target)   // today runWithTargetAppDisplayContext (PiP / Win indicator)
  → controllerLease.ensure()        // → CONTROLLER_BUSY
  → settler.wait(targetKey)
  → handler(args)
  → settler.defer(targetKey)
  → telemetry({durationMs, terminalStatus, toolName, appId})
```

TOCTOU hardening (post-validation rewrite of the `app_ref` pid / window_id binding target) exists and
stays. **No per-app approval popup is introduced.**

### 6.3 `selectText` by content

The model-facing signature is `selectText(elementIndex, text, {prefix, suffix, selectionType})`; today's
ZCode is `select_text({target, text_range:[start,length]})`.

**No Helper change is needed:** the SDK reads the element value (existing `read_element`), the host uses
`prefix` / `suffix` to find a unique match, computes `[start, length]`, and calls the existing
`element_select_text`. A non-unique match throws `NOT_SELECTABLE` with the candidate count.
`selectionType` maps to a collapsed selection with `length:0`.

### 6.4 `ActionSettler`

New `ActionSettler` (`defer()` pushes the deadline, `wait()` waits until it), applied on all platforms,
bucketed per target. Parameters: `postActionMs` between consecutive actions defaults to 100ms; base wait
before observation about 1000ms, increasing to at most 5000ms on loading / busy signs. The latter is
implemented in S3 as a local stability check ("element-table hash equal twice", no Helper change); S5 lets
the Helper provide a busy signal. This makes deleting the `wait` tool possible (§3.5).

### 6.5 `TargetSessionStore`

Each bound target holds on the host side
`{ appRef, stateId, frameId, diffBaseline, appInstructionsShown, settleDeadline }`. Uses: baseline for
index / coordinate resolution, diff baseline, reattach on `getApp` re-bind, app-specific hints shown once
(`Set` dedup). Lifetime follows the runtime session, not the Worker.

### 6.6 `paste` (native broker method)

**Implemented as a native Helper action, not host-side assembly.** The Helper performs clipboard save ->
write -> send paste key -> restore internally.

ZCode adds one broker method `paste` with parameters `{app_ref, target?, text, format}`, implemented
natively on the Helper (macOS NSPasteboard, Windows / Linux their own clipboard APIs), with save / restore
fully inside the Helper.

Why not host-side composition (`read_clipboard` -> `write_clipboard` -> paste key -> restore): it would
keep two broker clipboard primitives that have no other consumer in v3.1 (§3.6). Restoring inside the
Helper also fixes a race: between the four host-side steps the user or another process may rewrite the
clipboard and the restore would overwrite the user's new content.

Value: `typeText` types per character and historically had a macOS unicode defect, and multi-line text can
trigger auto-indent / auto-complete; prefer `paste` for formatted and multi-line content.

**Scheduling:** `paste` depends on a Helper change, so it lands in S0c (the protocol slimming PR), not S1.
`md` / `html` need multi-flavor pasteboard: S0c does `text` only, passing `md`/`html` throws
`ACTION_UNAVAILABLE` with a downgrade hint, and S5 completes them.

### 6.7 Key alias normalization

Models have priors for xdotool / keysym key names. A normalization layer goes before
`findUnsupportedKeyToken`:

| Input alias | Canonical token |
|---|---|
| `Return` `Enter` `KP_Enter` | `return` |
| `Control_L` `Control_R` `Control` `Ctrl` | `ctrl` |
| `Alt_L` `Alt_R` `Meta_L` | `alt` |
| `Super_L` `Super_R` `Super` | `cmd` (darwin) / `super` (linux) / `win` (win32) |
| `Shift_L` `Shift_R` | `shift` |
| `Escape` | `esc` |
| `Prior` / `Next` | `pageup` / `pagedown` |
| `period` `comma` `greater` `slash` `minus` `equal` | `.` `,` `>` `/` `-` `=` |
| `KP_0`…`KP_9` | needs Helper mapping; throws an explicit error when missing, never silently dropped |

Input-side compatibility only; the internal token set and the cross-platform modifier rule are unchanged
(macOS `cmd`, Linux / Windows `ctrl`; the docs keep saying so).

### 6.8 Files to add / change / delete

- **Rewrite:** `zcode-cua-plugin/scripts/computer-use-client.mjs` (`cua` global, `Target`/`App`, auto emit,
  error mapping, `cua.computer` (14), undocumented members), `zcode-cua-plugin/docs/computer-use.md` (v3.1
  reference, browser half removed, per-cell bootstrap section), both `SKILL.md` files
  (`zcode-cua-plugin/skills/computer-use/` and the producer source of truth
  `zcode-cua/plugin/skills/computer-use/`).
- **Delete:** `zcode-cua/src/tools/zoom.ts` (480 lines); `electronDisplaySelection.ts` and
  `selectedDisplayId` in `targeting/session.ts` (S0c).
- **Sync:** `tools/manifest.ts` (`TOOL_NAMES` 30 -> 14, `APP_ASSOCIATION_MODE_BY_TOOL`),
  `tools/tier-table.ts` (`left_mouse_up` leaves SAFETY_CONTROL), `tools/schemas/*` (16 tools; `detail` /
  `repeat` / `amount`), `tools/{observation,pointer,keyboard-runtime}.ts` handlers, `targeting/format.ts`
  (§3.3), `targeting/frame-registry.ts` (no raster bytes kept for zoom, drop the `zoom` hint from errors).
- **Delta:** `tools/observation.ts` maps all three states to a complete internal AppState and removes the two
  unconditional `force_full:true` (:644, :1092); `broker/server/axReadOnly.ts` delta / no_change responses
  carry the full `elements` table + a new `state_id`.
- **New:** `runtime/action-settler.ts` (§6.4), `runtime/target-session-store.ts` (§6.5),
  `tools/action-policy.ts` (§6.2, replaces `withKillSwitchPreflight` call sites), `tools/target-binder.ts`
  (§5.5); key aliases (§6.7) and `select_text` content matching (§6.3) in `keyboard-runtime.ts`.
- **Maps/docs:** `tools/legacyToolMap.ts` gains `computer` (surviving 14) and `v3` columns, deleted tools
  marked `removed` + replacement; `zcode-cua/docs/cua-30-tool-e2e-validity.md` is **renamed and rewritten**
  30 -> 14 with the thaw reason (§4.3).
- **Protocol:** `broker/types.ts` / `ipcVersion.ts` and the Helper native layer per §7.3.

---


## 7. Compatibility, sweep and tests

### 7.1 Compatibility channels

1. **`cua.computer.*`:** the 14 surviving methods keep schema and return envelope verbatim.
2. **`agent.computerUse`:** kept for one version as an alias of `cua`; deleted in S5.
3. **`legacyToolMap`:** deleted tools marked `removed` + replacement path, used only for read-only parsing
   and troubleshooting of historical transcripts, never executed.

### 7.2 Deletion sweep (the real S0 workload)

- `test/manifest.test.ts` 4-way drift gate: baseline 30 -> 14, all four still agree; sync
  `test/tier-table.test.ts` / `annotations.test.ts` / `test/legacy-tool-map.test.ts` (`removed` assertions).
- `docs/cua-14-tool-e2e-validity.md` (normative): `protocol.all_30_tools_have_passing_oracles` -> 14; remove
  entries from `FULL_SURFACE_ORACLE_CHECKS`; state the thaw.
- `evals/zcode-gui-eval/`: delete or rewrite scenarios for deleted tools (C18 full-surface coverage is
  affected most).
- `scripts/cua_act_verify*.py` + `docs/cua-act-verify-{,windows-,linux-}scenarios.md`: sweep each
  platform's scenarios; `hold_key` / `wait` / `select_text` must be rewritten to the new forms.
- `scripts/windows-*-live-smoke.mjs` / `verify_linux_*.mjs` and other `docs/` references to deleted tools.


### 7.3 Broker protocol slimming (S0c, in scope)

Deletion list in §3.6: 15 deleted + 1 added (`paste`), optionally 6 more test probes. **A separate PR**,
placed before the SDK refactor because `paste` depends on it.

- `src/broker/types.ts`: `BROKER_METHODS` 63 -> 49; `READ_ONLY_BROKER_METHODS` drops deleted items.
- `src/broker/ipcVersion.ts`: `CUA_BROKER_IPC_VERSION` 1 -> 2.
- `electronInputHandlers.ts`: delete `move_to` / `mouse_down` / `mouse_up` / `key_down` / `key_up` /
  `type_text_into_current_focus` / `read_clipboard` / `write_clipboard`; add `paste`.
- `electronNativeBackend.ts`: delete `screenshot` / `list_displays` / `set_display` / `cursor_position` /
  `screen_size` / `get_skyshot` / `click_element_at_point`.
- `electronDisplaySelection.ts`: delete entirely (topology stays in `lib/display-topology.ts`).
- Native layer: delete the matching addon exports (`moveTo` / `mouseDown` / `mouseUp` / `keyDownGlobal` /
  `keyUpGlobal` / full-screen `screenshot` / the display-enumeration part used only for selection); add
  native `paste` (NSPasteboard / Windows / Linux, one each).
- `test/broker/*`: update `types.readOnlyMethods.test.ts` etc. to the new list.
- Cross-version: old Helper + new host goes through `version_mismatch` (no retry, prompt to upgrade), an
  existing M2 path.

**Rollback granularity:** S0c is one commit / PR. Rolling it back also rolls back `paste`, so S1's
`paste`-related tests must skip rather than fail when `paste` is absent.

### 7.4 Contract test changes

| Test | Current assertion | Change |
|---|---|---|
| `z-code .../zcode-cua-plugin/tests/sdk.node-test.mjs` | `METHOD_NAMES.length === 30` | becomes: `cua.computer` has 14 entries + all 12 `Target` members present + `cua` has no browser member |
| same | action results contain `action_sent` / `dispatch_status` | success resolves `undefined`; `possibly_sent` rejects with `actionSent === true` |
| `zcode-cua/test/skill-keyboard-contract.test.ts` | pins `nodeRepl.write(nextState.text)`, `return_state="none"`, 22KB limit | pins "observation methods display automatically", "never write the observation result again", "per-cell bootstrap" |
| `zcode-cua/test/observation-tools.test.ts` | delta / no_change -> `null` | inverted: all three states return a complete internal AppState |
| New | n/a | exact surface assertion (§7.5), `target-binder.test.ts`, `action-settler.test.ts`, `key-alias.test.ts`, `paste.test.ts`, `error-mapping.test.ts`, `compact-carries-actions.test.ts` |

### 7.5 Surface gate

`apps/zcode-cli/packages/zcode-cua-plugin/tests/sdk.node-test.mjs` makes exact surface assertions on the
model-visible surface:

1. The 12 `Target` interaction-surface members **exist with identical names and positional parameter
   order;**
2. Additions relative to the core interaction surface **may only be** optional option keys or trailing
   optional parameters, or allowlisted members (current allowlist: `cua.requestAccess`, `cua.stop`,
   `cua.computer`); **the number of extra members on `Target` must be 0;**
3. `cua` has no browser member and `State` has no `browsers` key.

An addition outside the allowlist fails the test, forcing the next API changer to decide explicitly.

### 7.6 Bootstrap template

```js
const root = process.env.ZCODE_CUA_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT
  ?? process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href);
await setupComputerUseRuntime({ globals: globalThis });   // installs globalThis.cua

const app = await cua.getApp("Notes");
await app.click(42);
await app.getAXState();
```

`setupComputerUseRuntime` is idempotent and runs in every cell. Call `cua.getState()` only when the app
list is needed; the reference doc is fetched on demand (`agent.documentation.get("computer-use")`), not
pushed on first use.

---

## 8. Staged rollout

- **S0a** (independent small PR): compact always carries `actions`, never `bounds`; delete `detail` (§3.3).
  Accept: `compact-carries-actions.test.ts`; `perform_action` no longer needs `detail:"full"`.
- **S0b**: tool-surface slimming 30 -> 14 (§3.2 / §3.4 / §3.5) + full sweep (§7.2) + thaw doc (§4.3).
  Accept: 4-way drift gate baseline 14 and consistent; evals / act-verify / smoke green; `pnpm typecheck`
  passes after `zoom.ts` deletion.
- **S0c**: broker protocol slimming 63 -> 49 + native `paste` (§3.6 / §7.3), including native-layer and
  `electronDisplaySelection.ts` deletion, IPC version 1 -> 2. Accept: old Helper + new host goes through
  `version_mismatch`; three-platform Helper builds pass; `paste`(text) has a real paste oracle.
- **S1**: `cua` global + `Target`/`App` + `TargetBinder` + `TargetSessionStore` + error mapping +
  `cua.computer`. Accept: `sdk.node-test.mjs` surface assertions green (`Target` extras 0);
  `error-mapping.test.ts` covers all codes.
- **S2**: auto emit + first-use doc disclosure + delta opened up (Helper adds `elements` and a new
  `state_id`). Accept: observation tokens for the same task down >= 60% vs S1; `no_change` no longer
  triggers force_full; no duplicate output.
- **S3**: `ActionSettler` + `withActionPolicy`. Accept: all "model waits itself" wording removed from the
  SKILL; act-verify pass rate does not drop.
- **S4**: `selectText` content matching, key aliases, `getWindow` (stays undocumented) / `elements`
  (promoted to documented, §4.2). Accept: 4 new unit-test groups + one new act-verify scenario per
  platform.
- **S5**: SKILL / `computer-use.md` / legacyToolMap / provenance sync; gray release; delete the
  `agent.computerUse` alias; `activate_window`; `paste` `md`/`html`. Accept: contract tests green;
  `pnpm typecheck` `pnpm lint`; GUI eval no regression.
- **S6** (optional): delete the 6 `pip_live_probe_*` test probes (63 -> 43), busy signal, `numpad` keysyms.

S0a can start immediately and depends on no model-surface decision. Doing S0b first halves the surface of
later changes. S0c must precede S1 because `paste` depends on it. Gray-release switch:
`ZCODE_CUA_SDK_SURFACE=v1|v3` (default v1, flipped to v3 after the observation period).

---

## 9. Risks

- **A deleted tool or broker method turns out to be needed.** Restoring costs a schema + handler + broker
  method + three-platform native implementation + another IPC version bump. Each deletion's reason and
  replacement path is on record (§3.2-3.6, Appendix B); S0b and S0c are separate PRs for whole rollback.
  Review accepted the cost, including the loss of "hold -> observe -> release" and clipboard reading; no
  broker primitive is kept "just in case".
- **No full-screen observation.** `listApps()` + `getApp()` replace it; macOS system UI are AX-bearing
  processes.
- **Small text unreadable without zoom.** S0b must quantify the real scaling of per-app screenshots. If it
  is severe, tune the per-app screenshot budget rather than restoring zoom.
- **Rolling back S0c also rolls back `paste`.** From S1, `paste` tests skip rather than fail when the
  method is missing (§7.3).
- **Native `paste` per platform** has more work and regression surface than host-side composition; in
  return, two fewer broker primitives and the restore race fixed (§6.6). S0c does `text` only.
- **`getAXState()` returning string costs a round trip for element discovery.** `app.elements()` is the
  fallback; S4 promoted it to a documented member (§4.2).
- **`possibly_sent` becoming a throw** may throw frequently on Electron/Chromium. S1 first only counts
  (resolves as before + records frequency) and flips after the baseline is confirmed; keep
  `ZCODE_CUA_POSSIBLY_SENT=throw|warn`.
- **Model reuses an old index after delta opens.** delta also issues a new `stateId`; indexes are resolved
  by the SDK with the current `stateId`; stale is always fail-closed.
- **Auto emit and the host structured sink double-write.** Keep the existing `hostProjectionResult` /
  `imageAuthorityResult` boundary; extend `format-model-facing-budget.test.ts` with a duplicate check.
- **"Bindings do not cross cells" misread as state loss.** Docs say: re-`getApp` in every cell; UI state
  and stateId are kept by the host; reattach prints one line.
- **Thawing the 30-tool contract weakens anti-drift.** The gate stays, only the baseline changes; thaw
  reason and deletion list go into the normative doc and commit message.
- **`getApp` semantics differ on Windows / Linux.** ZCode does not throw on non-macOS; missing capabilities
  use typed errors: Linux without AX elements -> `ELEMENT_UNAVAILABLE`; Linux/Windows keyboard without
  pid targeting -> `FOREGROUND_REQUIRED`. `cua.computer.target` exposes the platform for model branching.

---

## Appendix A: v3.1 examples

```js
// ── Recipe 1: bind → act → observe
const app = await cua.getApp("Notes");       // shows initial full tree
await app.click(42);
await app.typeText("hello");
await app.pressKey("Return");
await app.getAXState();                       // automatically shows the diff

// ── Recipe 3: ZCode additions (option bags only)
await app.click(42, { mouseButton: "right", modifiers: "cmd", strategy: "a11y" });
await app.pressKey("Return", { holdSeconds: 0.5 });
for (let i = 0; i < 3; i++) await app.pressKey("Down");   // replaces the removed repeat
await app.paste("多行\n内容");

// ── Recipe 5: error handling
try {
  await app.performSecondaryAction(7, "Show Menu");
} catch (e) {
  if (e.code === "ACTION_UNAVAILABLE") {
    await app.getAXState({ disableDiffing: true });   // compact already carries actions; see the legal values
  } else if (e.code === "CONTROLLER_BUSY") {
    nodeRepl.write(`another ZCode Computer Use session owns control: ${e.details.owner}`);
  } else if (e.actionSent) {
    await app.getAXState();                            // may have landed; look at state first
  } else throw e;
}
```

---

## Appendix B: Disposition of the 30 tools

- **Keep (14), `cua.computer`:** `list_apps` (`cua.listApps()`), `open_application` (`getApp` launches
  transparently; `activate` via the escape hatch), `list_windows` (escape hatch; `cua.getWindow()`
  undocumented), `get_app_state` (`app.getAXState()` / `getAXStateAndScreenshot()` / `getScreenshot()`),
  `left_click` (`app.click`), `scroll`, `left_click_drag` (`app.drag`), `type` (`app.typeText`),
  `set_value`, `select_text` (escape hatch = range form; `app.selectText`), `key` (without `repeat`;
  `app.pressKey`), `perform_action` (`app.performSecondaryAction`), `request_access`
  (`cua.requestAccess()`), `stop_computer_control` (`cua.stop()`).
- **Delete, per-app path covers (5):** `screenshot` (full screen) -> `app.getScreenshot()`; `zoom` (tune the
  per-app screenshot budget); `list_displays`, `switch_display`, `cursor_position` (none; per-app capture
  works per the window's screen, cursor position was pure diagnostics).
- **Delete, equivalent replacement (9):** `wait` (SDK settler); `double_click` / `triple_click` /
  `right_click` / `middle_click` (`click` options); `hold_key` (`pressKey(key, {holdSeconds})`);
  `write_clipboard` (`app.paste(text)`, native broker `paste`); `left_mouse_down` / `left_mouse_up`
  (`drag(from, to)`).
- **Delete, review-accepted contraction (2):** `read_clipboard`, `mouse_move` (hold-style primitives).

Broker methods deleted with their tools: `move_to`, `mouse_down`, `mouse_up`, `read_clipboard`,
`write_clipboard`. Broker protocol 63 -> 49 in step (15 deleted + native `paste` added), with 6 more test
probes optionally removable to reach 43 (§3.6).
