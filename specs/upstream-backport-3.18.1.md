# Upstream 3.18.1 backport (reconstructed from the binary)

Status: in progress (2026-11-11). Lands as extra commits in the upstream 3.18.0 sync PR #402
(`sync/upstream-3.18.0`), on top of the 3.18.0 merge.

## Why reconstructed

Upstream shipped ZCode 3.18.1 (build `3.18.1.10376`, commit `9f7ab4c3`, built 2026-11-11) as a binary
only; `zai-org/ZCode` stops at `b95ebaffe` (v3.18.0). The changes below were recovered by diffing the
official `ZCode-3.18.0-mac-arm64.zip` from `cdn-zcode.z.ai` against the installed 3.18.1 app:
`app.asar` (main, host, preload, renderer, CSS) and `Resources/glm/zcode.cjs` (Node CLI). Bundles
were compared per function with identifiers normalised, so chunk renames and minifier noise drop out.

Every item is **reconstructed from minified code, not upstream source**. Root causes are inferred
from the diff, not confirmed. Names visible in the bundle (`startCliMemoryDiagnostics`,
`createMemoryDiagnosticRecorder`, `sanitizeCliMemoryDiagnostic`, `projectAllocations`, `hashBundle`,
`readOwnBundleId`, `resetMicrophoneAccess`) are reused so the real source merges with few conflicts.

**Next upstream sync:** when upstream publishes the 3.18.1 (or later) source, take upstream's
version of every file listed here and drop the reconstruction; do not merge hunk by hunk.

Shared-data names stay byte-identical to 3.18.1, because the original app runs against the same
`~/.zcode`: IPC channel `zcode:reset-microphone-access`, directory `~/.zcode/cli/memory-diagnostics`,
format `zcode-cli-memory-v1`, the `font-smoothing-enabled` class, storage keys and i18n keys.

## Items

| #   | Item                                                                                                                     | Area                           | Kind    |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------- |
| 1   | Browser element picker no longer forces the side pane into full view                                                     | ui                             | fix     |
| 2   | Mobile web back navigation keeps `zcodeMobilePage` in history state                                                      | ui                             | fix     |
| 3   | Small UI fixes: subagent badge wrapping, panel max size 65% -> 100%, popover `no-drag`, `min-w-0`, animated text refresh | ui                             | fix     |
| 4   | Microphone permission recovery guide (macOS `tccutil reset` + re-ask + relaunch, Windows settings)                       | desktop, ui                    | fix     |
| 5   | OAuth callback after polling completed; `provider` in the authorize URL                                                  | services                       | fix     |
| 6   | macOS font smoothing becomes a setting (was always antialiased)                                                          | ui                             | feature |
| 7   | Node CLI memory diagnostics (heap sampling profile, JSONL, log export)                                                   | cli, shared, services, desktop | feature |

## Behaviour after the backport

1. Selecting a design element in the browser opens the design panel only on design-tool pages and no
   longer dispatches `zcode:side-pane-full-view-enter-request`; `side-pane-full-view/enterRequest.ts`
   is deleted (3.18.1 has no reference to the event).
2. Mobile web: entering chat replaces a `home` history entry with `chat` instead of pushing a new
   one; going home replaces the chat entry and no longer calls `history.back()`; `popstate` maps
   `zcodeMobilePage === "chat"` to chat, anything else to home.
3. Origin badge wraps (`basis-full`, `[overflow-wrap:anywhere]`) and sits under the question;
   resizable side pane `maxSize` 100%; project composer menu `[app-region:no-drag]`; reasoning
   collapsible `min-w-0`; queued summary shows same-key updates immediately.
4. (Not reachable from the composer since owner decision 5 of the 3.18.0 sync, `specs/upstream-sync-3.18.0.md`: the
   composer has one mic, fork dictation, and the upstream voice input button is not rendered.) A denied microphone on
   macOS/Windows opens a permission popover instead of an error toast. macOS
   "Request again" runs `tccutil reset Microphone <own bundle id>` (packaged builds only, bundle id
   read with PlistBuddy and validated), then asks again; when macOS still reports denied the popover
   asks to restart ZCode. Concurrent resets share one in-flight request. Linux keeps the old error.
5. `zai_cn` OAuth: the relay `redirect_uri` carries `provider=zai_cn`; a code-bearing callback for a
   `zai_cn` polling flow only saves login attribution (within the generation / grace-window check)
   and never exchanges the code, because polling owns completion.
6. `-webkit-font-smoothing: antialiased` applies only on macOS desktop with the setting on (default
   on, localStorage `zcode-macos-font-smoothing`, broadcast `state:fontSmoothingEnabled`); Settings ›
   Appearance shows the switch on macOS desktop.
7. Every Node CLI process samples a V8 heap allocation profile (1 MiB interval, 25 ms budget, stops
   at 80 % of the heap limit) and writes one JSON record per tick to
   `~/.zcode/cli/memory-diagnostics/memory-<pid>-<instance uuid>.jsonl` (7-day retention, capped).
   Always on, no switch, as in 3.18.1. Log export and the feedback archive include up to 16 of those
   files (64 KiB each), re-sanitised; the archive therefore carries pid, instance id, bundle sha256 and
   bundle function names with line/column (`docs/monitoring/memory-diagnostics-log.md`).

Tests: `desktopMicrophoneAccessReset`, `voiceInputFailureNotice`, `oauthPollingCallback`,
`fontSmoothingSync`, `cliMemoryDiagnostic`, `feedbackLogArchive.cliMemory`,
`memory-diagnostics-recorder`, `memory-diagnostics-writer` (fork manifest). Items 1–3 have no unit
tests; they are UI-only and not yet checked in a running app.

## Not portable

Prebuilt binaries changed too (cua-helper app, `rg`, `ugrep`, `bfs`, `zcode-window-bounds`, sharp,
node-pty, keyring, koffi); they are rebuilt artefacts and not part of the source. Item 7 is Node CLI
only: the Rust CLI (`packages/rust-cli`) gets no equivalent in this backport.
