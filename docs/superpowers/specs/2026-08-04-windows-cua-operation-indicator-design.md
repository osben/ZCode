# Windows CUA Top Operation Indicator Design

> **Partly superseded (2026-09-14):** the **trigger decision** and the **10-second safety timer** of this
> document have changed. The trigger is no longer "every `tool-started` of an official CUA tool": after the
> node_repl + SDK refactor, action-level tool calls no longer exist and the decision is per cell (sideband
> boolean fact `computerUse`, anchored on the bootstrap statement `setupComputerUseRuntime`). The safety timer
> was relaxed from 10s to 30s and explicitly demoted to a fallback; hiding is led by explicit clearing paths
> such as the turn terminal state. Window shape, copy, position, click-through, `host source + cuaTurnKey`
> aggregation and multi-window semantics are unchanged. See
> `docs/cua/2026-09-14-windows-cua-indicator-repair-spec.md`.

## Background and goals

While ZCode observes or operates the desktop through Computer Use on Windows, users can only tell whether it is
still running from the session tool cards and results. Once the ZCode window is covered by another app this
information is invisible, and the user cannot keep confirming that the machine is still being operated by the
Agent.

This feature shows a lightweight, non-focus-stealing, click-through indicator at the top of the Windows
desktop:

> ZCode is operating the computer (中文: `ZCode 正在操作电脑`)

It appears when a turn first really starts executing an official Computer Use tool and disappears when that
turn ends or the control chain terminates abnormally. It offers no pause, stop or takeover button; those
controls are out of scope.

## Trade-offs

Active state is kept per `session_id + turn_id`: the first Computer Use tool call of a new turn triggers the
indicator, a new turn replaces the old one (ending it first), and `end_turn`, pipe/socket close and dispose end
the active turn. The indicator is a separate desktop overlay window independent of the main window's React
tree. Picture-in-Picture is macOS-only and not the basis of the Windows implementation.

## Scope

Included: Windows desktop-local Computer Use started from a desktop window or by mobile `/remote` reusing the
same desktop-local Host; a non-interactive top indicator on the current display; zh/en copy, light/dark theme,
DPI, multi-monitor and reduced-motion; terminal-state closure on turn success, failure, stop, session close,
runtime restart, Host exit and app quit.

Excluded: macOS PiP or background mode; a Linux indicator; Web/mobile rendering the indicator; pause, stop or
takeover buttons; live picture, step list, target window title or per-action copy; changes to the `zcode-cua`
broker/native wire protocol.

## Design principles

1. **The CLI provides the authoritative lifecycle, the Host owns the desktop projection state.** The CLI sends
   slim transient sideband notifications from raw runtime events; the Host maintains active turns; Main only
   consumes the Host's projected state and manages the native window, never guessing from tool cards or the
   Renderer DOM.
2. **Tool-level trigger + bounded display** (see "End rules"): only real CUA tools trigger it; ordinary Agent
   turns and ordinary MCP tools never show it.
3. **Fail closed to hidden.** When the Host/runtime lifecycle breaks, the matching active record is removed; a
   permanent overlay must never remain.
4. **Not in screenshots.** The overlay enables Windows capture exclusion so a CUA screenshot does not feed it
   back to the model.
5. **Hyphens throughout.** New code generates and checks only the official `computer-use` canonical identity.
6. **Independent of conversation projection subscriptions.** The notification must not depend on the legacy
   `session/event` `deliveryKind` or on a v4 conversation subscription, and must not enter snapshot, replay,
   conversation frames or the persisted event stream.

## State and sequence

### Authority keys

