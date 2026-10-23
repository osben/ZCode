# Upstream Sync 3.16.2

Status: merged (merge commit on `claude/zcode-app-sync-update-19013e`). Base `0a1fc56d` (v3.16.1, the current `fork-upstream-base.json` pin). Target `3c5b2276` (v3.16.2, upstream `main`, `Source-Commit: 5a082039`). Method: one real `git merge --no-ff 3c5b2276` into `integration`. `0a1fc56d` is an ancestor of the fork, so git uses the correct three-way base. Do not squash: the merge commit keeps the next sync three-way.

## Scope

The upstream diff `0a1fc56d..3c5b2276` covers 263 files: 35 added, 7 deleted, and 221 modified. 114 of them were also changed by the fork. A dry run (`git merge-tree`) gives 58 conflicted files. The remaining files merge cleanly.

Dependencies do not change. Only the root `package.json` version moves (3.16.1 → 3.16.2). Per `specs/fork-release-versioning.md` the root version follows the upstream base, and fork builds set `-fork.N` at build time.

## Resolution rules

The rules match `specs/desktop-upstream-sync.md`:

- A file the fork did not touch takes upstream (git does this automatically).
- A conflict where the fork side is only comment churn (Chinese → English translation) or formatting takes upstream code. The English comments are kept where the code around them did not change.
- A conflict with real code changes on both sides follows upstream structure, and the fork hunks are re-applied on top. Comments touched in edited code are English.
- A conflict that cannot be resolved without a product decision keeps the fork behavior. It is listed under "Open questions" and is not guessed.
- Migration SQL, ids, and schema baseline strings take upstream verbatim (shared `~/.zcode` databases, `AGENTS.md`). Fork migrations stay `9xxx_fork_*`.

Fork features that must survive the merge: incognito sessions, session deletion cascade and archive permanent erase, worktree open/identity/recovery, deep links (`specs/deeplink-new-task.md`), voice dictation, resource telemetry toggle, bots `/remote`, the self-hosted relay V2, `fork_workspace_pins`, the OAuth callback page, the ACP agent runtime, composer quick prompts, the uk-UA locale, and English e2e copy.

## Database changes in 3.16.2

- Project storage gets a new additive migration step, `packages/services/src/project-storage/migration-order/migration.ts`. It adds `remote_project_entries.initial_position INTEGER` and orders the initial local projects and remote entries from the legacy `lastWorkspaceSession`. `schema.baseline.sql` gets the same column. Both are taken verbatim.
- No other DDL changes.

## Conflict resolution ledger

Status: resolved, and the merge is committed. `merged` means the file follows upstream structure with the fork hunks re-applied.

Shared and services:

- `shared/src/dynamic-workflow-feature.ts`, `shared/test/dynamicWorkflowFeature.test.ts`: upstream. The user's dynamic workflow mode choice now always wins, and a disabled offer only sets the default (`readDynamicWorkflowOfferedMode`).
- `shared/src/test-ids.ts`: merged. Upstream adds `SIDE_PANE_FULL_VIEW_*`. The fork trajectory ids are kept. `TID_V4_TASK_OPEN_IN_SPLIT` is removed, because nothing uses it any more.
- `shared/test/zcodeProtocol.test.ts`: both. The fork rate-limit cases stay and the upstream session kind policy cases are added.
- `services/src/node.ts`: fork. The upstream hunk is the auto-archive scheduler default (7 → 30 days), and the fork has no scheduler (see open questions).
- `services/src/zcode-agent/zcodeAgentService.ts`: merged. Adds the upstream auxiliary session kind gate and the default-offer fallback.
- `services/src/zcode-agent/zcodeTaskIndexSyncer.ts`, `zcodeTaskServiceAdapter.ts`: fork structure plus upstream `isAuxiliarySessionKind`.
  - The fork's repair copy (`zcode-agent/repairSubagentTaskIndex.ts`) gets the same auxiliary kind rule and keeps the fork soft delete.
  - The fork's auto-archive fallback now uses the new 30-day default.
- `services/test/*`: upstream cases added (SAT28/SAT29, dynamic workflow policy).

UI:

- Split panes: upstream removed the v4 split entry points (context menu "Open in split view", header split buttons, drag-to-split). No fork feature depends on them; selection side chat, subagent drill-down and read-only bindings go through `selectWorkbenchSession`. The removal is taken, together with its keys in en-US, zh-CN and uk-UA, and the split-only test cases.
- Side pane full view (new upstream module `side-pane-full-view`): taken. `WorkspaceShellLayout.tsx`, `SessionPane.tsx`, `ConversationTimeline.tsx`, `ChatPromptEditor.tsx` and `V4WorkspaceChatArea.tsx` are merged with the fork features re-applied:
  - read-only and selection side chat bindings
  - the trajectory v2 launcher
  - the voice preview
  - quick prompts
  - the first-submission state
- uk-UA gets the 13 new keys.
- `store/index.ts`: the fork's `stateBroadcast.ts` stays the single broadcast owner. Upstream's new `notificationEnabled` cross-window sync is added there.
- `side-pane-plugin-menu.test.mjs` (manual review, pending): the fork's trimmed version is kept. Upstream's SPT-E2E-007 cases were not restored.

CLI, web, desktop e2e:

