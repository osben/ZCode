# BUG-GWT-013: destination chip does not appear after a programmatic workspace open (qa-open / --open-workspace): the lost initial git refresh is never retried

- Status: FIXED (fix wave 2, 2026-10-18: unit + live confirmed in RT2; marker removed)
- Severity: S4 (cosmetic/feature availability; recoverable by renderer reload or clicking the project; FLAKY: initialization race)
- Cases: A2, A4 (repeat observations: B1-0, warn in the H block)
- Environment: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (branch `qa/git-worktree-20261017`), isolated QA instance (production build)

## Repro

1. Fixtures R2 (`empty`) and R5 (`detached`) per QA-PROMPT §4; QA app running (§2.7) with some workspace (R1) already open and showing the chip "Choose where this task runs".
2. Open a new workspace via a second instance (QA-PROMPT §3.6):

   ```bash
   source "$QA_ROOT/bin/qa-vars.sh"
   cd "$REPO/packages/desktop"
   "$QA_ROOT/bin/qa-run.sh" "$ELECTRON_BIN" . --open-workspace="$QA_ROOT/repos/empty"
   ```

3. In the opened workspace `document.querySelector('[aria-label="Choose where this task runs"]')` is `null` (immediately and after 2 minutes); the project chip and an active composer are present.
4. `agent-browser reload` makes the chip appear ("main" for R2, "Detached HEAD" for R5).
5. Alternative recovery without reload: click another project in the sidebar and back (a `workspacePath` change restarts the refresh).

Log at the open second: `zcode-agent.subscribeSessionsIndexV4 FAIL … Error: ZCode Agent runtime is not running` (runtime-start race marker; the sessions-index subscription recovers by itself, `subscribeSessionsIndexV4 OK` after ~0.5 s).

## Expected

`specs/composer-branch-switcher-semantics.md` §4 (single destination control) and §47 (empty repo: chip with base=HEAD): the destination chip is present in the draft composer of any project workspace that is a git repository, without a manual reload; chip state resolves from workspace state by itself.

## Actual

- R2: chip absent >2 minutes after qa-open (checked twice); appeared only after reload. Control: R1 opened the same way 4 minutes earlier had the chip immediately.
- R5: same on a normal repo, so not specific to unborn HEAD.
- Host log at the open second: `git.refresh OK` (39.6 ms and 29.1 ms); the next `git.refresh` only after reload. Whole run: 254x `git.refresh OK`, 0x FAIL; no renderer warn `[useGitRepository] 读取 Git 仓库状态失败` ("failed to read Git repository state").
- So the host got git state successfully, the renderer neither applied the result nor retried. Git data unchanged.

## Cause (confirmed by code and log)

- The chip renders only when `shouldRenderComposerDestinationControl`: `gitState.workspaceKey === activeWorkspaceKey && gitState.summary.isGitAvailable && gitState.summary.isRepository` (`packages/ui/src/v4/composer/destinationControlVisibility.ts:10-20`; mounted in `WorkspaceShellLayout.tsx:1543-1546` and `1640-1655`; `gitState` is owned solely by `useGitRepository`, `App.tsx:491-501`).
- `useGitRepository` issues exactly ONE `gitService.refresh` per `workspacePath` change (`useGitRepository.ts:465-475`); the retry decision `shouldRefreshLiveGitData` (`:354-381`) ignores error or lost result: unless workspacePath/workspaceKey/refreshToken/includeExtendedData change, no retry happens.
- A result is dropped silently when `disposed || requestVersionRef.current !== requestVersion` (`:499-503`); cleanup sets `disposed=true` (`:550-552`); a reject writes error state without retry (`:530-548`).
- Auto-refresh cannot rescue: file watchers are installed only if `gitSummary.isGitAvailable && gitSummary.isRepository` is already true (`useGitAutoRefresh.ts:59`), a closed loop for a stuck workspace.
- Recovery came only from a remount (reload) or a `workspacePath` change; both rerun the effect with `shouldRefresh=true`.
- Hypothesis (not fully verified): in the 25-40 ms window after open there is a burst of re-renders/reconnects (deep-link -> addTab + startDraftInWorkspace + setting.update, v4 workspace connection creation, CLI runtime start; `subscribeSessionsIndexV4` fails with `runtimePolicy: "existing-only"` in `agentSessionsIndexTransport.ts:121-126`). Probably an identity change of an effect dependency (for example the service proxy) triggered cleanup with unchanged logical inputs, dropping the result with no retry. The sessions-index layer retries and recovers (OK after 504 ms); the git layer does not.

## Fix direction

`packages/ui/src/hooks/useGitRepository.ts` (no protocol change): make loss/failure of the initial refresh self-healing: (a) let `shouldRefreshLiveGitData` treat incompleteness (`loading && !summary.isRepository`) or a last-request error as grounds for a retry at the next effect evaluation / `rpcReady` transition, or (b) do not discard an in-flight result on service identity change without a `workspaceKey` change. Do not mask with timeouts.

## Test

`packages/ui/test/destinationChipOpenWorkspaceGitRefreshRetry.test.ts`, hook level (deterministic), 2 tests:

- control (no request drop): PASS, validates the harness;
- bug case `BUG-GWT-013: re-issues the initial git refresh when the in-flight result is dropped, so the destination chip resolves without a reload`: after a `workspacePath` change (open-workspace), an in-flight `git.refresh` dropped by a service reconnect (identity swap with unchanged logical inputs) must resolve without remount, so `shouldRenderComposerDestinationControl` becomes true (`expect(result.current.summary.isRepository).toBe(true)`). Was `it.fails`; marker removed after the fix.
