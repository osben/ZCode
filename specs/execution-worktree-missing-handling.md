# Execution worktree missing handling

Status: implemented (2026-10-15; §3 amended same day: the health flag moved from a nested `executionWorktree.missing` extension to a top-level `executionWorktreeMissing` summary field — the nested wire schema is strict and frame validation fails closed, so a nested unknown key would drop whole frames on older clients).

## Problem

A worktree session binds the agent's execution cwd to a linked worktree directory (`executionWorktree {path, branchName}` on createSession; persisted as `execution_directory`/`execution_branch` in session-store migration `0023`). The user can delete that directory out-of-band (manual `rm`, `git worktree prune` from a terminal, repo re-clone). Today nothing notices:

- `resumeFromStore` restores `workingDirectory = session.executionDirectory` (`apps/zcode-cli/packages/core/src/runtime/methods/resume.ts:125-134`) without an existence check — the resumed turn runs with a nonexistent cwd and fails with confusing tool errors.
- The create path resolves the path without checking it (`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:172-178`) — a stale recovery path turns into the same silent dead cwd.
- The sidebar renders the GitBranch badge purely from the presence of `task.executionWorktree` (`packages/ui/src/workspace-grouped-tasks/task-row.tsx:244,464`) — a deleted worktree still shows a healthy badge.

This spec defines validation at the protocol boundary and a `missing` health fact surfaced to the UI and model context. A missing worktree does not disable the conversation: the agent can discuss stored history, while every operation that needs the worktree filesystem fails clearly. No operation may silently use the parent workspace as a substitute.

## Contract

### 1. Create boundary — reject

When assembling runtimeConfig for a new session with `params.executionWorktree` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:3497`), check that `path` exists and is a directory (fs stat in the CLI process — the same machine `workingDirectory` resolves against, valid for local and server-remote workspaces). Both create entry points funnel through `materializeSessionRecord` → `createRecord` (the legacy `session/create` op and the V4 native `createSession` command via `createSessionRecordForV4`), so this single check covers both.

- Missing/not-a-directory → fail the createSession request with a precise error (`Execution worktree path does not exist or is not a directory: <path>`). A session must never start executing in a dead cwd.
- The UI creates the worktree immediately before the first send (WT-04 recovery, `packages/ui/src/command-center/worktreeCreation.ts`), so rejection only fires on a race or a non-UI caller; the existing request-failure rendering covers it.

### 2. Resume boundary — preserve history and block filesystem actions

Resume paths must not fail the whole resume because the directory is gone; the session history is still valid. Keep the session's identity, rows, drafts, and worktree fact. Bootstrap may use the parent directory only to initialize conversation services. The resumed runtime keeps the missing execution path as its working directory, and a Host-side operation guard revalidates it before each filesystem, Git, or terminal tool call. These actions fail with a clear worktree-missing error; the parent must never be used as their fallback target.

- Protocol resume (`materializeSessionRecord`, `server-operations.ts:1514`): if the persisted `executionDirectory` does not exist on disk, keep the worktree fact on the record but mark it `missing: true` on the runtime-internal fact (the wire flag is §3's `executionWorktreeMissing`). Preserve the parent workspace as the session's listing identity. Do not silently convert the worktree execution target into the parent workspace.
- Cold-resume backstop in core (`resume.ts:125-134`): stat `session.executionDirectory`; when missing, keep it as `workingDirectory` and retain `config.executionWorktree` as `{ path, branchName?, missing: true }` (do NOT unset it — the fact must stay visible to the wire meta and model-context renderer, see execution-worktree-model-context.md). The runtime remains available for history-based conversation. A centralized operation guard must reject file, Git, shell, and other filesystem actions against the missing execution worktree with a clear error; it must revalidate the path before each action so deletion during a run also fails closed. One `warn` log (`event: "session.resume.execution_worktree_missing"`, `module: "core.runtime"`, sessionId + path). Never throw from resume. `getExecutionWorktree` (`apps/zcode-cli/packages/core/src/runtime/internal-methods.ts:89`) gains the same optional `missing` on its return type.
- Both checks are a single `stat` — no git probing, no `listWorktrees`.

### 3. Wire: `missing` health flag on the sessions-index summary

Additive **top-level** field on the summary (optional, `packages/shared/src/zcode-protocol-v4/sessions-index.ts:58`):

```ts
// Set when the worktree directory was absent when this summary was derived (host-side stat).
executionWorktreeMissing: z.boolean().optional(),
```

- The flag lives at the summary's top level, NOT inside `executionWorktree`: `zcodeExecutionWorktreeSchema` (`packages/shared/src/zcode-protocol/index.ts:1916`) is `.strict()`, and clients validate every incoming sessions-index frame with `frameSchema.safeParse` (`TopicWireFrameAssembler`), which turns a nested unknown key into a fault that drops the whole frame — one missing worktree would poison every snapshot for that workspace on older clients. A top-level additive field on the plain `z.object()` summary is silently stripped by old parsers instead — the same compatibility pattern as `workflowActivity`/`pendingInteractionSummary`. The nested wire shape stays byte-compatible; new UI + old CLI simply sees the field absent.
- The runtime-internal fact (`AgentRuntimeConfig.executionWorktree`, `apps/zcode-cli/packages/core/src/runtime/types.ts`) keeps a nested `missing?: boolean` — it never crosses the wire. The bridge strips runtime-only fields when placing the nested fact on a summary, so the strict wire schema keeps validating.
- Mirror the type on `ZCodeTaskMeta.executionWorktreeMissing` (`packages/shared/src/zcode-task-types-core.ts:362`).
- **Owner of the fact:** the CLI host that owns the filesystem — computed at the summary-metadata construction sites, NOT inside the projection reducer (it is documented pure, no I/O): the cold-seed stored-summaries provider (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts:1635`) and the live meta hook `getSessionIndexMeta` implementation (`v4-bridge.ts:1779`, consumed by `resolveIndexMeta` in `v4-gateway.ts:1190-1205`; the hook is synchronous, so the live check is a `statSync`). The reducer just carries the field and includes it in the upsert equality check (`sessions-index-projection.ts:128`).
- **Refresh cadence:** each time the summary is derived (session events, gateway cold start, sessions-index publisher construction). A plain re-subscription serves conflated state and does not re-stat. No fs watcher, no push on external deletion — the flag converges on the next derivation. This is an observation, not a session event: it does not enter `desktop-continuous` stream or `SessionEvent` journal.
- Resume detection (§2) marks the runtime fact `missing: true`, which the live meta hook maps to the summary flag immediately so the UI does not wait for a refresh to learn the worktree is gone.

