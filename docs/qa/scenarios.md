# Desktop QA scenario catalog

Manual (agent-driven) scenarios for the dev desktop app, driven over CDP with `agent-browser`. Used by `desktop-qa-orchestrator-prompt.md` (full sweep) and `desktop-qa-verifier-prompt.md` (re-checks). Issues go to `issue-ledger.md` and cite the scenario ID.

## How to read a case

Each case has a stable ID (`SB-` sidebar, `CP-` composer, `CH-` chat, `SP-` side panes, `ST-` settings, `MS-` sessions, `MI-` misc), a tier, steps, the expected result, the selectors to use, and the spec that defines the rule. A case passes only if the expected result holds **and** the log watcher reports no new error/`FAIL`/`ok:false`/`AppErrorBoundary` lines and no renderer block > 1 s during the case.

Tiers: **P0** = sidebar, composer, chat core (run all, first). **P1** = side panes, settings, session tables. **P2** = everything else. Within a tier run in the listed order: later cases reuse sessions created earlier.

`(regression ISSUE-NNN)` marks a case that re-checks a fix from earlier rounds (`docs/plans/2026-10-21-qa-findings.md`).

## Selector rules

- Test ids come from `packages/shared/src/test-ids.ts` (`testId(a, b)` renders `a-b`). `docs/conversation-session-ui-testid-contract.md` is **stale**: it lists ids that nothing renders (`chat-view`, `chat-messages`, `v4-retry`, `v4-timeline-load-older`, `chat-queue-*`, …). Never use it.
- Composer: several composers can be mounted (split panes, side chats). Scope every composer selector to the visible `[data-testid="v4-composer"]`. While a permission/question card is open the composer stays mounted with `display:none`.
- Composer state without opening menus: hidden span `[data-testid="v4-model-config"]` with `data-provider`, `data-model`, `data-thought`, `data-mode`, `data-plan-enabled`, `data-usage-used`, `data-usage-max`. Routing: `[data-testid="v4-composer"]` `data-input-routing` = `startNow|enqueue|guide|choice|reject`.
- Typing: `agent-browser keyboard type` / `press` (real key events) or the Lexical bridge on the visible composer `[...document.querySelectorAll('[data-testid="v4-composer"]')].find((e) => e.offsetParent)?.querySelector('[data-testid="v4-composer-input"]').__zcodeLexicalInputE2E.setText("…")` (attached in dev builds; `document.querySelector` would take the first, possibly hidden, composer). Never set `textContent`/`innerHTML`.
- Timeline rows: `[data-row-id][data-testid^="v4-row-"]` (plain `^="v4-row-"` also matches `v4-row-attachments-*`). User rows have `v4-edit-<row>`, assistant rows have `v4-fork-<row>`.
- Timeline state: `[data-testid="v4-timeline"]` `data-row-count`, `data-total-row-count`, `data-following`, `data-loading-older`.
- Grouped and long lists are virtualized: scroll the row into view before querying it.
- Permission prompt: clicking an unselected option only selects it; click it again or press the `aria-label="Confirm"` button.
- Context-menu content mounts lazily: open the menu, then snapshot.
- Freeze measurement: before a case, `agent-browser eval` a `PerformanceObserver({type:"longtask", buffered:true})` that pushes `{t,d}` (t = startTime ms, d = duration ms) into `window.__qaLongTasks`; read and clear it after the case. Record the worst block for perf cases.

## Fixtures the cases assume

- `QA_REPO` = `~/qa-sandbox/zcode-qa-repo`: git repo with `README.md`, `src/math.js`, `notes.md`, branches `main` and `feature/qa-branch`, one commit each. Added to the app as project `qa-sandbox`. All git/destructive actions happen only here.
- Every session, project and group the run creates is titled with the prefix `qa-` (rename after creation when the title is generated).
- Chat prompts are short and deterministic ("Reply with exactly the word pong."). Use the cheapest model in the picker unless the case says otherwise.

---

## Catalog corrections (run 2026-10-22)

- Project row ids have no `<id>` suffix: `virtual-project-edit`, `virtual-project-pin`, `virtual-project-delete`, `virtual-project-manage-sessions`, `virtual-project-create-task`.
- `Ctrl+Shift+M` cycles permission modes (it does not open the menu). A mouse click on a permission option answers immediately.
- "Show less" exists only for the pinned block; project lists only grow with "Show more".
- The mention panel is virtualized: scroll it before counting rows (ISSUE-038).
- `destination-worktree-status` does not exist.
- There is no font-family control in Appearance; interface zoom lives in the profile menu (`sidebar-interface-zoom-trigger`).
- Harness: never send `Meta+<key>` over CDP except renderer-handled shortcuts (⌘K, ⌘B, ⌘F, ⌘[ ⌘], ⌘,) — others trigger the native menu's About (ISSUE-030). Select-all = `document.execCommand("selectAll")`.
- Harness: run the dev app with the local `ZCODE_QA_NO_OCCLUSION=1` switch (never committed) or keep the window unoccluded; check a rAF probe before UI cases (ISSUE-034).
- Harness: attach with `agent-browser --session qa --cdp 9229 --pin-tab`; without `--pin-tab` opening the in-app browser moves the session to the webview target. After `close`, `connect 9229` launches a new Chrome; use `--cdp` instead.
- Harness: `agent-browser mouse wheel` does not scroll the chat timeline; send a raw CDP `Input.dispatchMouseEvent` `mouseWheel`.
- Harness: Radix menus/popovers need real pointer events (move/down/up at the element centre); HTML5 drag needs synthetic DragEvents sharing one DataTransfer.
- Harness: a Vite hot update of a context provider can crash the sidebar with `project.directory-provider-required` ("Could not Fast Refresh"); reload the renderer or restart before judging.
- Watch the installed upstream app's log (`~/.zcode/v2/logs/<date>.log`) for `failed schema validation|writing settings to` during any settings case.

