# Windows CUA Full Pointer and Virtual Desktop Foundation Design

> Date: 2026-07-29
>
> Status: confirmed
>
> Scope: Windows local desktop continuous source-development chain
>
> Related repositories: `z-code`, `C:\Users\dev\zcode-cua`

## 1. Background

Windows CUA Phase 1 closed the source-development loop (on-demand Windows Helper started by the local Host with
a random named pipe and bearer token, credentials via the official plugin authority, UIA enumeration and
semantic actions, `open_application`, coordinate click and keyboard on Notepad, clean Helper stop/restart).

Remaining gaps: the Windows native addon does not export `moveTo`, `scrollAt`, `drag`, `mouseDown` and
`mouseUp`, so `mouse_move`, `scroll`, `left_click_drag`, `left_mouse_down` and `left_mouse_up` fail closed, and
the existing coordinate click computes `SendInput` absolute coordinates from the primary display only (no
virtual desktop, negative coordinates or secondary displays). The pointer tools require `app_ref` or
`state_image` scope in their descriptions, but when sending to the broker they dropped the resolved `app_ref`,
so Windows could only run a global `SendInput` that cannot prove the target window identity, contradicting the
"frontmost window, PID and observation state must match" design. The Windows system surface also represented
the unimplemented clipboard read as an empty string and write as a no-op success, and native
`screenCaptureStatus()` reported `granted` before any WGC implementation existed; the model could mistake "not
implemented" for "succeeded", so real capability semantics are restored first.

## 2. Goals of this phase

Complete the Windows pointer input foundation without changing the MCP tool count or names:

1. Make these five existing tools really work in the Windows source Helper: `mouse_move`, `scroll`,
   `left_click_drag`, `left_mouse_down`, `left_mouse_up`.
2. Make the existing coordinate click and the new pointer actions share Windows virtual desktop coordinates.
3. Before global `SendInput`, verify the target app is still the only frontmost app; fail closed when it
   cannot be proven.
4. Keep the `left_mouse_down` / `left_mouse_up` session holder constraint.
5. After any partial failure, Helper stop or parent-process loss, leave no mouse button pressed by CUA.
6. Unimplemented screenshot and clipboard capabilities explicitly report unavailable/unknown, never an empty
   value or a no-op success.
7. macOS and Linux keep their original implementations and native dispatch semantics.

## 3. Non-goals

Windows Graphics Capture, D3D11, screenshot revision or the `state_image` pixel loop; UIA MTA worker,
cancellation or hang isolation; a real native clipboard; installer, SEA, prebuilt addon, signing, SmartScreen,
auto-update; SSH, WSL, Docker, remote workspace, mobile `/remote` or the replayable chain; Windows-only MCP tool
names or an input channel bypassing the broker; changes to the macOS Helper, Linux AT-SPI or the 30-tool
manifest.

## 4. Design choice

- **A. Windows-only tools in the tool layer** (for example `windows_scroll`, `windows_drag`) - rejected. It
  reintroduces platform forks and tool semantics conflicts and bypasses the broker's delivery-state, session
  holder and lifecycle constraints.
- **B. Only add the five addon exports** - rejected. The tool layer does not pass the resolved `app_ref` to the
  broker; adding native exports alone turns requests that were explicitly unavailable into global input whose
  target identity cannot be verified.
- **C. Complete the existing platform-neutral seam end to end** - selected:
  - the tool layer keeps coordinates and the resolved `app_ref`;
  - the broker applies a strict frontmost-PID gate to Windows global pointer requests;
  - the Node adapter keeps exposing capability through the optional native ABI;
  - the Windows addon implements the five existing ABIs with virtual desktop coordinates;
  - Helper lifecycle releases CUA-held input state on termination;
  - unimplemented system capabilities explicitly fail closed.

  It does not change the MCP surface and does not require the Agent to know Windows specifics.

## 5. Runtime chain

```text
MCP pointer tool
  |
  | resolve target -> screen point + app_ref
  | reject missing/mismatched scope
  v
official zcode-cua plugin
  |
  | broker action RPC
  | { point/start/end, app_ref, session_key, ... }
  v
Windows Computer Use Helper broker
  |
  | resolve live app identity
  | verify exactly one frontmost app and expected pid
  | verify no-focus policy + holder state
  v
NodeAutomationAdapter
  |
  | existing optional native ABI
  v
ax_native.node
  |
  | virtual desktop mapping
  | SendInput move / wheel / drag / down / up
  | guaranteed release on partial failure or terminal shutdown
  v
interactive Windows desktop
```

Forbidden chains:

