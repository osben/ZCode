# Upstream sync 3.18.0

Status: merged locally, PR open (2026-11-11), branch `sync/upstream-3.18.0`.

Upstream `b95ebaffe` ("chore: sync ZCode source v3.18.0") is merged into `fork` with a real
`git merge --no-ff`. The previous pin is `a9fe401ee` (v3.17.2), which is the merge-base. Upstream
publishes each release as one squashed commit: 5099 files, +429k/-45k lines. The trial merge gave 676
conflicted files (631 UU, 23 DU, 10 UD, 11 AU, 1 AA).

**The PR must be merged with "Create a merge commit".** A squash drops `b95ebaffe` from the fork's
ancestry and `pnpm fmt:check` then fails (`specs/fork-format-scope.md`); see #380/#381.

## Resolution rules

The rules match `specs/upstream-sync-3.16.2.md` and `specs/desktop-upstream-sync.md`:

- A file the fork did not touch takes upstream (automatic).
- A conflict where the fork side is only comment churn (Chinese -> English translation) or formatting
  takes upstream code; English comments are kept where the code around them did not change, and new
  Chinese comments inside resolved hunks are translated to English.
- A conflict with real code changes on both sides follows upstream structure, with the fork hunks
  re-applied on top.
- A conflict that cannot be resolved without a product decision keeps the fork behavior and is listed
  under "Owner decisions" (formerly "Open questions"); it is not guessed.
- Migration SQL, ids, checksum inputs and schema baseline strings take upstream verbatim (shared
  `~/.zcode` databases, `AGENTS.md`). Fork migrations stay `9xxx_fork_*`.
- A file upstream deleted (UD) is deleted unless the fork edit carries a fork feature.
- A file the fork deleted (DU) stays deleted.
- Documents follow `specs/docs-compaction.md` "Upstream sync": an in-scope conflicted document keeps
  the fork's English version and gets the meaning of upstream's change ported in English (163
  documents). Out-of-scope markdown (`docs/testing/conversation-session-*`, test-parsed catalogs)
  takes upstream bytes. New upstream documents land as is; translation is a follow-up.
- `packages/rust-cli/**` is not touched by upstream and is not changed by this sync.

Fork features that must survive the merge: incognito sessions, session deletion cascade and archive
permanent erase, worktree open/identity/recovery and `9002_fork_session_execution_worktree`, deep
links, voice dictation, resource telemetry toggle, bots `/remote`, the self-hosted relay V2,
`fork_workspace_pins`/project pins, the OAuth callback page, the ACP agent runtime and ACP settings,
composer quick prompts, the uk-UA locale and fork locale storage, English e2e copy, the Rust agent
runtime switch (`specs/fork-agent-runtime-selection.md`), Dream run journal, session title polish,
subagent model override sync, model settings (ChatGPT plan, Ollama), attachment ref trust boundary,
task-index CLI facts admission, pane session restore precedence.

## Overlapping features (fork behaviour kept, decision for the owner)

Upstream 3.18.0 ships counterparts of fork features. The merge keeps both code paths compiling and
the fork behaviour active; it does not pick a winner. The owner's choices are under "Owner decisions"
(voice: decision 5; worktrees: 6; permanent deletion: 7; login: 3; locales: 12):

- Voice input (upstream, zcode-server ASR) vs fork voice dictation.
- Managed worktrees (upstream, `0010_task_worktree_root`) vs fork session execution worktree.
- Permanent deletion (upstream `0007_task_permanent_deletion`, `0025_session_permanent_deletion` with
  guard triggers) vs fork archive permanent erase.
- Resource manager (upstream) vs fork resource telemetry toggle.
- Login rework (upstream) vs fork OAuth callback page.
- New upstream locales (ja-JP, ru-RU, ko-KR, follow system) vs fork uk-UA and fork locale storage.

## Conflict resolution ledger

### web (packages/web)

