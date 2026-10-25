# BUG-GWT-002: Review pane / change counter does not update by itself on external file changes (60-second self-resetting debounce)

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)

- Severity: S3 (workaround: manual Refresh; UX degradation of stale status for a minute or more)
- Cases: A7 (main; FAIL 0/2), B2 (echo: dirty warning appeared only after reload), F2 (echo: change counter stale until the panel was reopened)
- Environment: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (branch `qa/git-worktree-20261017`), isolated QA instance (production build, sandbox HOME)

## Repro from scratch

1. Fixture R1 `basic` (`$QA_ROOT/bin/make-fixtures.sh R1`; clean `main`).
2. Open `$QA_ROOT/repos/basic` as a project in the QA app (`qa-run.sh "$ELECTRON_BIN" . --open-workspace=…`), Review pane open, status clean ("No changes are available").
3. From outside, append a line to a tracked file: `"$QA_ROOT/bin/qa-run.sh" bash -c 'echo "probe line" >> /Users/<user>/.zcode-git-qa/<run>/repos/basic/src/app.txt'`
4. Watch the Review pane and the host log tail (`$QA_ROOT/home/.zcode/v2/logs/<date>.log`, count of `git.refresh OK` lines).

## Expectation

- Case A7: "a file changed from outside (qa-run.sh) -> the Review pane updates by itself, without a manual refresh" (`$QA_ROOT/cases/A7.md`).
- The chain design documented in code: 150 ms debounce on the watcher (`packages/services/src/fileWatcher/fileWatcherService.ts:10`) + 350 ms Git debounce on the renderer (historical note in the comment at `packages/ui/src/hooks/useGitAutoRefresh.ts:13-14`). Manual refresh takes about 1-2 s — auto refresh must land within seconds.
- Note: `specs/review-reliability-fixes.md` does not govern auto-refresh timing (case A7's reference to it is nominal); the expectation here comes from the case definition and the code's own design.

## Fact

- Over 45 s (probe 1) plus another appended line plus 10 s of log control (probe 2) the panel did NOT update once: "No changes are available" while git sees `1 .M src/app.txt`.
- The `git.refresh OK` counter in the host log over the observation window was 44 -> 44: the RPC was not called at all.
- The watcher was registered: `file-watcher.watch OK` x2 at 19:07:56.986 (workspace root recursive + `.git`), the `file-watcher.onDynamicChange` subscription was made, no `[GitAutoRefresh]` errors/warnings in the log.
- Manual Refresh immediately shows `src / app.txt +1−0` — data and path are correct; only the automatic trigger is broken.
- The B2 and F2 echo effects agree: the stale state lives until reload/reopen, longer than any observed window.

## Evidence

- Case protocol and timeline: `$QA_ROOT/cases/A7.md` (no A7 screenshots — verdict from UI polling plus the log counter; git ground truth inside the case).
- Host log: `$QA_ROOT/home/.zcode/v2/logs/2026-10-17.log` — `file-watcher.watch OK` x2 at 19:07:56.986; `git.refresh OK` at 19:07:56.982 (44th) and afterwards only at manual/navigation refreshes (19:08:11.002, 19:09:36.293, 19:09:53.149).
- B2: `$QA_ROOT/evidence/B2-1-dirty-cue.png` … `B2-3-dirty-cue.png`; F2: `$QA_ROOT/evidence/F2-1-changes.png` … `F2-3-after-commit.png`.

## Cause

Confirmed:

- `packages/ui/src/hooks/useGitAutoRefresh.ts:15` — `GIT_AUTO_REFRESH_DEBOUNCE_MS = 60_000`: auto refresh is delayed by 60 s.
- `packages/ui/src/hooks/useGitAutoRefresh.ts:110-121` — `scheduleRefresh` does `clearTimeout` + a new `setTimeout(60 000)` on EVERY event: refresh fires only after 60 s of complete filesystem silence. The A7 observation window of 45+10 s is < 60 s, and the second append (~T0+45 s) reset the timer again -> 0 `git.refresh` calls. Under any activity more frequent than once a minute the refresh is postponed indefinitely (starvation), including the agent's batch writes the delay was introduced for.
- Aggravating (same cause): the effect cleanup `packages/ui/src/hooks/useGitAutoRefresh.ts:160-165` kills an unfinished 60-second timer on any effect rerun/unmount (panel/tab/workspace switch) — in B2/F2 the wait was also cancelled by navigation.
- The rest of the chain is intact and confirmed: host watcher `fs.watch(recursive)` with 150 ms debounce (`packages/services/src/fileWatcher/fileWatcherService.ts:10,63-88`) registers (`watch OK` x2), the event is delivered by the `onDynamicChange` subscription into `scheduleRefresh`, and `onRefreshGit` -> `handleRefreshGit` (`packages/ui/src/App.tsx:475-481`) -> `setGitRefreshVersion` -> RPC `git.refresh` — the manual path works. Existing tests `packages/ui/test/gitAutoRefresh.test.ts` and `packages/ui/test/useGitAutoRefresh.test.ts` cover only watch-path selection, not the delay.

Hypothesis: end-to-end delivery of a concrete fs event over RPC at echo time was not traced directly (QA app stopped); but the subscription is registered, there are no errors, and the confirmed code cause is enough for all observed facts (55 s < 60 s).

## Proposed fix

Renderer layer, `packages/ui/src/hooks/useGitAutoRefresh.ts` (product code was not changed — by assignment):

- Return the Git debounce to the project's sub-second range (350 ms), or, if protection against agent batch writes is needed, replace "trailing debounce with full reset" with throttle/leading-edge (first event refreshes, then a cooldown), so continuous activity cannot starve the refresh and cleanup on panel switch does not cancel the update forever.
- Update the comment/documentation to the chosen semantics; leave the host-side 150 ms debounce untouched.

## Test

- File: `packages/ui/test/gitAutoRefreshExternalChange.test.ts` (new; unit test of the `useGitAutoRefresh` hook; mocks only the RPC boundaries `fileWatcherService`/`systemService`, the auto-refresh git logic is real; `vi.useFakeTimers`, no sleep; self-contained, no `$QA_ROOT` dependency). The name `gitAutoRefresh.test.ts` is taken by the upstream path-selection test, hence this file name.
- Red run without the marker (`it("refreshes Git shortly after an external change event reaches the renderer")`) failed with `AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times` at `packages/ui/test/gitAutoRefreshExternalChange.test.ts:97:26` (`expect(onRefreshGit).toHaveBeenCalledTimes(1)`). Preconditions in the same run passed: `watch` called with `{ path: "/repo", recursive: true }`, listener subscribed — the failure is the bug's assertion, not setup.
- With the marker `it.fails("BUG-GWT-002: refreshes Git shortly after an external change event reaches the renderer")`: 3 files passed, 9 tests passed | 1 expected fail. The test turns red once the debounce is returned to a sub-second/correct mode — then the marker can be removed.
