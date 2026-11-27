# Upstream sync 4.0.0

Status: merged on branch `sync/upstream-4.0.0` (2026-11-23), PR to `fork` pending.

Upstream `a4b444514` (tag `v4.0.0`) is merged into `fork` with a real `git merge --no-ff`. It is one
squashed commit on top of v3.18.2 (`fec975905`, the previous pin and the merge-base) and covers 3.19.0,
3.19.1 and 4.0.0: 2209 files, about +150k/-25k lines. The merge left 334 conflicted files (704 hunks).

**The PR must be merged with "Create a merge commit".** A squash drops `a4b444514` from the fork's
ancestry and `pnpm fmt:check` then fails (`specs/fork-format-scope.md`).

## Pin and migrations

- `fork-upstream-base.json`: `upstreamCommit` is `a4b4445141eb7d3b3e99eada9292775383bfc44e`,
  `upstreamVersion` is `4.0.0`. The merge commit also carries `pendingUpstreamCommit` (same SHA) so the
  staged-size gate skips upstream-identical blobs; the next commit on the branch removes the field.
- `fork-upstream-migrations.json` is regenerated. Upstream adds one CLI migration,
  `0026_dwf_run_parent_session_index` (an index on `dwf_run(parent_session_id)`). Its checksum
  `6d69a28d...` matches the row already in the live shared ledger. No upstream migration definition is
  touched; fork migrations stay at `9001_fork_*` and later.
- New upstream `setting.json` keys come in through upstream's own schema: `replyLanguage`,
  `preinstalledToolsAutoInstall`, `preinstalledToolsAgentDisabled`, `agentAlwaysBackgroundEnabled`,
  `totalTokensReminderEnabled`. No fork key moves into `setting.json`.
- `.staged-file-size-exemptions` gains 19 files over 20 KB that carry fork deltas on top of upstream
  (14 of them are already over 20 KB in upstream itself). Upstream files are not split.

## Owner decisions

1. **Composer model picker.** The local branch `feat/composer-model-picker-4-0-0` (browse-only provider
   rows on the 4.0.0 Popover picker) is folded into this sync. `ComposerModelMenu.tsx` and
   `ComposerProviderMenu.tsx` are upstream 4.0.0 plus the browse-only deltas; the flyout state lives in
   `ComposerModelMenu`. Spec: `specs/composer-model-picker-browse-only-providers.md`.
2. **Voice shortcut.** `CmdOrCtrl+Shift+D` stays with the fork's `voiceDictation`. Upstream's
   `toggleVoiceInput` id is kept in the shortcut union with no default binding, so users can assign it.
   The upstream composer voice E2E stays `describe.skip` (owner decision 5 of the 3.18.0 sync: one mic,
   fork dictation). `docs/desktop/shortcut-settings-spec.md` §12.7 records the fork rule.
3. **Status panel.** Upstream replaces the status panel with composer capsules (Goal, Todo, Git
   changes, Background activity). The capsules are taken now: `ConversationStatusPanel.tsx` and its
   model are upstream verbatim and `ConversationBackgroundWorkTrigger.tsx` is deleted. The fork's Last
   turn, Context, PR status, throughput, worktree marker and branch-switch guard modules stay in the
   code but are not rendered. A follow-up PR re-homes them after a mockup is approved. Until then these
   suites are skipped with a note: `statusPanelInsightsToggle.test.ts`, `statusPanelInsightsPanel.test.ts`,
   E2E `conversation-session-status-panel-last-turn.test.ts` and the pending
   `conversation-session-dream-background.test.ts`.

## Fork deltas kept on top of upstream

CLI (`apps/zcode-cli`):

- Incognito: the `skills` gate on the main and subagent context builders, re-applied on upstream's new
  `collectSkillsListing` (`context-refresh.ts`); the `mcp` exclusion re-applied in
  `bootstrap/src/app/dynamic-mcp-config.ts` (explicit servers emptied).