- package.json union; react/react-dom 19.3.0 (fork). communityUrl.ts fork toServiceLocale (uk-UA). main.tsx upstream (documentHiddenMotionPause removed).
- share landing: upstream regional login actions + fork theme palette. browserOAuthCredentialRepo: upstream session model + fork clearAll on expired JWT.
- web-remote-control: fork relay V2 requires + upstream web-auth; entry uses upstream revision logic with fork pairing bearer (matchesSession compares bearer()).
- transport: upstream (stale-waiting recovery removed upstream; fork had only comments).
- OPEN: upstream login offers only zai/zai_cn; BigModel no longer selectable in web login and share card (fork comment said private share owners need both).
- OPEN: fork clearAll() on read path vs upstream session epoch (possible interference with an in-flight login).

### root

- package.json: fork scripts and pnpm 12 kept; upstream build:sea:prepare, lint session-control-boundary, test:architecture added. typecheck keeps the fork project list plus upstream session-control, design-runtime, renderer-services, plugin-api. pnpm-workspace.yaml gets the upstream @radix-ui/react-menu patch.
- architecture-policy.yaml: union; upstream's relocated duplicate web-remote-control entry dropped (fork entry kept, requires remote-relay-protocol + web-auth).
- .gitattributes, .oxlintrc.json, copied-components.json, feature graph: union; comments translated. AGENTS.md/CONTEXT.md/DESIGN.md: fork English + upstream additions ported in English. README.md: fork.
- scripts/build-desktop-agent-cli.mjs: fork provider-config staging + upstream async stageDevAgentBundle.

### CLI (apps/zcode-cli) first pass

- read-session-context handler and bash-shell-snapshot deleted with upstream.
- usage.ts: fork 30-day usage prune kept at merge time; removed by owner decision 1 (usage facts kept forever).
- project-memory.ts / events.ts: fork workspace identity kept (overlap with managed worktrees).
- marketplace.ts: fork lspServers manifest field kept.
- context-builder/subagent-explore/runtime-trace tests and request-user-context hunks: upstream (autonomy appendix removed upstream).

### desktop first pass

- autoUpdater.ts: fork install-on-quit kept at merge time; removed by owner decision 2 (upstream quit-install loop).
- package.json: @modelcontextprotocol/server added; @napi-rs/keyring 2.1.2; electron-builder fork uk language list + NSMicrophoneUsageDescription kept.
- wdio.conf.ts: upstream voice-input fixture, fork seeds; upstream auth-gate fixture dropped (fork deleted it).
- UD e2e conversation-session-fork-cold-start-membership / v4-queue deleted with upstream; fork-deleted auth-gate / session-events / settings-personalization tests stay deleted.

### CLI second pass

- hooks.ts / internal-hook-methods.ts: fork runPreCompactHooks/runPostCompactHooks/runSessionEndHooks kept (compact-active, session-facade still call them); upstream buildLifecycleHookContextEntry taken.
- compact.ts: fork execution-context budget thresholds + upstream total-tokens rollover. context-refresh.ts: upstream pure announcements, fork env_info gate (incognito).
- turn-loop.ts: fork LSP diagnostics + upstream previous-runtime agent notice. runtime-tools.ts: fork automation tool gating + upstream session control / topic resource.
- request-user-context.ts: upstream InstructionFile structure, fork memory-as-context re-applied (full announcement only; OPEN: instruction delta path).
- errors.ts: fork provider facts + upstream unsettled-call note. bash.ts: fork backgroundDisabled + cwd write-back guard + upstream process log.
- startup-marks.ts: upstream async plugin preparation/discovery, fork incognito plugin exclusion.
- session-store.port.ts: fork session tree types + upstream deletion snapshot types.
- context-builder test vs fork AUTONOMY appendix: resolved by owner decision 9 (appendix removed, as upstream).

### CLI third pass (hard files)

