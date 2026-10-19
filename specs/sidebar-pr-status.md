# Session pull request status

Status: implemented (2026-10-18). Supersedes the "Merged" badge idea in
`merged-session-highlight.md`: that probe was workspace-level; this contract is task-level.

## Problem

A worktree session usually ends in a pull request, but nothing in the app shows whether that PR is
open, merged, closed, or blocked by failing checks. Users switch to GitHub to find out which
sessions still need attention.

## Scope rules

1. **Task-level only.** PR status belongs to a session that owns its checkout: a session with
   `executionWorktree`. Ordinary sessions (running in the shared workspace checkout) show no PR
   status anywhere, including the Git tools section: the workspace branch is not a session fact
   (same reason the workspace merge probe was disabled).
2. **No database changes.** The session's branch is already persisted (`execution_branch`, CLI
   migration `0023`; `executionWorktree.branchName` in task meta). PR status is a derived fact owned
   by GitHub and is never persisted, never written to `SessionEvent`/journal, never sent over the
   `desktop-continuous` stream.
3. **Source: `gh` CLI on the workspace host.** It reuses the user's existing GitHub auth, works for
   remote workspaces, and sees squash/rebase merges. No PR or non-GitHub remote → no indicator anywhere.
   Missing `gh` or no auth → no row icon, header chip, or Session manager value, but the hover card
   and Git tools of worktree sessions show one muted line (`PR status unavailable: install gh` /
   `PR status unavailable: sign in to gh`) so the feature never fails silently. One `warn` per
   workspace, no retry spam.
4. **Link by branch, not by stored reference (v1 heuristic).** Industry practice (GitHub Copilot's
   agent app) stores created/source PR references per session and keeps a last-known badge. v1 uses
   branch lookup because of the no-DB constraint; the contract carries `source: "branch"` so a pinned
   source can be added later without reshaping it.
5. **Known limitation (needs a migration, out of scope):** PRs opened from branches other than the
   session's worktree branches (`git push origin HEAD:other`, stacked PRs) are not found. The fix is a
   pinned PR reference in a `fork_`-prefixed column (`9002_fork_*` migration in the CLI session
   store), never a new key in task `meta_json` or `setting.json` (both re-parse and strip unknown
   keys).

## Resolving `gh`

- A Finder-launched app does not inherit the shell `PATH`. `gh` is spawned with the Host's runtime
  env (`initializeRuntimeProcessEnv` applies the login-shell `PATH` before any spawn), the same env
  the Git service uses, never a bare Main-process `PATH`.
- Binary candidates mirror `getGitBinaryCandidates`: optional `ZCODE_GH_BINARY` override, then `gh`,
  plus the standard Windows install path. Resolution is cached per Host like the git binary.
- `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`; every call has a timeout. `gh`
  must never wait for input.
- Unauthenticated (`gh auth status` non-zero) → `unavailable` with reason `auth`; not found →
  reason `no_gh`. Both are cached for the 10 min tier and shown as the muted line from scope rule 3.

## Repository targeting (fork workflows)

`gh` is never asked to guess the repository: every call passes the base repository explicitly.

- **Base repositories** (where PRs live): the `gh repo set-default --view` repository when set;
  otherwise **every distinct GitHub repository among the remotes** (typically `origin` and
  `upstream`), each queried in its own batch. Picking one remote is wrong for long-lived forks: in
  this repository `origin` = `osben/ZCode` (PRs into `integration`) and `upstream` =
  `zai-org/ZCode`, and no `gh` default is set — an "upstream first" rule would miss every fork PR.
- **Head owner** (who pushed the branch): owner of the branch's push remote
  (`branch.<name>.pushRemote` → `remote.pushDefault` → `branch.<name>.remote` → `origin`).
- PRs whose `headRepositoryOwner` differs from the head owner are dropped (a contributor fork may use
  the same branch name). Remotes are parsed with the `workspace-github-link` parser (GHE hosts, SSH
  over 443, SCP-style URLs), exposed as a structured `gitRemoteUrlToRepository` helper next to
  `gitRemoteUrlToWebUrl` so callers get `{ host, owner, name }` without re-splitting a web URL.

## Branch set of a session

The host resolves PRs for the union of:

- `executionWorktree.branchName` (persisted at worktree creation);
- the worktree's current `HEAD` branch (`git symbolic-ref --short HEAD` in `executionWorktree.path`),
  when the directory exists and HEAD is not detached.

This covers an agent switching branches inside the worktree. `gh` runs with cwd = parent workspace
(`workspacePath`), so a missing worktree directory still resolves the persisted branch.

## Data contract

