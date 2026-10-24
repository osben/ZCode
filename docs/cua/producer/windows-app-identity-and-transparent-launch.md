# Windows app identity and transparent launch

## Status

Current-facts document + implementation spec. Replaces `docs/open-application-activation-contract.md`
(activation is no longer a standalone model-facing capability; its semantics move into `get_app_state`).

Goal: **delete the `open_application` tool** so that `get_app_state(app_ref={name})` is self-sufficient on
Windows: it finds an already-running app by name; launches it first if not found; and, when pixels are needed
but the window is not visible, makes it visible. Net tool surface minus one; no new tool or parameter.

Scope: this doc does not cover Linux (cua does not currently need to support Linux). On macOS
`open_application` was removed from the tool surface on 2026-09-11; this pushes the same contraction to
Windows and adds the launch capability Windows lacked.

---

## 1. Current state (2026-09-14 real-machine measurements, Windows 11 26200)

All conclusions are measured on a real machine, not inferred from static reading.

### 1.1 Windows takes a separate code path

`selectPlatformAxSource` (`src/broker/server/platformAxSource.ts:109`) uses `createAxWinReadOnlySource`
(`src/native/win.ts`, 413 lines) in the win32 branch and **does not go through `nativeAxSource.ts`**, so the
macOS transparent-launch control flow (`nativeAxSource.ts:1676-1751`) never runs on Windows.

| Capability | macOS | Windows |
| --- | --- | --- |
| `captureApp` implementation | `nativeAxSource.ts` | `src/native/win.ts` |
| Transparent background launch | yes (`openApplicationInBackgroundAsync`, `ax_macos.mm:8883`) | **no export** |
| Name -> canonical identity | `resolveApplicationBundleId` (LaunchServices, `macosApplicationResolver.ts:106`) | only a hard-coded 5-entry table (1.2) |
| Wait for AX tree to settle after launch | `settleFreshlyLaunchedTree` | **none** |
| `window_id` takes part in capture | yes | yes (`win.ts:313`, and the returned window_id is verified) |

### 1.2 "Launch by name" is only a Calculator alias table

`windowsSystemSurface.ts:34`:

```ts
const WINDOWS_PACKAGED_APP_ALIASES = new Map<string, string>([
  ["calculator", CALC], ["windows calculator", CALC],
  ["calc", CALC], ["calc.exe", CALC], ["计算器", CALC],
]);
```

Names outside the table fall to `openRunner([name])` -> `spawn("记事本")` -> ENOENT ->
`open_application failed: could not launch "记事本"`. `{name:"计算器"}` working is not design; the table
happens to contain it.

### 1.3 `app.name` is the window title, not the app name

`BuildAppInfoFromHwnd` (`ax_win.cc:1294`) fills `name` with `WindowTitleW(hwnd)`. Measured
`listApplications()`:

```
{"pid":2888, "name":"无标题 - Notepad",   "bundle_id":"...\\Notepad.exe",              "aumid":null}
{"pid":28932,"name":"◐ agent-cli",        "bundle_id":"...\\WindowsTerminal.exe",      "aumid":null}
{"pid":13036,"name":"agent-cli changelog - agent-cli Docs - Google Chrome", ...}
```

`win.ts:118 windowsNameMatches` is a **case-insensitive substring** match:

| `app_ref.name` | Result | Reason |
| --- | --- | --- |
| `"计算器"` | hit | the Calculator window title happens to equal the app name |
| `"记事本"` | `capture_app: could not be resolved` | title is `无标题 - Notepad`, does not contain "记事本" |
| `"设置"` | silently wrong | hits two entries (1.4); `win.ts:188` takes `active` or the first, **no ambiguity error** |

Substring semantics are itself dangerous: `{name:"cli"}` hits the terminal window `◐ agent-cli`.

### 1.4 One UWP app yields two records, both cloaked

Measured for "设置":

```
applicationInfo(348)   name=设置 bundle_id=...\SystemSettings.exe        aumid=null
  listWindows(348)     window_id=198526  bounds=[0,1,938,701]
applicationInfo(14556) name=设置 bundle_id=...\ApplicationFrameHost.exe  aumid=windows.immersivecontrolpanel_...
  listWindows(14556)   window_id=722794  bounds=[88,77,956,711]
applicationInfoByAumid(设置).pid = 14556
```