- Context: `execution_worktree` source, `memoryIndexAsContext`, `nested_agents_md` reminder, prompt
  constants that the fork moved to `@zcode/shared`, `systemPromptOverrides` in `updateConfig`.
- LSP: post-edit diagnostics in `turn-loop.ts`, `includeLsp` on the embedded search branch, LSP
  preferences in plugin management. Upstream moved the CLI packages to zod 4, so the fork LSP contract
  uses the two-argument `z.record`. Upstream made `resolveExecutionCommand` async; its argv branch is now
  the exported sync `resolveArgvExecutionCommand`, which the LSP spawn path uses so `startServerProcess`
  stays synchronous (no start/stop race).
- Dream: the dream slot and journal flow, with upstream's required `bashShellSelection` added.
- Subagent skill grants (`resolveAllowedSkill`), now throwing upstream's `SkillNotFoundError`.
- `bash.ts` cwd write-back guard and the parallel-commands prompt bullet. The duplicate
  `analysisContainsDirectoryChange` is upstream's (it also counts `chdir`).
- `contextBudgetPolicy` stays in `@zcode/shared` (the composer meter uses it). Upstream's window-scaled
  output reserve is ported there: `min(maxOutput ?? 32K, max(21K, floor(window * 0.08)))`; core
  re-exports the ratio.

Services, shared, server:

- App settings: upstream's new keys plus the fork's `memoryIndexAsContext`, `incognitoDefaults`,
  `resourceTelemetryEnabled`, `agentRuntime`; fork locale schemas plus upstream `replyLanguageSchema`.
- `stripZcodeForkVersionSuffix`, ACP and voice dictation wiring in `services/src/node.ts`, the fork's
  single `resolveClientLanguage`.
- LSP and CUA permission observation in `zcodeAgent.ts`, next to upstream `setWorkspacePluginTrust`.
- `project-repository-rows.ts` (the fork moved `readTask` and `resolveDirectories` there): upstream's
  `hostMismatch()` errors ported in.

Desktop:

- `official-plugin-packages.mjs` (the fork extracted the list from `prepare-agent-node-bundle.mjs`, so git
  could not merge it): upstream's `officeInvocationPaths` and the new design plugin seed list ported.
- Unread signals on every attachment, Windows AppUserModelId and product variant, dictation shutdown
  mute, the localized clear-all-data dialog (upstream's `beforeClearAllData` runs first), the resource
  telemetry drain guard, wdio fake-`gh` and ACP seams.
- `zcode_libreoffice.py` in the four office plugins stays the fork's copy (`_remove_tree`); upstream adds
  no new function there. They keep their size-exemption entries.

UI:

- Composer: voice dictation (`voiceDictationEnabled && !isWebRemoteControl`), quick prompt bar before
  the status row. The merged `useMemo` dependency list for the toolbar had dropped
  `insertVoiceTranscript`; it is restored.
- `useArchiveManagement` keeps the fork's delete dialog, so upstream's `previewProjectTaskDeletions`
  is unused for now.
- `GitBranchSwitcher` is upstream's Host/Hosted split with the fork props (`selectionIntent`,
  `beforeSwitch`, `disabled`, `triggerTitle`) re-applied; `beforeSwitch` still reaches it through
  `GitActionMenu`.

Repository:

- Fork deletions since `a6cfcca1c` stay deleted: `README.en.md`, the Feishu/CI/bitable docs,
  `docs/ui/chat-view-composition.md`, the web remote auth-gate fixture, its two specs and its unit test.
- Root `package.json`: union of scripts (upstream `test:git-invocation`) and the fork's newer
  `vitest`, `@types/node` and `@tanstack/react-virtual`. `pnpm-lock.yaml` regenerated with
  `pnpm install`.
- `third-party/inventory.json` and `THIRD-PARTY-NOTICES.md` are the fork's copies (see follow-ups).

## Fork code dropped because upstream implements it

