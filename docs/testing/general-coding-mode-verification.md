# General/Coding Mode: Impact and Verification

## Feature Summary

| Field                         | Value                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent / capability | M1: presentation differences and panel retention between general and coding mode                                                 |
| Change layer                  | presentation, option-source, draft-default, validation, persistence                                                              |
| Operating mode                | implementation-handoff; closing verification added against the confirmed product semantics                                       |
| Primary seeds                 | `createZCodeStore`, `useIsGeneralMode`, `useAppPanels`, `ToolCallBlockComponent`, `ConversationRowView`                          |
| Out of scope                  | Model prompts, artifact management, unified file preview, settings button displacement, changing continuous/replayable protocols |

## UI Surface Matrix

| User scenario / UI entry                | Shared implementation                                    | Display/authority owner, default and landing              | Validation / commit action                      | Mode boundary / isolation invariant                                         |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| Appearance setting / avatar menu switch | `settingsCodePreview` / `WorkspaceSidebarFooter`         | ZCodeStore; default coding; localStorage                  | setInterfaceMode / existing broadcast           | Shared by Desktop/Web; does not change task mode, model or permissions      |
| View commands and file changes          | the four `ToolCallBlocks` renderers                      | Original tool nodes; display derived only                 | canToggle/forceOpen, title and detail filtering | Raw results not deleted; file clicks still use the existing preview         |
| Thinking / final answer                 | `ConversationRowView` / `MessageResponse`                | Original row; code preview preference                     | Thinking source display, forceCodeWrap          | Applied while streaming and when complete; never written back to the source |
| Status Git area / turn summary          | `conversationStatusPanelModel` / `ConversationTurnGroup` | Original Git and task projection                          | Hide Git model / summary                        | Does not stop Git queries or rewrite the repo                               |
| New review/terminal                     | `AnimatedSidePanePanel` / quickPick / Terminal           | useAppPanels; existing tabs and terminal state            | Filter options, block creation                  | Already-open items kept; existing close still works                         |
| Open externally                         | `WorkspaceEditorButtonGroup` / openWithEditors           | Installed programs / existing selected preference         | Filtered to file manager                        | Does not override the saved editor preference                               |
| Dev settings isolation                  | SettingService                                           | Explicit home override / fallback to original environment | Existing get/update                             | Compatible with the original path when no override is configured            |

## Shared and divergent behavior

Shared components read the same mode preference. Candidate filtering and display rules run per entry; already-open tabs and terminals keep independent owners. No new remote config, runtime commit action or recovery semantics. The Web limit of no native editor/browser is kept; mobile does not repeat Desktop's native launch capability verification.

## Feature relationships

| Rank           | From -> Semantic edge -> To                                         | Reason and evidence                                           |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| must-inspect   | Preference -> projects-to -> conversation/settings/panel entries    | All `useIsGeneralMode` callers and `createQuickPickCommands`  |
| must-inspect   | Mode switch -> must-not-mutate -> already-open panel state          | `useAppPanels` returns raw `sidePaneState` / `isTerminalOpen` |
| should-inspect | Mode -> projects-to -> code wrapping, Git area                      | `MessageResponse`, `conversationStatusPanelModel`             |
| conditional    | Dev environment -> persists-to -> separate settings directory       | `SettingService.resolveUserHomeDir`                           |
| invariant-only | UI preference -> must-remain-isolated-from -> Agent / remote stream | shared protocol, runtime and relay unchanged                  |
| evidence-only  | Unit tests / pending UI E2E -> covered-by -> cases below            | Unit tests are not remote-control end-to-end proof            |

## State owners and commit sinks

See the state diagram of the [feature spec](../ui/general-coding-mode.md). ZCodeStore owns the mode; useAppPanels/taskSidePaneMemory own panels; TerminalSession owns the PTY; CLI/runtime own raw task data. The settings-service environment fix only changes the config location under an explicit Dev home.

## Must-preserve invariants

A mode switch does not close the PTY, lose tabs or selected items, change source text, change the saved wrap preference or trigger a model request, and does not spread mobile replayable recovery semantics to desktop continuous.

## Codegraph evidence

The tool environment had no codegraph service or CLI, so no depth-2 codegraph scan ran. Exact `rg` and the current diff traced shared symbols, direct callers and tests; code-graph scanning must not be claimed.

## Graph drift candidates / graph delta

The existing semantic graph has no interface mode; capability, preference owner and entry relations are registered for the confirmed scope. The graph does not record the unimplemented proposal "unified opening of file contents by file name". The mechanical resolvability of code seeds is verified separately; codegraph verification stays unavailable.

## Boundary decisions / clarification log

- accepted: the user asked for the names general/coding mode; general hides technical entries and keeps already-open panels.
- accepted: the user confirmed it works and moved to the pre-commit test/doc phase; no proactive commit or push.
- ignored: unified file-name preview; patch/file rules still apply, and the discussion is not taken for new implementation.
- pruned: full permutations of model/provider, since mode does not take part in requests; UI preference and tool-record invariants represent them.
- pruned: full permutations of theme x language x workspace; desktop coverage uses Chinese and the default theme, the remote-identity hook case covers shared-state retention, native multi-platform and mobile remote control are left to real-environment verification.

## Accepted cases / coverage matrix

