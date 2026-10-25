# Unreliable merge status in the conversation list and hover popup

Status: the Git service and its cache are kept, but workspace-level observation and its UI projection are disabled — the workspace's current branch is not a truthful status of an individual session or worktree. Rows and the hover popup show no merge indicators until a task-level status source exists.

Update 2026-10-18: task-level PR status (including merged) is specified in `sidebar-pr-status.md`; the workspace probe stays off.
Update 2026-10-16: the hover popup shows available task metadata and `changeSummary`; it does not show branch or merge state from the workspace probe. Resuming merge indication requires a status addressed to a specific task and its execution worktree (`executionWorktree.branchName`), not re-enabling the workspace probe.

## Current visibility in lists

- No `Merged` badge in grouped sidebar rows or the straight/legacy `TaskListItem`, including their drag-overlay variants.
- Keep the Git service and its cache. Workspace-level merge status is not passed to rows or the hover popup; the popup shows task status, workspace, model/effort and task `changeSummary`.
- Do not replace the badge with another criterion or state without a separate decision based on PR/worktree lifecycle research.

## Data model clarification (found during implementation)

There are no per-session branches in the data model: not in `ZCodeTaskMeta`, not in session events, not in the UI. A branch exists only per workspace (`GitRepositorySummary.branchName`). "Session branch" therefore means the current branch of the workspace the session lives in; observation has workspace + branch granularity (same as the cache key below). All rows of one workspace show one status.

## Problem

In the sidebar (`packages/ui/src/workspace-grouped-tasks/task-row.tsx`) a session shows status, `+N −M` diff and time, but not whether its branch was merged. Completed sessions should be visible at a glance, with useful hover information.

## Code facts (as of this spec)

- Row: attention badge `taskAttentionDisplay` (`task-row.tsx`), metadata block on the right.
- Tooltip: `taskChangeParts` via `formatGroupedTaskHoverChangeParts` (`packages/ui/src/workspace-grouped-tasks/task-row-tooltip.ts`).
- Diff: `ZCodeTaskMeta.changeSummary` (`packages/shared/src/zcode-task-types-core.ts`), read via `getTaskChangeSummary` (`packages/ui/src/lib/taskChangeSummary.ts`).
- No PR data: no PR fields in `ZCodeTaskMeta`, zod schemas (`packages/shared/src/validation.ts`, `packages/shared/src/task-realtime-core.ts`), UI or i18n. No GitHub PR client: `apps/zcode-cli` only has the read-only allowlist `gh pr view|list|status` (`apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts`).
- The "Missing worktree" state with a Resume button from the original screenshot was not found in sources. Out of scope.

## Product rules

1. Conversation rows do not show a `Merged` badge, even if a workspace-level record with state `merged` remains in the store.
2. The hover popup does not show workspace branch or merge state; it shows available task metadata and `changeSummary`.
3. Merge status is not passed from the store to grouped or legacy task rows.
4. Merged does not mean a closed session: no auto-archive.

## State source: local git

- A session branch counts as merged when its tip is an ancestor of the default branch: `git merge-base --is-ancestor <headRef> <baseRef>` (exit 0). `baseRef` comes from `origin/HEAD`; if absent, status is `unknown`.
- **Known limitation:** squash and rebase merges are not detected; no badge for such sessions. Accepted decision.
- No network. No automatic `git fetch`: default-branch freshness depends on the user's last fetch. Explicit fetch is out of scope.
- The `gh` variant (more precise, but needs auth and network) is not in this version.

**State owner:** a service in the runtime (`packages/services` or CLI), runs `git` with cwd `workspacePath`. Not Main: Main holds no task/session state (repository rules).

**Key:** `workspaceIdentity?.trim() || workspacePath` + branch. Remote workspaces pass `workspaceIdentity` and `remoteSessionId`, never a path. `git` runs on the workspace host; the result returns over the protocol.

**Cache:** in-memory, TTL 60 seconds; reset on branch change or checkout. A cache hit is validated against the current HEAD: one cheap `git symbolic-ref --short HEAD` per hit (an external checkout missed by invalidation is caught on the next probe; if HEAD is not read, the hit is accepted). An in-flight probe cannot repopulate the cache after invalidation: writing the result is guarded by a per-workspace generation counter incremented on reset. Refresh on sidebar open, window focus, and a successful git-mutation signal (`onRefreshGit` → store counter → immediate re-probe). Rate limiting is moot for local git calls; the service owns the cadence — there is no client-side TTL gate in the UI.