```ts
type PullRequestStage = "draft" | "open" | "merged" | "closed";
type PullRequestChecks = "passing" | "running" | "failing" | "optional_failing" | "none";

type SessionPullRequest = {
  number: number;
  url: string;
  title: string;
  repository: string; // "owner/name" display label
  headRefName: string;
  stage: PullRequestStage;
  checks: PullRequestChecks;
  failingCheckCount: number;
  totalCheckCount: number;
  hasConflict: boolean; // mergeable === "CONFLICTING"
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  additions: number;
  deletions: number;
  updatedAt: string; // ISO
  mergedAt: string | null; // ISO
};

type SessionPullRequestStatus = {
  state: "ready" | "unavailable" | "rate_limited";
  unavailableReason: "no_gh" | "auth" | "not_github" | "error" | null;
  source: "branch"; // v1; a later pinned source adds "pinned"
  pullRequests: SessionPullRequest[]; // sorted, primary first
  primaryNumber: number | null;
  fetchedAt: string | null; // ISO; last successful fetch
  stale: boolean; // true when serving the last in-memory value after a failed/rate-limited refresh
};
```

Types live in `packages/shared/src/git.ts` (file convention: `| null`, no optional). The method is
`IGitService.getSessionPullRequests` in `packages/services/src/git/git.ts`, the existing UI↔host
service surface (same as `getBranchMergeStatus`); no `zcode-protocol` entry, because this is an
on-demand observation, not a session event.

**Request shape (one RPC per workspace per refresh, decided 2026-10-18):** the UI sends the full
list of that workspace's worktree tasks across timeline, pinned, and archived membership (not only
the currently rendered page); the host answers one entry per task. `forceTaskIds` is scoped to that
workspace's request and must not force a same-named task in another workspace.

```ts
type SessionPullRequestsTaskInput = {
  taskId: string;
  branchName: string | null; // persisted executionWorktree.branchName, null when absent
  worktreePath: string | null; // executionWorktree.path, null when absent
};

type SessionPullRequestsRequest = {
  workspacePath: string;
  workspaceIdentity?: string;
  tasks: SessionPullRequestsTaskInput[];
  forceTaskIds?: string[]; // bypass the TTL for these tasks (turn end, onRefreshGit, explicit Refresh)
};
// IGitService.getSessionPullRequests(request): Promise<Record<taskId, SessionPullRequestStatus>>
```

Every requested task receives an entry (a task whose branch set is empty resolves to a "no PR"
entry), so the UI can distinguish "checked, no PR" from "never requested". Ordinary sessions are
excluded at this boundary: the UI never sends them, and the host ignores task inputs without any
branch. The web home-only stub (`packages/web`) answers `{}` — no workspaces are connected there.

**One GraphQL call per base repository**, not one call per branch. All branches of all sessions
that target the same base repository are batched into one `gh api graphql` request with aliased
fields (chunks of at most 25 branches):

```graphql
query ($owner: String!, $name: String!, $b0: String!, $b1: String!) {
  repository(owner: $owner, name: $name) {
    b0: pullRequests(headRefName: $b0, first: 10, states: [OPEN, MERGED, CLOSED],
                     orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...Pr } }
    b1: pullRequests(headRefName: $b1, ...) { nodes { ...Pr } }
  }
  rateLimit { remaining resetAt }
}
fragment Pr on PullRequest {
  number url title state isDraft mergedAt updatedAt mergeable reviewDecision
  additions deletions headRefName headRepositoryOwner { login } mergeStateStatus
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state contexts(first: 100) { totalCount nodes {
      ... on CheckRun { conclusion status }
      ... on StatusContext { state }
    } }
  } } } }
}
```

Branch names are passed as GraphQL variables, never interpolated into the query text.

- `checks` mapping over `statusCheckRollup`: `failing` if any CheckRun conclusion is `FAILURE`,
  `ERROR`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, or any StatusContext state is `FAILURE` /
  `ERROR` — except `optional_failing` when exactly those conclusions are present and
  `mergeStateStatus === "UNSTABLE"` (all failing checks are non-required); else `running` if any
  item is not completed (`QUEUED`, `IN_PROGRESS`, `PENDING`, `EXPECTED`); else `passing` when the
  rollup is non-empty; else `none`.

**Primary PR:** open (non-draft) > draft > merged > closed; ties by newest `updatedAt`.
**Row health:** the worst `checks`/`hasConflict` across all open and draft PRs, not only the primary
(shared pure helper `worstSessionPullRequestHealth`, reused by the UI selectors; severity order
conflict > failing > optional_failing > running > passing > none).

## Owner and event order