## P0-A Sidebar

**SB-01 · Shell controls**

- Steps: with a session open, check each control: `task-new-button` (and ⌘N), `automations-open`, `plugin-store-sidebar-open`, `sidebar-search-open` (and ⌘K, ⌘⇧P), `task-settings-button` (and ⌘,), sidebar collapse (⌘B and `desktop-top-logo-sidebar-toggle` / "Toggle sidebar"), resize separator `role=separator` "Resize sidebar" (drag; ArrowLeft/Right, Home, End).
- Expected: each opens its target (new draft, Automations page with `aria-pressed=true`, Plugin Marketplace, Command Center dialog, Settings); collapse/expand restores the same width; resize clamps at min/max and persists after restart.
- Spec: `specs/sidebar-ui-polish.md`, `specs/workspace-sidebar-customization.md`.

**SB-02 · Views**

- Steps: `sidebar-view-menu` → `sidebar-view-projects`, `sidebar-view-grouped`, `sidebar-view-timeline`; restart the app.
- Expected: each view renders the same tasks; the chosen view survives restart; switching view blocks ≤ 200 ms (regression: 173 ms on 1949 tasks).
- Spec: `packages/ui/src/project-sidebar/CONTRACT.md`.

**SB-03 · Project rows**

- Steps: `virtual-project-add` → ProjectEditor → add `QA_REPO` as `qa-sandbox` (folder picker is native: if it blocks, add the project through `composer-workspace-trigger` → `composer-create-project` or ask the user once); `virtual-project-toggle`, `virtual-project-toggle-all`; hover → `virtual-project-actions`: `virtual-project-create-task`, `virtual-project-files`, `virtual-project-menu`; menu items `virtual-project-<id>-edit` (rename to `qa-sandbox-renamed` and back, change color), `-pin` / unpin, `-manage-sessions`, `-open-on-github` (only if a GitHub remote exists); drag the project within its bucket.
- Expected: project appears once; expand state persists; edit/pin apply immediately and persist; "Manage sessions" opens Settings › Sessions filtered to the project; a collapsed project with an unread task shows `virtual-project-unread`; reorder persists and never crosses pinned/unpinned buckets.
- Known: `-delete` runs with no confirmation — test only on a throwaway `qa-delete-me` project, record as `decision-needed` (see ledger), do not fix.
- Spec: `docs/specs/project-editor-dialog-ui.md`, `docs/specs/project-creation-folder-confirmation.md`.

**SB-04 · New task outside a project** (regression ISSUE-011, ISSUE-009)

- Steps: `virtual-project-new-task` → composer shows "Select project"; model chip is a real model, not "Choose model"; send "Reply with exactly the word pong."; rename the task to `qa-outside`.
- Expected: Send accepted immediately; row appears in the Tasks section ≤ 300 ms; reply arrives; no `project.not-found` in logs; the draft never appears in another session's composer.
- Spec: `specs/sidebar-new-task-outside-project.md`.

**SB-05 · Task row states**