DWM shows both HWNDs as `cloaked=2` (DWM_CLOAKED_SHELL, suspended), `visible=True`, `iconic=False`.

- `EnumerateUserHwndsForPid` (`ax_win.cc:2223` via `listWindows`) **does not filter cloaked**;
  `screenCaptureProbeWindows` (`ax_win.cc:2267`) does. The two disagree.
- `PickPrimaryHwndForPid` (`ax_win.cc:929-952`) picks the "largest non-minimized window"; a cloaked window is
  not iconic and still competes. With a shared host pid, **which identity gets reported is decided by window
  geometry at that moment**. Evidence: the same pid 14556 reported "计算器" in the previous session and "设置"
  in this one (Calculator had been killed).

### 1.5 The AUMID channel is asymmetric between launch and binding

The comment at `ax_win.cc:2185` says "the broker must still complete the final identity binding via
`applicationInfoByAumid` from HWND properties". Measured, that is wrong for packaged **desktop** apps:

```
applicationInfoByAumid(Microsoft.WindowsNotepad_...!App)  => null   (Notepad is running)
applicationInfoByAumid(windows.immersivecontrolpanel_...) => pid 14556  ok

activateApplicationByAumid(Microsoft.Paint_...!App) => pid 1936
  FOREGROUND_CHANGED = false                       <- cold start did not steal focus
  applicationInfoByAumid(Microsoft.Paint_...!App)  => null
  applicationInfo(1936)  => name="无标题 - 画图" bundle_id=...\mspaint.exe
  listWindows(1936)      => [{window_id:1313674, focused:false}]
```

Root cause: `PKEY_AppUserModel_ID` exists only on UWP windows hosted by `ApplicationFrameHost`. New Notepad /
Paint are packaged desktop apps and have no such property on their window.

**Conclusion: binding must be pid first, AUMID as fallback;** each covers half:

| App form | pid returned by activation | That pid has a visible window | AUMID binding | Use |
| --- | --- | --- | --- | --- |
| packaged desktop (Paint/Notepad) | the app itself | yes | null | **pid** |
| UWP (Settings/Calculator) | real process (e.g. 348) | window cloaked / non-visual frame | host pid | **AUMID** |

### 1.6 Installed-app registry: `shell:AppsFolder`

Measured 134 entries, each with `Name` + `System.AppUserModel.ID` + `System.Link.TargetParsingPath`:

```
计算器        aumid=Microsoft.WindowsCalculator_8wekyb3d8bbwe!App    target=(none)
Google Chrome aumid=Chrome                target=C:\Program Files\Google\Chrome\Application\chrome.exe
微信          aumid=D:\Weixin\Weixin.exe  target=D:\Weixin\Weixin.exe
CC Switch     aumid=com.ccswitch.desktop  target=...\cc-switch.exe
```

`IsValidAppUserModelId` (`ax_win.cc:821`) requires **exactly one `!`**, so `Chrome` /
`com.ccswitch.desktop` / `Microsoft.AutoGenerated.{GUID}` are all rejected by the existing AUMID channel;
today only 38/134 are reachable.

Classified by "valid AUMID or `.exe` target":

| Class | Count | Launch method |
| --- | --- | --- |
| valid AUMID | 38 | `ActivateApplication(AO_NONE)` |
| `.exe` target | 75 | `CreateProcess(target)` |
| not launchable (`.url` / `.msc` / `.html` / shell CLSID) | 21 | reject |

**113/134 (84%) are launchable;** the 21 rejected are doc links, admin consoles and shell-namespace items that
should not launch as apps anyway. Enumeration cost (PowerShell COM automation, two property reads per entry;
native is faster): 386 / 281 / 280 ms.

### 1.7 Focus semantics: the two paths differ and Win32 cannot block it

| Path | Measured | Note |
| --- | --- | --- |
| `ActivateApplication(AO_NONE)` | **does not steal focus** (two independent measurements, incl. cold start) | equals macOS `activates=NO` |
| `CreateProcess` / `spawn` | **steals focus** (`FOREGROUND_CHANGED=true`, new window `focused:true`) | |
| `CreateProcess` + `STARTF_USESHOWWINDOW` + `SW_SHOWNOACTIVATE` | **still steals focus** | charmap calls `SetForegroundWindow` itself; nCmdShow is only a hint |
| `ShowWindow(SW_SHOWNOACTIVATE)` to un-minimize | **steals focus** (`focused=true`, foreground 32324->25792) | restoring a minimized window cannot avoid a focus shift |
| `PreventActivation` / `IsFocusStealPrevented` | honest no-op (`ax_win.cc:3345-3357`, "Windows has no equivalent") | no usable suppression mechanism |