**Contract (local git):**

```ts
type MergeStatus = {
  state: "merged" | "not_merged" | "unknown";
  baseRef: string | null;
  headRef: string | null;
  lastCommitAt: string | null; // ISO, date of the branch tip
};
```

Actual integration: types `GitBranchMergeStatus` in `packages/shared/src/git.ts` (file convention — `| null` instead of optional); method `IGitService.getBranchMergeStatus` in `packages/services/src/git/git.ts` — the existing UI↔host service surface (same as `getBranchComparison`). No `zcode-protocol/index.ts` entry needed: this is on-request observation, not a session event.

**Versions:** an old host without the method rejects the call — the hook catches the error, the workspace record is removed from the store (the badge is guaranteed hidden, including one previously shown), the next focus re-probes. A `git status` error inside a probe is not thrown: the repo layer returns `unknown` with `headRef: null` and a single `warn`.

**Boundary:** merge state does not flow into the `desktop-continuous` stream and is not written to `SessionEvent`/journal. It is observation, not a session event (same principle as `session-token-throughput.md`).

## UI

- Badge: `Badge` from `packages/ui/src/components/ui/badge.tsx`, size `text-ui-xs` (`DESIGN.md:227`). Color: primary accent. Do not use `--color-success`: reserved for waiting confirmations (`DESIGN.md:112, 130`).
- Popup: reuse the current Tooltip. Show task status, workspace, model/effort and task `changeSummary`; do not show workspace branch or merge status — they do not belong to an individual task. Text `text-ui-sm` (`DESIGN.md:226`). All sizes via `text-ui-*` (`DESIGN.md:11`), no `text-sm`/`text-xs` or arbitrary `text-[13px]`.
- No second popup. Interactive overlays sit above passive tooltips (`DESIGN.md:427`).
- Rows via intl: keys `taskList.branchMerged*` in `en-US`, `zh-CN`, `uk-UA` (`packages/ui/src/i18n/locales/`).
- The Git service and its cache stay (`ComposerDestinationControl` uses them). The workspace-level UI projection was removed 2026-10-23 (PR #325): `BranchMergeStatusProbes`, `useBranchMergeStatuses`, `branchMergeStatusStore` and `branchMergeStatusProbeRunner` no longer exist; recovery: `git show 8724e0c1:<path>`. Task-level indication must be built on a separate task-level contract, not on reviving the workspace probe.
- External links only via `IPlatformService` (`packages/shared/src/platform.ts`), never `window.zcode`.
- Second line of `packages/ui/src/TaskListItem.tsx`: the badge was added to both status chains with the same priority rule (after pendingInteraction and attention) — applies again once a task-level source restores the badge.

## Platforms (desktop, web, mobile remote)

- Desktop (`desktop-continuous`): status is computed on the workspace Host and reaches the sidebar over realtime.
- Web (`packages/web`) and mobile remote (`web-remote-replayable`): the same `MergeStatus` contract. The mobile client connects to the desktop's existing Host attachment; no separate Agent, Local Host or remote session is created.
- Reconnect recovery: `MergeStatus` is re-requested from the snapshot, not stored in the event queue — a separate path from the `desktop-continuous` stream.

## Logging

- Service: `createServiceLogger("branch-merge-status")`. `info` on state change; `debug` for raw git output; `warn` for a git error except "ref not found" (once, no spam per refresh); `error` is never used for a normal "not merged".
- UI: `packages/ui/src/logger.ts`.

## Acceptance scenarios

1. Even with `merged` in the store, grouped and legacy rows show no badge, and the hover popup shows task metadata without workspace branch and merge label.
2. `changeSummary` stays visible in the row and hover popup.
3. A remote workspace keeps showing the correct remote label and task metadata.
4. Merge indication resumes only after a separate task-level contract with regression coverage.

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Unit: the Git service keeps mapping, TTL and workspace-identity tests in `packages/services/test/branchMergeStatusService.test.ts`. UI is covered by rendered-markup tests of the task row and hover popup: badge, branch and merge label absent under workspace-level merged status; task metadata and `changeSummary` present.

## Out of scope

- "Missing worktree" state and Resume button.
- Auto-archiving merged sessions.
- Creating PRs from the UI.
- Detecting squash and rebase merges.
- Automatic `git fetch` and network calls.