- Steps: open a `qa-` task; start a run in it and watch the row; finish; let another task finish in the background; wait 70 s.
- Expected: spinner while running; `[data-unread-indicator]` on the background task until opened (opening clears it); `[data-error-indicator]` after a failed turn; badges render when applicable: `[data-worktree-task-icon]`, `[data-incognito-task-icon]`, `[data-task-pr-stage]`, diff `+N -N`; relative time advances within 70 s with no interaction (regression ISSUE-013).
- Known spec mismatch: on hover the pin button replaces the run indicator (`task-hover-card-layout.md` #8 says indicators stay visible) — confirm and record as `decision-needed`.
- Spec: `specs/sidebar-ui-polish.md`, `specs/worktree-icon-visibility.md`, `specs/merged-session-highlight.md`.

**SB-06 · Two-step archive**

- Steps: hover a `qa-` row → `task-archive-<id>` (button turns into destructive "Confirm") → press Esc; arm again → pointer-down elsewhere; arm again → mouse-leave → click Confirm.
- Expected: Esc and outside pointer-down disarm; mouse-leave does not; Confirm archives; the task is listed in Settings › Archive (`archive-task`) and `archive-unarchive` restores it to the same place.
- Spec: `specs/ui-accidental-action-guards.md`.

**SB-07 · Task context menu**

- Steps: right-click a `qa-` row; exercise: Move to group (`task-group-move-menu`, `[data-task-group-target]`) and Remove from group (`task-group-remove`); Pin/Unpin; Rename (dialog: unchanged title → no-op; new title `qa-renamed`); Archive/Unarchive; Mark as unread; Open in split view (`v4-task-open-in-split`; only in the project/pinned/timeline row menu and only in the desktop shell, not in the grouped view or the header menu); reveal in Finder; Copy path / Copy task path / Copy log path / Copy session ID; Go to config; View model trajectory (`task-view-model-trajectory`); Report issue (do not submit); PR items on a worktree task.
- Expected: every item acts and toasts where applicable; copy items start disabled and enable once paths load, clipboard content is correct (`agent-browser eval "navigator.clipboard.readText()"` or paste into the composer); **rename does not move the row to the top or change its time label** (regression ISSUE-014 / invariant I6); mark-unread survives reopening the sidebar.
- Known: "Delete task" is not in the sidebar or header task menus (`session-deletion-cascade.md` expects it); deletion exists only in Archive management (see CH-02) — confirm, `decision-needed`.
- Spec: `docs/session-management` skill invariants, `specs/sidebar-pr-status.md`, `specs/session-deletion-cascade.md`.

**SB-08 · Hover card**

- Steps: hover a `qa-` row ≥ 300 ms in project view and in grouped view.
- Expected: `[data-task-hover-card]` with title, worktree/incognito markers, time, branch with `+N −N`, provider/model/effort, PR section (`[data-task-hover-pr=list|unavailable]`); `data-task-hover-status` matches the run state (regression ISSUE-006 for grouped view).
- Spec: `specs/task-hover-card-layout.md`.

**SB-09 · Grouped view**

- Steps: grouped view → `task-group-add` → inline rename `task-group-title-input` to `qa-group` (Enter commits; repeat with Esc to cancel) → color `task-group-color-trigger` / `task-group-color-<color>` → `task-group-new-task` → drag a `qa-` task into the group and back → `task-group-toggle-all` → group context menu: Rename (`task-group-rename`), Ungroup (`task-group-ungroup`) → `grouped-draft-task` close button; child-sessions marker `button[data-child-sessions-marker]` on a task with subagents/forks.
- Expected: changes persist across view switches and restart; drag never leaves a ghost row; new task in group lands in the group; system groups (cron, off-peak) have no rename/ungroup; live overlay fields (incognito) are shown only in the flat list (known, not a bug).
- Spec: `specs/sidebar-child-conversation-counts.md`, `specs/ui-sidebar-fork-reapplication.md`.

**SB-10 · Pinned block and paging**

- Steps: pin 2 `qa-` tasks → `project-pinned-tasks`; project with > 5 tasks → Show more (`[data-task-list-show-more]`) / Show less; timeline view → `[data-timeline-date-heading]`, scroll to page past 20 rows.
- Expected: pinned order stable; paging adds 5 (projects) / 20 (timeline) without jumps; unpin returns the row to its time position.
- Spec: `specs/ui-pins-upstream-migration.md`.

**SB-11 · Navigation shortcuts**

- Steps: open 3 sessions in sequence; ⌘⇧[ / ⌘⇧] (prev/next conversation); ⌘[ / ⌘] (back/forward).
- Expected: active row and pane follow; no draft text is lost while navigating.

**SB-12 · Drag and drop**

- Steps: drag a `qa-` task row onto another project (`project-session-drop-target`, `project-drop-indicator`); drag a row onto the workbench (split).
- Expected: folder outside the target roots → "Add folder to project" confirm, Cancel leaves everything unchanged; drop on workbench opens a split pane (or is refused when the session is already in a pane).

**SB-13 · Command Center search** (regression ISSUE-020, pack 3)

- Steps: ⌘K → type part of a `qa-` title from another project; type fast 10 characters.
- Expected: results from every local workspace with project labels; query settles after ~200 ms; no block > 100 ms while typing; Enter opens the task.
- Spec: `specs/task-search-debounce.md`.

**SB-14 · Sidebar perf at real scale**

- Steps: only if a large index is available (the user's real index copy): switch views, scroll 4 × 1500 px, expand all projects.
- Expected: worst block ≤ 200 ms per action (round-2 baseline: grouped 173 ms, timeline 65 ms, scroll 0 long tasks).

## P0-B Composer

**CP-01 · New-task vs follow-up composer**

- Steps: open a new draft (⌘N) in `qa-sandbox`; open an idle existing session; start a run and look at the follow-up composer.
- Expected placeholders: new task `chat.placeholder.newTask` text; idle follow-up "Ask for follow-up changes"; running "Keep typing to queue follow-up changes". Draft-only header row (project menu, destination, incognito) and suggested prompts only on the new-task draft.

**CP-02 · Send basics** (regression first-submission)

- Steps: empty input → `v4-composer-send` disabled; type; Shift+Enter inserts a newline; Enter sends; on a fresh draft double-click Send quickly.
- Expected: one user row, one turn, one CLI command (check `[rpc:call]` lines: exactly one send); optimistic user bubble appears instantly; sidebar row ≤ 300 ms; reply ≤ 15 s on the cheap model (provider latency varies; > 30 s is a failure).
- Spec: `specs/first-submission-instant-ux.md`, `specs/first-submission-lifecycle.md`, `specs/ui-draft-send-path.md`.

**CP-03 · Model and effort picker**

- Steps: `chat-model-select-trigger` (also Ctrl+M) → provider submenu `composer-provider-trigger` / `composer-provider-back` → pick the cheapest model (`chat-model-select-item-<value>`) → effort slider `composer-thought-slider` → close; Ctrl+T cycles effort.
- Expected: `v4-model-config` attributes change accordingly; focus returns to the same composer input after close; the choice is remembered for the next new task ("Recent"); a session keeps its own model.
- Spec: `specs/composer-picker-focus-restore.md`, `docs/chat-model-change-notice.md`.

**CP-04 · Mode and Plan**

- Steps: `chat-mode-select-trigger` (also Ctrl+Shift+M) → `chat-mode-select-item-build` ("Ask before changes"), `-guarded` ("Autonomous mode"), `-yolo` ("Full access"); toggle `chat-mode-select-item-plan` → `v4-composer-plan-marker` → its remove button.
- Expected: `data-mode` / `data-plan-enabled` follow; Full access label is warning-colored; Plan marker removes Plan for the next submission only.

**CP-05 · Project menu**

- Steps: on a new draft `composer-workspace-trigger` → `composer-project-menu`: `composer-work-outside-project`, back to `qa-sandbox`, `composer-project-detach`, `composer-edit-project`, `composer-create-project` (cancel), `composer-remote-connection` (cancel).
- Expected: header label follows the selection; detach shows "Select project"; cancel paths leave no project/connection behind.

**CP-06 · Destination: worktree and branch** (sandbox only)

- Steps: in `qa-sandbox` open the destination trigger ("Choose where this task runs") → switch Worktree on → status `destination-worktree-status` → send "Reply with the current git branch name only." → rename `qa-worktree`; new draft → Worktree off → task branch `feature/qa-branch` → send → "Switch branch?" guard → confirm; try a branch that is checked out in another worktree.
- Expected: worktree created under `<repo>-worktrees/`, header chip "Worktree · branch", agent reply = that branch; branch case checks out at send time; branches used by another worktree are disabled; a forced creation failure (e.g. `chmod 555` on the `-worktrees` parent) must render the setup error with Retry/Cancel inside the failed session's timeline and survive navigation away (`specs/composer-worktree-setup-steps.md`); the `worktree-failure-modal` belongs to the worktree-RETURN failure flow, not creation failures.
- Spec: `specs/composer-destination-control.md`, `specs/composer-branch-switcher-semantics.md`, `specs/composer-worktree-setup-steps.md`.

**CP-07 · Incognito** (regression ISSUE-022)

- Steps: new draft → `v4-composer-incognito-trigger` → marker `v4-composer-incognito-marker` → capability checkboxes `v4-composer-incognito-capability-<key>` (toggle two) → `v4-composer-incognito-off` (hover) → on again → send pong → rename `qa-incognito`.
- Expected: input border uses the incognito color; sidebar row shows `[data-incognito-task-icon]` (flat views) right after send and after restart; control hidden after the first submission and for existing sessions.
- Spec: `specs/incognito-session.md`.

**CP-08 · Plus menu**

- Steps: `chat-attachment-button` ("Add context") on an empty draft; navigate with ↑/↓/Enter; check Attachments (`chat-attachment-menu-item`), Goal, Workflow, Plugins, Files, Sessions sections; type text, reopen.
- Expected: Goal only on a new session with empty draft; Goal/Workflow hidden once text exists; selecting Files/Sessions inserts a chip.
- Spec: `docs/ui/chat-composer-action-menu.md`.

**CP-09 · Attachments** (no native picker)

- Steps: synthetic paste of a PNG (`agent-browser eval` dispatching a `ClipboardEvent('paste')` with a `DataTransfer` file) → chip `v4-attachment-<id>` with `data-upload-status` → preview on click → "Remove attachment"; paste 9 small images; paste ≥ 15 KB plain text; send with an attachment and no text.
- Expected: progress then ready; 9th shows toast "You can attach up to 8 attachments"; long text becomes a text-file attachment; attachment-only send works and the user row shows `v4-row-attachments-<row>`.
- Spec: `docs/ui/chat-file-attachments.md`, `docs/ui/chat-long-paste-text-attachment.md`.

**CP-10 · Mentions and slash commands**

- Steps: type `@` → `prompt-suggestion-panel` → pick a file from `qa-sandbox`; `#` → a session; `$` → a skill; `/` → a command (`prompt-suggestion-option-slash:<name>`); Esc dismisses; Backspace right after a chip deletes it; Option+→ skips over a chip.
- Expected: sections render with options; Enter/Tab insert; Esc keeps the typed token; sending a message with a file mention shows the mention in the user row.
- Spec: `docs/ui/slash-command-skill-suggestions.md`.

**CP-11 · Prompt history**

- Steps: send two messages in a session; empty input → ↑ ↑ ↓; force a failed send (CP-14) and check history.
- Expected: history walks the sent prompts newest first, only when the input is empty; failed sends are not recorded; consecutive duplicates collapsed.
- Spec: `docs/ui/composer-prompt-history.md`.

**CP-12 · Drafts** (regression ISSUE-009, ISSUE-019)

- Steps: type "qa draft A" in session A; switch to session B, type "qa draft B"; back to A; restart the app; open A and B; in a new-task draft type text and switch project; change only the model in an empty composer and restart.
- Expected: each scope keeps its own text across navigation and restart; a failed send restores the text only into its own scope; empty drafts and model-only changes are not persisted; a draft whose project was deleted restores with no project instead of failing prewarm (`project.not-found` absent from logs).
- Spec: `docs/ui/composer-text-draft-persistence.md`, `specs/ui-draft-send-path.md`.

**CP-13 · Running state, stop, queue** (regression ISSUE-010, pack 3)

- Steps: send a long prompt ("Count from 1 to 200, one number per line."); while running: type and send twice → `v4-queue` with two `v4-queue-item-<id>`; drag reorder; `v4-queue-item-edit-<id>` (empty composer, then with text in the composer); `v4-queue-item-delete-<id>`; `v4-queue-item-send-now-<id>` ("Steer"); press `v4-stop` (and Esc in a second run) with one item queued; then `v4-queue-resume`; with the queue paused type and Send → `v4-paused-queue-send-dialog` → test both `v4-composer-clear-queue-send` and `v4-composer-keep-queue-send`; ⌘Enter while running.
- Expected: Stop truncates the reply and returns Send; **a queued item does not auto-send after Stop**: `v4-queue-paused-banner` appears and the queue runs only after "Continue"; Edit puts text back (toast if composer non-empty); Steer runs the item now; ⌘Enter uses the opposite routing; no duplicate sends.
- Spec: `specs/stop-queue-hold.md`, `docs/ui/chat-message-queue.md`, `docs/conversation-session-case-catalog.md` B01–B09.

**CP-14 · Send failures and blocked sends**

- Steps: send with attachments still uploading; send in a session whose device/host is unavailable (if reproducible); first-submission outcome unknown → `composer-held-unlock` → `composer-held-unlock-warning` → cancel and confirm.
- Expected: `composer-send-blocked-reason` with a readable reason and one deduped toast; "Failed to send. Try again later." restores the draft; never a silent no-op (regression ISSUE-011).

**CP-15 · Context usage**

- Steps: hover `chat-context-usage-trigger` in a session with a few turns.
- Expected: "Context windows" panel with per-source breakdown and Auto-compact; numbers match `v4-model-config` `data-usage-used/max`; refresh action (Coding Plan users) cycles spinner → check.
- Spec: `docs/chat-context-usage-refresh-action.md`, `docs/context-window-usage-state.md`.

**CP-16 · Suggested prompts**

- Steps: new draft in `qa-sandbox` → click a suggested prompt; type text first, then click another.
- Expected: the prompt replaces the draft and never auto-sends.

**CP-17 · Composer keyboard**

- Steps: IME-like composition is out of scope; check Enter while sending is blocked inserts a newline; Esc closes an open mention panel without stopping the run; Esc with no panel stops the run.
- Spec: `packages/shared/src/shortcutCommands.ts`, `docs/elicitation-keyboard-behavior.md`.

## P0-C Chat

**CH-01 · Streaming and message rendering**

- Steps: ask for "a short markdown answer with a heading, a list, a table and a JavaScript code block"; on a reasoning-capable cheap model ask something that thinks.
- Expected: `chat-loading` while streaming; markdown renders progressively without layout jumps; code block "Copy code" copies, "Wrap lines" toggles, highlighting appears after streaming; `chat-reasoning-trigger` shows "Thinking" then "Thought for Ns" and auto-collapses; "Worked for" `chat-assistant-history-trigger-<key>` expands/collapses.
- Spec: `docs/streaming-markdown-reveal.md`, `docs/chat/reasoning-streaming-auto-collapse.md`, `docs/chat/assistant-streaming-text-rendering.md`.

**CH-02 · Session header**

- Steps: `workspace-title`; `workspace-path` tooltip; `workspace-more-button` menu (dry run 2026-10-22 saw: Pin task, Rename task, Archive task, Mark as unread, Open in Finder, Copy path, Copy task path, Copy log path, Copy session ID, Go to config, View model trajectory, Report issue — do not submit); Archive opens "Archive this task?" (Cancel / Archive task); `terminal-toggle`; `side-pane-toggle`; `conversation-share-trigger` only to open/close (never publish without asking the user).
- Delete path: there is no "Delete task" in the header or sidebar menus. Delete through Settings › Archive management: expand the group heading (rows are not rendered while collapsed), `archive-task` row → `archive-delete` → "Delete 1 session?" → "Delete 1". Only on `qa-` sessions.
- Expected: actions match the sidebar menu behavior; archive removes the row from the sidebar; delete cascades (gone from archive and Manage sessions); title updates everywhere after rename.
- Spec: `specs/session-deletion-cascade.md` (expects a Delete entry with confirmation in the task menus: mismatch, `decision-needed`).

**CH-03 · Message actions**

- Steps: on a finished turn: `v4-copy-<row>`; `v4-feedback-like-<row>` then again (clears), `v4-feedback-dislike-<row>`; `v4-pin-<row>` on a user and an assistant row → `v4-pinned-bar` → `v4-pinned-chip-<row>` jumps → `v4-pinned-chip-unpin-<row>`; `v4-edit-<row>` → `v4-edit-input-<row>` change text → `v4-edit-submit-<row>`; again with `v4-edit-rewind-workspace-<row>` on a turn that edited a file in `qa-sandbox` (conflict dialog `v4-edit-workspace-conflict-dialog` when files changed after).
- Expected: copy says "Copied"; feedback `aria-pressed` toggles and survives reopen; pins survive restart and highlight in the turn navigator; edit resends from that point; rewind restores files per the dialog choice.
- Spec: `docs/chat-message-pins.md`, `docs/rewind-button-any-message.md`, `specs/turn-navigator-pin-highlight.md`.

**CH-04 · Fork** (regression ISSUE-015, ISSUE-018)

- Steps: `v4-fork-<row>` on an assistant row → new session opens with history → send pong → rename `qa-fork`.
- Expected: first send succeeds (no `project.host-mismatch`); fork row appears in the sidebar under the same project; `[data-marker-type=forkNotice]` "Forked from conversation" navigates to the parent.

**CH-05 · Tool-call cards** (sandbox, mode "Full access" or approve prompts)

- Steps: ask: "In this repo run `ls`, read src/math.js, then add a function `square` to it." Then expand each card.
- Expected: `chat-tool-call-block-<id>` per call with `data-status`; `tool-summary-trigger-<id>` expands; bash shows `execute-command` and output (`bash-result-output`); read and search cards render; edit shows an inline diff; per-turn `chat-change-summary-toggle-files-button-<msgId>` undoes the change (undo only: the panel then shows "Undone" with Undo disabled; there is no Reapply — ISSUE-041 decision, matches upstream V4) and "Review" opens the diff.
- Spec: `docs/agent-tool-call-renderer.md`, `docs/ui/tool-inline-diff.md`, `docs/chat/execute-tool-call-grouping.md`, `specs/message-change-summary-tree-view.md`, `docs/rewind-button-any-message.md`.

**CH-06 · Permission prompt**

- Steps: mode "Ask before changes" → ask to create `qa.txt` → prompt "Permission required": select `[data-permission-option-kind=allowOnce]` + Confirm; next request → `allowAlways` ("Always allow in this project"); next → deny with feedback text in "Tell the model what to do instead..." and Enter; keyboard 1–3 + Enter.
- Expected: sidebar row shows "Awaiting approval" while pending and clears after; allow runs the tool; always-allow suppresses the next identical prompt; deny passes the feedback to the model; no stuck composer (`display:none` is lifted).
- Spec: `docs/permission-project-approval.md`.

**CH-07 · AskUserQuestion**

- Steps: "Before answering, ask me one multiple-choice question with the AskUserQuestion tool." → answer single-select; repeat with multi-select and free text; Previous/Next; Dismiss; let the countdown pill show and press "Stop timer".
- Expected: answers reach the model; Dismiss resolves without an answer; meaningful input snoozes auto-resolution.
- Spec: `docs/ask-user-question-auto-resolution.md`, `docs/elicitation-keyboard-behavior.md`.

**CH-08 · Errors and resume**

- Steps: provoke an error the cheap way (select a model of a provider without credentials if one exists, or disconnect network for one send if the user allows); then fix and press "Resume".
- Expected: `chat-error-banner[data-error-code]` with Show details (`chat-error-details-button`), Copy, Report issue, Resume, Dismiss; Resume sends "Continue from where you left off"; banner clears on the next turn start; `model_config_missing` shows "Set" instead of Resume.
- Spec: `specs/chat-error-resume.md`, `docs/chat/error-banner-restore-dismissal.md`.

**CH-09 · Subagents**

- Steps: "Use a subagent (Task tool) to list the files in this repo, then summarize." → click the subagent row.
- Expected: single summary row with agent name, tokens, duration; `v4-subagent-open-side-pane-<childSessionId>` opens a read-only "Subagent" side tab; sidebar child-sessions marker counts it.
- Spec: `specs/subagent-inline-token-usage.md`, `docs/subagent-session-side-tabs.md`.

**CH-10 · Model switch mid-session**

- Steps: in a session with one turn switch the model (second cheap model) → send pong.
- Expected: immediate toast; timeline marker `[data-marker-type=modelChange]` "Model switched {from} → {to}" after the next prompt; the new model answers.
- Spec: `docs/chat-model-change-notice.md`, `docs/ui/model-switch-toast.md`.

**CH-11 · Scroll, load older, turn navigator** (regression pack 2)

- Steps: in a long session (≥ 20 queries; create one by sending short prompts or use an existing long session): scroll up → `v4-timeline-bottom` appears (`data-following=false`) → click; scroll to the top until `data-loading-older` flips and `data-total-row-count` grows; `v4-turn-navigator` → `v4-turn-navigator-item-<key>` jumps 10 → 20 → 1.
- Expected: no scroll jumps while streaming at the bottom; load older keeps the viewport anchored; jumps land on the query; worst block per jump ≤ 300 ms (baseline 254/62/246 ms).
- Spec: `docs/ui/chat-scroll-bottom-pinning.md`, `docs/ui/conversation-turn-navigator.md`, `docs/ui/chat-virtual-scroll.md`.

**CH-12 · Find in conversation**

- Steps: ⌘F → "Search messages..." → query with several hits → Enter / Shift+Enter → scope toggle "Search file changes" → Esc.
- Expected: counter "{current} / {total} results" updates; hits highlight and scroll into view; Esc closes only the find bar.
- Spec: `docs/ui/task-find-dialog.md`, `docs/v4-session-find-highlight.md`.

**CH-13 · Split view**

- Steps: open a second session in split (sidebar row context menu in project or timeline view → `v4-task-open-in-split`; if absent, drag the row onto the workbench as in SB-12) → drag `v4-split-divider` → send in each pane → `v4-split-close`.
- Expected: each pane has its own composer and draft; closing a pane keeps its session running; cross-workspace pane shows `v4-pane-workspace-badge`.
- Spec: `docs/v4-split-pane-workbench.md`.

**CH-14 · Status panel**

- Steps: in a worktree session with changes: `chat-summary-panel` collapse/expand; "Changes" → Review tab; branch switcher ("Switch Git branch"); ask the agent to run `sleep 30` in the background → `background-bash-open` → output tab (`background-bash-details`); cancel background work `v4-background-work-cancel-<id>`.
- Expected: counts in `data-running-terminal-count` / `data-running-agent-count` follow; output tab streams; cancel stops it.
- Spec: `docs/ui/chat-summary-panel.md`, `docs/background-bash-output-details.md`.

**CH-15 · Selection tooltip**

- Steps: select text in an assistant message → add to current task; ask in side chat.
- Expected: a context chip appears in the composer; side chat opens or shows its blocked reason.
- Spec: `docs/ui/conversation-selection-side-chat.md`.

**CH-16 · Resume after restart and long-session open** (regression pack 2)

- Steps: restart the app while a `qa-` session is idle → open it → send pong; open the longest available session from the sidebar and measure.
- Expected: history intact, continues in the same session; worst block on open ≤ 300 ms (baseline 150–188 ms on 1052 messages).

**CH-17 · Model trajectory viewer** (regression ISSUE-023, pack 3 deltas)

- Steps: View model trajectory on a session with several turns → show next rows → search → `model-trajectory-refresh`.
- Expected: opens ≤ 300 ms worst block; rows beyond 40 collapsed with "show next"; inputs reconstructed from deltas match a full record (no missing rows); refresh works.
- Spec: `docs/model-trajectory-viewer.md`, `specs/model-trajectory-input-deltas.md`.

## P1 — Side panes, settings, session tables

**SP-01 · Side-pane tabs**: `[data-side-pane-add-tab-trigger]` → each `[data-side-pane-open-tab-item=files|review|terminal|browser|model-trajectory]`; switch and close tabs. Expected: one tab per kind where specified, state kept when switching sessions. Spec: `docs/ui/side-pane-tabs.md`.

**SP-02 · Review pane**: `git-pane` scopes Unstaged / Staged / All branch changes / Last turn, "Group by directory", per-file diff, Refresh. Expected: lists match `git status` in the worktree. Spec: `specs/review-reliability-fixes.md`, `specs/review-tab-directory-grouping.md`.

**SP-03 · Git tools** (sandbox only): `git-action-trigger` → `git-commit-dialog` → `git-commit-generate-button` → `git-commit-include-unstaged` → `git-commit-action-item-commit`; detached HEAD in the sandbox → warning. Never push. Expected: commit lands in the sandbox worktree (`git log -1`). Spec: `specs/git-commit-detached-head-warning.md`.

**SP-04 · Terminal**: `terminal-toggle` → `pwd`, open a second terminal tab, close with `terminal-close-button`. Expected: cwd is the session's worktree. Spec: `specs/terminal-worktree-working-directory.md`, `docs/ui/side-pane-terminal-tabs.md`.

**SP-05 · Files tree**: `workspace-file-tree-panel`, `workspace-file-tree-refresh-button`, open a file, drag a row into the composer → @-mention ("Drop to mention this file or folder").

**SP-06 · Browser pane**: `browser-address-input` → a public page → back/forward/refresh → an unreachable URL → `browser-load-error`.

**ST-01 · Settings sweep**: back up `~/.zcode/v2/setting.json` first. The file is shared with the installed app: theme, locale and font changes show up live there too, so revert each change right after checking it. Open every settings section; switch theme, font family, interface zoom, locale (uk-UA and back — **skip while an upstream build shares `setting.json` unless ISSUE-045 is fixed**: upstream rejects `uk-UA` and rewrites the whole file with defaults; also tail the installed app's log for `failed schema validation|writing settings to` during this case), ask-user-question auto-resolution switch (`settings-ask-user-question-auto-resolution-switch`); revert each. Expected: every section renders with no console error; uk-UA has no untranslated keys on the pages visited; after the reverts, `diff` against the backup shows only keys the installed app changed meanwhile.

**ST-02 · Model providers**: Settings › Model provider: provider status, Coding Plan quota (regression ISSUE-004), model list refresh. Do not change credentials.

**MS-01 · Manage sessions and archive**: Manage sessions table (search, sort, project filter) and Archive management (`archive-search`, `archive-sort`, `archive-project-filter`, `archive-unarchive`, `archive-delete` on `qa-` items only). Expected: actions reflect in the sidebar immediately; worst block ≤ 150 ms. Spec: `specs/manage-sessions-table.md`.

## P2 — Misc

- **MI-01** Automations page renders; create-limit message (`docs/automation-create-limit.md`); do not leave automations enabled.
- **MI-02** Plugin Marketplace renders; open a plugin card; do not install unless the user asked.
- **MI-03** Command Center commands list (Manage sessions, settings entries).
- **MI-04** Help menu, profile menu, zoom menu.
- **MI-05** Remote connection dialog → cancel path.
- **MI-06** Check for updates (dev build: skipped message, no crash).
- **MI-07** Idle hygiene: leave the app idle on the home screen 60 s and count log lines: settings reads, voice polls, `meta_json` warnings, `git.refresh` (baseline: settings 0–4/min, voice ≤ 10/min, meta warns 0).

## Round-2 additions (run 2026-10-22, branch claude/qa-run-20261022-2)

Cases for #286 (model trajectory v2), #287/#277 (ACP agents), #296 (quick prompts). Harness corrections from this run are at the end.

### TV — Model trajectory v2 (side-pane tab; run after CH-17)

- **TV-01 · Open + summary line** — header menu → "View model trajectory v2". Expected: opens ≤ 300 ms worst block (observed 176 ms); summary line shows `N calls (+M other) · in/out tokens · cache % · context peak % · model time · tools time · models used`. Refresh (`model-trajectory-v2-refresh`) updates counts after new turns.
- **TV-02 · Overview strip** — Model/Tools lanes with per-span `timestamp · duration`; hint "Drag to filter · Ctrl/⌘+wheel to zoom · Shift+wheel to pan". Drag-to-filter and zoom are not drivable over CDP (synthetic wheel/pointer events have no effect) — E2E-only; check lanes render and spans match the ledger requests.
- **TV-03 · Event ledger** — virtualized `listbox` "Trajectory events": Request rows show params (`max N`, `thinking`, `effort`, `tools · KB`), delta from the previous request (`maxOutputTokens 384000 → 128000 … system prompt changed`); User/Assistant/Context rows; "Context rewritten (input is not a continuation)" marker after a compact; Tool rows appear after scrolling (virtualized) once "Show sidecar and subagent calls" is on.
- **TV-04 · Inspector** — click a Request row → drill-in with Summary / Payload / Timing; click a Tool row → Summary / Payload / Result / Schema / Timing (all five). Payload shows parameters (maxOutputTokens, thinking, effort, toolChoice, temperature, stream) and system-prompt blocks with sizes; Timing shows Started/Completed/Duration/TTFT/Decoding/time-to-first-text/Streaming.
- **TV-05 · Context chart** — `#N · tokens · %` groups per main call, compact markers ("Context rewritten…") in the chart; click filters the ledger.
- **TV-06 · Time by tool + categories** — per-tool exec time and call count plus a Model bar (observed `Model 5m 20s · 33×, Bash 5m 6s · 11×, Skill 37 ms · 1×`); summary line gains `skills: <name>` after a skill turn. Memory/MCP entries need respective usage (generate with a memory write / an MCP call, or mark n/a).
- **TV-07 · Old records without timing** — open v2 on a session created before the timing change: TTFT shows "—" and model spans render solid (unit-covered; needs an old-format session to see live).
- **TV-08 · Layouts** — wide (default side pane), narrow (drag `role=separator` splitter), mobile layout manual-only.

### AC — ACP agents on macOS (#287)

- **AC-01 · Settings group + detection** — Settings → Model settings → "ACP agents": opencode, Cursor, Qwen Code, Gemini CLI (brand SVG marks). Codex/Claude Code appear only when the adapter binaries (`codex-acp`, `claude-agent-acp`) are on PATH — their absence is spec behavior, not a bug. Each detail shows version, resolved command path, Enable switch, Login status.
- **AC-02 · Test roundtrip** — detail → Test: handshake runs without sending a prompt. Expected "Roundtrip OK · N ms" + raw JSON-RPC frames; auth-required agents surface the sign-in message (Qwen "authenticate first", Gemini authMethods). Expect 2 warn log lines per failed (auth) test — expected failures.
- **AC-03 · Composer agent choice + pre-turn options** — draft → model menu → provider submenu `composer-provider-trigger` lists `<agent> (ACP)`; after picking, `v4-model-config` has `provider=acp:<agent>` and the agent's catalog options render as `external-agent-config-trigger-{mode,model,effort}` from `fork_acp_agent_catalog.json`.
- **AC-04 · Draft choice isolation** — with agent choices set on a draft (mode Plan, model X), open another draft with the same agent: it must show catalog defaults, not the other draft's choices (Codex finding a). Choose mode, then model: the mode must survive (Codex finding b).
- **AC-05 · Live delegation** — one turn with an agent whose model is free (opencode `*-free`); reply arrives; trajectory shows the ACP session. Other agents: detection only (paid sign-in).
- **AC-06 · Enable/login** — the Enable switch flips Ready/Disabled; Login section shows stored credentials state ("API key stored") with Check login / Log in (never change credentials).

### QP — Quick prompts (#296)

- **QP-01 · Settings CRUD** — Settings → Quick prompts: Project picker, "…quick prompts" + "Global quick prompts" sections, `quick-prompts-settings-new` opens the editor (Name `quick-prompt-editor-name`, Project/Global scope, prompt body with /, $, @). Save disabled until valid. Row: Pinned + Shown-in-project switches, drag handle, edit/duplicate/delete.
- **QP-02 · Composer row** — `quick-prompt-row` above the composer (drafts and sessions) lists pinned globals (not hidden in the project) then pinned project prompts. Click inserts at the caret (mention chips intact); ⌘-click sends only when the draft is empty, otherwise inserts. `quick-prompt-save-draft` saves the current draft content.
- **QP-03 · "/" panel** — type `/` → "Quick prompts" section (virtualized — scroll); Enter replaces the `/token` with the stored body.
- **QP-04 · Row menu + management** — right-click a chip → Edit / Hide in this project / Remove from row / Delete; Settings lists reflect immediately (state broadcast).
- **QP-05 · Scope rules** — a global prompt with an `@file` mention is rejected with a readable reason; project prompts may reference the project; restart restores rows and switches.

### Harness corrections (round 2)

- `worktree-failure-modal` is the worktree-RETURN failure flow; creation failures render progress/failure/Retry in the destination entry and (per spec) the failed session's timeline. See CP-06 and ISSUE-051.
- `agent-browser eval` prints **pretty-printed JSON across multiple lines** — capture the whole output and parse with `jq`; `tail -1`/quoted-string parsing produces garbage coordinates that click random UI (cost ~15 min in the AC-04 retest).
- Radix menus/popovers do **not** open from JS `.click()`/`keydown` dispatch on the trigger — only real CDP pointer `move → down → up` at the element centre; but items inside an open menu accept JS pointer event sequences. Keyboard Enter works on `workspace-more-button`.
- Lexical draft text: `document.execCommand('selectAll'/'delete')` does not clear the composer; use `__zcodeLexicalInputE2E.setText(...)`.
- A failed attachment chip persists with the project-scoped draft and keeps Send disabled until removed (also blocks sends after project re-select round-trips).
- `pnpm verify:pre-push` standalone passing does not guarantee the hook passes (first push failed transiently at 6 s with exit 2; the immediate retry passed in 44 s). Retry once before diagnosing.

## Manual only (do not attempt over CDP)

Native file/folder pickers, multi-window, quit confirmation with a running session, deep links (`zcode://`, the dev bundle spawns a second instance), microphone/voice dictation, mobile pairing, sign-in flows. List them in the run summary as "needs manual check".
