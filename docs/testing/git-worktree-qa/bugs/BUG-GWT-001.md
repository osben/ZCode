# BUG-GWT-001: Opening a folder with spaces + unicode through a second instance (`--open-workspace`) deterministically kills the PRIMARY app (Electron process singleton)

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)

- Severity: S2 (the whole app crashes on the only programmatic project-open path; workarounds — native folder dialog or an ASCII path — not verified; a related defect: a hung second instance blocks restart)
- Cases: A6 (FAIL 2/2; status/diff/branches for R7 not verified — the project never opened)
- Environment: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (branch `qa/git-worktree-20261017`), isolated QA instance (production build, sandbox HOME), Electron 41.0.3 (`packages/desktop/package.json:111`)

## Repro from scratch

1. Fixture R7: `"$QA_ROOT/bin/make-fixtures.sh R7"` -> `$QA_ROOT/repos/проект с пробелами ü` (branches `main`/`feature/a`/`release`).
2. Start the QA app (M 2.7): `"$QA_ROOT/bin/qa-run.sh" "$ELECTRON_BIN" . --remote-debugging-port=9339`, wait for the port.
3. Open the project with a second instance (M 3.6): `cd "$REPO/packages/desktop" && "$QA_ROOT/bin/qa-run.sh" "$ELECTRON_BIN" . --open-workspace="$QA_ROOT/repos/проект с пробелами ü"`
4. Result: the primary app dies the same second (CDP 9339 stops answering, window closes); `$QA_ROOT/logs/electron.log` has `[ERROR:chrome/browser/process_singleton_posix.cc:779] additional_data_size exceeds payload length`.
5. Repeating after an app restart gives the same crash within 2 s (2/2). The hung second instance ("ZCode QA") holds the singleton userData; new launches exit silently until it is killed.

## Expectation

- Case A6: "status, diff, branches work for a project with spaces/unicode in the path" (`$QA_ROOT/cases/A6.md`; spec: `docs/git/branch-switching-service-design.md` — the git service works on `workspacePath` with no path-character restrictions).
- M 3.6 of QA-PROMPT: a second instance with `--open-workspace=<absolute path>` is the standard way to open a folder; a path with spaces/unicode is a valid macOS path.
- Electron API (`app.requestSingleInstanceLock(additionalData)` / `second-instance`): `additionalData` is an arbitrary serializable JS object; string values with any Unicode characters and spaces are legal and must reach the primary instance without destructive side effects.

## Fact

- Both attempts: the primary app (pid 55507, then 77796) dies right after the second instance starts; `electron.log` shows `process_singleton_posix.cc:779 additional_data_size exceeds payload length` twice (lines 27101, 28538).
- The second instance (pid 77918) stays alive, holds the singleton userData and blocks restart: a new instance (78022) exits silently. After killing the tree the app came up (pid 90773) and the session was restored.
- R7 Git state unchanged (the project never opened). Status/diff/branches in the UI for R7 not verified.
- What does NOT reproduce the crash (byte-level simulation of the mechanism): a path with spaces only and no non-Latin-1 characters; a path with unicode only and no spaces.

## Evidence

- Case protocol: `$QA_ROOT/cases/A6.md` (timeline, pids, 2/2).
- Crash lines: `$QA_ROOT/logs/electron.log:27101` (pid 55507) and `:28538` (pid 77796).
- Recovery screenshot: `$QA_ROOT/evidence/A6-3-app-restarted.png`.

## Cause

Confirmed (our layer is correct; the defect is entirely inside Electron 41 / the patched Chromium `process_singleton_posix.cc`):

