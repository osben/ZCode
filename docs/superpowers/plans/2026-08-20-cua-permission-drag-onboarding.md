# CUA Permission Drag Onboarding — Current Contract and Design Rationale

Status (2026-08-20): the drag path shipped —
`PrepareCuaHelperPermissionDrag`/`StartCuaHelperPermissionDrag` IPC
(`packages/shared/src/channels.ts`, `packages/desktop/src/main/desktopCuaPermissionIpc.ts`),
`prepareCuaHelperPermissionDrag` (`packages/desktop/src/main/cuaAccessibilitySettings.ts`),
the drag panel (`packages/desktop/src/main/cuaPermissionDragPanel.ts`,
`cuaPermissionPanelPositioner.ts`, `packages/desktop/src/renderer/cuaPermissionPanel.ts`), the
bounds watcher (`cuaSystemSettingsWindowWatcher.ts`, `packages/desktop/native/macos-window-bounds/`,
`scripts/build-macos-window-bounds.mjs`). The panel is shown per stage by the onboarding session
(`dragPanel.show(stage.permission)` / `hide` / `destroy`).

Open follow-up: the in-app permission checklist modal (`CuaPermissionChecklistModal`, Task 7 of the
original plan) is not implemented; onboarding is still entered from `ComputerUseSection`.

This document is the only spec for this design (no separate design file exists).

## Why drag instead of the system prompt

- The system prompt's only real effect is making the app appear in the TCC permission list. A
  brand-new user has no entry to check, so without the prompt the drag of Helper.app into the list
  is the only alternative path.
- Verified on macOS (Darwin 25.5.0, 2026-08-20): dragging `Calculator.app` (zero prior TCC entries)
  into the Accessibility list via Electron `webContents.startDrag({file, icon})` creates the entry
  directly as `auth_value=2` (granted) — one step fewer than the prompt.

## Hard invariants

- Onboarding never calls `requestHelperAccessibilityPermissionViaLaunchServices` /
  `requestHelperScreenRecordingPermissionViaLaunchServices` or the upstream `promptTrust`
  (`AXIsProcessTrustedWithOptions({prompt: true})`, `CGRequestScreenCaptureAccess()`). Locked by
  tests. Non-prompting APIs (`AXIsProcessTrusted()`, `{prompt: false}`,
  `CGPreflightScreenCaptureAccess()`) are allowed.
- Drag-start synchronization: `event.sender.startDrag()` must be called synchronously inside the
  dragstart chain with no `await` of any I/O — otherwise the OS drag gesture window is missed and
  nothing can be dragged. Install/verify runs in `prepareCuaHelperPermissionDrag` ahead of time and
  is cached.
- TOCTOU gate: before dragging, compare the cached `cuaHelperBundleFingerprint` (`ino:ctimeNs:size`;
  ctime cannot be rolled back from user space) synchronously. On mismatch, refuse the drag, clear
  the cache and re-prepare. Never drag a possibly replaced bundle into the permission list — TCC
  binds to the dragged bundle identity, so a swapped bundle would bypass the Team-pin design.
  Ordering inside prepare matters: snapshot the fingerprint BEFORE verify, and re-check after
  verify and after identity resolution.
- The fingerprint never crosses IPC: `PrepareCuaHelperPermissionDragResult` (shared) has no
  `helperBundleFingerprint` field; only the main-process result type carries it, and the IPC
  handler strips it before replying to the renderer.
- fail-closed vs fail-open: signature/fingerprint checks fail closed (refuse the operation); window
  bounds acquisition fails open (fall back to bottom-center of the screen — snapping is an
  enhancement, not a precondition).
- Permissions take effect only after Helper restart (screen recording does not apply to running
  processes; accessibility has a process-level `AXIsProcessTrusted` cache). Keep
  `restartHelperAfterReturn`.
- Permission display state: persistent UI must use `isCuaPermissionTccGranted`
  (`packages/ui/src/lib/cuaPermissionStatusStore.ts`), never the `includeFunctionalProbes`
  judgment — the read-only refresh's `screenCaptureProbeOk` is always `false`, so the probe-based
  judgment would show granted users as pending.
