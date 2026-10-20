# Composer branch switcher semantics

Status: §1 (draft branch intent) and §2 (guard) implemented 2026-10-15; §3 worktree-session Git targeting is implemented by per-path Git state; §4 decided (variant "Switch + branch rows") and implemented behind the renderer-local flag; ask-codex review adopted (Task/Base labels, dirty cues, HEAD-fallback disclosure, withdraw-not-disable); 2026-10-18: switching worktree mode ON selects the repository's main branch as the Base default; 2026-10-19: the Task/Base row value and the list checkmark are per-mode (the worktree Base override no longer names the project-mode task branch).

## Problem

The branch picker shown in the draft composer header (`GitBranchSwitcher` in `WorkspaceShellLayout.tsx:1559`) performs an **immediate** `git switch --no-guess` on the shared workspace checkout (`useGitBranchSwitcher.ts:251` → `gitCliRepo.ts:1500`) while no chat exists yet. The picker reads as a setting for the future chat, but it mutates the working tree for everything in the workspace: other open sessions, and any agent mid-turn. There is also no guard against switching while tasks are active. Separately, a worktree session's status panel targets the parent workspace (`SessionPane.tsx:5671` → `ConversationStatusPanel`), so the worktree's own branch cannot be switched from the UI.

Decided 2026-10-15 (user): draft branch selection becomes intent applied at send; switching with active tasks asks for confirmation with a list; worktree-session panel targeting is in scope; the unified destination control replaces the checkbox behind a default-on renderer-local flag (§4).

## Contract

### 1. Draft: branch selection is intent, applied at send

- The draft header `GitBranchSwitcher` no longer issues git calls on selection. Picking a branch records a draft intent (the chosen `branchName`) reflected in the picker trigger, plus a menu-footer hint that it applies on send.
- The intent lives beside the existing worktree draft intent (the `composerDraftWorktreeIntent` slot pattern; since specs/composer-worktree-setup-steps.md the slot is consumed as `beginCreation` at send, non-blocking). It is cleared with the draft; navigating away or clearing has no side effects. (Anchor amended 2026-10-15: the spec originally pointed at `interceptFirstSend`, replaced by the setup pipeline.)
- On send without the worktree intent (checkout mode), read the current branch first. If it already matches the selected branch, proceed without a guard or switch. Otherwise run the guard (§2), then `gitService.switchBranch`, then session creation proceeds. A failed or cancelled switch aborts the send with the switch failure message: **no session is created**, draft text and intent are preserved, and commit-assist handling is not invoked. The guard considers every active task in the workspace, including tasks beyond the collapsed sidebar page.
- While the "New worktree" checkbox intent is active (the intent slot is registered or a setup pipeline is running/ready for the workspace), the header picker is disabled with a hint ("the worktree form sets the branch") so the draft never holds two competing branch sources. The worktree flow itself is unchanged (created at send per the decided Variant B).

### 2. Guard: confirm with the list of affected active tasks

- "Active" = session phase `prewarming` or `running` (sessions-index phases, `packages/shared/src/zcode-protocol-v4/snapshot.ts:28`). Sessions bound to an `executionWorktree` are excluded from the checkout-switch list — a parent-checkout switch does not touch them.
- The guard applies to: (a) the send-time checkout switch (§1), (b) a status-panel branch switch in a live session. It is a confirm dialog listing the affected active tasks by title ("Switching the branch changes the working tree for N running task(s): …"); cancel aborts the whole action.
- The draft destination control's "Create and switch to new branch" action also runs the checkout guard before creating or switching the branch; cancelling performs neither operation.
- Every branch-switch entry point for the same repository uses the same scoped guard, including the branch picker nested inside the Git commit dialog. Opening that dialog must not create an unguarded route around the status-panel confirmation.
- "Affected" = tasks sharing the same checkout root: for a checkout switch, all non-worktree active tasks of the workspace; for a worktree-panel switch (§3), tasks bound to that worktree. A dialog with an empty list is skipped (nothing to confirm).
- Data source: the Host's existing sessions-index summary is copied into the transient controller task overlay. The UI guard reads that overlay alongside activity; persisted task metadata remains unchanged. This adds a field to the existing controller frame, not a new RPC endpoint.
- An empty list is authoritative only after the active-task query succeeded for the current workspace scopes and source generation. While loading or after a failed query, switching fails closed with retry guidance; unavailable data is never treated as “no affected tasks.”
- Concurrent confirmation requests are serialized. Each keeps its own resolver until confirmed or cancelled; replacing one visible dialog cannot strand a send or branch action.

### 3. Worktree session panel targets the worktree