- Our code builds the second-instance data correctly: `packages/desktop/src/main/index.ts:2183` calls `app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv))`; `packages/desktop/src/main/desktopDeepLinkUrl.ts:251-258` puts the path into `additionalData.openWorkspacePath` (object `{ openWorkspacePath: "<path>" }`). This is documented API use.
- Electron serializes `additionalData` with the V8 ValueSerializer (`blink::CloneableMessage`, `shell/browser/api/electron_api_app.cc`, `RequestSingleInstanceLock`) and sends it over the singleton socket as `...\0<additional-data-size>\0<raw bytes>`.
- The primary tokenizes the whole message with upstream Chromium code: `chrome/browser/process_singleton_posix.cc`, `SocketReader::OnSocketCanReadWithoutBlocking` -> `base::SplitString(str, std::string(1, '\0'), base::TRIM_WHITESPACE, base::SPLIT_WANT_ALL)` — every token is trimmed of whitespace bytes at both ends. The Electron 41 patch (`patches/chromium/feat_add_data_parameter_to_processsingleton.patch`) then joins tokens back with `\0` and checks `if (additional_data_size > remaining_args.size()) LOG(ERROR) << "additional_data_size exceeds payload length"` — line 779.
- Corruption mechanism (verified empirically with Node `v8.serialize`, the same ValueSerializer, plus a simulation of `TRIM_WHITESPACE` tokenization and re-join): the R7 path contains Cyrillic (characters > U+00FF), so V8 serializes the string as two-byte UTF-16LE where each ASCII char is `XX 00` and each space is `20 00`; the `0x20` byte sits next to the `\0` separator and is TRIMMED. For the exact R7 path the declared size is 166 bytes and after the parser round-trip 163 (exactly 3 spaces lost) -> the check at line 779 fires -> the notification is dropped and the primary sends no ACK -> by POSIX singleton semantics the second instance treats the primary as hung, kills it and takes the singleton (observed: primary dead within 2 s; hung second holds userData; new instances exit silently).
- Isolating spaces vs unicode (same simulation): ASCII+spaces only — one-byte blob, no NULs, no loss (NO crash); unicode without spaces — NULs present but none adjacent to a whitespace byte, no loss (NO crash). The trigger is the combination: at least one character > U+00FF (forces two-byte serialization) AND at least one ASCII space. Results: `R7 exact: declared=166 received=163 -> CORRUPT`; `ASCII only with spaces: 60/60 intact`; `Unicode, no spaces: 78/78 intact`; `/Users/osben/про ü: 62/61 CORRUPT`.
- This is a known Electron bug fixed upstream: electron/electron#52020 (symptoms identical down to line 779), fix electron/electron#52025 (`TRIM_WHITESPACE` -> `KEEP_WHITESPACE`), merged 2026-07-27, backported to 42/43/44-x-y and NOT backported to 41-x-y (verified: the `41-x-y` branch patch has 0 occurrences of `KEEP_WHITESPACE`; `main` has it, patch lines 252-253).

Hypothesis (not verified at app level — the QA app was stopped in this session): the exact behavior of the second instance in the 41.0.3 binary (whether it obtains the lock after killing the primary or hangs midway) was inferred from observed effects and the match with #52020, not from tracing the second instance. Workarounds (native dialog / renaming to ASCII) were not tested.

## Proposed fix

- Main: upgrade Electron from 41.0.3 to >=42.x containing electron#52025 (check release notes that the fix landed in the specific minor).
- App-side alternative if the upgrade is blocked: in `createDeepLinkSingleInstanceData` (`packages/desktop/src/main/desktopDeepLinkUrl.ts`) encode the path (for example `encodeURIComponent`/base64) and decode it in `extractOpenWorkspacePathFromSingleInstanceData`; the V8 blob then stays one-byte with no whitespace bytes at `\0` boundaries and the bug does not trigger. Test by round-trip `extractOpenWorkspacePathFromArgs([`--open-workspace=${encoded}`])` (unit layer, modeled on `packages/desktop/test/desktopDeepLinkUrl*.test.ts`).
- Related: robustness against "the second instance killed the primary and holds the singleton" goes away after the upgrade; do not fix it separately (Chromium behavior).

## Test

- Path: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-open-workspace-unicode-singleton.test.ts` (tag `BUG-GWT-001` in a comment; kept in `pending` per `.agents/skills/e2e-case-lifecycle/SKILL.md`).
- Layer: E2E (WDIO, launching a second app instance from the spec). The cause is entirely inside the patched Chromium/Electron `process_singleton`, so it is not reproducible at unit level on our code (our `createDeepLinkSingleInstanceData`/`extractOpenWorkspacePathFromSingleInstanceData` behave correctly; the defect appears only in the real Electron inter-process handshake).
- Status: **not run (E2E pending)** — WDIO did not run in the QA session. The red app-level run is recorded by case A6 itself (FAIL 2/2).
