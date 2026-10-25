# Windows CUA source development runbook

This runbook covers only the local development chain on a logged-in Windows user's desktop. It does not apply
to SSH, WSL, Docker, remote workspaces or mobile `/remote`; those paths cannot start or attach a Windows
Computer Use Helper.

## Prepare the source Helper

First build the JavaScript Helper and the native N-API addon in the `zcode-cua` source root:

```powershell
$zcodeCuaRoot = 'D:\path\to\zcode-cua'
Set-Location $zcodeCuaRoot
pnpm install
pnpm rebuild:native
pnpm build
pnpm test
```

After the build, the two files declared by `package.json.zcodeCuaRuntime.windows` must exist. Current
contract example:

```text
<zcode-cua>\dist\windows-helper.js
<zcode-cua>\build\Release\ax_native.node
```

After each change to `zcode-cua` source, run `pnpm rebuild:native` again (when the native addon changed) and
`pnpm build`. The ZCode product need not be repackaged.

If Windows Smart App Control is enforcing, a newly compiled `ax_native.node` not signed by a Trusted Root
Program CA is refused by Code Integrity; a successful compile does not mean the machine can run it. The live
smokes then exit 2 before creating the Helper/fixture and report native addon blocked or unavailable. Do not
turn off the system security policy for source acceptance; use a build with a trusted dev signature, or
re-verify on a dedicated dev machine that allows local unsigned native modules. Product signing and the
installer loop are outside this runbook.

## Start the desktop dev environment

The official `zcode-cua` plugin must be enabled. Then in the ZCode source root:

```powershell
$zcodeRoot = 'D:\path\to\z-code'
Set-Location $zcodeRoot
$env:ZCODE_CUA_DEV_MODE='1'
$env:ZCODE_CUA_DEV_ROOT=$zcodeCuaRoot
pnpm dev:desktop:prod
```

`ZCODE_CUA_DEV_MODE=1` is the existing one-knob bundle that also enables internal development features; do
not replace or split it into a new environment variable. `ZCODE_CUA_DEV_ROOT` only resolves source build
artifacts and only the desktop-local Windows Host may use it.

`ZCODE_CUA_DEV_ROOT` must point directly at the physical source root: the root must not be a
symlink/junction, `package.json`, the contract entry and nativeAddon must be non-link regular files, and
their `realpath` must be inside that root. Admission failure does not fall back to installer resources; fix
the directory layout rather than bypass isolation with links.

If `ZCODE_CUA_DEV_ROOT` is not set, `pnpm dev:desktop:prod` defaults to the producer installed in this repo
(`<repo>\node_modules\@zcode\zcode-cua`, the version pinned by the `pnpm-workspace.yaml` catalog, same source
as product staging), via `scripts/dev-desktop-cua-env.mjs`. That is only a default: to verify your own
producer change, set the variable explicitly as above; an explicit value always wins. In dev,
Electron's `process.resourcesPath` points at `node_modules/electron/dist/resources`, which has no
`tools/cua-helper`, so with no value set the product branch necessarily fails with
`invalid-runtime-manifest`.

Expected processes and communication:

```text
ZCode desktop Host Process
  └─ Node/Electron child: the entry declared in package.json
       ├─ the nativeAddon declared in package.json
       └─ \\.\pipe\zcode-cua-<random>

official zcode-cua plugin ── authenticated broker RPC ──┘
```

Broker token authentication was removed wholesale by the node_repl refactor: the connection gate is now
native peer-identity (code-signature / `parentProcessPid`) and the Helper environment injects no broker
token. `ZCODE_CUA_PERMISSION_BROKER_TOKEN` now exists only as a **hostile input that must be stripped** (see
`must-not-be-forwarded` in `windowsCuaDevRuntime.test.ts` and the cli-side
`zcode-cua-plugin-host-authority` test); it is no longer a credential source and no code injects it. Do not
confuse it with browser-use's `ZCODE_NODE_REPL_BROWSER_BROKER_TOKEN`, which belongs to the node_repl browser
broker, a different chain. The only formal credential is the socket + `pluginAuthority` pair, handed by the
Host to the official plugin through `buildCuaProductHelperAgentEnv()`; user-authored plugin config overrides
are not accepted. `pluginAuthority` is the only sensitive credential and must not appear in child argv,
process title, logs, error text, telemetry or copyable UI text.