| ID      | Setup                                              | Action                               | Assertions / non-UI evidence                                                              | Entry and status                 |
| ------- | -------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------- |
| MODE-01 | No value / old value / invalid value               | Initialize and switch                | Default/compat normalization correct, preference saved, broadcast without echo            | unit passed                      |
| MODE-02 | coding, bottom terminal and git/terminal tabs open | coding -> general -> coding          | Same tab id, active item and collapsed state kept; close still works; creation controlled | hook passed; Electron 2/2 passed |
| MODE-03 | general, empty side panel                          | View start page / add / command menu | No review/terminal, new button hidden, browser entry kept                                 | unit passed; Electron 2/2 passed |
| MODE-04 | Execute/modify tool, running/done/failed           | Switch mode                          | Detail visibility changes, failed status kept, raw nodes unmodified                       | unit passed                      |
| MODE-05 | Thinking source wiring, reply with code            | Project and switch back              | Thinking restores raw wiring; reply wrapping does not override the saved preference       | unit passed                      |
| MODE-06 | Git status and installed editors                   | Switch mode                          | Git area hidden, file manager kept                                                        | unit passed                      |
| MODE-07 | Explicit Dev home / normal home                    | Update settings                      | Writes only the target settings path, does not pollute the real home                      | service unit passed              |

## Planning and E2E handoff notes

- Spec location: the Electron spec is the formal `packages/desktop/test/e2e/ui-shell/general-coding-mode.test.ts` (MODE-01 and MODE-02/03); no model request, so no provider response fixture and no `ZCODE_E2E_MANUAL_REVIEW`.
- Existing conversation data rendering is covered by component unit tests; no model output is faked to pose as real network verification.
- E2E uses an independent test home and the framework's run-scoped processes; it does not touch the user's dev instance.
- Docker preset admission has not been executed, so no Docker CI coverage is claimed. `e2e:promote` supports only conversation-session (dry run rejects ui-shell paths), so the spec was moved within its own domain by hand without changing the script.
- Remaining scope: native Windows/Linux, real mobile remote control and code-graph scanning.

## Verification results (outcome)

macOS arm64; baseline sequence 2026-09-11 (`042a36cad2` -> `87d6a7b2fc` staging), MR recheck 2026-09-14 (`c71d91499b`, target `origin/staging` `2408407197`).

- Targeted unit: 8 files / 121 tests pass, covering preference normalization, persistence, broadcast without echo, panel owner, running/done/failed tool display, thinking fence, reply code container/copy/wrap entry, Git projection, editor filtering and Dev home isolation. Related unit (`vitest related --run`) over the working-tree changes passed (410 files, 4119 passed / 3 skipped before the thinking filter was removed). After syncing staging: 413 files, 410 passed / 3 failed with 4 timeouts (auto-update, settings write, SSH config read); a `--maxWorkers=1` rerun of those 3 files passed 93/93 with no timeout loosening. On the MR recheck: 418 files passed (4163 tests, 3 skipped); two remote-control files failed to load because the local Electron executable was missing, and after the E2E bootstrap installed Electron they passed 74/74.
- Standalone Electron: spec 2/2 pass. It really creates review, side terminal and bottom terminal, switches mode, verifies tab id/selected item unchanged, existing PTY output with an independent marker, close works, and settings page / avatar menu / refresh preference. The formal path run (without manual-review) also passed 2/2. The recheck fixed two interaction assumptions in the test itself (the hidden xterm textarea is not directly clickable; clicking before the Radix menu exit animation ends hit the browser entry) by waiting for menu unmount, clicking the visible terminal and checking focus, without product changes or fixed sleeps.
- `pnpm lint` 0 errors (41-42 warnings), `pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm architecture:check --changed` (0 violations), `git diff --check`, baseline freshness check pass. `pnpm verify:pre-push` passed but its affected phase was skipped because no commit existed yet; real push still goes through the hook. Format check of 44 changed files passed; three large existing catalog/matrix docs already had format issues on HEAD and only a coverage index was appended.
- The conversation coverage audit fails; with all changes of this round reverted to HEAD the output was identical, so it is pre-existing statistics/generated-doc drift, not newly introduced.
- After removing thinking code filtering (latest product decision): the thinking filter function and its 7 filter tests were deleted, `ReasoningRowView` restored to the staging raw wiring, Markdown rendering/collapse unchanged (3 files / 83 tests pass). After reverting the answer-file-link context-menu mode filter (answer file links and the left-sidebar file tree keep the full external-app candidates and remote availability limits; the top "Open" button filter stays; 3 files / 48 tests pass), lint, typecheck, architecture check and `git diff --check` pass. The Electron E2E predates these removals and was not rerun for them.
- Run recipe (clean build, repo dependencies installed):

```bash
ZCODE_E2E_MANUAL_REVIEW=1 \
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$PWD/config/provider/zcode-builtin.json" \
  mise exec -- pnpm --filter @zcode/desktop test:e2e -- \
  --spec './test/e2e/ui-shell/manual-review/pending/general-coding-mode.test.ts'
```

The explicit provider config keeps startup from falling back to remote config initialization that cannot complete; it changes no model response and sends no conversation request. After a full E2E build, test-only changes may reuse it with `ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1`. (The spec has since been promoted; its pending path above is the historical recipe.)

- Failure diagnosis kept for reference: the initial run stalled on startup config initialization; one WebDriver session creation timed out; the first test draft opened the Radix trigger with a DOM click and switched consecutively without waiting for the old menu to exit. Final tests use real clicks and wait for the old menu to unmount, with no fixed sleep and no product change for test issues.

## Coverage not claimed

Native Windows/Linux runs, real mobile remote control, other languages/themes, Docker replay/CI admission are unverified. The recheck covers macOS, Chinese, default dark theme. Unified file-link preview stays out of scope. The `mode-output-demo1/` directory is a manual test artifact kept locally and excluded from commits.