- Office plugin pre-ports (#632) and the server's office asset list: upstream's code.
- OAuth local-clock expiry: upstream's server-time rule (`docs/oauth/desktop-oauth-polling.md`).
- `resolveCredentialFilePath`: upstream's `getCredentialsFilePath`.
- Dynamic workflow fail-closed: upstream's on-demand state on fetch failure.
- `feedbackLogArchive` bounded read: upstream's tail-window read.
- Compact: `MAX_OUTPUT_TOKENS_FOR_SUMMARY` (upstream caps the summary at the auto-compact reserve) and
  the `queryScope` history field (upstream's `output_token_continuation` source).
- MCP session handling: upstream's session rework (the fork's copy was translation only).
- Desktop E2E: upstream's composer model panel, status capsule and Activity capsule flows replace the
  fork's status-panel pre-ports.

## Merge mechanics worth knowing

- Git's directory-rename detection moved the fork-only
  `task-management/manual-review/pending/conversation-session-permanent-delete.test.ts` next to the two
  tests upstream promoted out of `pending/`, which broke its relative imports. It is moved back. A check
  that no merged path exists in neither parent found nothing else.
- Upstream's capsules use `ResizeObserver` and `MutationObserver`. Fork composer suites that mount
  `ConversationComposer` on the minimal DOM mock `ComposerStatusRow`; the jsdom suite imports
  `packages/ui/test/resizeObserverStub.ts`.
- Upstream now resets a bound credential store in the background after a key failure. The fork cipher
  tests wait for `onReset` before removing their temp directory.
- Fork LSP plugin tests use upstream's async `discoverPlugins` (the sync variant is gone).
- i18n: uk-UA gains the 113 new upstream keys, drops 18 keys upstream removed from en, and en drops five
  status-panel keys that no code reads any more. The zcode-rs inbound schema and tool contracts are
  regenerated (zod 4 output and the two new settings).
- The merge dropped upstream's spreadsheets viewer paths (`skills/xlsx-viewer/SKILL.md` and the `dist`
  viewer trio) from the remote official-plugin check. They are restored, and the fork test
  `forkRemoteOfficeAssetsParity.test.ts` now compares the remote list for the four office plugins with
  the desktop bundle list.
- `scripts/check-test-copy.mjs`: 10 new upstream suites with zh-CN locale setup join the verbatim list,
  and five entries follow upstream's moves out of `manual-review/pending/`.

## Verification

- `pnpm db:migrations:check`: pass (5 sets, pin `a4b444514`).
- `pnpm typecheck`: pass. CLI typecheck (`turbo run typecheck` in `apps/zcode-cli`): pass.
- `pnpm lint`: 0 errors, 581 warnings. Hooks warnings compared per file against both parents: none new
  after the `insertVoiceTranscript` fix.
- Staged-size gate: pass.
- `pnpm test:fork`: 3421 passed, 2 failed, 6 skipped. The 2 failures predate the sync:
  `packages/acp-agent-runtime/test/process-tree.test.ts` fails the same 2 cases on a clean `fork`
  checkout (and outside the sandbox).
- Engineering suite (the affected selection is the whole suite, so it ran in full): 644 files passed,
  4 failed, 5 skipped. One failure came from the sync and is fixed: the merge translated the
  `e2e-electron-reload.ts` barrier error, so upstream's new assertion is updated to the English text.
  The other three predate the sync and fail the same way on a clean `fork` checkout: the two
  process-tree cases above, `windowsInstallerCompile.test.ts` (`makensis` aborts with `bad_alloc` on
  this Mac) and `audit-conversation-session-json-out.test.mjs` (the same 7 formal admission rejections).
- The case audit is fixed in this PR: the five ACP specs get `providerRequestPolicy: "none"` manifests
  (they talk only to the mock ACP agent), the trajectory viewer manifest reason and the gray always-on
  resume ledger (`dwu-c-agent-group`) match their fixtures, and five pending specs point at their new
  paths. `audit-conversation-session-case-coverage.mjs --check` passes.