## Verify the source Helper

Confirm the source Helper is built as above, then run the opt-in real-machine test:

```powershell
Set-Location $zcodeRoot
$env:ZCODE_CUA_DEV_MODE='1'
$env:ZCODE_CUA_DEV_ROOT=$zcodeCuaRoot
pnpm exec vitest run packages/services/test/windowsCuaDevHelper.integration.test.ts
```

`ZCODE_CUA_DEV_MODE=1` is required here as well as when starting the desktop dev environment; it is the
one-knob bundle enabling the internal dev runtime/feature, and setting only `ZCODE_CUA_DEV_ROOT` is not
enough.

The broker's connection gate is native peer-identity (`getPeerCredentials` / code-signature /
`parentProcessPid`); the Windows-side peer verification has not landed. **Since producer `37a0c9ef` the gate
is temporarily open on Windows** (producer-side constant `WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN`;
otherwise a packaged build structurally could not get the dev exemption: `ZCODE_RUNTIME_ENV=production`
injected by `app.isPackaged` makes every localDev criterion constantly false and the Helper necessarily fails
to start). So the broker no longer reports `refusing to start an unauthenticated broker` for a missing opt-in
but starts unauthenticated with one stderr warning (`peer identity verification temporarily disabled`): any
local process on Windows can connect to this named pipe. When the native peer primitive of M5 lands the
constant is retired, the gate closes automatically and the refuse-to-start behavior returns.

The test runs only when all four hold: Windows, `ZCODE_CUA_DEV_ROOT` set, a valid producer contract, and the
contract's entry/nativeAddon exist. It verifies a real child, a random named pipe, health/`broker_info`,
read-only application listing, the official plugin environment pair, no `pluginAuthority` leak, and child
exit after `stop()`. The external MCP tool name is `list_apps`; the source broker's actual read-only RPC is
`list_applications`, and the test calls it by that existing mapping without adding an alias or changing the
plugin tool surface.

This file is not covered by `pnpm typecheck` (`packages/services/tsconfig.json` `include` is only `src`) and
is skipped in CI by default. So if a service-layer symbol it references is deleted by a refactor there is
neither a type error nor a test failure, only a `ReferenceError` on the first local real-machine run. After
changing the CUA credential contract this file must be run locally; do not rely on green CI.

## Verify packaged resources

Product-resource acceptance and the source override are two independent paths. When building the product
`ZCODE_CUA_DEV_ROOT` must be removed and the repo config file passed explicitly for the `--dir` command:

```powershell
Set-Location $zcodeRoot
Remove-Item Env:ZCODE_CUA_DEV_ROOT -ErrorAction SilentlyContinue
$env:ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR=$zcodeCuaRoot
$env:ZCODE_SKIP_REMOTE_ASSETS='1'
$env:ZCODE_TARGET_OS='win32'
$env:ZCODE_TARGET_ARCH='x64'
pnpm --filter @zcode/desktop build
pnpm --filter @zcode/desktop exec electron-builder `
  --config electron-builder.config.js --win --x64 --dir
Remove-Item Env:ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR
```

`ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR` selects only the build-time producer and does not enable the source
runtime override of the installer; at run time only `ZCODE_CUA_DEV_ROOT` counts. When the local producer commit
is not pushed yet, use the former to finish staging while keeping the workspace/lockfile pointing at a
remotely fetchable upstream commit.

Windows native files are signed when electron-builder copies `extraResources`, so the staging manifest hash
describes only the pre-copy bytes. Windows `afterPack` first checks win32/arch of the actual build context,
then refreshes the hash from the final signed bytes and re-verifies strictly. The build fails outright when
the target environment variables disagree with `--win/--x64` (or `--arm64`).

`electron-builder.config.js` is not a default file name electron-builder discovers automatically. Omitting
`--config` bypasses `extraMetadata.version`, the Windows CUA `extraResources` and the afterPack config, so it
is not a valid product build command.

Real lifecycle acceptance uses two explicit variables so the test cannot accidentally read the dev directory
or the current process:

```powershell
$env:ZCODE_CUA_PRODUCT_RESOURCES_PATH = `
  (Join-Path $zcodeRoot 'packages\desktop\dist\win-unpacked\resources')
$env:ZCODE_CUA_PRODUCT_EXECUTABLE = '<a runnable Electron 41.0.3 x64 executable>'
pnpm exec vitest run packages/services/test/windowsCuaProductHelper.integration.test.ts
Remove-Item Env:ZCODE_CUA_PRODUCT_RESOURCES_PATH
Remove-Item Env:ZCODE_CUA_PRODUCT_EXECUTABLE
```