- `v4-bridge.ts`: fork, plus the upstream `isReadonlyAgentSessionKind` guard.
- `workflow-concurrency-governor.ts`, `transport.ts`, `node-execution-adapter-run.ts`, `v4-cold-resume.test.ts`: merged, or upstream where the fork change was comments only.
- Web auth and relay token files and their tests: upstream. The fork changes were comments only. Upstream replaces the pending OAuth nonce in `sessionStorage` with a pending-login list in `localStorage`, and the legacy pre-update login fallback is gone.
- E2e: the upstream split-pane helpers were removed (no consumers left). The model picker block was added to the composer toolbar case, and the mobile Files-tab flow was taken.

Root and docs:

- `package.json` and `package-lock.json`: fork, at version `3.16.2-fork.1`. `third-party/inventory.json`: fork, with the `package.json` hash recomputed.
- `README.md`: fork plus the update line. `README.en.md` stays deleted, as in the fork.
- `architecture-policy.yaml`: union of both sides; the new upstream reason is translated.
- Docs: the fork's English versions plus upstream's new content in English.
- `.staged-file-size-exemptions`: five upstream-owned files above the size cap are listed instead of being split, which keeps sync parity.

## 3.16.3 ledger (binary only, pre-ported)

Upstream released 3.16.3 (build commit `a82dd43e`, 2026-10-23) before publishing its source. The deltas below were inferred from the minified app bundle by comparing string literals against `3c5b2276`.

Update (user decision, 2026-10-23): the reconstructible items were pre-ported from the bundle. Each port uses upstream's identifiers, and each spec carries a "Reconciling with the real 3.16.3 source" section. When upstream publishes 3.16.3, take upstream and delete the port.

| Area                        | Status                    | Spec                                     |
| --------------------------- | ------------------------- | ---------------------------------------- |
| Remote SSH hardening        | ported                    | `specs/port-3.16.3-remote-ssh.md`        |
| `LocalToolSearch`           | ported                    | `specs/port-3.16.3-local-tool-search.md` |
| Copy login link             | ported                    | `specs/port-3.16.3-ui-small.md`          |
| Copy device MID             | ported                    | `specs/port-3.16.3-ui-small.md`          |
| `reuseExistingRoot`         | ported                    | `specs/port-3.16.3-ui-small.md`          |
| Onboarding eligibility      | ported                    | `specs/port-3.16.3-ui-small.md`          |
| Plugin scope labels removal | ported                    | `specs/port-3.16.3-ui-small.md`          |
| Window-scoped terminals     | analysis only, not ported | `specs/port-3.16.3-terminal-owner.md`    |

Window-scoped terminals are not ported because the phone client produces the terminal owner id, and its 3.16.3 source is not available.

- No new migrations, no DDL, and no changed migration SQL. 3.16.3 shares `~/.zcode` with this fork safely.
- Electron (41.0.3) and dependency versions are unchanged.
- Remote SSH: new error codes `remote-platform-unsupported`, `remote-authentication-unsupported` (extra verification such as one-time codes), and `remote-workspace-directory-unresponsive` (30 s). Also a minimum glibc 2.28 warning, Windows native shell failure detection, and an "Open project folder" connection step.
- Terminals scoped to an owner window: the host message `set-terminal-owner` and the reconnect reason `terminal-owner-ended`.
- OAuth login fallback "Browser didn't open? Copy login link" (`login.oauth.*`, 4 keys).
- Help menu "Copy device MID" (`workspaceHeader.help.*Mid*`, 3 keys).
- `LocalToolSearch`, a separate tool name for local tool search (`toolSearchNameForMode`). **Risk (checked):** sessions written by stock 3.16.3 may contain `LocalToolSearch` tool results. The fork's `core/src/tool/search/history.ts` counts only `ToolSearch` as a successful search, so those results degrade: their deferred tools are not marked as loaded, and the model can search again. Nothing throws.
- Project open: the `reuseExistingRoot` option and the `project.invalid-directory-open` error.
- Docker daemon probe and WSL exec error formatting.
- Onboarding eligibility check (`getOnboardingEligibility`).
- The plugin scope labels (`settings.plugins.scope.*`) were removed.
- en-US locale: +15 keys, −5 keys, no value changes.

## Open questions

These were found in this sync and need a decision. They are not resolved by guessing.

1. Auto-archive: upstream archives tasks from a scheduler (`project/autoArchiveScheduler.ts`, wired in upstream `node.ts`). The fork still archives on read in `zcodeTaskServiceAdapter.listGroupedTaskViewStructure`. Choose between wiring the upstream scheduler and dropping the read path, or keeping the fork path. This divergence was already there before 3.16.2.
2. `zcodeTaskServiceAdapter.syncTaskIndexSnapshot`: upstream delegates to `taskIndexSyncer.syncSnapshotAndBroadcast`, which also broadcasts. The fork writes directly. Check whether the broadcast is needed.
3. `task-facts/repairSubagentTaskIndex.ts` (upstream, hard delete) has no caller. The fork uses its own soft-delete copy in `zcode-agent/`. Delete it or keep it for parity.
4. `side-pane-plugin-menu.test.mjs`: restore upstream's SPT-E2E-007 concurrent-install cases or keep the fork's trimmed version.
5. Pre-existing doc debt: `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` has a duplicated block (lines 28–171 repeated) and is still in Chinese.