**Decision: accept that the Win32 branch steals focus.** No more suppression attempts. The tool description
must say so honestly and must not claim "background launch".

### 1.8 Observation capability matrix: `get_app_state` in four target states

"Does observation need activation" is not yes/no: two of four states do, at very different costs.

| Target state | UIA tree | Window screenshot | Needs | Focus cost |
| --- | --- | --- | --- | --- |
| not running | n/a | n/a | launch | packaged **no**; Win32 **yes** |
| running, window normal (may be occluded) | 229 elements | 112,795 B | **nothing** | none |
| running, UWP suspended (`cloaked=2`) | **1 element only** | stale frame 20,478 B | `ActivateApplication(AUMID)` | **no** |
| running, minimized (`iconic=True`) | full | `invalid_target` | un-minimize | **always** |

Key measurements:

```
# background-launched window that never had focus: observation fully works
listWindows -> focused:false ; captureApp -> 229 elements ; PNG -> 112,795 B ; focus never moved

# suspended UWP woken by AUMID (no focus cost)
before: cloaked=2 focused=false elements=1
after:  cloaked=0 focused=false elements=129   FOREGROUND_STOLEN=false

# minimized window: tree intact, UIA writes still work
after minimize elements=61 (same as before, element refs stable)
setValue(while minimized) = {"ok":true} ; readElement.value = "minimized-uia-write-ok"
```

**Windows.Graphics.Capture therefore needs neither foreground nor non-occlusion:** `ValidateWindowTarget`
(`screen_capture_win.cc:267-269`) rejects only `IsIconic || !IsWindowVisible`, with no foreground criterion.

### 1.9 Defect: a minimized app cannot be observed at all today

`win.ts:370-377` escalates a screenshot `invalid_target` into a whole-call throw:

```
capture_app: the verified Windows capture target is unavailable (invalid_target);
re-observe before acting.
```

So `get_app_state` for a minimized app **fails entirely** although its UIA tree is intact and writable, and
the hint is a dead end: observing again gives the same result. Today's only escape is
`open_application(activate=true)`: `ActivateApplication(pid)` (`ax_win.cc:3228`) has
`if (IsIconic(target)) ShowWindow(target, SW_RESTORE); SetForegroundWindow(target);`.

The fix is neither "degrade" nor "add a tool": let the observation path take **the minimal action needed to
complete the requested observation** (2.2): if the tree suffices do not touch the window; restore it only
when the model explicitly asks for pixels. This is the same principle by which this path already launches a
non-running app.

`ActivateApplication(AUMID)` **cannot** restore a minimized window (measured: `iconic` stays True after
re-activation, screenshot still `invalid_target`); it only lifts UWP suspension. The two must be handled
separately.

### 1.10 Raw input already activates by itself

`activateConcreteWindow` (`electronInputHandlers.ts:951-979`) calls `adapter.activateWindow(pid, bundleId,
windowId)` before dispatching window-level raw input, atomically doing raise + focus + activate + verify and
failing closed with `action_sent=false`.

So "removing activation breaks Windows raw keyboard/mouse" does not hold: **raw input lifts the target window
to the foreground itself.** UIA element actions need no foreground (1.8: `setValue` on a minimized window
still `ok:true`), so the only model-facing scenario that lacks activation is **needing pixels of a window that
cannot see itself**.

The `activateWindow(pid, expectedCanonicalBundleId, windowId)` chain already exists: `ax_win.cc:3258` export
-> `nodeAutomationAdapter.ts:238` wrapper -> `electronNativeBackendTypes.ts:380` type. Only a model-visible
tool is missing.

---

## 2. Design

### 2.1 Native additions (`src/native/ax_win.cc`)