The test first resolves the product manifest with the resources path, current architecture and Electron
`41.0.3`, overriding only the resolved `command` with the explicit executable; root, entry, addon and the
dependency closure still come from the packaged resources. It verifies that ready/health/`broker_info` PIDs
agree, then runs `stop()` and within a bounded deadline confirms a new pipe connection fails, the exact owned
PID is gone, and the token is not in argv or captured logs. With either variable missing the real lifecycle
case must show as skipped; the invalid-packaged-root case always runs and asserts the stable
`WindowsCuaDevRuntimeResolutionError`.

A machine with Windows Application Control enabled may refuse a branded exe that has not finished release
signing; do not turn the policy off. Use an exact, hash-verified Electron 41.0.3 executable of the same ABI to
finish packaged-resources/ABI acceptance, but state explicitly in the report that this does not equal final
branded/signed exe acceptance. The final conclusion still needs CI/the signing machine to complete `rcedit`,
native-file/EXE signing, afterPack and the branded exe lifecycle. The 2026-07-29 concrete paths, versions,
hashes, live smokes and local build limits are in `docs/cua/windows-product-runtime.md`.

### Live smokes (all opt-in, on an unlocked interactive desktop)

All smokes default off; without the opt-in variable they start no Helper and move no cursor. Common
preamble: `Set-Location $zcodeCuaRoot; pnpm rebuild:native; pnpm build`, then set the variable, run, and
remove the variable.

| Smoke                  | Variable / command                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pointer                | `ZCODE_CUA_WINDOWS_POINTER_LIVE=1`, `pnpm smoke:windows:pointer`               | Accepts only one `active=true` live foreground app and uses its exact `{pid,bundle_id,name}` as `app_ref`. Moves the cursor up to 24 coordinate units toward the display center, sends an `amount:0` wheel probe through the same scoped path, restores the original position in `finally` and verifies a two-pixel tolerance; finally a five-second `hold_key` verifies Helper shutdown wakes the wait within 1.5 s, releases the key and exits cleanly                                                                                                                                                                                                                                                                    |
| clipboard              | `ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE=1`, `pnpm smoke:windows:clipboard`           | Starts its own uniquely identifiable Helper, confirms `clipboard=true`, reads the original text, writes a random marker, reads it back exactly, and restores and re-checks the original text in `finally`. stdout prints only a boolean summary, never original text, marker, token or pipe. Warning: the `CF_UNICODETEXT` smoke saves/restores text only; if the clipboard also holds images, file lists or app-private formats those cannot be restored; the operator must confirm they may be overwritten first                                                                                                                                                                                                          |
| WGC visual             | `ZCODE_CUA_WINDOWS_SCREEN_CAPTURE_LIVE=1`, `pnpm smoke:windows:screen-capture` | Creates only two controlled WPF windows: a green/magenta checkerboard target and an opaque blue occluder. Auto-verifies `screen=true`, `screenshot=true`, PNG/bounds of the selected display, pixel equivalence of the target before/after full occlusion, `capture_app(include_screenshot=true)`, the official MCP `get_app_state` `state_id` and safe `state_image` button click, fixed minimized failure, and clean exit of Helper/fixtures. stdout prints only booleans, sizes, fixed result codes and exit facts, never images, window titles, temp paths, token or pipe. If not opted in, locked, not the default input desktop, or blocked by native signature policy, it exits 2 before starting any Helper/fixture |
| canonical tool surface | `ZCODE_CUA_WINDOWS_TOOL_SURFACE_LIVE=1`, `pnpm smoke:windows:tool-surface`     | Via the official `buildServer` + MCP client directly calls the 28 non-clipboard tools, verifying that `open_application({app:{pid}})` only resolves/activates the existing WPF fixture without a second launch, UIA/WGC observation, display, `state_image`, all pointer/keyboard, element action/focus, wait and stop. `read_clipboard` / `write_clipboard` stay with the clipboard companion smoke; the union must exactly equal the canonical 30-tool manifest. The script saves and restores the cursor, releases held input, waits for Helper/fixture clean exit; with default-off or failed preflight it creates no child process                                                                                     |