- session-fork.ts: upstream (helpers moved to runtime/session-fork-commit/\*); fork incognito re-applied in session-fork-commit/builders.ts.
- cold-event-merge.ts: upstream loop + fork external_agent_context_reset (ACP) handler; external agent event types added to transcript-hydration sets.
- session-mgmt.ts createSession: fork preparation/activation/executionWorktree/incognito + upstream cwd/worktreeCreation/source; pending worktree record placed after the replay early returns.
- v4-bridge.ts / v4-gateway.ts / product-projection.ts (+test): fork + upstream patch (cwd workspace ref, pending input admission, TransactionalMap, steer edit lock test).
- bundled-plugins.ts: upstream async version; upstream dropped filesystem seed hashing, so the fork hash memo and its test are removed.

### desktop e2e (half B)

- v4-stop-queue: upstream + fork STEER cases. archive-management: fork permanent-erase dialog (OPEN: upstream archive confirm flow not ported). tool-discovery-card, workflow-status, marketing: upstream. Locale unions keep uk-UA.
- helpers (v4-conversation, project-sidebar, upstream-replay-server, model-provider-restart): upstream; inline user-query edit moved to upstream composer edit mode.

### UI (packages/ui)

- 31 comment-only files: upstream code with fork English comments; 118 three-way merged.
- ConversationComposer / LexicalChatInput: fork dictation, quick prompts, first-submission flow + upstream voice input (upstream voice input disabled while fork dictation is on — OPEN).
- SessionPane: fork incognito prewarm and create-route send; fork inline queue edit dropped (upstream moved editing into composer edit mode). Attachment ref trust must be re-applied on the composer edit submit path (follow-up check).
- task-row / TaskListItem: fork two-step archive and hover card + upstream rename, archive-blocked-while-running. Upstream TaskRowIdentityHoverCard not mounted (OPEN).
- useArchiveManagement: fork permanent-delete dialog (upstream inline delete preview not used — OPEN).
- Settings / ModelProviderSection: fork resource telemetry, terminal WebGL, coding-plan auto-continue, ACP/Ollama kept.
- WorkspaceShellLayout: fork child-session capability state + upstream worktree picker. Managed vs execution worktree marker: fork wins when both (OPEN).
- Subagent cancel: upstream stop control replaces fork RunningWorkCancelButton. Login error: upstream toast.
- Upstream-deleted renderers (changes/cua/execute groups, conversationCuaGroups, documentHiddenMotionPause) deleted; DeleteAllArchivedTasksButton stays deleted.
- en-US / zh-CN: key union. uk-UA: 568 new keys translated and 57 keys upstream removed are dropped; the long legal/security strings need a native-speaker read.

### desktop e2e (half A)

- composer toolbar, scroll, virtual-project, coding-plan team usage, automations hub: upstream cases ported in English.
- goal-run-cases MR-GOAL-07: upstream expectation (edited queue item stays frozen in place).
- background-bash-output: upstream resumed-message wait gated by fork Node-only log check (Rust runtime).

### Shared, services, bots, packaging, tests

- Shared protocol: `create-session-command.ts` (fork split) carries upstream `cwd`, `worktreeCreation` and
  `firstInput.source`; `command.ts` re-exports `worktreeCreationRecordSchema`. `SharedLocale` excludes uk-UA.
- Services `node.ts`: upstream project services order, fork bots `createBotRemoteWorkspaceService` kept over upstream
  `createBotProjectRuntime`; fork `sourceServerWorkspaceService` registration stays conditional.
- taskIndexRepo: hand-applied merge holding both worktree models (fork `executionWorktree` in `meta_json`, upstream
  `cwd` / `worktree_root`).
- Bots: messages typed by `BotMessageLocale` (zh-CN, en-US, uk-UA).
- Desktop packaging: `prepare-agent-node-bundle.mjs` imports `official-plugin-packages.mjs`, which gains upstream
  `@zcode/design-plugin`. `pnpm-workspace.yaml` sets `core-js: false` (postinstall only prints a banner).
