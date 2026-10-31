# Execution worktree model context

Status: implemented (2026-10-15).

## Problem

Worktree sessions execute in a linked worktree while the session's listing identity stays on the parent workspace. The model sees the worktree path as `Primary working directory` and the worktree branch as `Current branch` (git detection runs in cwd), but nothing says this is a _linked worktree_ of the parent workspace, nor that file changes stay isolated there until merged. The agent can plausibly believe it is editing the main checkout: it may suggest switching branches in the "main" tree, commit on the assumption its edits are shared, or fail to tell the user where the changes live.

## Contract

### Fact source — runtime config, render-time projection

- The authority is `config.executionWorktree` (`{ path, branchName?, missing? }`, set at create in `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:172-178` and at resume in `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts:129`; `missing: true` per execution-worktree-missing-handling.md §2).
- Extend the runtime-internal worktree type with an optional parent reference: `workspacePath` — set at create where the runtime config is assembled (bootstrap `runtime-config.ts` spreads `options.runtimeConfig`; the parent path is `options.runtimeConfig?.workingDirectory`, still un-overridden at that point) and at resume from `session.directory`. The wire schema (`zcodeExecutionWorktreeSchema`, `packages/shared/src/zcode-protocol/index.ts:1916`) stays unchanged; this is a core-runtime field only.
- `EnvInfo` (defined in `@zcode/contracts` `context-source.port.ts`, held by `apps/zcode-cli/packages/core/src/context/types.ts:105`) stays untouched: the fact is passed into the env-section builders at render time, not persisted into env-info snapshots and not restored from them (persisted `envInfo` shape/compat is frozen).
- No git probing: the line renders purely from config facts. Zero added I/O per turn.

### Rendering — own section in both builders

- Environment facts (cwd, platform, shell, git flag) now reach the model as runtime announcements, not as system text (upstream 3.17.1 environment model). The worktree notice is therefore a separate section, not a bullet inside the `Environment` block.
- Main agent: `buildExecutionWorktreeSection` (`apps/zcode-cli/packages/core/src/context/sections/env-info.ts`) renders the fact as a dynamic system section (`source: execution_worktree`) with the `# Environment` heading and one bullet. `ContextBuilder` (`builder.ts`) appends it after the environment sections. It is not gated by the incognito `environment` toggle.
- Subagents: `buildSubagentExecutionWorktreeContext` (`apps/zcode-cli/packages/core/src/subagent/system-prompt.ts`) returns a bare `<env>` block that holds only the worktree bullet; `SubagentContextBuilder` (`subagent/context-builder.ts`) adds it as a system section after the environment sections. Task-tool subagent children do NOT spread the parent's worktree fact (unchanged).
- Healthy worktree session — one bullet:

  `- Execution worktree: this session runs in a linked git worktree of <workspacePath> (branch <branchName>); file changes stay in the worktree until they are merged.`

  Omit the `(branch ...)` clause when `branchName` is absent (cold-seeded rows). The subagent block carries the same sentence without the list prefix.

- Missing worktree (`missing: true`; the session retains its missing execution target and blocks workspace actions per execution-worktree-missing-handling.md §2) — the bullet becomes:

  `- Execution worktree: the requested worktree <path> is missing; filesystem and terminal actions are blocked until it is restored. The parent workspace is <workspacePath>.`

- Plain sessions (no `executionWorktree`) → no notice section or block; the rest of the prompt is unchanged. This is a hard requirement: system-prompt formatting is pinned by contract tests (sentinel strings), and the shared prompt prefix must not shift for the majority non-worktree case.

## Why

One line removes a whole class of agent mistakes (branch confusion, "where are my changes" answers) for the price of a config read, and makes the fail-closed state model-visible so the agent can explain that history remains available while filesystem actions wait for worktree restoration.

## Acceptance scenarios

1. Worktree session (healthy, with branch) → the execution-worktree section contains the bullet with parent path and branch.
2. Worktree session without persisted branch (cold-seeded row) → bullet without the branch clause.
3. Plain session → no execution-worktree section or subagent block (regression guard).
4. Resume of a worktree session whose directory was deleted → bullet renders the missing-variant; the session retains the missing execution target, and workspace actions remain blocked until restoration.
5. Subagent spawned inside a worktree session → subagent environment block carries the same bullet.
6. Subagent spawned inside a plain session → no bullet.
7. No new git invocations during context build (the section build does no fs I/O for this line).

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Unit: `env-info` section builder tests for scenarios 1-3 and 7 (extend the existing context/env-info test coverage in `apps/zcode-cli/packages/core/tests/`); subagent context-builder test for scenarios 5-6; resume-missing variant covered together with execution-worktree-missing-handling.md (`runtime-execution-worktree-resume.test.ts`).
- Check the system-prompt contract tests still pass unchanged for plain sessions (scenario 3 is their concern too).

## Out of scope

- Directory-change notices mid-session (the worktree is fixed for the session lifetime).
- Putting the fact into the git system-context block (branch label there already reflects the worktree branch).
- Any UI rendering of this line (UI surfaces are owned by execution-worktree-missing-handling.md).
