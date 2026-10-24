# Subagent Provider-Visible Prompt Assembly

> Historical implementation plan (2026-07-07), implemented and archived. Kept for the child
> system prompt shape contract, the frozen-copy rule, and the out-of-scope boundary.

**Goal:** Converge the provider-visible system prompt of ordinary subagent child requests
(Explore, general-purpose, custom profiles) onto one assembly shape, while keeping
`system[0] = "You are ZCode, an interactive coding agent"`.

## Contract

- Child `system` messages are exactly four entries, in order:
  1. ZCode CLI prefix: `You are ZCode, an interactive coding agent`
  2. agent-specific prompt (Explore / general-purpose / custom profile body)
  3. common subagent Notes (cwd reset, absolute paths, no emoji, no colon before tool calls,
     do not write report/summary/findings/analysis `.md` files)
  4. env/model context (working directory, git repo, platform, shell, OS version, model name)
- Explore and general-purpose agent-specific bodies use a single frozen copy, asserted exactly
  in `subagent-explore.test.ts` / `subagent-prompt-assembly.test.ts`. No variants by model,
  provider, channel, history, or experiment branch. Punctuation, line breaks, and operational
  wording are part of the provider-visible acceptance surface.
- The env/model context section has a fixed position and outer shape, but field values,
  fallbacks, shell display, git repo detection, and model name formatting reuse the current
  main runtime/context builder logic (`EnvInfo` from `contextSourceSnapshot.envInfo` /
  `config.envInfo`, session shell override, `formatModelRef(childModelRef)` into
  `envInfo.currentModel`, shared `isEnvInfoGitRepository` helper). Do not fabricate data the
  main path does not already expose.
- No extra identity narrative (for example "you are a subagent"); only the existing
  operational notes such as `Agent threads...` and `parent agent reads your text output...`.
- `currentDate` is not part of the four system messages; it flows through the existing
  meta-user `context_prefix` attachment when present.
- Main runtime `ContextBuilder` behavior is unchanged; only child runtimes select the
  subagent builder.

## Implementation Shape

- `AgentRuntimeConfig.subagentContext?: { agentPrompt: string }` selects the subagent builder;
  there is no `systemMessages` override config and no `systemPrompt` string path for children.
- `createContextBuilderFromSnapshot(...)` (`apps/zcode-cli/packages/core/src/runtime/methods/context.ts`)
  creates `SubagentContextBuilder` (`apps/zcode-cli/packages/core/src/subagent/context-builder.ts`)
  which returns a full `ContextBuildResult`: CLI prefix, agent prompt, Notes, environment,
  current date, skills; one provider-visible system message per section; skills_listing and
  context_prefix meta-user attachments. Resume, lazy, and refresh paths share the same builder
  strategy.
- Prompt pieces: `buildSubagentCommonNotes()` / `buildSubagentEnvironmentContext(...)`
  (`apps/zcode-cli/packages/core/src/subagent/system-prompt.ts`);
  `buildExploreAgentPrompt(...)` (`apps/zcode-cli/packages/core/src/subagent/explore.ts`)
  returns only the Explore agent-specific body (no embedded Notes/env context, no leading
  newline from the old custom-prompt wrapping).

## Verification Anchors

- Unit: `apps/zcode-cli/packages/core/tests/subagent-prompt-assembly.test.ts`,
  `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts` — assert the final child
  provider request (`messages.filter(role === "system")`), not runtime config or intermediate
  objects.
- E2E: `packages/desktop/test/e2e/conversation-session/conversation-session-subagent-prompt-assembly.test.ts`
  (foreground Electron window, replay provider, child request evidence).
- Main-prompt regression guards: `context-builder.test.ts`, `runtime-trace.test.ts`.

## Out Of Scope (unchanged boundary)

- Parent `Agent` tool schema/description, child `tools[]` schema, `SendMessage`,
  `Task` alias filtering, child tool allow/disallow and MCP required-server semantics.
- Background `<task-notification>` and idle wake, teammate/worktree isolation, fork/repl
  hydration, read-only agents omitting project instruction files, agent memory, appended
  subagent system prompts.
- Copy variants by model, provider, channel, historical version, or experimental branch.