The already-linked `shobjidl.h` / `propsys.h` / `propkey.h` suffice; **no WinRT is needed here** (WinRT is
already in the build for `Windows.Graphics.Capture` in `screen_capture_win.cc`, AppsFolder just does not need
it). The `shell:AppsFolder` parsing name is already used in `ApplicationIconPngForPid` (`ax_win.cc:3056`).

```ts
// Installed app list. Source shell:AppsFolder, reading PKEY_ItemNameDisplay +
// PKEY_AppUserModel_ID + PKEY_Link_TargetParsingPath.
listInstalledApplications(): {
  name: string;
  aumid: string | null;        // non-null only when it passes IsValidAppUserModelId
  target_path: string | null;  // non-null only when it ends with .exe
}[]

// Launch by identity. Non-null aumid uses ActivateApplication(AO_NONE) (does not steal focus);
// otherwise CreateProcess(target_path) (steals focus, see 1.7). Returns pid or null.
launchApplicationAsync(aumid: string | null, targetPath: string | null): Promise<number | null>
```

`BuildAppInfoFromHwnd` (`ax_win.cc:1293`) gains `window_id`: the HWND is in hand and the conversion copies
`BuildWindowFromHwnd` (`ax_win.cc:1328`). Identities reported by `listApplications` / `applicationInfo` thus
carry which window they were read from, and `captureApp` need not re-run the area heuristic.

`PickPrimaryHwndForPid` excludes cloaked windows, aligning with `screenCaptureProbeWindows`: a cloaked window
has no pixels on screen, and selecting it as primary hands the model a tree it can neither see nor click.
`listWindows` keeps cloaked windows but adds `cloaked: boolean` to each (callers need to know the window
exists but is suspended).

`listApplications` now produces entries **by identity**, not by pid: a pid hosting several distinct AUMIDs
yields several entries. Risk is downgraded: the Windows `resolvePid` at `src/native/win.ts:188` takes `active`
or the first on multiple hits and **raises no ambiguity error**, so duplicate pids are tolerable (the
ambiguity error is macOS `nativeAxSource.ts:1374`, not on this path). The 128-entry slice is kept.

### 2.2 JS (`src/native/win.ts`)

`resolvePid` -> `resolveTarget(appRef): { pid: number; windowId?: number } | null`; name resolution has two
layers:

1. **Exact match of the installed-app name** (case-insensitive, authoritative) gives `{aumid, target_path}`,
   then find the live process:
   - valid `aumid` -> `applicationInfoByAumid(aumid)` -> pid + window_id
   - otherwise -> in `listApplications()` match `bundle_id === target_path`