The Host isolates one active CUA turn with:

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
cuaTurnKey   = workspaceKey + NUL + sessionId + NUL + turnId
```

Except for `session-closed`, lifecycle notifications carry the runtime's raw `turnId`; `tool-started` may lack
`turnId` for compatibility with runtime events. In that case the tracker uses the `turn-started` turnId most
recently received for that session; with both missing the indicator is not activated, so unknown-origin state
does not spread to other sessions.

The tracker also keeps a monotonic `sequenceNumber` watermark per session, processed `eventId`s and a bounded
retired-turn set. Late events below the processed watermark, duplicate events and later events of a turn
already replaced by a new turn or already terminal are all ignored, so an old turn never rolls back or
reactivates the indicator after its terminal state. Runtime/workspace cleanup also clears these transient
indexes. The sideband notification is the tracker's only protocol event source and is not mixed with the
independent sequence domain of the legacy `session/event`.

### Event flow

```text
CLI runtime              CLI protocol sideband       Host tracker           Desktop Main       Overlay
    | turn_started              |                         |                       |                 |
    |-------------------------->| computer-use/           |                       |                 |
    |                           | operation-event         |                       |                 |
    |                           |------------------------>| remember turn         |                 |
    |                           |                         |                       |                 |
    | tool_call_scheduled       |                         |                       |                 |
    |-------------------------->|------------------------>| remember id/name      |                 |
    | tool_call_started         |                         |                       |                 |
    |-------------------------->|------------------------>| each CUA tool        |                 |
    |                           |                         |-- active(turnKey) --->| add key         |
    |                           |                         |                       |-- show -------->|
    | ... more CUA tools ...    |------------------------>| refresh deadline      | extend 10s      |
    | turn_complete/error       |                         |                       |                 |
    |-------------------------->|------------------------>|-- inactive(turnKey) ->| remove key      |
    |                           |                         |                       |-- hide -------->|

v4 conversation frame -----------------------------------------------> Renderer (existing chain, not part of indicator state)
legacy session/event (absent without deliveryKind) -------------------X Host tracker
```

### Trigger rules

`tool-scheduled` builds the `toolCallId -> toolName` mapping; only `tool-started` activates or refreshes the
indicator. Since `toolName` in the runtime started payload is optional, the tracker reads the name carried by
started first, then falls back to the scheduled mapping. The CLI sends only the tool name and call identifier,
never tool input, tool result, model text or screenshot content.

Recognition scope:

- accept the official canonical `mcp__computer-use__*` and `computer-use` tool names with the official plugin
  namespace;
- screenshot, reading app state, click, scroll, drag, keyboard, typing, opening an app and similar all
  activate;
- `wait` and `request_access` do not activate, since they do not mean the desktop is being observed or
  operated;
- `stop_computer_control` does not activate and, when its `tool-started` arrives, immediately clears the
  session's currently active CUA turn.

### End rules

These events remove the matching active key:

- `turn-completed`
- `turn-failed`
- `session-closed`
- `stop_computer_control` started
- 10 seconds without a new CUA tool trigger after the latest CUA `tool-started`
- workspace runtime restart/dispose
- Host process exit
- ZCode app quit

The CLI sends no sideband notification for individual `tool_call_result|tool_call_error`. A tool result does
not hide the indicator by itself; the 10-second safety timer after the latest CUA `tool-started` closes it,
and a later CUA tool restarts the timer. This avoids flicker between consecutive tools and also avoids a
permanent leftover when a tool fails or a terminal notification is lost.

Main keeps a set by `host source + cuaTurnKey` and a 10-second deadline per active key from the latest CUA tool
trigger. The indicator shows while the set is non-empty and hides only after terminal state or the timer
clears the last key, covering multiple windows and parallel sessions.

The CLI sideband notification and the Reporter are best-effort desktop projection sidebands. Notification
construction, a Host MessagePort close race or a reporting exception may only log `warn` and must not truncate
v4 conversation frames, ordinary protocol notifications or CUA tool execution.

## Component boundaries

### App <-> Agent: `computer-use/operation-event`

`packages/shared/src/zcode-protocol/index.ts` gains a strictly validated one-way notification with method
`computer-use/operation-event`. `computer-use` and `operation-event` use hyphens throughout. The payload is
this discriminated union:

```ts
type ZCodeComputerUseOperationEvent =
  | {
      kind: "turn-started" | "turn-completed" | "turn-failed";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId: string;
      timestamp: number;
    }
  | {
      kind: "tool-scheduled";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId: string;
      timestamp: number;
      toolCallId: string;
      toolName: string;
    }
  | {
      kind: "tool-started";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId?: string;
      timestamp: number;
      toolCallId: string;
      toolName?: string;
    }
  | {
      kind: "session-closed";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      timestamp: number;
    };
