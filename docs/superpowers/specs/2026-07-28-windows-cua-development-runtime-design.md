# Windows CUA Source Development Runtime Design

> Date: 2026-07-28
>
> Status: confirmed
>
> Scope: Windows local desktop source-development environment
>
> Related repositories: `z-code`, `C:\Users\dev\zcode-cua`

## 1. Background

ZCode's current Computer Use product chain is mainly macOS:

```text
ZCode Host
  -> install, verify and start a separate Helper.app
  -> generate socket + bearer token
  -> inject credentials into the official zcode-cua plugin
  -> plugin exposes tools to the Agent via MCP
  -> Helper.app executes via AX / ScreenCaptureKit / CGEvent
```

The external `@zcode/zcode-cua` repository already contains Windows UIA, a named pipe, basic `SendInput`
click/keyboard and some element semantic actions, but no complete runtime chain for the ZCode local desktop
exists yet:

- the ZCode default Product Helper allows only `darwin`;
- Windows standalone wrongly enters the macOS Helper launch logic;
- there is no loadable `ax_native.node` in the current installation;
- Windows screenshot, clipboard, app launch and the full mouse actions are not closed;
- UIA collection can still synchronously block the V8 main thread;
- coordinate input is mainly computed from the primary display and does not fully cover the virtual desktop and
  mixed DPI;
- Windows tests still mix in POSIX path, Unix socket and file mode assumptions.

This design first solves "the source-development environment really runs", and does not address installers,
prebuilt binaries, code signing, auto-update or formal release in the same milestone.

## 2. Process and target verification principles

The Windows Helper is a separate native process started on demand and watching `--parent-pid`; the pipe name
contains a random UUID and the Helper and pipe exit together after the last client closes. Screenshots use
Windows Graphics Capture (occluded windows supported); input is bound to an explicit window and verifies
window, bounds, screenshot and user input state; UIA element indexes are bound to the current observation
snapshot; a physical Escape can interrupt the current Computer Use turn. The implementation reuses no
third-party proprietary binary or undisclosed protocol.

## 3. Goals

The first milestone must achieve:

1. In the interactive desktop of a logged-in Windows user, build and load `ax_native.node` from source.
2. The ZCode local Host starts a separate Windows Computer Use Helper on demand.
3. The Host generates a random named pipe and bearer token and injects them only into the official CUA plugin.
4. Only after the Helper is ready can the official plugin start the MCP server; when the Helper is unavailable
   it fails closed.
5. The Agent can complete in ordinary desktop apps such as Notepad:
   - app and window enumeration;
   - UIA tree observation;
   - window activation;
   - element or window coordinate click;
   - text input and shortcuts;
   - supported UIA semantic actions.
6. When the Helper crashes or exits, or ZCode or the client closes, no orphan process that still accepts
   requests is left.
7. A Windows source-development failure must give a diagnosable cause and never silently disguise a native
   build or load failure as success.

Later milestones on the same architecture (see §14): WGC, window snapshots and stale action protection, full
mouse actions, multi-monitor/negative coordinates/mixed DPI, clipboard and app launch, UIA worker/cancel/timeout,
and Chinese/emoji/key-combination/focus verification.

## 4. Non-goals

This phase explicitly excludes:

- SSH, WSL, Docker or any remote workspace CUA;
- mobile Web remote control or the replayable realtime chain;
- Windows installers, prebuilt addons, code signing, SmartScreen, auto-update;
- macOS Helper install, TCC, signing or notarization changes;
- Linux AT-SPI or Linux broker host changes;
- Windows permission settings UI or app-level authorization UI;
- reusing, calling or redistributing third-party proprietary Computer Use binaries;
- changing the names of the existing 30 MCP tools;
- building a Host capability router that bypasses the Broker.

## 5. Core decisions

### 5.1 Separate Windows Helper

