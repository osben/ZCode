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
- Not run: desktop E2E (runs in the Linux box, not on the Mac).

## Follow-ups

- Re-home the status panel features in the capsules (decision 3), after a mockup.
- `node scripts/licenses.mjs notices` fails on `@koromix/koffi-*@3.0.2`. This predates the sync: #496
  bumped koffi from 2.15.6 to 3.0.2 without regenerating, and the inventory still says 2.15.6.
- Chinese left in clean-merged upstream text: `apps/zcode-cli/docs/design/v2/tool/02-write.md` errorCode
  table, `docs/workspace-hook-trust.md` D24 and §12.9.
- `docs/chat/composer-voice-input.md` still names `Cmd+Shift+D` for upstream voice input.
- knip: `previewProjectTaskDeletions` and `status-panel-insights` are unused until the follow-ups land.
- `conversation-session-dynamic-workflow-gray-always-on-resume.test.ts`: the fork and upstream gates for
  the same race are combined; not run yet.