Then verify the official plugin's fail-closed boundary:

```powershell
pnpm --filter @zcode/zcode-cua-plugin test
```

This runs `tests/zcode-cua-plugin-host-authority.node-test.ts` directly. That file contains only Host
authority credential-boundary tests; the script no longer depends on Node's `--test-name-pattern`, so a
missing file, load failure or assertion failure fails the command and a zero-match false green is
impossible. Check three things: with no broker credential the usable CUA tools are zero or return an explicit
unavailable; a valid Host-injected credential keeps the official server config; a token in user-authored
plugin config is never accepted.

The command first runs the plugin launcher's own tests, then builds the CLI dependencies and runs the
authoritative credential test of the official `__zcode-plugin-host`, which verifies that the Host-injected
canonical product/broker/socket config is preserved and that user-authored env or argv overrides of the
broker credential are rejected; it does not accept a user token as a credential source. A bare plugin
`node --test` is not a valid gate because it lacks the package `build` prerequisite; use the package test
command above.

When running generic broker unit tests on Windows, live server/client cases must connect to a per-case unique
`\\.\pipe\zcode-cua-test-<random>`; do not hand a `b.sock` under a temp directory to Node `net.listen()`.
Authentication, protocol, dispatch, timeout and shutdown ordering still run on a real named pipe;
POSIX-file-node assertions (`0600/0700`, symlink, stale Unix socket, unlink) run only on macOS/Linux:

```text
win32 ──> \\.\pipe\zcode-cua-test-<random> ──> live transport / protocol tests
posix ──> <private tmpdir>/broker.sock       ──> live transport + fs security tests
```

## Logs, security and limits

During development prefer the ZCode service logs and `~/.zcode/cli/log`, `~/.zcode/cli/debug`,
`~/.zcode/cli/rollout` to trace session/Helper lifecycle; Helper stderr is for local diagnosis only. Before
copying or committing logs, check and remove the broker token, random pipe path and other connection
credentials.

Windows lock screen, Session 0 or a non-interactive user desktop must fail closed: the Helper cannot inject
input and must not pose a non-interactive state as usable. Windows pointer operations require the target
`app_ref` PID to still be the only foreground app at dispatch; negative-coordinate secondary displays use the
virtual desktop mapping; `left_mouse_up` is only a cleanup operation for an already pressed mouse button and
may release after a focus change. The Windows native text clipboard uses `CF_UNICODETEXT` and an N-API async
worker and reports `clipboard=true` only when the interactive-desktop preflight and both read/write exports
hold; it uses no PowerShell, external command or Electron fallback. Windows screenshots use WGC with an N-API
async worker: displays are captured by selected bounds, windows are re-checked before and after by
HWND/PID/full executable/bounds; minimized, locked-screen, target-changed and higher-integrity-level cases
fail closed with fixed errors. The PNG is 8-bit BGRA SDR with the system default capture border kept; HDR/color
management fidelity is not promised. Further isolation of the UIA worker is not done yet; blank pixels or any
other fallback must not pose as success.

### Windows launcher and GUI process identity

Before `open_application` launches, one UIA application PID/identity snapshot must be collected
asynchronously. A launcher PID that UIA can reliably resolve is always preferred; only Windows may rebind a
windowless launcher to a GUI child, and the child must simultaneously: not be in the pre-launch snapshot,
have a non-empty canonical executable identity, exactly equal the identity resolved from the launcher, still
be exposed by UIA, and be the unique candidate. An old process, a same name/basename only, a same name at a
different path, or multiple new candidates must fail closed; guessing through `active` or the first
enumerated item is forbidden.

Win11's `notepad.exe` is an App Execution Alias; command text or basename cannot be assumed to be the process
identity. The implementation queries the process's full executable path through native
`processExecutablePath(pid)` immediately after `spawn` returns the PID; on a real machine it returns the real
`...\Notepad\Notepad.exe` inside WindowsApps. Cross-PID rebind may use only that full path, never the alias
text, name or basename. UIA registration on a real machine can lag spawn by about 2 seconds, so the resolver
uses a bounded `30x100ms` wait; extending the budget must not relax the snapshot, full path, live
re-verification or uniqueness conditions. Non-Windows platforms keep the original bundle/name resolution and
do not enter launcher->GUI child rebind.