Windows uses a separate Helper child process, not the ZCode Host business process, the Agent main process or
the official CUA MCP plugin process: a native crash cannot take down Host services, UIA blocking cannot block
the Agent MCP stdio, lifecycle and credential injection reuse the macOS control plane, and a later migration
from the Node Helper to SEA or a signed native executable leaves the upper-layer protocol unchanged. The
first-phase form is a Node.js child process with the `@zcode/zcode-cua` broker/server and `ax_native.node`; the
MCP plugin and Agent must not need to notice a later replacement.

### 5.2 The Host manages only lifecycle and credentials

The ZCode Host decides whether the local Windows development state is enabled, resolves the controlled local
`zcode-cua` source root, starts/stops/health-checks the Helper, generates pipe, token and capability
generation, injects credentials only into the official CUA plugin authority, stops an invalidated generation's
old credentials from entering a new Agent, and recovers through the existing active-turn and Agent recycle
boundaries. It is not responsible for UIA collection, screenshots, mouse/keyboard injection, HWND/element
token/screenshot revision management or interpreting CUA tool arguments; all of that stays in the
`zcode-cua` Helper/backend.

### 5.3 Windows Graphics Capture

Screenshots use `Windows.Graphics.Capture` (`Direct3D11CaptureFramePool.CreateFreeThreaded` ->
`ID3D11Texture2D` / `SoftwareBitmap` -> BGRA buffer or encoded image -> the existing zcode-cua image
pipeline), never `BitBlt`, PowerShell `System.Drawing` or external commands as the formal main path. If WGC is
not finished, the first milestone allows the UIA loop with `includeScreenshot=false`, but the screenshot
capability must truthfully report unavailable and never return a fabricated or blank success.

### 5.4 Window-level input

Every window-level action resolves to `WindowIdentity { pid, hwnd, processPath?, title?, bounds }` and,
before execution, verifies: the HWND still exists and belongs to the same pid; the target is not a lock
screen, non-interactive desktop or rejected high-integrity process; the bounds have not left the range of the
current observation; the window-space to virtual-desktop-space mapping is correct; and the window can be
safely activated or is already the expected foreground window. A failure asks for a re-observation and never
sends input to whatever app happens to be in the foreground.

### 5.5 Observation snapshot

`state_id` is progressively strengthened into a Windows observation revision
`ObservationSnapshot { stateId, revision, windowIdentity, accessibilityRevision?, screenshotId?,
screenshotBounds?, capturedAt }`. An element index is valid only within the accessibility revision that
generated it, and screenshot/state-image coordinates only within their screenshot revision; after an action
that may change layout, focus or modal state the old revision is not used for the next action; stale, unknown
or window-mismatched state fails closed with a "re-observe" diagnostic; a post-write transport failure keeps
`possibly_sent` and is never auto-replayed.

## 6. Runtime architecture

```text
ZCode renderer / Agent request
             |
             v
ZCode local Host Process
  WindowsCuaHelperHost
    - local-only admission
    - child lifecycle
    - pipe/token generation
    - health + generation
             |
             | spawn
             v
Windows Computer Use Helper (Node child)
    - CuaPermissionBrokerServer
    - named pipe server
    - ax_native.node
    - UIA worker
    - WGC capture worker
    - SendInput actuator
             ^
             | authenticated broker RPC
             |
official zcode-cua MCP plugin
             ^
             | MCP stdio
             |
ZCode Agent
```

Forbidden paths:

```text
UI -> native addon
UI -> Repo
Host service -> concrete UIA implementation
remote Host -> local Windows Helper
ordinary MCP server -> broker credentials
```

## 7. Startup sequence

```text
ZCode local Host starts
  |
  |-- platform == win32?
  |-- ZCODE_CUA_PRODUCT_HELPER enabled?
  |-- local host only?
  |-- official CUA plugin enabled for workspace?
  |-- ZCODE_CUA_DEV_ROOT resolves to allowed source root?
  |
  | no -> no Helper, no credentials, no CUA MCP injection
  |
  ` yes
      -> build/runtime preflight
           - dist Helper entry exists
           - ax_native.node exists and loads
           - interactive user desktop available
      -> mint random pipe + token
      -> spawn Helper with parent pid and controlled environment
      -> Helper reads token without exposing it in logs
      -> Helper binds pipe
      -> Host authenticates and calls broker_info
      -> validate pid/platform/capabilities/version
      -> publish credential generation
      -> official plugin host receives canonical broker argv/env
      -> MCP server starts
      -> Agent sees CUA tools