- Not run: desktop E2E (runs in the Linux box, not on the Mac).
- Local ocr review of the conflict resolutions (glm-5.3, 221 of 237 review units, 16 failed on 429s):
  18 comments. Fixed: the spreadsheets viewer paths above, the missing `typescript-lsp` fixture in
  `build-sea.test.mjs` (it failed the same way on `fork`), a half-translated comment line in
  `WorkspaceHookPendingBanner.tsx` and dead selector fallbacks in the fork flyout browser test. The other
  comments point at upstream 4.0.0 code or text kept verbatim, or at fork code older than the sync.
  Two of those are handled anyway: `GitBranchSwitcher` now runs the `beforeSwitch` guard through
  `runAfterBranchSwitchGuard`, which fails closed and logs when the guard rejects. The missing replay of
  MCP resource subscriptions after a reconnect is upstream's contract (its test "does not replay
  subscriptions after reconnect": the host re-subscribes after `onAppConnectionInvalidated`), so it stays.

## Follow-ups

- Re-home the status panel features in the capsules (decision 3), after a mockup.
- Done 2026-11-27: `node scripts/licenses.mjs notices` passes again. The five `@koromix/koffi-*@3.0.2` platform
  packages ship without a LICENSE; `third-party/npm-overrides.json` points them at `koffi@3.0.2`'s `LICENSE.txt`, and
  the notices and inventory were regenerated (they also picked up the `transcribe-cpp` 0.4.2 and `tar` 7 drift).
- Done 2026-11-27: the Chinese text in `apps/zcode-cli/docs/design/v2/tool/02-write.md` (errorCode table) and in
  `docs/specs/workspace-hook-trust.md` (D24 and §12.9) is translated. Quoted Chinese UI labels stay.
- Done 2026-11-27: `docs/chat/composer-voice-input.md` says `toggleVoiceInput` has no default binding in the fork,
  because `CmdOrCtrl+Shift+D` belongs to `voiceDictation`.
- knip: `previewProjectTaskDeletions` and `status-panel-insights` are unused until the follow-ups land.
- Archive deletion E2E now drives the fork delete dialog (`task-delete-dialog`). Changes against the
  upstream versions of `conversation-session-archive-management.test.ts` and
  `conversation-session-delete-all-archived-tasks.test.ts`:
  - APD03 (per-row pending input reasons) and APD04 (preflight race) are dropped. They test upstream's
    preflight, and the fork running guard is process-local, so a queued `session_input` does not block
    deletion.
  - APD11 checks the fork Web remote gate: on the phone the delete button is disabled with
    `taskDelete.remoteUnavailable`, then the row is deleted on desktop.
  - ARM02, ARM03 and TSL39 expect fork tombstones (`deleted=1` rows stay in tasks-index, no
    `session_purge`). ARM02 expects the whole source session directory to stay while a fork child
    survives.
  - Fixture meta_json now carries `provider: "glm"`. Without it the tombstone row got provider NULL and
    the erase skipped it. Real data (1579 tasks) has no such rows.
  - TSL39 counts every archived row: wdio seeds 25 more archived tasks for this spec.
  - Specs without the coding plan mock reach the live marketing API. The archive spec closes the
    campaign popup (`cloud-content-dialog`) before each case. Other specs may need the same.
  - TSL39 found two fork bugs that predate the sync. Permanent delete removed attachment files that a
    kept session still referenced by `zcode-artifact://` URL: fixed in #634 (merged into `fork`, then
    into this branch). The fork erase path also kept the deleted tasks' browser recent visits, because
    `eraseTasks` fires no `permanentlyDeleted` signal: `permanentlyDeleteTasks` and `eraseHiddenRows`
    now clear them (`specs/session-deletion-cascade.md`).
  - Box run on 2026-11-24: TSL39 passes, archive-management 5 of 6 pass. APD11 did not reach the delete
    check: "Copy link" stayed disabled because no relay answered. The phone browser itself starts in
    the box (Debian Chromium through `ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE`, since Google Chrome has no
    linux-arm64 build).