A Windows direct preferred/launcher PID is also not a stable identity on its own. Before accepting
`applicationInfo(preferredPid)` the resolver must normalize its live `bundle_id` to a full executable path and
compare it exactly with the canonical full executable path read right after launch; if they differ the PID
must not be returned, and the resolver continues to look for a unique new GUI candidate satisfying all the
constraints above, finally failing closed if there is no safe candidate. If the canonical lookup is missing,
throws or returns a non-absolute path, even if UIA can directly see the preferred PID it must not count as
evidence this launch succeeded. This rule prevents PID reuse and the TOCTOU where process identity changes
"after the launcher identity was read but before UIA accepted"; non-Windows direct PID keeps the original
behavior.

When Windows `axSource` / UIA is missing, the backend must reject `open_application` before spawn, and the
resolver must defensively return `null`, never `launchHint`; non-Windows keeps the existing no-`axSource`
fallback.

Windows packaged apps cannot reuse the executable-path rebind above. An app like Calculator is hosted by
`ApplicationFrameHost.exe`; the host executable is neither an AUMID nor proof of the specific app identity. A
packaged app must pass the exact AUMID through `bundle_id`, be activated through native
`IApplicationActivationManager`, then have its unique PID resolved exactly from the `PKEY_AppUserModel_ID` of
the visible top-level HWND; 0 or multiple PID candidates fail closed. Later `get_app_state` and actions prefer
the PID returned by `open_application`. Ordinary Win32 apps continue to pass an explicit executable name (for
example `notepad.exe`), with the full-path verification rules unchanged; guessing by localized title,
basename, active state or the first enumerated item is forbidden.

> The tool surface changed after this section was written: see
> `docs/cua/producer/windows-app-identity-and-transparent-launch.md` (`open_application` deletion for
> Windows) and `docs/cua/producer/cua-14-tool-e2e-validity.md` (14-tool baseline). The paragraphs above and the
> "30 tools" statements below describe the 2026-07-29 state.

The official CUA provider-visible tool names remain only `mcp__computer-use__*`. The Agent accepts a one-way
runtime alias `mcp__computer_use__*` that models occasionally generate, only for the official server that
passed Host authority verification, and restores the canonical name before permission, hook, event, history
and MCP dispatch. Third-party MCP servers do not get this alias, and globally normalizing hyphens and
underscores is forbidden.

## Real-machine acceptance summary (2026-07-29)

Environment: Windows 11 10.0.26200 x64, interactive Session 1, Node 24.18.0 (ABI 137), pnpm 10.33.2; the
official `computer-use@zcode-plugins-official` chain was started and verified from the source desktop,
limited to the local desktop continuous chain (no SSH, WSL, Docker, remote workspace or mobile `/remote`; no
screenshots requested in Phase 1).

Defects found on the real machine and fixed:

- The default runner's `windowsHide: true` made modern Notepad start its first GUI window hidden; the runner
  now shows the GUI explicitly.