2. **Window-title substring match** (today's semantics, keeping existing uses like `{name:"Notepad"}`)
3. Both layers empty but layer 1 found an installed app -> launch
4. Layer 2 with multiple hits -> **raise an ambiguity error listing candidates** (aligned with macOS,
   replacing today's silent pick)

The `captureApp` preamble grows from "launch if no process" to **"make the target observable"**, covering the
three non-normal states of 1.8:

```
resolveTarget(appRef)
  ├─ null (no live process)
  │    → listInstalledApplications() exact match on name
  │        hit → launchApplicationAsync(aumid, target_path)
  │                 → bind: pid has a non-cloaked window ? use pid
  │                        : aumid ? applicationInfoByAumid(aumid)
  │                        : re-resolve among live processes by target_path
  │                 → settleFreshlyLaunchedTree (ported from macOS, see below)
  │        miss → throw, text names only paths that really work
  │
  ├─ hit but primary window cloaked (UWP suspended) and has aumid
  │    → activateApplicationByAumid(aumid) wake → re-read
  │      free: measured no focus steal, tree grows from 1 to 129 elements
  │
  └─ hit but primary window iconic (minimized)
       ├─ include_screenshot=false (default) → do nothing, return the full tree
       └─ include_screenshot=true         → restore the window (steals focus) then screenshot
```

The last branch is the only place this spec keeps "activation", and it needs no new tool or parameter:
**`include_screenshot` is the focus switch.**

`include_screenshot` is an existing model-visible `default(false)` parameter (`schemas/observation.ts:45`)
whose description already says "set true only when vision is needed". "The model explicitly wants pixels"
therefore already has an expression, and a minimized window **physically** cannot produce pixels without
being restored (`ValidateWindowTarget` rejects `IsIconic`, `screen_capture_win.cc:268`). The trigger is thus
exact and self-consistent:

| Case | Touch the window | Focus cost |
| --- | --- | --- |
| window normal (even fully occluded) | no | none |
| window iconic, `include_screenshot=false` | no, tree only | none |
| window iconic, `include_screenshot=true` | restore | **yes** |
| UWP suspended cloaked | AUMID wake | none |

So **the default path never steals focus;** it happens only when the model says "I want to see the picture"
and the picture is truly unobtainable.

This also fixes the 1.9 defect: `invalid_target` no longer throws when the window is iconic; either restore
already succeeded or the `include_screenshot=false` tree-only path applies. Other `invalid_target` /
`target_changed` (the window really changed or vanished) keep throw semantics: that is identity drift and must
fail closed.

The restore must be logged on the broker side (aligned with the existing `[cua-captureapp-launch]`, adding
`[cua-captureapp-restore]`): it is a user-visible desktop change and must be traceable. The model surface
**adds no** output field: screenshot success itself implies the window was made visible, and the behavior is
documented in the tool description.

`settleFreshlyLaunchedTree` must be ported. The macOS root cause (`nativeAxSource.ts:1731`) holds on Windows
too: a freshly launched app's AX tree is still growing, and element indexes noted in the model's first cell
point to other nodes by the next cell. Measured: the Paint window appears about 3.5s after activation.

When the launcher pid differs from the GUI pid, keep the existing mechanism: get the canonical path via
`processExecutablePath(launcherPid)` and re-resolve among live processes (the logic already exists at
`electronNativeBackend.ts:1683-1700`; move it to win.ts).

The `AppsFolder` enumeration is cached for the Helper's lifetime; **on a name miss re-enumerate once before
failing**, so newly installed apps need no Helper restart.

### 2.3 Tool surface: delete `open_application`

The tool disappears (not a platform contraction). Deleted along with it:

| Deleted | Location |
| --- | --- |
| Tool definition (about 183 lines) | `src/tools/observation.ts:1038-1220` |
| Registration / tier / policy / legacy map | `manifest.ts:138`, `tier-table.ts`, `action-policy.ts`, `legacyToolMap.ts:26` |
| Argument schema | `src/tools/schemas/openApplicationAppArg.ts`, `schemas/index.ts`, `schemas/jsonSchemas.ts` |
| Broker method and handler | method name in `broker/types.ts`, two special cases in `broker-client.ts`, the handler in `electronNativeBackend.ts` (688 lines) + helpers serving only it (`resolveAppByPid` / `rollbackFreshApplication` / `discoverFreshApplicationForRollback` / `settleActivatedAppByPid` / `positiveWindowId` / `activateMacFilePanelSurface`, 378 lines) + the `broker_info` capability flag |
| Windows launch machinery | `openApplication` in `windowsSystemSurface.ts`, the Calculator alias table, the whole `openRunner` / `WindowsAumidActivator` (173 -> 44 lines); with it the `windowsOpenRunner` / `windowsActivateApplicationByAumid` options of `nodeSystemSurface` and the injection points in `helperMain` / `windowsDevHelperMain` |
| Platform-contraction mechanism (dead once emptied) | all of `src/tools/platform-surface.ts` + `tools/index.ts:61-62`, `manifest.ts:241-242`, `computer-use-runtime.ts:111-167` |
| Activation contract doc | `docs/open-application-activation-contract.md` |
| `prevent_activation` rejection branch | `electronNativeBackend.ts:1386-1389`. It guarded the model's explicit activation request, which no longer exists; and on Windows the gate never fires (`IsFocusStealPrevented()` hard-coded false, `ax_win.cc:3353`), so it is dead code |

**One spec error corrected by fact:** `adapter.openApplication` (the adapter-layer launch capability) **must be
kept.** `reopenWindowlessApp` (darwin only) uses it inside `capture_app` to reopen a windowless macOS app,
which is the existing precedent for "the observation path takes the minimal action required to complete the
observation". What is deleted is the **tool** and the **broker method**, not the capability.
`NodeSystemSurface.openApplication` therefore becomes **optional**: macOS implements it, Windows no longer
does (Windows launches via native `launchApplicationAsync`, the whole path in `captureApp` in
`src/native/win.ts`, not through the system surface), and `nodeAutomationAdapter` exposes it conditionally on
the system surface providing it. `settleApplicationWindow` and `hasOnscreenWindow` are kept for the same
reason (callers outside the handler).

**Activation is no longer a capability but the minimal action `get_app_state` takes to complete an
observation.** Split apart, the three things each have a home:

| Capability | Owner | Focus cost |
| --- | --- | --- |
| Wake suspended UWP | automatic inside `get_app_state` (2.2) | **none** |
| Raise to foreground (for raw input) | raw input does it at dispatch (1.10 `activateConcreteWindow`) | yes, but that is raw input's existing semantics |
| Restore minimized window (for pixels) | `get_app_state` + `include_screenshot=true` (2.2) | yes, explicitly triggered by the model |

None needs a standalone tool. A narrow `activate_window` tool was considered and rejected: it would have one
use (pixels of a window that cannot be seen), which is already `get_app_state`'s job; another tool does not
reduce what the model must understand, it just renames `open_application`.

`file-url-window-verification` (`src/lib/`) loses its callers with the `urls` parameter (only
`electronNativeBackend.ts:63` and `observation.ts:63` reference it) and is deleted too.

### 2.4 Model-facing contract changes

`app_ref.name` semantics widen from "window-title substring" to "installed-app display name (exact) or window
title (substring)"; the description must be rewritten.

The `window_id` description **stays** (currently: macOS save-panel only, do not guess placeholder values like
1): window resolution stays inside the broker; the model neither needs nor should supply it for Windows
observation.

The `get_app_state` description must state three things honestly: a non-running target is launched (packaged
launches in the background, others take the foreground focus); a suspended target is woken (no focus cost); a
minimized target with `include_screenshot=true` **restores the window and therefore takes focus**; keep the
default `include_screenshot=false` whenever the tree suffices to avoid disturbing the user.

The tool count goes 15 -> 14 (`open_application` out, nothing added). The comments "canonical 15-tool
surface" and "Source: `tool_manifest.py`, verbatim" in `manifest.ts` must change: this is a deliberate
divergence from the upstream Python manifest, and leaving them would be false. `APP_ASSOCIATION_MODE_BY_TOOL`
drops the entry in step (the drift gate enforces this).

**Nothing new for the model to learn:** no `get_app_state` parameter changed; the behavior becomes "take the
minimal action necessary to give you what you asked for".

---

## 3. Test plan (tests first)

New:

- `test/native/windows-installed-app-resolution.test.ts`: three AppID shapes classified, `.url`/`.msc`
  rejected, exact name match beats title substring, re-enumerate once after a miss.
- `test/native/windows-transparent-launch.test.ts`: not running -> launch -> bind -> settle end to end;
  packaged binds by pid, UWP falls back to AUMID (both rows of the 1.5 table pinned); launcher pid != GUI pid
  re-resolution.
- `test/native/windows-name-ambiguity.test.ts`: multiple title-substring hits raise an ambiguity error listing
  candidates (replacing the silent pick).
- `test/native/windows-observability-states.test.ts`: the 1.8 four-state matrix row by row: a normal window
  (even fully occluded) yields tree and pixels with no activation; cloaked -> AUMID wake then re-read; iconic +
  `include_screenshot=false` -> tree only, **window untouched**; iconic + `include_screenshot=true` -> restore
  then screenshot succeeds; when the window truly vanishes/drifts `invalid_target` / `target_changed` **still
  throw**.
- cloaked: `PickPrimaryHwndForPid` does not pick cloaked; `listWindows` still reports it with `cloaked:true`.
- The launch path must refuse uninstallers (name or target path containing `uninstall` / `卸载`).

Rewrite / delete (about 3,200 lines):

| File | Lines | Disposition |
| --- | --- | --- |
| `test/windows-open-application-identity.test.ts` | 771 | delete; identity assertions move into the new transparent-launch suite |
| `test/open-application-new-instance.test.ts` | 584 | delete (`new_instance` goes with the tool) |
| `test/open-application-identity-conjunction.test.ts` | 474 | delete |
| `test/open-application-args.test.ts` | 423 | delete |
| `test/open-application-error-taxonomy.test.ts` | 268 | delete; error taxonomy assertions move to `get_app_state` |
| `test/broker/windowsSystemSurface.test.ts` | 201 | trim (drop openApplication and the alias table) |
| `test/get-app-state-transparent-launch.test.ts` | 205 | extend with a Windows branch |
| `test/native/windows-app-ref-resolution.test.ts` | 278 | rewrite for `resolveTarget` |
| `test/tool-platform-surface.test.ts` | 47 | delete (`open_application` is its only entry; the mechanism becomes dead) |
| `test/resolve-opened-app-active-settle.test.ts` | 237 | delete (`settleActivatedAppByPid` deleted; native activation has its own foreground verification loop) |
| `test/manifest.test.ts` / `tier-table` / `schemas-*` / `skill-tool-signatures` / `tool-return-shape.parity` | n/a | sync tool count and signatures (15 -> 14) |

E2E: `docs/cua-act-verify-windows-scenarios.md` needs a case "cold-launch and observe by Chinese app name"
(today `{name:"记事本"}` must fail).

---

## 4. Phases

| Phase | Content | Independently verifiable |
| --- | --- | --- |
| A | Native: `listInstalledApplications` + `launchApplicationAsync` + `window_id` + cloaked criterion | yes: pure new exports, no existing behavior changed |
| B | `win.ts`: `resolveTarget` + transparent launch + iconic restore + settle + ambiguity error | yes: `get_app_state({name})` end to end |
| C | Delete all `open_application` surfaces + platform-contraction mechanism + contract doc | yes: pure deletion |

C depends on B (replacement before deleting the old tool), B on A. The iconic restore in B adds no native
code: `activateWindow` / `activateApplication` both exist and both contain `IsIconic -> SW_RESTORE`
(`ax_win.cc:3300` / `3228`).

---

## 5. Unverified items and risks

- Win32 launch focus-stealing was measured only on charmap (n=1). Apps honor nCmdShow differently and some may
  not steal focus. This does not change the design (focus stealing is accepted); it only affects copy rigor.
- `launchApplicationAsync` for `.exe` targets with arguments is not designed (AppsFolder `TargetParsingPath`
  carries no shortcut arguments); apps launched with arguments may behave differently.
- The 134 `listInstalledApplications` entries include uninstallers ("卸载微信"). Exact name match mitigates but
  a model passing that name would run the uninstaller. **The resolution layer must explicitly refuse** names or
  target paths hitting `uninstall` / `卸载`. This is the only new dangerous surface in the design and must have
  a test.
- AppsFolder enumeration time on machines with very many apps is unmeasured (134 entries / 280ms here).
- After producing `listApplications` by identity, the 128-entry slice may fill up more easily.
- `setValue` on a minimized window works (measured), but the foreground did change in the same round
  (minimizing hands the foreground to the next window; whether `setValue` steals focus additionally cannot be
  separated from this n=1 measurement). This does not affect 2.2, but "operating a minimized app has no side
  effects" must not be written into model-facing copy.
- The "restore minimized -> screenshot succeeds" end-to-end triggered by `include_screenshot=true` was
  verified in Phase B: after minimizing charmap, `screenshot=false` returns 27 elements with the window kept
  minimized and focus untouched; `screenshot=true` restores the window and returns a 38,140 B screenshot
  (focus stolen, accepted).
- The restore side effect has no standalone model-facing output field, only the indirect signal of screenshot
  success + the broker log. This is a deliberate trade-off to not widen the tool surface; add a field to the
  observation payload only if models are found to misjudge the user's desktop state because of it.
- **Known asymmetry (Phase B implementation choice):** the "installed display name" layer needs one async
  enumeration and participates only in `captureApp`; `list_windows` / `application_info` still have only the
  window-title substring layer. So `list_windows({name:"记事本"})` still does not resolve while
  `get_app_state({name:"记事本"})` does. No regression (the old implementation failed both) but the criteria
  do not match; aligning them needs `AxReadOnlySource.listWindows` to become async, a broker-wide
  cross-platform contract change out of this spec's scope.
- **`cloaked` / `minimized` do not reach the model surface:** they are native facts that `adaptSnapshot` does
  not carry when mapping to the broker's `AxRawWindow`. The model cannot tell from `list_windows` that a
  window "exists but has no pixels". Fixing it needs `AxRawWindow` (a cross-platform contract) and was not
  done in this phase.
- With an old addon (no `window_id`) the window-state check is skipped entirely: when `makeObservable` has no
  `window_id` it does not guess, leaving window selection to native `PickPrimaryHwndForPid` (more reliable
  than the first EnumWindows z-order entry of `listWindows`, which is the source of the 136x39 shell helper
  window problem noted in its comment). The cost: on such an addon neither the cloaked nor the minimized rescue
  works, which is the existing degradation semantics of an additive ABI.
- **Eval harness not updated with this deletion (follow-up):** 16 files under
  `evals/zcode-gui-eval/src/evaluators/` have about 104 references to `open_application`;
  `cua-open-application-tasks.mjs` and `zcode-agent-open-application-tasks.mjs` exist entirely for it. The
  cross-repo drift mirror (`evals/zcode-gui-eval/tool-manifest.json`) is synced and
  `zge validate --all --definition-only` still passes 37 / 0 failures, so the CI-visible gate is green; the
  breakage appears only in the macOS real-machine lane. **These cases were already broken before this
  deletion:** they are gated by `process.platform !== "darwin"` and run only on macOS, while the mac surface
  has excluded `open_application` since 2026-09-11. Cleaning it needs a real macOS machine and cannot be
  verified on Windows; blindly editing a harness that cannot run is worse than leaving it.
- `test/macos-background-application-open.test.ts` is **trimmed**, not deleted: 15 cases drive the deleted
  broker method and are removed; 3 drive `adapter.openApplication` directly (completion-backed ABI coverage of
  the kept capability) and stay.
- The SKILL.md 14KB cap (resident preload budget) is nearly full: after adding two Windows focus exceptions it
  is 14,322 / 14,336; one old sentence duplicating a new paragraph was condensed. Measure size before adding
  anything to the SKILL. (Updated 2026-09-16: after rebasing on `dbae0665` upstream compressed some, now
  14,275 / 14,336, 61 bytes of headroom.)
- **Known limitation, decided not to fix: `list_apps` hides UWP apps behind a shared host.** `ListApplications`
  de-duplicates by pid (`seenPids.insert(pid)`) and all UWP apps share the single ApplicationFrameHost pid, so
  only one entry appears, named after the top window in EnumWindows z-order. Measured 2026-09-16: with
  Calculator and Settings both awake on pid 19076, `list_apps` still returned 7 entries, the AFH entry was
  named "计算器", and **"设置" did not exist in `list_apps` at all**. Same root: `application_info({pid})` on
  AFH reports the name and AUMID of the largest window.

  The reason is not "small impact" but that **the half that causes misoperation is already fail-closed:**
  `{pid:host}` no longer silently returns another app's tree, observation-time wake no longer activates the
  wrong AUMID, and that error carries the host's window list to the caller. What remains is purely
  **incomplete discovery**. The real fix is to have a shared host produce **per-window entries** (each with
  its own `window_id` and AUMID identity) rather than one per pid, but that changes the outward shape of the
  core `list_apps` method: many tests pin its structure and the "one app, one pid" mental model of
  `app_ref.pid` would loosen; the gain (discovery completeness) does not justify that risk surface.

  The only two remaining consequences cause no misoperation: asked "which apps are open now" the model misses
  UWP apps on the same host, and `application_info({pid})` on AFH reports the wrong app name. **Workaround:**
  bind by app name (main path, works), or take the `window_id` from the shared-host error.
- **The full failure baseline was never triaged item by item, so "N = N" is a regression gate, not proof of
  health.** The repo has had about 50 failures on Windows, generally summarized as "macOS / PiP contracts must
  be red on Windows". On 2026-09-16 triaging one of them,
  `test/windowsDevHelperMain.test.ts > runs the source Windows Helper against the real native addon`, turned
  out not to be a platform difference but a test **broken twice over that never passed**: (1) `fork` did not
  pass `ZCODE_CUA_DEV_MODE=1` (the source Helper composition root self-checks peer primitives at the native
  load point, Windows lacks them yet, so refusing to start without explicit opt-in is correct product
  behavior); (2) the startup handshake sends `transport_ready` then `ready` while the test used `once()`
  expecting `ready` first. So the signal "a dev-mode Helper can start against the real addon" was empty. Fixed
  (baseline 52 -> 51). **Implication:** the remaining 51 may hide real problems; "new failures = 0" is
  trustworthy for judging regressions, but do not read the number as "the rest are all platform differences".