- Mobile relay fixture. The fork deleted upstream's `web-remote-control-auth-gate-fixture.ts` when it
  was created (a6cfcca1c), so no mobile spec got a loopback relay and pairing never produced a link.
  It is restored as an upstream-identical file, called from `wdio.conf.ts` before Electron starts and
  stopped in both teardown paths, as upstream does. Its unit test goes back into
  `scripts/engineering-test-files.json`, which now matches upstream 4.0.0 again. The fixture only
  acts on the specs it lists; the two auth-config specs it also names
  (`web-remote-control-auth-gate`, `web-remote-control-session-events`) are not in the fork.
  - The shared fake relay (`packages/shared/test/fixtures/fake-relay-v2.ts`) now answers the fork's
    `POST /api/v1/remote/session` exchange: a known identity token comes back as the relay JWT.
    Without it the desktop got no relay JWT and never produced a pairing link.
  - With pairing working, APD11 found that `RootWorkspaceContent` did not pass `isWebRemoteControl`
    to the workspace settings layer, so the phone's Settings page opened inside a workspace treated
    Web remote control as local and left permanent Delete enabled. Upstream has the same missing
    prop, but its APD11 deletes from the phone on purpose, so only the fork gate depended on it.
    Whether upstream's other consumers of the flag are affected was not checked. Fixed by passing
    `Boolean(webRemoteControlWorkspaceSwitcher)`, as the no-workspace path in `Root.tsx` already
    did; every Settings consumer of the flag now gets it in workspace mode too.
  - The phone UI follows the desktop language, not the Playwright locale, and this spec keeps the
    desktop in Chinese. APD11 switches the desktop to English for the case and back in `finally`, so
    its locators stay English (`scripts/check-test-copy.mjs` rejects CJK locators). It also closes
    the desktop remote control dialog before the desktop delete steps.
  - APD11's last step (an offline phone draft of the deleted task is cleared after reload) failed:
    the phone learns about permanent deletions from `listPermanentlyDeletedTaskIds`, which read
    only `task_purge` receipts, and the fork erase writes tombstones instead. The fork now answers it
    with tombstones plus receipts (`specs/session-deletion-cascade.md`, removal replay paragraph).
  - Box runs on 2026-11-24 with the fixture: archive-management 6 of 6 after the replay fix; `conversation-session-hooks-mobile` and
    `conversation-session-workspace-mcp-trust` pass; `conversation-session-hook-trust` fails HK19
    (expects the Chinese missing-entry reason, the phone shows English text) with and without the
    Settings flag fix, so it is not caused by it and was not investigated. VP13 in
    `conversation-session-virtual-project-mobile` now gets past pairing and fails at its persist
    task stage, not investigated. The other specs the fixture covers (about 45) were not run.
  - #636 fixed both. HK19 now pins the desktop to Chinese before pairing. VP13 needed the
    `data-branch-switcher-primary-icon` marker on the destination chip, and its desktop child check
    (`project-created-draft.test.mjs`, PCD01/02) waited for an alertdialog in cleanup while the fork
    project delete confirm is a `role="dialog"` (`project-delete-confirm`). Box run on 2026-11-25 at
    8612f056e: both specs pass.
  - `pinE2ELocale` returned once the renderer showed the new language, before `setting.json` held
    it. The phone reads the saved setting, so it now also waits for the file
    (`docs/testing/conversation-session-e2e-development-workflow.md`, shared setup contract).
- `conversation-session-dynamic-workflow-gray-always-on-resume.test.ts`: the fork and upstream gates for
  the same race are combined. Box run on 2026-11-26 at 27ccb81c7: Node 4/4, Rust 2/4 (DWU-03 and the
  dependent DWU-04): zcode-rs did not send the 4.0.0 `activitySummaryDismissed` boundary, so the Activity
  capsule kept the stopped run after the next real message. Ported in `specs/fork-rust-activity-summary.md`;
  Rust 4/4 after the port. `completedActivityCount` is sent by zcode-rs too (`specs/fork-rust-completed-activity-count.md`).