- Resolve the active session's `executionWorktree` from its scoped live sessions-index summary, the same source used by the sidebar badge. The persisted task-list cache is not authoritative for this field and may not contain it.
- For a session with `executionWorktree`, the status-panel Git summary, dirty count, change summary, branch switcher, and Git actions all use a Git repository refresh keyed to `executionWorktree.path`; the workspace-level `gitState` datasets are never reused. Both the status panel and open Git Review follow that execution path's watcher and explicit refresh actions, with the same remote workspace identity/session routing. The parent-checkout watcher remains scoped to workspace-level state.
- Git repository view state is scoped by both the workspace identity key and concrete `workspacePath`. A different execution path under the same remote workspace identity must render empty state until that path's Git refresh completes.
- The status panel keeps a worktree disclosure row with the live branch (or detached-HEAD label) from that execution path's Git summary and the worktree directory from session metadata. The label updates after branch switches; it must not keep showing the creation-time branch. Switching branches and other Git actions use the execution path. The existing guard (§2) receives `scope: "worktree"` and that path, listing only active sessions bound to the same worktree. The parent workspace is never targeted by the session panel.
- The workspace header path button (folder icon, `WorkspaceHeaderTitleSection` tooltip/popover) follows the same fact source: while the active session is bound to an `executionWorktree`, its context path shows the worktree directory (not the parent checkout) and its branch row/button label shows `executionWorktree.branchName` (falling back to the workspace git summary only for plain sessions or rows without a branch). The project display name in the tooltip title stays the workspace name — the button describes where the active chat executes, not a second workspace identity.
- Draft queue lifecycle is owned by the composer: queueing clears the visible editor only after saving the frozen recovery record. Withdraw/unmount detaches that submission and keeps its text and attachment manifest in a separate recovery record owned by the prepared session. Recovery is explicit and requires an empty editor; it never merges with newer input. Attachments and references stay recoverable and are never dispatched twice. An in-flight Git create may finish and remain reusable as an orphaned worktree.
- First-send claim drops the persisted draft unconditionally (the debounced draft persist may already have stored the submitted text). The visible editor may stay until acceptance, but the draft store must not hold already-submitted text: the first-send promotion re-applies the persisted draft into the promoted session, which would resurrect the sent input after acceptance. Failure recovery restores from the frozen submission snapshot, never from the draft store.

### 4. Unified destination control (decided 2026-10-15: variant "Switch + branch rows")

The detailed contract is in [Composer destination control](composer-destination-control.md).
Acceptance scenarios, validation and scope exclusions remain below.

## Acceptance scenarios

1. Draft: selecting a branch issues no git RPC while drafting; the picker reflects the choice.
2. Draft send, branch unchanged → session created; no switch call.
3. Draft send, different branch, no active tasks → switch runs, then the session is created on it.
4. Draft send, different branch, a running task in the workspace → confirm lists it; cancel aborts everything; confirm switches, then creates.
5. Switch failure (dirty-tree conflict path) → abort with the switch failure message; no commit-assist flow or session creation runs, and the draft text and intent remain intact.
6. Worktree checkbox active → header picker disabled; the worktree form's branch is the only source (flow unchanged).
7. Clearing the draft or switching conversations drops the intent with no side effects.
8. Status panel of a checkout session with its own turn running → confirm lists it; confirm switches.
9. Worktree session panel → shows the worktree's branch and dirty state; switching changes the worktree branch only; the parent workspace and its sessions are unaffected.
10. Worktree-only workspace → checkout guard never fires (list empty ⇒ skipped).
11. Remote workspace: same flows through the existing Host RPC surface; identity rules unchanged. The execution-worktree fact follows the matching workspace identity and remote session in the existing controller stream.
12. Switching to a different project after the popover was used → the cached branch list, base selection, and open views are dropped; worktree creation in the new project resolves its base only from that project's branches (never a name carried over from the previous project's list).
13. Selecting the already-current branch while another task is active → no confirmation appears, no switch runs, and the message proceeds.
14. A branch switch while the current workspace task list is loading or has failed is rejected with retry guidance; a successfully loaded empty result allows the switch without confirmation.
15. Two overlapping switch requests are shown one at a time, and confirming or cancelling each settles only that request.
16. Editing a tracked file inside an active worktree refreshes its open Git Review state; parent-checkout summaries remain driven by the parent watcher.
17. Creating and switching to a new draft branch while a task is active asks the checkout guard; cancellation creates no branch and performs no switch.
18. Changing the Git target path while retaining a remote workspace identity immediately hides the previous path's summary and datasets until the new path refreshes.
19. Create-and-switch to a new branch from the destination popover, then re-open the popover → the list reloads, the new branch is present and marked current. Re-opening after a failed load retries the load. A slow response from an earlier open never replaces the list of a later open.
20. Toggling worktree ON with a resolvable main branch (project override present locally, or an `origin/HEAD`-derived branch present locally) → the Base row immediately shows the main branch; the send-time `beginCreation` receives it as `baseBranch`; no `switchBranch` call runs.
21. The project override wins over `origin/HEAD`; an `origin/HEAD`-derived name without a matching local branch resolves nothing → the Base row keeps the existing fallback (live current branch).
22. A manual base pick after ON survives while the mode stays on; toggling OFF→ON again re-selects the main branch, replacing the previous stint's pick.
23. Signals unavailable at toggle time (branch list still loading, merge-status probe failed, `baseRef` null) → no selection change; the existing fallback applies, and the toggle itself issues no git RPC.
24. Toggling worktree OFF after any Base selection (manual pick or main-branch default) → the Task branch row, the chip, and the project-mode list checkmark all show the task branch (`intent ?? current`); the Base override is not rendered there and is never applied to the shared checkout. An explicit task-branch intent renders instead of the detached-HEAD label and is applied by the send switch.

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Unit: intent slot lifecycle (set/clear/competes-with-worktree-intent); guard list computation (phases, worktree exclusion, same-checkout-root grouping); send ordering (switch-then-create, abort preserves draft); picker disabled state under worktree intent; panel path substitution for worktree sessions.
- Manual: dialog copy/UX pass; a live check that a running agent in the same workspace pauses-safely across a confirmed switch (agent's next git call sees the new branch — expected, documented behavior).

## Out of scope

- GitPane and other workspace-level git widgets (their immediate-switch semantics are unchanged; §2 already guards the dangerous cases).
- Copilot-style per-chat branch workspaces as a new workspace kind — worktree sessions already cover isolation.
- New RPC endpoints or changes to persisted task metadata.
- The legacy `ChatEmptyWorktreeTaskToggle` path (flag `"0"` restores it wholesale) and the Command Center worktree palette's default base (`resolveDefaultBaseBranch`) — both keep their existing defaults; the main-branch default applies to the unified destination control only.