### 4. UI: badge missing state

- `task-row.tsx` (both render chains, :244 and :464): when `task.executionWorktree` is present and `task.executionWorktreeMissing` is true, render the GitBranch marker in the destructive/attention color instead of the default, with tooltip `taskList.worktreeTaskLabelMissing` ("Worktree directory is missing; filesystem actions are unavailable"). Normal worktree sessions keep the existing `taskList.worktreeTaskLabel` tooltip.
- This slot is also where the pending icon-visibility improvement (colored icon + improved tooltip, option 2 of the 2026-10-15 badge study) lands; the missing color is the distinct state on top of it.
- Header "Open in editor/folder" targets are unchanged (they still point at the worktree path; the missing badge explains why opening fails).
- Row metadata equality (`useWorkspaceActiveTaskState.ts:61`) must compare the `executionWorktreeMissing` flag (normalized, absent ≈ false) so a state change re-renders.
- i18n: new key `taskList.worktreeTaskLabelMissing` in `en-US`, `zh-CN`, `uk-UA` (`packages/ui/src/i18n/locales/`).

## Why

Every surveyed harness treats a vanished worktree as a first-class state, not a crash: PI-Desktop reconciles worktree rows at startup and marks them `Missing` (`crates/host-core/src/session_worktrees/lifecycle.rs:885`); Copilot surfaces `workspaceWorktreeMissing`/`checkoutHealth: missing` with a retry action; deepseek's `workingDirectory.ensure()` restores the original project when the directory disappeared. Our current behavior — silent dead cwd on resume, badge that lies — is the worst of the three.

History survives worktree cleanup, so resume stays available. Filesystem work fails closed because redirecting an isolated session to the parent workspace could read or change unrelated files. New worktree preparation and activation also fail closed when the returned directory is absent or invalid.

## Acceptance scenarios

1. Session created with `executionWorktree` pointing at an existing directory → creates normally (unchanged happy path).
2. Create with a nonexistent path → createSession fails with the precise error; no session row is created.
3. Worktree deleted externally, then resume → history remains available; workspace/filesystem/Git/shell tool calls fail closed and never run in the parent; `warn` logged once; `config.executionWorktree` kept on the resumed runtime as `{ path, branchName?, missing: true }` (the fact must stay visible to the wire meta and the model-context renderer).
4. Same resume → the session row carries `executionWorktreeMissing: true` immediately (no refresh needed), and the user can ask questions about stored history.
5. In a missing-worktree session, an agent file or terminal action returns a clear missing-worktree error and never executes in the parent workspace; deleting the directory during a run has the same result on the next action.
6. Externally deleted worktree, no resume → next summary derivation (session event, gateway cold start, or index publisher construction) flips the badge to the missing state (color + tooltip); no realtime push required.
7. Recreated worktree at the same path → the next workspace-bound tool validation clears the runtime `missing` fact after confirming the directory is present; subsequent summary derivation returns the badge to normal (`executionWorktreeMissing` omitted/false). Non-workspace tools do not probe or change worktree health.
8. Plain sessions (no worktree) → summaries byte-identical to before; badge rendering untouched.
9. Old UI + new CLI (unknown `executionWorktreeMissing` field) and new UI + old CLI (field absent) → no parse errors (old parsers strip the unknown top-level key), badge shows the normal worktree state.
10. Projection upsert equality: a summary whose only change is `missing` produces a delta (does not get conflated away).

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Unit: extend `apps/zcode-cli/packages/core/tests/runtime-execution-worktree-resume.test.ts` (scenarios 3-4: missing directory on cold resume); extend `apps/zcode-cli/packages/bootstrap/tests/sessions-index-projection.test.ts` (scenario 9 + flag propagation through deriveSessionSummary); create-boundary rejection (scenario 2) at the server-operations level; UI badge state + equality in the existing task-row/task-meta test files.

## Out of scope

- Behind-base tracking and merge-back flows (separate future spec; PI-Desktop-style preview/merge/conflict).
- `git worktree repair` or any repair/recreate action.
- Realtime fs watching of worktree directories.
- A dedicated "Resume" button or toast on missing rows (the badge and clear blocked-tool error are the v1 surface).
- Recreating the worktree automatically.