- `fork-upstream-migrations.json` pins the three new upstream migrations (`0025_session_permanent_deletion`,
  `0007_task_permanent_deletion`, `0010_task_worktree_root`); their sources are byte-identical to upstream.
- `mcp-apps/contract.ts`: fork English comments condensed to stay under the 300-line contract limit.
- coding-plan-team-usage e2e: fork-deleted CTP-20..31 cluster stays deleted; upstream CTP-32, CTP-33, CTP-CN-03 added.
- `check-test-copy.mjs`: renamed suites remapped; 40 upstream-3.18 suites listed as verbatim.

## Owner decisions (2026-11-12)

The owner accepted the proposed resolution of all 21 questions. Each entry names the question and the
decision; entries that changed code name the PR change and its test.

Changed code (test written first, then the change):

1. Usage facts: kept forever, as upstream. Node `pruneUsage` / `pruneUsageIfDue` and the `zcode-rs` raw prune
   (#407) are removed; the fork rollup stays for history that builds up to 3.17 already pruned. Tests
   `usage-retention`, `usage_writes_keep_raw_rows_of_any_age`; specs `fork-agent-runtime-selection.md`,
   `usage-observability.md`, `docs/specs/usage-stats-history-and-filters.md`.
2. autoUpdater: no install on quit, as upstream. The `before-quit` handler is removed; every platform installs
   only from the explicit entry. Test `autoUpdaterNoInstallOnQuit`.
3. Web credential read: `loadCachedSessionState` no longer calls `clearAll()` on an expired legacy JWT; it
   returns `reauthentication-required` and changes nothing, as upstream. Test `webOAuthCachedSessionReadOnly`.
4. Voice: one composer mic, fork dictation. Upstream voice input (ASR through zcode-server, needs a ZCode
   account) is never enabled or rendered in the composer; its service stays. Test
   `v4ConversationComposerSingleMic`; spec `voice-dictation.md`. Consequence: the 3.18.1 microphone permission
   guide (`specs/upstream-backport-3.18.1.md` item 4) belongs to the upstream input and is not reachable from
   the composer.
5. context-builder: follows upstream; the four autonomy paragraphs are removed from the fork's editable
   context-management default (`packages/shared/src/system-prompt.ts`), not only from the test.
6. `packages/ui/src/ToolCallBlocks/useStageDurationText.tsx` deleted (fork-only, no consumers).

Recorded, no code change:

3. Web login: upstream (`zai_cn` plus a linked BigModel, `oauth:linked_bigmodel`).
4. Managed worktree vs fork execution worktree: the fork worktree wins (the owner chose the full port).
5. Permanent deletion: the fork erase window stays. Node already uses `session_purge`; Rust is in wave 2
   (`specs/fork-rust-agent-parity.md`). The upstream archive confirm flow is not ported.
6. `TaskRowIdentityHoverCard` stays unmounted; the upstream file is not touched.
7. MR-GOAL-07: upstream (an edited queue item stays frozen).
8. Credential cipher: upstream `enc:v2` by default; fork OAuth corrupt-session recovery kept.
9. uk-UA locale storage: fork routing (`setting.json` is not fork-safe storage).
10. Visualize plugin on by default (#409).
11. Bots: fork (`/remote`, relay V2).
12. zh-CN `noArchivedTasks` takes upstream wording. Owner-side: a native-speaker review of the new uk-UA strings.
13. Closed: composer edit -> `handleEdit` -> `editUserQuery`; Host re-checks attachment refs in
    `sendConversationCommandV4`; the UI shows a toast on rejection (verified by reading the code).
14. Translation debt (upstream documents and comments still in Chinese): a separate task.
15. Bootstrap official plugin build: upstream (clean `dist` every build).
16. Owner-side: confirm `uk.lproj` in a real mac build after the next release.
17. Update release notes: fork D14 fallback (`setting.json` is not fork-safe storage).
