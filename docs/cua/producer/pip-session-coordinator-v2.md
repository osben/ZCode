# PiP Session Coordinator v2: composite capture of related windows

## Goal

v2 continues v1's session/turn authority and only fixes the mixing of macOS native window identity and PiP
presentation identity. One keyboard or element action can open an attached sheet/dialog; it has its own
CGWindowID but still belongs to the same PiP presentation as the original top-level window.

```text
actual window 2310 (root) ───────────────┐
                                          ├─ presentationWindowId=2310 ── one PiP
actual window 2324 (attached sheet) ─────┘                            composite

actual window 2400 (independent root) ───── presentationWindowId=2400 ── second PiP
```

CUA tool state/frame stay bound to the actual window; only PiP presentation uses the logical root window.
Association must not be inferred from shortcut name, tool name or `include_screenshot`.

## Capture binding

`PipCaptureTarget` gains an optional `presentationWindowId`:

```ts
type PipCaptureTarget = {
  windowId: number; // the surface actually focused/operated this time
  presentationWindowId?: number; // provable same-process logical root; equals windowId when absent
  pid: number;
  bundleId: string;
};
```

macOS capture walks `AXParent` up to 8 levels from the selected AX window. Only same-PID ancestors with a
non-zero CGWindowID are accepted; the outermost valid ancestor is the presentation root. A cycle, timeout,
cross-process ancestor, missing ID or read failure falls back to the actual window ID. Linux/Windows keep
`presentationWindowId === windowId`.

macOS 14.0/14.1 lack ScreenCaptureKit `includeChildWindows`, so they also keep
`presentationWindowId === windowId` (v1 independent-surface display); identity and pixels merge only on
macOS 14.2+.

`window.window_id`, screenshot frame provenance, input target and post-action state keep reporting the actual
window; `presentationWindowId` does not enter the model-visible window DTO.

## Strict native ABI

The public protocol is version `2`, runtime id `zcode-cua-pip-session-v2`. The Helper handshake is ready only
if native provides `pipStartVerifiedCompositeAsync`; without that ABI Auto-PiP is disabled and falling back
to v1 `pipStartVerifiedAsync` is forbidden.

Composite start parameters are fixed:

```text
(presentationWindowId, windowId, pid, bundleId, width, height, group)
```

The native panel registry, dismissal and capacity are keyed by `(group, pid, presentationWindowId)`; the
controller separately stores the latest actual window ID for double-click activation and diagnostics.

## Native presentation state

- New presentation: resolve the presentation root's `SCWindow` and create a ScreenCaptureKit filter with
  `includeChildWindows=YES`.
- Same presentation, same actual window: refresh the filter and promote; do not create a panel.
- Same presentation, actual window changed: advance capture generation, refresh the root filter and actual
  activation target; keep the old last frame until the new first frame.
- Different presentation root: create a new panel under the existing multi-panel rules.
- After a sheet closes, the next root capture still hits the same presentation and refreshes to a root-only
  picture.

When root differs from actual and the composite filter cannot be built, an existing panel keeps its last
frame; with no panel, Auto-PiP is abandoned. The actual child must never start as a second panel. A PiP
failure does not change the CUA tool result.

## Presentation admission ordering

PiP session mode owns one producer-side presentation scheduler. The coordinator still synchronously validates
focus revision, turn sequence and capture binding, but native presentation start must be serialized through
the scheduler; different presentations arriving in parallel within one turn cannot race for native's
single-worker admission.

```text
new turn ── synchronous cancellation barrier (pipBeginTurn)
                         │
                         ├── invalidate the previous native start generation
                         ├── remove queued captures/terminal for the previous turn
                         └── release the mailbox wait for the superseded capture
                                              │
                                              ▼
coordinator ── capture(root) ── capture(sheet/root) ── terminal
                         │                  │
                         └── same key coalesce latest actual window
                                          │
                                          ▼
                             one native start at a time
```

- The capture key is `(sessionId, turnId, pid, presentationWindowId)`; queued entries with the same key keep
  only the latest actual window.
- A completed terminal is ordered after previously accepted captures; failed and closed run their native
  terminal effect after the in-flight start settles, so a late panel cannot revive.
- A new turn is the exceptional same-session cancellation barrier: `pipBeginTurn` must run synchronously
  before the lifecycle ACK, invalidating the old start through the native generation and cancelling the old
  turn's queued capture/terminal. Begin-turn must not be queued behind a capture Promise that may never
  settle; otherwise the protocol returns `applied=true` while the native window stays on the previous turn's
  green check.
- If `pipBeginTurn` throws, the barrier is not established: the old active capture must be aborted, the new
  turn's coordinator state must not be committed, and `applied=true` must not be returned. After
  `native-reset-failed`, the same lifecycle event may retry; during the failure, new-turn capture bindings are
  rejected against the old turn's state so the ACK and native lifecycle cannot diverge.
- native busy/false allows only bounded retry; never call global `pipStop` and never advance another
  in-flight worker's generation.
- Focus group switching stays immediate and is not blocked by the presentation admission queue.
- The scheduler keeps at most 64 unique captures; over the limit it drops the oldest background capture
  first, and lifecycle control is never dropped. This degradation affects only Auto-PiP, not the CUA tool
  result.

Native start admission must take the single worker slot before advancing the request generation; the worker
releases the slot before its Promise settles. Only explicit lifecycle cancellation (`pipStop`,
`pipBeginTurn`, global disable) may invalidate an admitted worker's generation.

## Explicit attached-surface resolution

An explicit `window_id` must not be searched only in `kAXWindows`. macOS checks, in order, top-level windows,
the focused/main window, and a bounded surface-container graph (same PID, 8 levels, 64 nodes) for the
requested CGWindowID; after a hit it computes the presentation root via `AXParent`. NSOpenPanel, sheet, dialog
and popover must attach to the parent presentation when the AX relation proves it, even if not listed in
`kAXWindows`. Unrelated CG-only/custom windows keep displaying independently under their actual ID; parent
and child must never be guessed from geometry, title or bundle.

## Pointer promotion ordering

An accepted pointer-down first updates, inside the event-tap thread, only the lead order protected by
`g_pip_stack_mutex`, then asynchronously runs `orderFrontRegardless` on the AppKit main thread. The async
commit is re-checked against membership, running, group visibility and visibility epoch, not the interaction
generation that advances on drag/up. The internal arbitration order and the WindowServer visual order must
end up consistent.

## Acceptance

- The `2310 -> 2324` trace of `Cmd+Shift+G` yields exactly one presentation.
- An attached sheet and its parent appear together in the composite PiP; after the sheet closes the same
  panel returns to the parent window.
- Two independent top-level windows of the same PID still produce two panels.
- Double-click activates the latest actual window; close writes a presentation-root dismissal.
- Repeated post-action settle, out-of-order late frames and fast sheet open/close add no panel and do not
  flash back to an old picture.
- Two independent presentations captured in parallel within one turn end with exactly two panels; busy
  admission does not drop the whole group.
- When the old turn's native start does not settle, the completed badge is cleared before the new turn's ACK,
  the new capture is not blocked by the old Promise, and the old terminal cannot late-arrive and re-add the
  green check.
- When native reset throws, the new turn returns `native-reset-failed` and the old capture mailbox is
  released; the coordinator does not consume that event's sequence/eventId, and retrying the same event can
  commit after reset succeeds.
- Capturing explicitly a root, an attached panel not listed in `kAXWindows`, and an independent top-level
  window yields 2 presentations.
- After clicking any visible panel, it becomes both the native lead and the WindowServer front panel.