```

Before the Helper passes the health check, the Agent must not be exposed to a CUA server that can start but
cannot connect.

## 8. Lifecycle state machine

```text
DISABLED
   |
   | enable + local Windows admission
   v
STARTING ---- preflight/spawn/health failure ----> FAILED
   |                                            |
   | health verified                            | explicit retry/restart
   v                                            |
READY ------------------------------------------+
   |
   | app exit / manual restart / credential invalidation
   v
DRAINING
   |
   | stop admission -> settle admitted calls -> close pipe -> child exit
   v
STOPPED
```

Constraints:

- At most one Windows Helper generation per Host lifecycle at a time.
- STARTING/READY use singleflight.
- FAILED keeps no injectable old tuple.
- Only READY can return resolver credentials.
- After DRAINING, new actions are rejected.
- If the connection drops after an action was written to the broker, it is still handled as `possibly_sent`.
- When the ZCode Host exits it stops admission first, then ends the Helper.
- The Helper watches the parent pid and exits by itself once the parent process disappears.
- On stop or restart, all keys and mouse buttons pressed by this Helper must be released.

## 9. Development-state source directory

An explicit development configuration:

```text
ZCODE_CUA_DEV_ROOT=C:\Users\dev\zcode-cua
```

Semantics:

- Read only when `win32` + local Host + Product Helper is explicitly enabled.
- Must resolve to an absolute, existing directory.
- Must contain the expected `package.json`, Helper entry and native build artifacts.
- The path is used only for code/build artifact resolution, not as workspace identity.
- Not written into user workspace configuration.
- Must not be passed through by a remote host.
- When unset or invalid, returns an explicit development diagnostic and does not fall back to the macOS Helper.
- The formal product build does not depend on this variable.

Suggested development commands:

```text
cd C:\Users\dev\zcode-cua
pnpm install
pnpm build
pnpm rebuild:native