```

At the runtime `onSessionEvent` entry, before any `record.deliveryKind` check, the CLI maps `TurnStarted`,
`ToolCallScheduled`, `ToolCallStarted`, `TurnComplete`, `TurnError` and `SessionEnded` to these notifications.
They keep the runtime's raw `eventId` and `sequenceNumber`, allow gaps but require monotonic order, and no
notification is sent for ordinary streaming, tool progress/result or model content.

The notification travels only over the existing App <-> Agent stdio connection. It creates no new Agent
runtime, writes no event store, and does not enter v4 topics, snapshots, replayable recovery or remote relay
business state. When an old Agent does not support the notification the Windows indicator stays hidden and must
not fall back to Renderer/DOM guessing.

### Services: `CuaOperationTurnTracker`

Responsibilities:

- consume transient lifecycle notifications already validated by `zcodeComputerUseOperationEventSchema`;
- maintain the current turn, tool name and active CUA turn;
- call the reporter only on inactive -> active or active -> inactive;
- clear all related state when a workspace/runtime is disposed;
- log lifecycle notifications at `debug` only; state transitions may log at `info`.

It depends on no UI, Electron or concrete Helper implementation.

`ZCodeAgentService.wireClient` validates `computer-use/operation-event` and hands it straight to the tracker.
The existing `session/event` still serves legacy protocol consumers but is no longer a CUA tracker input,
avoiding the raw `sequenceNumber` and the protocol-projected `seq` sequence domains overwriting each other.

### Host -> Main message

A new strict-schema one-way message:

```ts
type HostCuaOperationStateResponse = {
  type: "cua-operation-state";
  active: boolean;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  workspaceIdentity?: string;
};
```

Only a Host with `serviceAuthorityMode="desktop-local"` wires the reporter. Remote workspace Hosts, the server
and plain Web do not send this message. When mobile `/remote` reuses the desktop-local Host the indicator on
the physical Windows screen is still triggered, but the mobile Renderer creates no second indicator.

### Desktop Main: `WindowsCuaOperationIndicator`

Responsibilities:

- aggregate active keys of different Hosts/windows;
- lazily create one lightweight `BrowserWindow`;
- update copy and colors by the current app locale/theme;
- when a new round goes from an empty to a non-empty set, position it centered at the top of the work area of
  the display currently under the mouse;
- destroy the window on app quit.

Main does not parse `tool.updated`, keeps no session business state and writes nothing back to the Host/Agent.

## Windows overlay visuals and window attributes

Default visuals:

- Copy: Chinese `ZCode 正在操作电脑`; English `ZCode is controlling your computer`.
- Top gap: the visible card's top edge sits `12px` below the work area top edge.
- Visible card height stays `38px`; Chinese/English widths stay `234px`/`308px`.
- The transparent window reserves a shadow safety area outside the card of `8px` left/right, `6px` top and
  `12px` bottom, so the Chinese/English windows are `250px × 56px`/`324px × 56px`; the window itself is offset
  up by `6px` so the visible card's position is unchanged after the larger canvas.
- Container: compact rounded corners, popover-semantic background and border; only a restrained two-layer
  CSS-drawn shadow, no native Windows window shadow.
- A low-contrast three-dot breathing animation on the left; no brand illustration.
- Enter: `opacity 0 -> 1`, `translateY(-6px) -> 0`, `140ms`.
- Exit: reverse animation, `120ms`.
- Under `prefers-reduced-motion: reduce`, displacement and looping animation are removed and only direct
  show/hide remains.

Window constraints:

```ts
{
  alwaysOnTop: true,
  focusable: false,
  frame: false,
  resizable: false,
  show: false,
  skipTaskbar: true,
  transparent: true,
  hasShadow: false,
}
```

### Topmost layer and reuse after hide

`alwaysOnTop: true` in the `BrowserWindow` constructor only guarantees a topmost request at first creation. On
Windows, a transparent window may lose the native `WS_EX_TOPMOST` after `hide()`; calling only
`showInactive()` later restores visibility but not Z-order, so a foreground ordinary window may cover the
indicator.

Every window show must run the same no-focus topmost chain, including the show after the first `loadURL`
completes and when a later turn reuses the hidden window:

```text
showInactive()
      |
      v