- Modern Notepad hands the launcher PID returned by `spawn` to another child PID holding the visible window.
  The fix is the Windows-only rebind described above ("pre-launch PID snapshot + launcher full executable
  path + new post-launch PID + `applicationInfo` live re-verification + unique candidate"); an old active
  window of the same name, a same basename at a different path, multiple candidates and name-only identity are
  all locked fail-closed by RED tests.
- PID branch once sent the window title to the launcher causing a second launch; Windows `*_to_app` keyboard
  handlers once returned unavailable before verifying the foreground PID for lack of the macOS per-pid
  primitive. Now a PID only resolves/activates an existing process with double confirmation, and Windows
  keyboard goes to global `SendInput` only after UIA proves `app_ref.pid` is the unique foreground app.
- Smoke fixtures had two Windows PowerShell 5.1 compatibility problems: Dispatcher delegates under StrictMode
  cannot rely on local HWND/window/timer closures (now script-scope live HWND/window/timer), and UTF-8
  no-BOM + LF Chinese comments may be misread by 5.1 as the ANSI code page, swallowing the newline (both WPF
  fixtures keep a UTF-8 BOM regression assertion). The minimize signal is confirmed only after `IsIconic(HWND)`
  is true, never by "signal consumed".

Retained results: the official plugin live smoke (Managed Host injecting socket/token/authority,
`__zcode-plugin-host` initializing the `zcode-cua` MCP and listing 30 tools; `list_apps`, shell-less
`open_application(notepad.exe)`, screenshot-less UIA `get_app_state`; element-target click, `type` verified by
refreshed UIA state; `Ctrl+A` followed by read-only re-observation without replaying the action; replacement
`type` verified); no token or full pipe in log scans; real `WindowsCuaHelperHost` recovery (generation 1 child
terminated after exact PID/parent/executable/entry checks and the old pipe refused; generation 2 with rotated
pipe and token but identical `pluginAuthority`; child exit after final `stop()`; no orphans after source
ZCode closes). Native text clipboard (`CF_UNICODETEXT`, independent 250ms mutex budget, `8x10ms` bounded
`OpenClipboard` retry, 8 Mi UTF-16 code units cap; no PowerShell/external command/Electron fallback). The
first clipboard live smoke on a locked desktop (foreground `LockApp`, `OpenClipboard(NULL)` access denied)
cannot count as a pass and no gate was relaxed; re-verified on an unlocked ordinary interactive desktop, the
pointer and clipboard smokes pass and restore the cursor and original text (clipboard evidence proves only
text-clipboard closure, not images or files). WGC visual loop, canonical 30-tool surface and clipboard
companion smokes all green three times in a row, with Helper/fixtures exiting 0 and no orphans.

Gates (final): zcode-cua Windows focused 16 files / 158 tests, full 122 passed / 6 skipped files, 2105
passed / 67 skipped / 18 todo tests; native rebuild, build, typecheck, lint exit 0; ZCode focused integration
4 files / 175 passed / 1 skipped; `pnpm --filter @zcode/zcode-cua-plugin test` 6 tests; main-repo typecheck and
lint exit 0; `pnpm exec vitest run packages/services/test/cua` 38 files / 788 passed / 35 platform skips / 2
todo.

Open items and limits:

- **provider-driven Notepad task not accepted (`BLOCKED/NEEDS_CONTEXT`).** Two source-desktop tasks, each
  sending one full Notepad instruction (`sess_049c964a-c225-4e7f-8147-dcdd53a24c4f` and
  `sess_70f5f0a4-f1de-4bda-9840-e9693cb6e3da`), were rate limited by the provider before the first tool call
  (`tool_use=0`, `tool_result=0`, "The service is currently rate limited. Please retry later."); Notepad
  never started and no write action was dispatched. A direct official-plugin smoke must not be passed off as
  model-task success, and the instruction must not be re-sent automatically.
- **`pnpm test:unit:affected` still exits 1** (13 failed files / 20 failed tests; 940 passed files / 8132
  passed tests): the failures are in pre-existing agent timing, UI timeouts, bot lock, Git/CI and desktop text
  assertions, none in CUA source or CUA test files. Windows unit-test portability work (unique named pipes per
  case; macOS `.app`/LaunchServices/codesign/`/usr/bin/unzip` and POSIX mode/symlink assertions classified by
  platform; broker round-trip/lifecycle, installer injection state machine, Helper PID evidence and
  owner/reaper pure decision logic restored as Windows-required) reduced it from 31 files / 102 tests to this
  level; the gate stays exit 1 and no repo-wide pass is claimed. Comparison on exact `bb8798db1c` showed the
  baseline failures remain at HEAD plus two non-stable full-suite-load timeouts
  (`animatedSidePanePanelLayout` 30 s, `workspaceShellRemoteMobileLayout` 15 s); a gate-owner waiver or
  independent governance of the Windows full baseline is still needed.
- Not extrapolable from source pass: official signing (Trusted Root Program CA), installer, HDR/color
  management, whether the provider actually chooses to call tools, and the non-CUA repo baseline. The Windows
  UIA worker isolation remains unfinished.

## Clean shutdown

When the desktop app closes or the dev process stops, the Host first stops accepting new work, then sends
Helper shutdown, closes the named pipe and waits for the child to exit. Confirm in Task Manager that no
leftover `windows-helper.js` Node/Electron child remains; if it does, keep the sanitized logs and stop using
that broker until the cause is fixed.
