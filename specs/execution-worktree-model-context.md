# Execution worktree model context

Status: implemented (2026-10-15; amended same day: Task-tool subagent children build an explicit config field list rather than spreading the parent `AgentRuntimeConfig`, so the worktree fact is passed to the child explicitly and threaded through `SubagentContextBuilderConfig`).

## Problem

Worktree sessions execute in a linked worktree while the session's listing identity stays on the parent workspace. The model sees the worktree path as `Primary working directory` and the worktree branch as `Current branch` (git detection runs in cwd), but nothing says this is a _linked worktree_ of the parent workspace, nor that file changes stay isolated there until merged. The agent can plausibly believe it is editing the main checkout: it may suggest switching branches in the "main" tree, commit on the assumption its edits are shared, or fail to tell the user where the changes live.

Precedent: deepseek-harness deliberately pushes working-directory facts to the model as user-context snapshots ("directory context never enters the system prompt" there; ours already lives in a system `Environment` section, which is the equivalent owner). PI-Desktop instead keeps the renderer/agent runtime ignorant by design — not applicable to us, where the agent itself must reason about isolation.

## Contract

### Fact source — runtime config, render-time projection

- The authority is `config.executionWorktree` (`{ path, branchName?, missing? }`, set at create in `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:172-178` and at resume in `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts:129`; `missing: true` per execution-worktree-missing-handling.md §2).
- Extend the runtime-internal worktree type with an optional parent reference: `workspacePath` — set at create where the runtime config is assembled (bootstrap `runtime-config.ts` spreads `options.runtimeConfig`; the parent path is `options.runtimeConfig?.workingDirectory`, still un-overridden at that point) and at resume from `session.directory`. The wire schema (`zcodeExecutionWorktreeSchema`, `packages/shared/src/zcode-protocol/index.ts:1916`) stays unchanged; this is a core-runtime field only.
- `EnvInfo` (defined in `@zcode/contracts` `context-source.port.ts`, held by `apps/zcode-cli/packages/core/src/context/types.ts:105`) stays untouched: the fact is passed into the env-section builders at render time, not persisted into env-info snapshots and not restored from them (persisted `envInfo` shape/compat is frozen).
- No git probing: the line renders purely from config facts. Zero added I/O per turn.

### Rendering — both env builders

- Main agent: `buildEnvInfoSection` (`apps/zcode-cli/packages/core/src/context/sections/env-info.ts`) gains an optional third parameter with the worktree fact; `ContextBuilder` (`apps/zcode-cli/packages/core/src/context/builder.ts:168`) passes `this.config.executionWorktree`.
- Subagents: `buildSubagentEnvironmentContext` (`apps/zcode-cli/packages/core/src/subagent/system-prompt.ts`, rendered via `subagent/context-builder.ts:137-142`) gains the same optional parameter, and the bullet is inserted inside the subagent `<env>` block right after `Working directory:` (the analogous slot to the main agent's `Primary working directory`). Plumbing note (verified 2026-10-15): Task-tool subagent children do NOT spread the parent `AgentRuntimeConfig` — `methods/subagent.ts` builds an explicit field list — so the child config must gain `executionWorktree: this.config.executionWorktree` explicitly, and `SubagentContextBuilderConfig` (assembled in `runtime/methods/context.ts`) threads it to the builder. The `context.ts:116` spread comment applies to legacy workflow children only. Subagents must know about isolation as much as the main agent.
- Healthy worktree session — one extra bullet in the `Environment` section, after `Primary working directory`:

  `- Execution worktree: this session runs in a linked git worktree of <workspacePath> (branch <branchName>); file changes stay in the worktree until they are merged.`

  Omit the `(branch ...)` clause when `branchName` is absent (cold-seeded rows).

- Missing worktree (`missing: true`, session already fell back to the parent workspace per execution-worktree-missing-handling.md §2) — the bullet becomes:

  `- Execution worktree: the requested worktree <path> is missing; this session is running in the parent workspace <workspacePath> instead.`

- Plain sessions (no `executionWorktree`) → the section is byte-identical to today. This is a hard requirement: system-prompt formatting is pinned by contract tests (sentinel strings), and the shared prompt prefix must not shift for the majority non-worktree case.

## Why

One line removes a whole class of agent mistakes (branch confusion, "where are my changes" answers) for the price of a config read. It also gives the fallback in execution-worktree-missing-handling.md a model-visible surface, so the agent can explain to the user why it is suddenly running in the parent workspace.

## Acceptance scenarios

1. Worktree session (healthy, with branch) → Environment section contains the execution-worktree bullet with parent path and branch.
2. Worktree session without persisted branch (cold-seeded row) → bullet without the branch clause.
3. Plain session → Environment section byte-identical to the current output (regression guard).
4. Resume of a worktree session whose directory was deleted → bullet renders the missing-variant; the session cwd is the parent workspace.
5. Subagent spawned inside a worktree session → subagent environment block carries the same bullet.
6. Subagent spawned inside a plain session → no bullet.
7. No new git invocations during context build (the section build does no fs I/O for this line).

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Unit: `env-info` section builder tests for scenarios 1-3 and 7 (extend the existing context/env-info test coverage in `apps/zcode-cli/packages/core/tests/`); subagent context-builder test for scenarios 5-6; resume-missing variant covered together with execution-worktree-missing-handling.md (`runtime-execution-worktree-resume.test.ts`).
- Check the system-prompt contract tests still pass unchanged for plain sessions (scenario 3 is their concern too).

## Out of scope

- Directory-change notices mid-session (our worktree is fixed for the session lifetime; deepseek's `working_directory` tool has no counterpart here).
- Putting the fact into the git system-context block (branch label there already reflects the worktree branch).
- Any UI rendering of this line (UI surfaces are owned by execution-worktree-missing-handling.md).