setAlwaysOnTop(true, "screen-saver")
      |
      v
moveTop()
```

- `showInactive()` keeps the target app's keyboard focus.
- The `screen-saver` level keeps the indicator above ordinary windows, the system taskbar and common
  full-screen windows.
- `moveTop()` moves it to the front of the current level without activating it.
- These calls do not change mouse pass-through, taskbar hiding or capture exclusion.
- Windows secure desktops (such as UAC), the lock screen and some exclusive full-screen programs are outside
  what an app window can cover; the indicator does not promise to show above those system surfaces.

### Shadow ownership and clipping boundary

The old implementation put a `234px × 38px` card in a `236px × 40px` transparent window with a
`0 4px 12px` CSS shadow, so the CSS shadow was clipped by the window boundary while the default
`BrowserWindow.hasShadow` made DWM draw a second rectangular shadow (a hard bottom edge plus a wide grey band).
There is now exactly one shadow owner:

- `BrowserWindow` sets `hasShadow: false` explicitly;
- `body` uses `padding: 6px 8px 12px` as the transparent safety area and `.indicator` fills the content box;
- light shadow `0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18)`; dark shadow
  `0 1px 2px rgba(0, 0, 0, 0.18), 0 6px 12px -6px rgba(0, 0, 0, 0.28)`;
- shadow, border and safety area live inside the capture-excluded BrowserWindow and do not change mouse
  pass-through, focus or screenshot exclusion.

After creation these must be called:

```ts
window.setIgnoreMouseEvents(true);
window.setContentProtection(true);
```

The overlay cannot become the key/focused window, does not block the mouse, does not appear in Alt+Tab or the
taskbar, and does not appear in Windows 10 2004+ system screenshots and WGC capture.

## Failure handling and invariants

- Repeated active/inactive from the Host must be idempotent.
- An unknown inactive key is ignored.
- When a Host exits, Main clears all of that Host's keys; it must not rely on the Host successfully sending
  inactive before exiting.
- BrowserWindow creation, security-attribute configuration or `loadURL` failure only logs warn and must not
  affect CUA tool execution; a synchronous creation/configuration failure fails hidden and auto-retries at most
  once within the current active epoch, with no retry loop.
- If the overlay window is unexpectedly closed by the system the active set is kept; Main schedules a
  reconcile immediately in the window `closed` callback and recreates it when the set is non-empty, without
  waiting for the next Host state.
- Every CUA tool trigger sets a 10-second safety deadline; later tool triggers extend that key's deadline. A
  legitimate long turn can keep running, but without new CUA tool triggers the indicator shows at most 10
  seconds.
- Desktop `continuous` and mobile `replayable` state do not enter this UI state machine; it consumes only
  transient lifecycle notifications received by the local Host, and does not persist, enter snapshots or
  broadcast to Web. When mobile `/remote` reuses the local Host through shared-host attachment it can trigger
  the same physical Windows indicator, but the relay and the mobile client do not own this state.
- `workspaceIdentity` is only for identity isolation and `workspacePath` for path semantics; do not mix them.

## Test strategy

- **Shared/CLI protocol:** the schema accepts the six legal lifecycle payloads and rejects empty ids, negative
  sequence numbers, missing turn/tool fields and unknown kinds; the CLI sends the sideband notification even
  when `record.deliveryKind` is unset and only a v4 subscription exists; only turn start/terminal and tool
  scheduled/started are projected (no input, result, model text or screenshot); a sideband notify throw only
  logs a warning.
- **Services:** ordinary turns/MCP tools never activate; `tool-scheduled` records the name and `tool-started`
  activates canonical `computer-use` (started-carried toolName needs no scheduled); every canonical CUA
  `tool-started` sends one active refresh (duplicate `eventId` deduped) without recreating the native window;
  tool result/error does not hide; turn completed/failed each report one inactive; session close, the stop tool
  and runtime/workspace clear clean up; no activation without a determinable turnId; multi-session,
  multi-workspace and `workspaceIdentity` fallback are isolated; a late lower-`sequenceNumber` `turn-started`
  never replaces the current turn and a late tool event of a terminal/retired turn never revives the
  indicator; a Reporter throw does not affect the state machine or v4 delivery; runtime `unavailable`
  (protocol closed, crash, request timeout) clears the workspace's active state even without a restart.
- **Shared/Host:** the `computer-use/operation-event` and `cua-operation-state` schemas accept complete legal
  payloads and reject missing sessionId/turnId, illegal active or empty workspacePath; only the local Host
  injects the reporter.
- **Desktop Main:** first active creates/shows the window; repeated active is idempotent; multi-Host/turn
  aggregation hides only on the last inactive; Host exit clears its keys; the window is always-on-top,
  non-focusable, taskbar-hidden, mouse-pass-through and content-protected; first show and reuse after hide both
  run `showInactive -> setAlwaysOnTop(true, "screen-saver") -> moveTop` without activating; native `hasShadow`
  is off and the canvas has the `6px 8px 12px` safety area so the card keeps its size and the top edge stays
  work area `+12px`; positioned at the top center of the work area of the display under the mouse (DPI-aware)
  on each empty-to-non-empty transition without jumping when a parallel source joins; every active refresh
  extends the key's timer to 10s and an expired key hides even without inactive; window creation or
  security-attribute errors fail hidden with a single bounded retry; locale/theme updates refresh content
  without stealing focus.
- **Windows runtime verification:** (1) start the dev ZCode with Notepad in the foreground; (2) run a CUA turn
  with screenshot, click and typing; (3) the indicator appears after the first CUA tool and does not flicker;
  (4) the target app keeps focus and the indicator is not clickable; (5) the CUA screenshot does not contain
  it; (6) hiding after success, tool failure, Stop, closing the task, restarting the Host and quitting the app;
  (7) on dual monitors a new turn from each monitor positions on the monitor under the mouse; (8) no
  rectangular DWM grey band, hard clipped edge or double shadow on light and dark backgrounds; (9) automatic
  hiding 10s after a single CUA tool trigger, and a later trigger within 10s restarts the timer; (10) with an
  Agent crash, protocol close or request timeout and no restart, it hides within 10s and the tracker leaves
  nothing behind.

## Documentation and capability graph updates

Update together with the implementation: `docs/product-capability-map-office-computer-use.md` (drop the old
unresolved Windows CUA description); the capability graph `surface.computer-use-task-experience` (add the
Windows desktop operation indicator producer/consumer and the chain `CLI runtime lifecycle ->
computer-use/operation-event -> desktop-local Host tracker -> cua-operation-state -> Desktop Main overlay`).
Dedicated live control/takeover stays planned; this change adds only a read-only status indicator.

## Acceptance

- After the first real Computer Use tool of a Windows CUA turn starts, the top indicator is visible.
- Every real CUA tool trigger shows or refreshes the indicator; consecutive tools do not flicker, it disappears
  10 seconds after the latest trigger, and a turn terminal state can close it earlier.
- Behavior is identical when only v4 conversation is used with no legacy `session/event` subscription.
- Ordinary Agent/MCP turns never show it.
- The indicator does not steal focus, does not block input and does not enter CUA screenshots.
- Top card size and position are unchanged; the shadow is drawn by CSS only, with no rectangular system shadow
  or steady-state clipping.
- Multiple windows and sessions neither hide early nor leave residue permanently.
- macOS, Linux, Web and mobile replayable semantics and existing Helper/PiP behavior are unchanged.
- Targeted tests, `pnpm typecheck` and `pnpm lint` all pass.