```text
tool -> Windows API
renderer -> native addon
remote Host -> local Windows Helper
missing app scope -> unchecked global SendInput
failed drag -> mouse button remains down
```

## 6. Tool-layer scope contract

### 6.1 Single-point operations

After resolving the target, `mouse_move`, `scroll` and `left_mouse_down` must obtain both:

```text
ResolvedPointerTarget {
  point
  appRef
}
```

An explicit top-level `app_ref` may override the target's own `app_ref`, but the override is still live-resolved
by the broker. A request must never send only `point`.

On Windows, if the accessibility source is available but no resolvable app scope is obtained, the request must
fail before any native input; it must not silently fall back to unconstrained global input because a pid-scoped
ABI does not exist.

### 6.2 Drag

`left_click_drag` resolves start and end separately:

```text
from_target -> { startPoint, startAppRef }
to          -> { endPoint, endAppRef }
```

- An explicit top-level `app_ref` constrains both ends.
- Otherwise both ends must resolve to the same app identity.
- Ends that clearly belong to different PIDs/identities are rejected before the broker call.
- If the same app cannot be proven, no drag is performed.
- The "current frontmost app" is never used to guess a missing end.

### 6.3 Cleanup

`left_mouse_up` still accepts no arbitrary target. It releases only the `left_mouse_down` that the same MCP
session sent successfully or possibly successfully. This is safe cleanup and does not re-resolve app identity;
even if the user switched windows between down and up, the button CUA pressed must be releasable.

## 7. Broker frontmost gate

Windows has no equivalent of macOS `CGEventPostToPid`; `SendInput` always acts on the current interactive
desktop. Therefore:

1. the broker resolves a unique live PID from `app_ref`;
2. right before native dispatch it re-enumerates live applications;
3. the action is allowed only when exactly one app is `active=true` and its PID equals the target PID;
4. zero or several active apps, an exited target, ambiguous identity or a different frontmost PID all fail
   closed;
5. the error asks to re-activate the target and re-observe; no auto-activation and no auto-replay;
6. `mouse_up` is the only pointer action without the frontmost gate, since it only releases a registered CUA
   holder.

The gate reuses the existing raw click frontmost verification and generalizes the error message from
click-specific to a general method. The macOS/Linux pid-scoped or existing global paths are unchanged.

```text
SCOPED
  |
  | resolve live identity
  v
FRONTMOST_CHECK
  | expected pid == unique active pid
  |------------------------------ no -> REFUSED (no input sent)
  v yes
NATIVE_DISPATCH
  |------------------------------ transport lost after send -> possibly_sent
  v
DONE
```

## 8. Windows native input contract

### 8.1 Virtual desktop coordinates

All absolute mouse input reads `SM_XVIRTUALSCREEN`, `SM_YVIRTUALSCREEN`, `SM_CXVIRTUALSCREEN` and
`SM_CYVIRTUALSCREEN`, and converts with the virtual desktop's top-left as origin:

```text
normalizedX = (x - virtualLeft) * 65535 / (virtualWidth  - 1)
normalizedY = (y - virtualTop)  * 65535 / (virtualHeight - 1)
```

- Reject non-finite coordinates and invalid virtual desktop sizes.
- An input point may be a negative screen coordinate.
- A point outside the virtual desktop fails closed, with no silent clamp.
- Absolute moves set both `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`.
- The existing `clickAtPoint` and the new move/drag share the same conversion function.
- No primary-screen fallback constant fakes success.

### 8.2 Pointer primitives

The Windows addon completes the existing optional ABI:

```text
moveTo(x, y)
scrollAt(x, y, amount, direction)
drag(fromX, fromY, toX, toY, button)
mouseDown(button)
mouseUp(button)
```

- `moveTo`: one absolute virtual-desktop move.
- `scrollAt`: move to the target point, then send a vertical or horizontal wheel.
- `amount=0`: legal no-op, no wheel event.
- `drag`: move to start, press, interpolate a finite number of moves to the end, release.
- `mouseDown` / `mouseUp`: only declared buttons; the current tool surface exposes left only.
- Any partial `SendInput` write counts as failure.
- Any failure in drag after down must best-effort send up.
- Modifier down/up stays managed by the broker's `withSyntheticModifiers`.

### 8.3 Input state and stop

The Windows addon keeps synthetic input state held by this Helper process. At minimum it tracks mouse buttons;
key state produced by the existing `keyDownGlobal` / `keyUpGlobal` joins the same terminal cleanup entry.

```text
IDLE
  |
  | mouseDown succeeds
  v
HELD
  | mouseUp succeeds ----------------------> IDLE
  |
  | drag/input failure/helper stop/parent gone
  v
RELEASING
  | best-effort synthetic up for owned inputs
  v
TERMINAL
```

