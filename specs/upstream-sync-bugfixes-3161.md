# Upstream bugfix port (3.16.1 audit): static path containment and terminal output buffering

## Scope

Two upstream v3.16.1 (`0a1fc56d`) bug fixes that the fork tree is missing. Only the affected hunks are ported; fork routes (`/api/connect-remote`, `/ws/remote/:id`, remote identity mapping) are unchanged.

## Owners

- Static file resolution: `packages/server/src/http.ts` (`resolveStaticFile`, `isInsideDirectory`, `isPathDriveQualified`). Single owner of static path containment.
- Terminal output emission: `packages/services/src/terminal/terminalService.ts` (`createBufferedTerminalOutputEmitter`). Single owner of PTY output fan-out per terminal instance.

## A. Static path containment (security)

- Behavior: a path whose decoded form starts with a drive letter (`Z:/x`, `Z:\x`, `Z:x`, including `%3A`) returns 404 and never reaches `path.resolve`. It does not enter SPA fallback.
- Behavior: `isInsideDirectory` treats an absolute `path.relative` result as outside the root. POSIX semantics are unchanged.
- Acceptance: drive-qualified requests return 404; `..` escapes fall back to the in-root SPA index; `packages/server/test/staticRoutePathContainment.test.ts` passes.

## B. Buffered terminal output

- Behavior: PTY output emitted before the first data listener subscribes is buffered (bounded at 1 MiB of characters, oldest chunks dropped first) and replayed in order when the first listener arrives.
- Behavior: output emitted while the listener set is empty after a disconnect is buffered the same way, so reconnects do not lose intermediate output. No timers are used.
- Behavior: fork terminal behavior (working directory selection per `specs/terminal-worktree-working-directory.md`) is unchanged.
- Acceptance: a chunk pushed before subscription is delivered on subscription; ordering is preserved; the buffer cap drops the oldest chunks; a listener attached after removal receives output buffered while detached; `packages/services/test/terminalOutputBuffer.test.ts` passes.

## C. Bugfix audit for upstream changelog items #4, #5, #6, #14, #17

Scope: the v3.16.1 bugfix list, compared against the fork at `origin/integration`. Upstream `0a1fc56d` is a squashed snapshot without history, so each verdict is based on file diffs (`0a1fc56d` vs fork, comment-stripped and formatted with `oxfmt`), not on upstream commit messages. Where the fork changed behavior on purpose, the fork test is the spec.

### C1. #5 switching the model overwrote the input being edited (`packages/ui/src/v4/composer/useDraftConfigControl.ts`)

- Verdict: already preserved in the fork; no behavior change. The fork keeps two rules on purpose. First, a draft with no model takes the session model (fork commit `ec083cb0`, "restore model selection in forked composer", recorded in `specs/ui-upstream-sync-ledger-fix-g2.md`). Second, a model chosen before mode hydration is not overwritten by a late snapshot (`packages/ui/test/useDraftConfigControl.test.ts`, "fork child ... 不被迟到的继承模型覆盖"). Upstream gates the initialization by `draft.mode`; the fork gates by `initialization` state, so the fork's rules are not replaced.
- Evidence: the new test `switching the model while typing keeps the typed input` covers a session draft and a root draft. It types text, switches models, and then delivers a late session snapshot that still reports the previous model. The typed text and the chosen model survive in both the hook and the persisted draft. The test passes on the current code, so it guards the behavior rather than fixing a reproduced bug.
- Not verified: the exact upstream repro for the overwrite (the changelog wording is not in the repository). If the overwrite is in `ConversationComposer` (editor reset on `composerDraft` change) rather than in this hook, this pass does not cover it.

### C2. #6 highspeed unavailable fallback keeps the input

- Verdict: not verified in this pass. The fork keeps the upstream `highspeedFallbackUnavailable` handling in `packages/ui/src/v4/SessionPane.tsx` (same check as upstream). The existing fork test `packages/ui/test/v4SessionPaneModelSwitchRecovery.test.ts` covers the fallback path. No new test was added for the input-retention assertion.

### C3. #4 attachments misplaced or marked failed when restoring a history session (UI side)

- Verdict: partially audited, not ported. The fork replaced upstream's restore path with `restoreSessionOwnedAttachments` (`packages/ui/src/v4/composer/useComposerAttachments.ts`): restored items keep `referenceOwnership: "session"`, `uploadStatus: "ready"` and the original `AttachmentRef`, and are not rebuilt as composer files. Upstream's `restoreDraftAttachments` rebuilds from `File`/`localPath`, which is a different contract. The fork also adds `captureSubmission`, `prepareForSend(attachmentIds)` and `reuploadForSession`. These are fork design, so the upstream restore code is not copied.
- Open: the upstream failure path that marks restored attachments as failed was not located in the fork diff within this pass. Next step: compare the history restore call sites in `ConversationComposer.tsx` for `restoreDraftAttachments` against the fork.

### C4. #14 lock and lag after database upgrades (`packages/desktop/src/host/database-startup/*`)

- Verdict: deferred by design; no port in this pass. The only upstream-side difference in `packages/desktop/src/host/database-startup` is `tasksStorageWorker.ts`, which passes the legacy settings snapshot as a third argument so project migration runs before the Host starts. The fork's `prepareTasksIndexStorage` in `packages/services/src/project-storage/startup.ts` has no such argument, and the fork `TaskIndexRepo` takes `(path, busyTimeout)` with no project migration. The fork documents this as deferred in `specs/desktop-upstream-sync.md` (services startup-entry sync).
- The lock mechanism is the same on both sides (busy timeout of 25 ms, a 60-minute lock wait loop with `waiting_for_lock` progress, and `BEGIN IMMEDIATE`). The fork's business connection also skips the full repair when the Worker has already prepared the path (`isTasksStoragePrepared`), which upstream does not do. Porting the settings-based project migration needs the services startup-entry sync first.

### C5. #17 MCP app calls fail when the app is not ready (desktop/UI consumers)

- Verdict: partially audited; the fork already matches upstream on the readiness path. The sandbox guest uses the same `did-stop-loading` resync (`packages/desktop/src/main/pluginSandbox/host.ts`), and the renderer app-tools host (`packages/ui/src/plugin-ui/app/pluginUiAppTools.ts`, `pluginUiHostController.ts`, `pluginUiInstanceStore.ts`) is identical to upstream after normalization.
- Intentional fork difference: `pluginUiBackground.ts` subscribes with `onDynamicPluginUiToolResult?.()` and returns a no-op when the method is absent, because the fork's `IZCodeAgentService` makes that method optional (web and remote agents do not provide it). Kept as is.
- Open: the upstream app-not-ready failure was not located. The fork `pluginUiBridgeService.ts` removed the `plugin_usage` `ui_tool_call` telemetry wrapper that upstream has around `callMcpToolForUi`. That removal is not a readiness fix and is not restored here.