```
UI surfaces (row, hover, menu, header chip, Git tools, Session manager)
   │ read one store entry per task key
   ▼
usePullRequestStatuses (sidebar driver) · useSessionManagerPullRequests (visible rows)
   │ triggers (all gated on window focused + a PR surface visible):
   │   surface becomes visible · window focus · TTL expiry (checked every 30 s while visible/focused)
   │ invalidating triggers (bypass TTL; both drivers):
   │   worktree session turn ends (running → completed/idle) · onRefreshGit (commit/push) ·
   │   explicit Refresh
   ▼
IGitService.getSessionPullRequests  ── on the workspace host (local or remote) ──
   │ cache key: (workspaceIdentity?.trim() || workspacePath) + branch
   │ TTL: 60 s while any PR is open/draft · 10 min for "no PR" · 30 min when all merged/closed
   │ failed refresh: the previous entry is served stale and no retry is made for 60 s (also for
   │   stale entries); a GraphQL error body is classified before gh's non-zero exit code
   │ generation counter per key: an in-flight probe never repopulates an invalidated entry
   │ requests within 250 ms are coalesced into one batch per base repository
   ▼
gh api graphql (async, one call per base repository, bounded concurrency)
```

Turn end is the important trigger: it is exactly when the agent has just run `git push` or
`gh pr create`, so a new PR appears without waiting for a TTL.

**Rate limits.** A GraphQL `RATE_LIMITED` error or `rateLimit.remaining` below 100 switches the
Host to `rate_limited` until `resetAt` (exponential backoff 2 → 32 min when `resetAt` is unknown).
During backoff the last in-memory value is served with `stale: true`; the row keeps its icon, the
hover card shows `Status may be outdated`. Nothing is persisted, so a restart during backoff shows
no indicator until the next successful fetch.

- Main holds no state; it only forwards the existing service RPC.
- Reconnect (mobile `web-remote-replayable`, web): the UI re-requests on reconnect; nothing is
  queued or replayed.
- The service owns cadence; the UI has no TTL gate of its own. Explicit Refresh bypasses the TTL.

## Required vs optional checks (decided 2026-10-18)

Only required checks make the row red. `mergeStateStatus === "UNSTABLE"` means the failing checks are
all non-required: the dot is warning and the text is `{count} optional checks failing`. Any other failing
state (`BLOCKED`, or `mergeStateStatus` unavailable) stays destructive. The query adds
`mergeStateStatus` to the `Pr` fragment. The distinction is carried in the contract as
`checks: "optional_failing"`.

## Proposed additions (not decided)

Seen in GitHub Copilot's agent app; available from the same query without the DB:

1. **`queued` stage** (`isInMergeQueue`): PR waiting in the merge queue; `--color-warning` icon.
2. **Merge readiness** from `mergeStateStatus`: `Ready to merge` (`CLEAN`), `Branch is behind base`
   (`BEHIND`) in the hover card and Git tools.

## Visual language (variant B, GitHub colors)

Icon = lifecycle stage. Dot = health of open/draft PRs.

| Stage  | Lucide glyph           | Token               |
| ------ | ---------------------- | ------------------- |
| Draft  | `GitPullRequestDraft`  | `--color-pr-draft`  |
| Open   | `GitPullRequest`       | `--color-pr-open`   |
| Merged | `GitMerge`             | `--color-pr-merged` |
| Closed | `GitPullRequestClosed` | `--color-pr-closed` |

| Health                       | Dot (row)   | Text (Git tools, hover)           |
| ---------------------------- | ----------- | --------------------------------- |
| Required checks failing      | destructive | `{count} failing`                 |
| Only optional checks failing | warning     | `{count} optional checks failing` |
| Merge conflict               | destructive | `Conflict`                        |
| Checks running               | warning     | `Checks running`                  |
| Passing                      | none in row | success dot                       |
| No checks                    | none        | nothing                           |

New tokens in `packages/ui/src/styles.css`, all four themes, as aliases (no new hex values):
`--color-pr-open` → `--color-success`, `--color-pr-draft` → `--color-foreground-subtle`,
`--color-pr-merged` → `--color-icon-purple`, `--color-pr-closed` → `--color-destructive`.
`DESIGN.md` gets a "Pull request status" entry in Semantic feedback colors. The row's green
attention badge never coexists with the PR icon: all row metadata is hidden while
`hasPendingInteraction` is true.

## Surfaces (v1)

1. **Sidebar row** (grouped `task-row.tsx` both chains incl. drag overlay, legacy `TaskListItem.tsx`):
   order clock/moon → worktree `Split` (unchanged, muted) → PR icon + health dot → time. Hidden with
   the rest of the metadata on hover and during a pending interaction. The icon is not clickable.
   `aria-label`/`title`: `PR #{number} · {stage}` plus health text.
2. **Hover card** (`TaskSidebarHoverCard.tsx`, replaces the existing TODO): one line per PR, max 3,
   then `+{count} more`: stage icon, `#{number} · {stage}`, health text right-aligned; a review line
   (`Approved` / `Changes requested` / `Review required`) for the primary PR only.
3. **Context menu** (grouped and legacy): `Open pull request #{number}` (primary; one item per PR
   when there are several, max 3), `Copy pull request link`, `Refresh pull request status`.