- Terminal shutdown first closes new broker admission, then calls native input cleanup.
- Cleanup releases only inputs the Helper registered; arbitrary physical user keys are not treated as CUA
  state.
- After the terminal latch, new hold/down are rejected.
- A cleanup failure logs a redacted diagnostic and the Helper must not report a clean shutdown.
- This phase does not move UIA calls to a worker, to avoid mixing two independent milestones.

## 9. Screenshot and clipboard capability truthfulness

Until WGC and the native clipboard exist:

- Windows `screenCaptureStatus()` returns `unknown`, never `granted`.
- `captureScreenPng` / `captureWindowPng` keep returning no image, and the final tool call explicitly fails.
- `get_app_state(include_screenshot=true)` may return UIA-only state but must mark that there is no image.
- `read_clipboard` explicitly returns an unavailable error; an empty string never stands for a truly empty
  clipboard.
- `write_clipboard` explicitly returns an unavailable error; no no-op success.
- No PowerShell, `System.Drawing`, BitBlt or external command fallback.

This phase fixes only capability declarations; it does not implement the Windows clipboard or WGC.

## 10. Error and retry semantics

| Scenario                               | Result                                                   |
| -------------------------------------- | -------------------------------------------------------- |
| Missing native pointer ABI             | `not_authorized`                                         |
| Target lacks app scope                 | fail closed before the action                            |
| Drag ends differ in / lack identity    | fail closed before the action                            |
| Target is not the unique frontmost PID | `element_unavailable`, asks to re-activate and observe   |
| Coordinate outside virtual desktop     | `invalid_request` or a stable permission error; no input |
| `SendInput` returns 0 / partial write  | `permission_denied`                                      |
| Drag fails after down                  | send up, then return failure                             |
| Broker disconnects after action write  | keep `possibly_sent`, no auto-replay                     |
| Helper terminal stop                   | freeze admission, release registered inputs, close pipe  |
| WGC/clipboard not implemented          | explicit unavailable, no fake success                    |

## 11. Test strategy

TDD, failing tests first.

### 11.1 TypeScript unit tests

Every pointer tool passes the resolved `app_ref` to the broker; an explicit top-level `app_ref` overrides the
target scope; drag passes for the same app and is rejected for cross-app or missing identity; the Windows
broker applies the unique frontmost-PID gate to move/scroll/drag/down; Windows `mouse_up` cleans up by session
holder only; a missing native ABI stays `not_authorized`; clipboard read/write and screen capture status no
longer succeed/report granted falsely; macOS/Linux handler behavior is unchanged.

### 11.2 Native source/binding tests

The addon exports the five pointer ABIs; the virtual desktop formula uses `SM_*VIRTUALSCREEN` and
`MOUSEEVENTF_VIRTUALDESK`; negative, boundary, out-of-range and zero-size coordinates are pure-function tested;
scroll in four directions and amount=0; drag normal and partial-failure release; terminal cleanup releases only
tracked inputs; non-interactive session and terminal latch keep failing closed.

### 11.3 Windows real-hardware tests

Use the local interactive desktop; do not start or attach SSH/WSL/Docker/remote:

1. Build `ax_native.node` and `dist/windows-helper.js` from source.
2. Start source desktop and the official CUA plugin.
3. In an explicitly frontmost test window verify move, vertical and horizontal scroll, drag, down/up.
4. After switching to another frontmost app, replay the old scoped request; it must be rejected with no
   move/scroll/press.
5. Stop the Helper after down and confirm the mouse button is not held.
6. Verify absolute position on a secondary display with negative coordinates; if the machine lacks that
   topology, keep the automated formula tests and state the hardware item as pending.
7. Confirm no Helper/plugin-host/pipe orphans.

The milestone does not depend on a provider/model; model-driven acceptance is extra evidence once a provider
is available and does not replace direct official-plugin hardware verification.

## 12. Required verification

`zcode-cua`: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm rebuild:native`, `pnpm build`. `z-code`:
`pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run packages/services/test/cua`, `pnpm test:unit:affected`.
If `pnpm test:unit:affected` has known Windows baseline failures unrelated to CUA, keep the full exit code, the
failing set and a clean-baseline comparison; never present focused green as a full pass.

## 13. Follow-up milestones

In order, within the same Helper/broker architecture: UIA MTA worker/deadline/cancel/hang isolation; WGC,
window/screenshot revision and `state_image` coordinates; native clipboard; Chinese, emoji, key combination,
mixed DPI and multi-monitor hardware matrix; product loop (SEA/prebuilt addon/signing/install/update). Until
these are verified, do not claim Windows CUA has reached a complete product release state.