- darwin-only: all new capabilities are `darwin`; other platforms fail safe (return, not throw).
- Upstream `@zcode/zcode-cua` is not modified; all changes live in this repository. No
  `--no-verify`.
- Any new system API must have its minimum macOS version checked (`CGWindowListCopyWindowInfo` is
  available since 10.5; `/usr/bin/lockf` was 15+ and broke macOS ≤14).

## Why the panel cannot live in Helper

Helper is a Node SEA with `LSUIElement=true`; its "native" part is only the `ax_native.node`
extension, not an AppKit app — no NSApplication event loop, which NSPanel display and
`beginDraggingSession` require. There is also a circular dependency: if Helper hosted the
authorization UI, the guide would be crippled exactly when Helper cannot start (the shape of the
macOS ≤14 `lockf` incident). The Electron panel is a separate always-on-top window.

## Bounds watcher

- `CGWindowListCopyWindowInfo` returns window bounds without any permission (only window images
  need Screen Recording) — this is the premise of the whole approach, since onboarding runs while
  precisely those permissions are missing. Electron has no binding; `osascript` needs the missing
  accessibility permission and `desktopCapturer` gives no bounds, so a small resident Swift CLI
  (`macos-window-bounds`) streams on-screen System Settings window rectangles as JSON lines.
- Watcher spawns the CLI once, parses line-by-line, keeps the first `layer === 0` window, returns
  `null` on exit/error/bad output without throwing, and `stop()` kills the child. Timers are
  `unref()`-ed.

## Panel behavior

- Window: `frame: false`, `transparent: true`, `focusable: false` (focusing would push System
  Settings to the background and break the flow), `skipTaskbar: true`, shown with `showInactive()`,
  `setAlwaysOnTop(true, "screen-saver")`, visible on all workspaces. Every terminal state
  (success, canceled, timeout, origin destroyed) destroys the panel and stops the watcher.
- Position (`cuaPermissionPanelPositioner`, pure function, integer output): with settings bounds,
  x = `settings.x + (settings.width - panel.width)/2`, y = `settings.y + settings.height - 6`
  (slight overlap, visually snapped); otherwise x centered on the display, y =
  `display.y + display.height - panel.height - 28`; finally clamped into the display. Driven by
  the watcher at ~150 ms, `setBounds` only when the target rectangle changes.
- Language follows ZCode: each `show(permission)` reads the main-process `currentApplicationLocale`
  and sends it via panel state IPC before `showInactive()` (avoid flashing the fallback locale);
  the renderer supports only the shared `Locale` values `zh-CN`/`en-US` and updates copy, tooltip,
  `document.title` and `<html lang>`. It never reads browser `localStorage` or the OS language.
- Renderer: one draggable tile; on mount call `prepareCuaHelperPermissionDrag()`, on dragstart
  `event.preventDefault()` then `startCuaHelperPermissionDrag()`.

## IPC handler details

- `prepare` handler caches the verified path + fingerprint on success and clears it on failure;
  the reply never contains the fingerprint.
- `start` without a cached helper never does async install/verify inline (it would miss the
  gesture): warn and refresh in the background for the next drag.
- After a successful `OpenCuaPermissionOnboarding`, re-prepare once — the onboarding includes long
  user waits in System Settings, and the stage-start fingerprint must not be treated as still
  verified.
- Every onboarding stage re-runs `verifyHelperPermissionIdentityUnchanged` (a same-UID process can
  replace the install directory while the user sits in Settings) and stores the result on the
  session for the drag cache.

## Known risk

With no system prompt, a brand-new user has only the drag path. If the panel is missed or dragging
fails, they are stuck. Mitigations: snapping (panel next to the user's focus) and the checklist
modal explaining the two permissions. If drag success proves too low, add static guidance to the
panel — do not revert to system prompts, which this change exists to eliminate.