set ZCODE_CUA_PRODUCT_HELPER=1
set ZCODE_CUA_DEV_ROOT=C:\Users\dev\zcode-cua
pnpm dev:desktop
```

The actual script names may be adjusted at implementation time, but the configuration boundary and fail-closed
semantics must not change.

## 10. Windows native/backend design

### 10.1 UIA thread

COM/UIA runs on a separate MTA worker; the Node/V8 main thread only validates arguments, queues and completes
Promises. Every request carries a deadline or cancellation signal; large UIA trees have node-count, depth,
text-length and time budgets; Helper close waits for or cancels workers (no destroyed N-API handles); element
tokens are bound to the snapshot/revision with a capacity cap and eviction policy.

### 10.2 Input execution

Virtual desktop coordinates (`SM_XVIRTUALSCREEN`, `SM_YVIRTUALSCREEN`, `SM_CXVIRTUALSCREEN`,
`SM_CYVIRTUALSCREEN`, `MOUSEEVENTF_VIRTUALDESK`) with explicit conversion at the physical/logical boundary;
the target HWND/PID is verified before each input; activation failure, UIPI refusal or a non-interactive
session fail closed; `hold_key`, drag and mouse-down/up have termination cleanup and release input state first
on a user or stop interruption.

### 10.3 Windows system surface

The Windows system surface is ultimately responsible for:

- app launch;
- clipboard read/write;
- window screenshots;
- screen/display information;
- cursor information.

Windows must not fall into the macOS `screencapture`, `pbcopy`, `open` command paths by default.

## 11. Broker and security boundary

The source-development phase keeps: random named pipe; high-entropy bearer token with constant-time
comparison; official plugin authority restriction; env sanitation for ordinary tool subprocesses; token log
redaction; Helper generation; action delivery state; interactive-session and UIPI checks. It does not claim to
have completed a current-user-only named pipe DACL, Windows executable signing, installer identity
verification, SmartScreen or app-level user authorization; diagnostics and docs must state these as unfinished
and never describe the state as "Windows security complete". The bearer token must not appear in logs, error
messages, telemetry, process title or copyable UI text; prefer a one-shot token or controlled inheritance, and
never a plain argv.

## 12. Errors and recovery semantics

| Scenario                          | Required behavior                                           |
| --------------------------------- | ----------------------------------------------------------- |
| Visual Studio C++ toolchain missing | build fails with a clear dependency hint                  |
| `ax_native.node` missing          | dev preflight fails, no silent `available=false`            |
| addon ABI mismatch                | print the Node ABI, addon path and rebuild hint             |
| non-interactive session / locked screen | Helper unavailable, no input injected                 |
| Helper start timeout / health check fails | terminate this child, clean the pipe, publish no tuple, inject no credentials |
| Helper disconnects after action   | `possibly_sent`, no automatic retry                         |
| HWND/PID/revision stale           | re-observe diagnostic, execute no input                     |
| UIPI refuses a high-privilege app | explicit permission denied, no automatic elevation          |
| Helper crash                      | generation invalidated, recover via the existing active-turn/recycle boundary |
| ZCode closes                      | stop admission, release input, close pipe, exit the child   |

## 13. Repository responsibilities

- **`z-code`**: Windows local Helper admission; `WindowsCuaHelperHost` lifecycle; dev root resolver; credential
  injection; active-turn/restart/recycle integration; Windows Host tests; development startup instructions.
- **`zcode-cua`**: Windows Helper CLI/entry; named-pipe broker host; strict `ax_native.node` build and load; UIA
  worker; WGC screenshot; window identity / revision; Windows system surface; input and multi-monitor
  coordinates; cross-platform test fixes; native and live desktop acceptance.
- **Official `zcode-cua-plugin`**: stays a broker-only thin shell that fails closed without socket/token,
  starts no second Windows broker, and changes only Windows artifact names and tests if necessary.

## 14. Phased implementation

### Phase 0: build and test baseline

Complete the Windows C++ build prerequisites docs and checks; make native build failure fail explicitly in dev
commands; fix the undeclared lint dependency and the POSIX path/Unix socket test assumptions; make missing-addon
tests skip or fail explicitly instead of null-dereferencing; keep macOS/Linux test semantics.

### Phase 1: development-state runtime loop

Windows Helper entry; on-demand separate child; named pipe + token + health; official plugin credential
injection; UIA list/capture; window-bound click, input, key and supported semantic actions; Notepad live smoke;
stop/restart/orphan cleanup.

### Phase 2: vision and full pointer

WGC window capture; screenshotId/revision; `state_image`/window coordinate mapping; move, scroll, drag,
mouse-down/up; virtual desktop, multi-monitor, negative coordinates, DPI; clipboard, launch app.

### Phase 3: reliability

UIA MTA worker, deadline, cancel; stale token LRU; foreground/bounds/user-input guard; physical Escape or an
equivalent interruption; CJK, emoji, dead key, keyboard layout; modal, minimized, occluded window;
high-integrity app and lock-screen behavior; named pipe DACL.

### Later product loop

Prebuilt x64/arm64 artifacts; SEA or native Helper; installer staging; signing, version, hash and identity
verification; release CI and Windows hardware gates; user settings and readiness UI.

## 15. Acceptance

### Automated

`zcode-cua`:

- `pnpm typecheck`
- `pnpm lint`
- Windows platform/path/pipe/native targeted tests
- broker delivery-state tests
- Helper lifecycle tests
- Windows screenshot/input contract tests

`z-code`:

- `pnpm typecheck`
- `pnpm lint`
- services Windows Helper host tests
- official plugin credential injection tests
- Agent recycle/generation regression tests

Platform-specific tests must be classified explicitly. macOS POSIX mode, Unix socket or `.app` tests may be
skipped on Windows for an explicit reason, but platform-neutral tests must not be skipped wholesale to get a
green result.

The Broker's live transport tests must use an address the current platform really supports: Windows uses a
per-case unique `\\.\pipe\zcode-cua-test-<random>` named pipe, macOS/Linux use a Unix socket in a controlled
temp directory. The platform-neutral contracts of authentication, NDJSON, dispatch, timeout and graceful-stop
must keep running on the Windows named pipe; only the `0600/0700`, symlink, stale-file and unlink assertions
that depend on a socket file node may be skipped on Windows, and a separate Windows named-pipe branch test
guards the boundary "must not touch POSIX file system nodes".

### Windows hardware

In a logged-in user Session verify: Helper appears on demand; the Agent sees the official CUA tools; enumerate
Notepad, get the UIA tree, click the edit area and confirm the target HWND; type Chinese, English and emoji;
`Ctrl+A`, replace text and Enter/Tab; operate a button or menu through a UIA action; restart the Helper and
re-establish the generation; after closing ZCode no Helper remains; after Phase 2 verify occluded window
screenshots and the secondary display, negative coordinates and different DPI. Record Windows version, Node
version and ABI, addon architecture, ZCode and zcode-cua commits, test app, whether the session is local
interactive, failure log path and uncovered scenarios.

## 16. Compatibility constraints

- The macOS `desktop-continuous` main chain is unchanged.
- The Web remote replayable chain is entirely outside this design.
- The local/remote decision must be made before Helper admission.
- Do not mix `workspaceIdentity` and `workspacePath`.
- Do not change the Agent/App `@zcode/protocol` unless a new cross-process product protocol really appears.
- Broker method/schema changes are validated strictly inside `@zcode/zcode-cua` and keep old calls compatible.
- IO uses async APIs.
- services logs use `createServiceLogger(scope)`.
- UI is not in this phase; if `packages/ui` is later modified, `DESIGN.md` must be read before implementation.

## 17. Risks

1. Toolchain: the current machine lacks the Visual Studio C++ workload, blocking native hardware verification.
2. ABI: system Node, ZCode bundled Node and Electron ABIs may differ; the standalone Node Helper must state
   which runtime it uses and build for that ABI.
3. UIA blocking: the current synchronous BFS may hang the Helper and needs worker isolation.
4. Screenshot complexity: WGC involves WinRT, D3D11, window close and device rebuild and is not a small patch.
5. Focus contention: `SetForegroundWindow` alone cannot prove the input target is correct.
6. Test debt: many tests hard-code macOS/POSIX assumptions; a Windows green baseline needs classification first.
7. Version drift: the compile-time `@zcode/zcode-cua`, the Helper runtime alias and the plugin version are not
   fully consistent; record the actual server/client versions.

## 18. Confirmed and open items

Item 1 was confirmed by this resolver contract; the other questions are left for spikes/tests in the
implementation plan and do not change this design's process boundary:

1. **Confirmed: the Windows dev Helper uses the current process's Node runtime.** The resolver fixes
   `command = process.execPath` and sets `ELECTRON_RUN_AS_NODE = "1"` in the child environment. The Desktop
   Host already uses the same pattern for zcode-agent; for the CLI/test host `process.execPath` naturally
   points to Node. `ax_native.node` is an N-API addon and must be rebuilt on the target Windows machine for
   that runtime. This resolver stage does not inject the broker token.
2. Whether the WGC native layer returns a BGRA buffer or directly a JPEG/PNG.
3. Whether the existing `state_id` can be extended compatibly into a revision or a new field is needed.
4. What minimal ACL implementation the one-shot token file uses in the Windows dev phase.
5. Whether physical Escape goes in Phase 2 or Phase 3.

The default principle is to choose the smallest implementation that can still be productized, and close the
open items after obtaining runtime evidence through TDD/spikes.