4. **Session header chip** (`WorkspaceHeader`): stage icon + `#{number}` of the primary PR, health
   dot; a button that opens the PR.
5. **Git tools section** (`ConversationStatusPanel.tsx` environment section, worktree sessions
   only): group `Pull requests · {count}` between the worktree row and Changes. Each PR is a
   two-line button: stage icon; title; `{repository} #{number} +{additions} −{deletions}` (or
   `merged {relative time}`); health on the right. Collapsed section trailing: primary PR icon
   before `+N −M`.
6. **Session manager** column `PR`: primary icon + `#{number}` + health dot, `—` when unknown.
   Status is requested only for visible rows, bounded concurrency; rows of closed/unreachable
   workspaces show `—`.

All external opens go through `IPlatformService.openExternal`. Mobile has no hover: the context
menu (long press) is the path to the PR list.

## i18n

New keys in `en-US`, `zh-CN`, `uk-UA` under `pullRequest.*`: stage labels (`Draft`, `Open`,
`Merged`, `Closed`), `prLabel` (`PR #{number}`), `checksFailing` (`{count} failing`), `checksOptionalFailing` (`{count} optional checks failing`),
`checksRunning`, `conflict`, `approved`, `changesRequested`, `reviewRequired`, `moreCount`
(`+{count} more`), `mergedAgo` (`merged {time}`), `sectionTitle` (`Pull requests · {count}`),
`open` (`Open pull request #{number}`), `copyLink`, `refresh`, `columnTitle` (`PR`),
`unavailableNoGh` (`PR status unavailable: install gh`), `unavailableAuth`
(`PR status unavailable: sign in to gh`), `stale` (`Status may be outdated`).

## Logging

`createServiceLogger("session-pull-requests")`: `info` on stage change of a PR, `debug` for raw `gh`
output, `warn` once per workspace for missing/unauthenticated `gh` or unparsable output. No tokens,
URLs of private hosts, or PR titles in `info`/`warn`. Warn details carry only error classes; a
flush failure rejects the request into the `request-error` fallback.
UI drivers mark only their own tasks stale on failure; store entries drop only when a workspace leaves the sidebar.

## Acceptance scenarios

1. Worktree session with one open PR and green checks → green `GitPullRequest`, no dot; hover shows
   `#N · Open`; Git tools lists it.
2. Open PR with a failing check → red dot in the row; Git tools shows `1 failing`.
3. Two PRs on the same branch (one merged, one open) → row shows the open one; hover and Git tools
   list both, open first.
4. Agent switched the worktree branch → PRs of both branches are listed.
5. Merged PR → purple `GitMerge`; cache keeps it for 30 min.
6. Ordinary (non-worktree) session → no PR in row, hover, menu, header, Git tools, or Session
   manager, even when the workspace branch has a PR.
7. `gh` missing or unauthenticated → no row icon, header chip, or Session manager value; the hover
   card and Git tools of a worktree session show the muted unavailable line; a single `warn`.
8. PR from a fork with the same branch name → ignored.
9. Pending interaction on the row → PR icon hidden together with other metadata.
10. Mobile remote reconnect → status re-requested, not replayed.
11. Remote workspace → `gh` runs on the remote host; key uses `workspaceIdentity`.
12. Agent runs `gh pr create` and the turn ends → the PR appears on the row without waiting for a
    TTL.
13. Checkout with `origin` = user fork and `upstream` = base repo, no `gh` default → both
    repositories are queried; a PR into the fork's own `integration` and a PR into `upstream` are
    both found, each filtered to head owner = fork owner.
14. App launched from Finder with Homebrew `gh` → `gh` is found through the Host runtime `PATH`.
15. GraphQL rate limit → icons stay with `stale: true`, hover says the status may be outdated, no
    requests until `resetAt`.
16. Ten worktree sessions in one repository → one GraphQL request per base repository per refresh
    (two in a checkout with `origin` + `upstream`), not one per session.
17. Only a non-required check fails (`mergeStateStatus` = `UNSTABLE`) → warning dot and
    `1 optional checks failing`, not red.

## Validation

- Unit (`packages/services/test`): `statusCheckRollup` → `checks` mapping, primary selection, fork
  owner filter, branch-set union, TTL tiers, generation counter, `unavailable` paths.
- UI rendered-markup tests: row (both chains), hover card, context menu, Git tools group, header
  chip, Session manager cell; ordinary-session absence (scenario 6).
- i18n catalog parity test.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.

## Out of scope

- Persisting PR numbers per session (stacked PRs / PRs from other branches) — requires a fork
  migration (`fork_` column, `9002_fork_*` id in the CLI session store).
- PR status for ordinary sessions.
- Creating, merging, or closing PRs from the UI.
- Auto-archiving merged sessions; sidebar filters by PR state.
