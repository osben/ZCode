# Subagent Tool

The model-visible tool name is `Agent`; the historical alias is `Task`. This design document calls it `Subagent`, but the implementation keeps `Agent` as the model-visible tool name, consistent with agent configuration, transcripts and SDK events in the compatible Claude Code plugin ecosystem.

## Purpose

`Agent` is not an ordinary function call but a small agent runtime entry. It picks an execution form from the input:

| Form                | Trigger                                                                                                              | Description                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| fresh subagent      | `subagent_type` specified, or omitted when fork is not enabled                                                       | Creates an independent agent conversation that gets only this `prompt` and the agent's own system prompt     |
| fork subagent       | fork gate on and `subagent_type` omitted                                                                             | The child inherits the parent conversation history, system prompt and exact tool pool, to share prompt cache |
| background subagent | `run_in_background`, agent definition `background: true`, or forced by coordinator, assistant mode, fork gate or proactive | Returns a task reference immediately; re-enters the main session as a notification on completion             |
| worktree subagent   | `isolation: "worktree"` or the agent definition carries worktree isolation                                           | Runs in a temporary git worktree; auto-cleaned if unchanged, path and branch kept if changed                 |
| remote agent        | `isolation: "remote"`                                                                                                | Executes in a remote environment; not supported by ZCode today                                               |
| teammate spawn      | `team_name` and `name` both present                                                                                  | This is an agent team/swarm, not an ordinary subagent; handle as a separate tool or mode                     |

Key boundary: an ordinary subagent is not an OS child process; it creates a new child execution context inside the same process and runs a new query loop. External processes, tmux, in-process teammates and remote agents belong to the agent team or remote task branches and must not be mixed into one concept with ordinary subagents.

## Input contract

Model-visible base input:

| Field               | Type      | Required | Description                                                                                                                       |
| ------------------- | --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `description`       | `string`  | yes      | Short description of 3 to 5 words for UI, task state and activity text                                                            |
| `prompt`            | `string`  | yes      | Task body for the child agent                                                                                                     |
| `subagent_type`     | `string`  | no       | Agent type to use. When omitted: `general-purpose` if the fork gate is off, fork if on                                            |
| `run_in_background` | `boolean` | no       | Request background run. The schema hides this field when background tasks are disabled or the fork gate is on                     |

`Agent` model-visible input has no invocation-level `model` override. Old transcripts may keep a historical `model` field, but the current input schema ignores it; the child runtime consumes only the Agent profile model resolved from Settings or the Markdown definition.

Extended input:

| Field       | Type                     | Scope                           | Description                                                                                                            |
| ----------- | ------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`      | `string`                 | background subagent or teammate | Gives the spawned agent an addressable name. A background subagent can be continued with `SendMessage({ to: name })`   |
| `team_name` | `string`                 | agent team                      | Together with `name` triggers teammate spawn. May use the current team context when omitted                            |
| `mode`      | permission mode          | agent team                      | Mainly for spawned teammates, such as `plan` mode. An ordinary subagent must not treat it as a child permission override |
| `isolation` | `"worktree" \| "remote"` | subagent                        | `worktree` creates a temporary git worktree. `remote` is not supported today                                           |
| `cwd`       | `string`                 | gated                           | Runs the child in the given cwd. Requires an absolute path and is mutually exclusive with `isolation: "worktree"`      |

ZCode makes schema gating a capability-negotiation result instead of scattering feature flags inside the tool. The absolute-path requirement of `cwd` and its mutual exclusion with worktree must also enter `validateInput`, not only the prompt description.

## Output contract

There are two public output schemas:

| `status`         | Fields                                                                      | Description                                                                                          |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `completed`      | `prompt` plus `agentToolResultSchema`                                       | Completed synchronously; returns the child's final text, usage, tool use count, duration and `agentId` |
| `async_launched` | `agentId`, `description`, `prompt`, `outputFile`, `canReadOutputFile`       | Background start succeeded; the result returns later through a task notification                     |

Two internal branches:

| `status`           | Description                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| `teammate_spawned` | team/swarm branch, returns teammate id, name, team, pane and so on                   |
| `remote_launched`  | remote branch, returns remote task id, session URL and output file                   |

`agentToolResultSchema`:

| Field               | Type                               | Description                                                                          |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `agentId`           | `string`                           | Child agent ID, also the correlation key of transcript/task/output                   |
| `agentType`         | `string?`                          | Agent type. Used so one-shot built-in agents skip the continuation trailer           |
| `content`           | `{ type: "text"; text: string }[]` | Final text blocks of the child agent                                                 |
| `totalToolUseCount` | `number`                           | Total tool uses inside the child agent                                               |
| `totalDurationMs`   | `number`                           | Total duration                                                                       |
| `totalTokens`       | `number`                           | Token count aggregated from the last assistant usage                                 |
| `usage`             | provider usage object              | input, output, cache, server tool use, service tier and so on                        |

Model-visible serialization is not raw JSON:

- On synchronous completion `content` is handed directly to the parent agent, followed by `agentId` and a `<usage>` trailer.
- One-shot built-in agents such as `Explore` and `Plan` omit the `agentId` and usage trailer when there is no worktree info, to cut token cost.
- On background start the parent agent is explicitly told not to repeat the same work and given the output file. The hint that it may read or tail the output file is shown only when the parent agent has `Read` or `Bash`.
- On remote start the parent agent is told to briefly inform the user it has started, then end the turn.
- The child's result is not shown to the end user automatically; the parent agent must summarize or continue.

## Agent definition contract

ZCode user/project custom Markdown is loaded only from direct files in the respective `agents` roots (`.md` / `.markdown`, case rules unchanged), without scanning subdirectories; standalone CLI, Host and Settings use the same scope. Plugin agents keep following the existing plugin discovery rules. See the root `docs/subagent-runtime-refresh.md`.

An agent definition has three kinds of source:

| Source   | Description                                                                              |
| -------- | ---------------------------------------------------------------------------------------- |
| built-in | Built into the code, system prompt generated dynamically                                 |
| custom   | Markdown or JSON agent in user, project, policy or flag settings                         |
| plugin   | Agent provided by a plugin; the agent type carries the plugin namespace                  |

Core fields of an agent definition:

| Field                | Description                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agentType`          | Stable name used when the model calls `subagent_type`                                                                                |
| `whenToUse`          | Selection guidance written into the Agent tool prompt                                                                                |
| `getSystemPrompt`    | Child agent system prompt                                                                                                            |
| `tools`              | Allowed tool specs. Omitted or `["*"]` means the whole available set after filtering is allowed                                     |
| `disallowedTools`    | Removed again from the allowed set                                                                                                   |
| `model`              | Agent default model; `inherit` inherits the parent model                                                                             |
| `effort`             | Reasoning effort override                                                                                                            |
| `permissionMode`     | Permission mode of tools inside the agent. Ordinary workers default to `acceptEdits`                                                 |
| `maxTurns`           | Maximum turns of the agent's inner query loop                                                                                        |
| `skills`             | Prompt skills preloaded at startup                                                                                                   |
| `mcpServers`         | Scope of parent MCP servers visible to the child; the design may support references or inline config, ZCode currently accepts only a list of parent server names |
| `requiredMcpServers` | Availability precondition of the agent: a matching server with tools must exist                                                      |
| `hooks`              | Session-scoped hooks registered during the agent lifecycle                                                                           |
| `background`         | The agent always runs in the background                                                                                              |
| `initialPrompt`      | Extension of the agent's initial prompt                                                                                              |
| `memory`             | user/project/local agent memory                                                                                                      |
| `isolation`          | Default isolation mode of the agent                                                                                                  |
| `injectAgentsMd`     | Whether to inject AGENTS.md into the child; read-only built-in agents do not inject by default to save tokens, see below             |

Load priority is built-in, plugin, user, project, flag, managed, overriding group by group; for the same agent name a later source overrides an earlier one. A Markdown file that fails to parse enters `failedFiles` only if it looks like an agent file.

### ZCode AGENTS.md injection contract

ZCode custom agent Markdown additionally supports the optional frontmatter field `injectAgentsMd: boolean`. It only controls whether the child request injects the AGENTS.md already resolved by the parent runtime and does not change the agent system prompt:

| Profile                      | Default behavior of `injectAgentsMd`        |
| ---------------------------- | ------------------------------------------- |
| built-in `general-purpose`   | inject                                      |
| built-in `Explore`           | do not inject                               |
| custom                       | inject; explicit `false` turns it off       |

The child runtime receives only a snapshot of the parent runtime's `contextSourceSnapshot.userInstructions`; with no parent snapshot nothing is injected, and the child neither re-reads files nor builds a fallback. The provider-visible position is the same as Main, reusing Main's Request User Context formatter:

```text
userInstructions resolved by the parent runtime
              |
              v
child system messages (existing 4 segments, unchanged)
meta-user context_prefix
  |- # agentsMd + AGENTS.md (when injection is allowed and content non-empty)
  `- currentDate
real child task
```

AGENTS.md must not be spliced into the agent-specific prompt, the common Notes or the environment system message; the child also does not inherit Main's Project Context or Project Memory. The Settings user custom agent form shows this field below the system prompt editor as a single-line "Inject AGENTS.md" switch, with the text and Switch vertically centered and no helper text; a change takes effect on the next runtime/profile load, and no hot-refresh chain is added. The `# agentsMd` heading shares the same formatter as Main and is rendered once depending on whether the aggregated request-user-context is non-empty. Since the child does not inherit Main Project Memory, the actual judgment in the child chain is still equivalent to whether the parent snapshot contains non-empty AGENTS.md; Explore, a custom agent with injection explicitly turned off, and a parent snapshot without AGENTS.md all render nothing.

## Tool Pool

A child agent does not simply inherit the parent's tools. An ordinary subagent uses:

1. Generate the worker permission context from the agent's `permissionMode`, default `acceptEdits`.
2. Assemble candidate tools from the worker permission context and the current MCP tools.
3. Apply the agent's `tools`, `disallowedTools` and the global subagent filter (distinguishing synchronous and background agents).
4. After agent-specific MCP servers initialize, merge their MCP tools with the resolved tools and dedupe by name.

Global filter rules:

- MCP tools are available to all agents.
- `ExitPlanMode` is specially allowed only in plan-mode agents.
- `TaskOutput`, `ExitPlanMode`, `EnterPlanMode`, `AskUserQuestion`, `TaskStop` and similar are forbidden for subagents by default.
- A subagent may not call `Agent` again, to avoid recursion.
- Custom agents inherit the same disallowed tools.
- An async agent may use only the background-agent allowed tool set, including read/search/web fetch/shell/edit/write/notebook/skill/tool search/worktree enter-exit and so on.
- An in-process teammate has extra allowed task tools and `SendMessage` for team collaboration.

The `Agent(...)` tool spec has a special meaning: on the main thread it can carry a list of allowed agent types, limiting which `subagent_type` the model can choose. Inside a subagent this spec keeps only the metadata and does not resolve an actual `Agent` tool.

Fork path exception: a fork child uses the parent agent's exact tool array and also inherits the parent thinking config and non-interactive setting, so that system prompt, tools, model, messages and thinking config stay byte-identical and hit the prompt cache.

## Execution flow

Ordinary fresh subagent:

1. Validate agent team permission and the nested teammate limit.
2. Resolve `effectiveType`: an explicit `subagent_type` wins; when omitted choose fork or `general-purpose` by the fork gate.
3. Filter agents by MCP requirement and permission deny rules.
4. If a required MCP server is still pending, wait at most 30 s, polling every 500 ms.
5. Resolve the model and record the agent selection event.
6. Get the agent system prompt and add environment details and available tool info.
7. Build a single user message whose content is `prompt`.
8. Assemble the worker tool pool.
9. If needed, create a worktree and run subsequent execution under that cwd.
10. Create the child execution context and run the child query loop.
11. The outer runner must also listen to the parent abort signal and maintain a foreground child activity watchdog. The watchdog by default reuses the model-stream idle timeout window and resets on child session events; if the child promise is still unresponsive after the silence window, end with `ToolTimeout` and write `SubagentStopped`. If the child promise does not settle after the parent aborts, end with `ToolCancelled`, so a foreground `Agent` does not stay in running for long.
12. Collect child agent messages and forward tool progress, bash/powershell progress and token metrics.
13. At the end extract the last assistant text, usage and total tool use count.
14. If the auto mode classifier is on, run a safety review of the subagent handoff.
15. Clean up the foreground task, hooks, skills, dump state and worktree.

Fork subagent:

1. `subagent_type` omitted and the fork gate on.
2. First use `querySource` and the fork boilerplate tag in messages to prevent a fork child from forking again.
3. Use a synthetic fork agent definition whose `agentType` is `fork`, `model` is `inherit`, `permissionMode` is `bubble` and `tools` is `["*"]`.
4. The child agent uses the system prompt already rendered by the parent conversation. It is recomputed only if unavailable, which may break the cache.
5. Clone all tool_use/thinking/text blocks of the parent assistant message, fill each tool_use with the same placeholder tool_result, then append the per-child directive.
6. A fork child is forced to run in the background and returns to the main loop through a task notification.
7. With fork + worktree, a worktree notice is appended, reminding that paths come from the parent cwd and must be translated to the worktree, and that possibly stale files must be re-read.

Background subagent:

1. Create `agentId` in advance and register a `LocalAgentTask`.
2. The task output path is written to `output.txt` and `task.output`; the child's messages/parts and the session state needed for recovery are persisted by the session store (default SQLite).
3. Return `async_launched`; the parent agent continues other work or ends the turn.
4. The background lifecycle consumes the child message stream and keeps updating progress.
5. On completion, first mark the task completed, so readers of the output are not stuck by the classifier or worktree cleanup.
6. Send status, summary, output file, usage and worktree info back into the main session via `<task-notification>`.
7. AbortError marks killed and returns a partial result when possible; other exceptions mark failed. A failed notification must take the original message closest to the provider from the exception cause chain: `<error>` stores the same original text, and the summary keeps the existing `Agent <type> task "<description>" failed.` prefix followed directly by that original text, without translation or error-code mapping, and without disguising the failure as `<result>`.
8. The parent-side Agent tool's initial `completed` only means the background task started successfully; only a failed notification matching `tool-use-id` may override the launch ACK. Both live events and snapshot/restore must override with the notification's `failed + error`, so the existing "execution failed" status text and hover error details are not lost when switching tasks; stopped/killed and other recovery semantics are out of scope of this change.

Sync to background:

- A synchronous agent also registers a foreground task at the start.
- After more than 2 s the UI may show a background hint.
- When the user or auto-background triggers it, the current iterator first `return()`s to clean up, then the child is rerun in the background with the same task id.
- The result returned to the parent agent becomes `async_launched`.

## Child context isolation

The child execution context isolates all mutable state by default:

| State                         | Default behavior                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| read file state               | cloned from parent, cleared at the end                                                                                   |
| abort controller              | a new child controller. A synchronous Agent may explicitly share the parent controller; background agents use an independent controller |
| app state reads               | marked by default to avoid permission prompts, preventing a background agent from popping interactive permission prompts |
| app state writes              | no-op by default. When task registration and kill are needed, write the root store only through the task-specific entry   |
| response length               | may be shared so the child counts into the parent response metrics                                                       |
| memory/skill/dynamic triggers | fresh Set                                                                                                                |
| content replacement state     | cloned from parent; fork uses it to keep cache replacement decisions consistent                                          |
| query tracking                | new chain id, depth is parent plus one                                                                                   |

When running, the child also:

- Creates or uses the passed-in `agentId`.
- For fork, filters incomplete tool calls so orphaned tool use does not break the API request.
- Loads user/system context; a read-only built-in agent may omit part of the context.
- Runs `SubagentStart` hooks and adds hook additional context to the initial messages as an attachment message.
- Registers agent frontmatter hooks; the Stop hook is converted to `SubagentStop`.
- Preloads the prompt skills named in agent frontmatter.
- Initializes agent-specific MCP servers and cleans them up at the end.
- Writes the output artifact and metadata; no longer writes an extra `transcript.jsonl`, child agent history is stored by the session store (default SQLite).
- In finally, cleans up MCP, session hooks, prompt cache tracking, read cache, todos, background shell/monitor tasks.

## Transcript and Resume

ZCode no longer writes a standalone `transcript.jsonl` file. The child agent's messages/parts and the session state needed for recovery are persisted by the session store (default SQLite); the session event store owns runtime event ordering, live sink and in-process event replay. The task artifact directory holds only `output.txt`, `task.output` and `metadata.json`.

metadata stores at least:

| Field          | Description                                                          |
| -------------- | -------------------------------------------------------------------- |
| `agentType`    | Restores the original agent type on resume. Fork resume must know it is `fork` |
| `worktreePath` | Restores cwd when a worktree agent resumes                           |
| `description`  | Original description used in notifications                           |

`SendMessage` can continue an already spawned subagent:

- `to` may be a registered name or a raw `agentId`.
- When a running task receives a message, only the text is put in `pendingMessages` and drained at the next tool round boundary.
- A stopped task is automatically resumed through `resumeAgentBackground()`.
- When the task has been evicted from the registry, the target is currently not rediscovered from the disk artifact alone.
- Resume reads messages/parts and session entries from the session store, filters unpaired tool use, rebuilds content replacement state, restores the worktree cwd, and appends the new prompt as a user message.
- Fork resume must rebuild the parent system prompt and must not pass in the original fork parent context slice again, to avoid duplicate tool_use ids.

Current persistence boundary: the session store (default SQLite) owns child history and session state; the session event store owns runtime event ordering, live delivery and in-process replay. Resume reads from the session store and no second transcript sidecar is maintained.

## Permissions and side effects

If `Agent`'s read-only declaration is fixed to `true` (because it only orchestrates and actual side effects are permission-checked by the underlying tools the child calls), this is convenient for the tool framework but too coarse for ZCode's audit semantics.

ZCode recommends two declaration layers:

| Dimension               | Recommendation                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `orchestrationReadOnly` | `true`; spawning itself does not write files, run commands or use the network directly                      |
| `effectiveReadOnly`     | dynamic, depends on the agent tool pool, permission mode, prompt intent, isolation and background           |
| `sideEffectScope`       | union of `session`, `workspace`, `git`, `network`, `system`, `userInteraction`                              |
| `concurrencySafe`       | spawn orchestration is concurrent, but write tools on the same worktree/cwd are still protected by the underlying tools and file locks |
| `destructive`           | if the agent can use write, shell, git or network tools, raise to potentially destructive                   |

Permission rules:

- An `Agent(...)` permission deny can forbid an agent type.
- Directly allowed in auto mode.
- A child agent should not automatically inherit the parent agent's tool restrictions; it reassembles through its own tool pool and permission mode.
- But when the parent permission mode is `bypassPermissions`, `acceptEdits` or `auto`, the child inherits that capability boundary and an agent definition must not override it to lower permission. This is a high-risk point.
- An async agent avoids permission prompts by default, unless the permission mode is `bubble` or showing prompts is explicitly allowed.
- `AskUserQuestion` is unavailable inside a subagent by default, so a child agent does not start interaction with the user directly.

The ZCode permission system should generate a `SubagentPolicy` snapshot before spawning, recording agent type, allowed tools, permission mode, side effect scopes, whether background is allowed, whether resume is allowed, whether worktree is allowed and whether a user prompt is allowed.

## Hooks, MCP, Skills

### Official Computer Use subagent boundary

When a child agent borrows the parent MCP port, the official `zcode-cua` cannot be inherited through a wildcard. Core uses the frozen official server authority to remove it from the child snapshot, tool allowlist and SkillPort; when a profile explicitly declares the official CUA server, tool, selector or Skill, `SUBAGENT_COMPUTER_USE_UNAVAILABLE` is returned before the child's first model request. This rule applies to Explore, general-purpose, custom, background and resume.

This filtering changes only the child view, not the parent snapshot, the MCP lifecycle or the main Agent's official CUA tools. The Producer must still reject all CUA tool calls when `runtime_scope=subagent`, as an execution-time backstop that the tool surface cannot bypass. Full contract: `docs/cua/2026-08-18-subagent-computer-use-unavailable-spec.md`.

A subagent does not only run model and tools; it also triggers the extension system:

- `SubagentStart` hooks input contains `agent_id` and `agent_type` and may return additional context.
- Agent frontmatter hooks are registered as session-scoped hooks and cleaned up when the agent lifecycle ends.
- Agent Stop hooks run as `SubagentStop` events.
- Agent frontmatter `mcpServers` may by design merge additively on top of the parent MCP clients, with the inline MCP client cleaned up at the end; ZCode currently has the child only borrow parent-owned MCP connections and does not create inline clients.
- Under plugin-only policy, user-controllable frontmatter MCP and hooks are skipped or restricted.
- `skills` are resolved at agent startup and preloaded as a meta user message; plugin skills can be resolved by bare name, plugin prefix or suffix match.

ZCode treats hooks/MCP/skills all as external I/O or extension boundaries, which must carry trace, permission, timeout, cleanup and source trust.

## Failure paths

Key failure paths:

- `team_name` passed while agent teams are not enabled.
- A teammate tries to spawn another teammate.
- An in-process teammate tries to spawn a background subagent, or the selected agent definition has `background: true`.
- A fork child triggers fork again.
- `subagent_type` does not exist.
- `subagent_type` exists but is forbidden by an `Agent(agentType)` deny rule.
- Required MCP server pending timeout, failed, unauthenticated or without tools.
- Remote agent eligibility not met, bundle or session creation failed (remote is not supported today).
- Agent system prompt fetch failed, falling back to the default agent prompt.
- Agent-specific MCP initialization failed.
- The child finishes without an assistant message and the result finalization stage errors.
- Sync agent AbortError.
- Sync agent exception midway but already has an assistant message: return a partial finalized result when possible.
- Async agent AbortError: mark killed and return a partial result.
- Async agent ordinary exception: mark failed.
- The provider's original message of an async agent ordinary exception must enter the task notification summary, `<error>`, the runtime task error and `SubagentStopped.payload.error` together; the outer `Turn execution failed` may be kept only as detail and must not override the failure reason seen by the parent model or the Agent card.
- Worktree cleanup failed or the worktree was deleted externally: on resume fall back to the parent cwd.
- Classifier unavailable or judges the handoff dangerous: a warning must be inserted into the result visible to the parent agent.
- Child history missing in the session store: resume fails.
- Output file or task state evicted: `SendMessage` does not rediscover the target from the disk artifact alone.

## ZCode Explore MVP (historical baseline)

This section records the narrowed scope of the original Explore MVP and no longer represents the full current capability:

- The model-visible tool name is `Agent`; input contains `description`, `prompt`, optional `subagent_type` and optional `run_in_background`.
- At that time v1 supported only `subagent_type: "Explore"`, defaulting to `Explore` when omitted.
- `Explore` supports synchronous one-shot and `run_in_background: true` background runs; after background completion it enters the next model request through a parent session notification.
- At that time v1 did not support resume, fork, worktree, team, MCP, hooks, agent skills or `SendMessage`.
- The child runtime uses an independent session id but inherits the parent `traceId`; `SubagentSpawned` / `SubagentStopped` events are written to the parent session, child tool/model/turn events to the child session.
- Child `tool_call_scheduled` / `tool_call_started` / `tool_call_progress` / `tool_call_result` / `tool_call_error` events must be mirrored to the parent runtime's live event sink, so compatible consumers, runtime diagnostics and telemetry can observe the tools running inside Explore. Mirrored events use the parent session id, parent turn id and a namespaced toolCallId, with the payload keeping `source: "subagent"`, `parentToolCallId`, `childSessionId`, `childToolCallId`, `agentId`, `agentType` and `description`. Mirrored events are not written to the parent event store; the source of truth is still the original events persisted in the child session, so a child tool is never mistaken for a model-visible tool call of the parent agent.
- ZCode Protocol V4 puts Agent/Task details uniformly in the child session. Before materializing a tool row, the parent ProductProjection must drop mirrored lifecycle events with `source: "subagent"` and must not generate a parent `ToolCallRow`, plan or file summary; the child topic still generates full tool rows from the original events. The waiting state of a foreground child is expressed by the parent Agent tool and the main turn phase, a background child by the subagent manifest/background work; blocking interactions such as permission and questions continue to be proxied to the parent session by subagent origin. Desktop continuous and mobile replayable use the same projection boundary.
- The child runtime's model comes only from the resolved Agent profile; when the profile configures no model it inherits the parent runtime's `modelRef` and `modelProviderOptions` at that time. `Agent` tool input provides no invocation-level model override, so historical tool call arguments cannot override the current Settings or Markdown profile configuration.
- The main runtime currently uses the embedded search branch by default; both main model requests and Explore child requests hide direct `Glob/Grep` and serve broad file/code search through Bash `find` / `grep` functions. Only when Windows CMD or a legacy shell fallback cannot inject Bash functions does it return to the non-embedded/direct branch and expose `Glob/Grep`.
- The child tool pool switches by the embedded search branch: by default `Bash`, `Read`, `WebFetch`, `WebSearch`, `TodoWrite`; the direct fallback branch additionally includes `Glob`, `Grep`. It always explicitly excludes recursion, write and user-interaction capabilities such as `Agent`, `Write`, `Edit`, `ApplyPatch`, `Skill`, `AskUserQuestion`.
- `Agent` itself is declared orchestration-layer read-only, `sideEffectScope: session`, needing no approval; actual file reads still go through the child's read-only tools with their own schema, permission and trace. `Bash` is the only entry in the child tool pool that may cause side effects, and its read-only constraint is carried jointly by the Explore system prompt's read-only prohibition and the absence of file-write tools.
- The child runtime uses `yolo` mode and a dedicated Explore system prompt; `plan` mode would intercept Explore's read-only shell queries because Bash is non-read-only, so at this stage read-only semantics are constrained by the tool allowlist and the Explore system prompt. Business code dispatches through `SubagentPort` and does not depend on runtime internals.

The original design source of background subagents is [Background Subagent v1 Implementation Plan (historical)](./07-subagent-background-plan.md). That document explains the v1 lifecycle trade-offs and does not override this section or the current `RespondToCoordinator` contract.

When adding new agent types, this stage's plan requires first adding:

- `AgentDefinitionRegistry` or an equivalent contract, declaring agent type, description, system prompt source, tool pool, permission boundary, and whether background/resume/worktree/user prompt are allowed.
- A `ToolPoolResolver` that resolves agent declarations into model-visible tool contracts, with tests proving recursive Agent, user interaction and write tools do not leak by accident.
- A child agent session history / task state storage contract supporting resume, kill, progress, notification and event replay.
- Capability, permission, timeout, cleanup and trace declarations for extension boundaries such as hooks, MCP, skills and remote agent.

## ZCode current implementation

The current implementation has grown from the original Explore MVP into a profile-backed local agent:

- The model-visible tool name is still `Agent`; when `subagent_type` is omitted it defaults to `general-purpose`, and an explicit value is resolved through the agent profiles loaded by the current runtime.
- A profile-backed agent supports synchronous runs and `run_in_background: true`. Background tasks keep using `RuntimeTaskRegistry`, the child session, completion notification and the runtime command queue; no second task state is built.
- The runtime registers the model-visible `SendMessage` only when `SubagentPort.sendMessage` is available; a profile-backed child currently has subagent capability fixed off and does not inject that port, so `SendMessage` is not registered there. If a child provides this port in future, the tool allowlist/disallowlist still keeps filtering model-visible tools.
- Built-in agents include the default `general-purpose` and the read-only search `Explore`; project/user profiles can override system prompt, tool policy, model, permission mode, skills and background settings. A profile's `tools: ["*"]` still has to converge through the global child tool filter, profile `disallowedTools` and runtime allow/disallow rules.
- The provider-visible `TaskStop` can stop `local_agent` / `local_bash` that are already backgrounded in the current runtime; the result `command` of `local_agent` uses the short `description` and must not fall back to the full `prompt`.

### Built-in Explore identity boundary

- `AgentProfile.source` is an identity fact written by the loader; frontmatter cannot override it. A project/user profile may override the built-in definition with the same name `Explore`, but still keeps its own source after overriding.
- Only `name === "Explore" && source === "built-in"` uses the built-in read-only prompt, the dynamic Explore tool pool, the `explore` toolset, the dedicated permission service, and yolo when no permission mode is explicitly set.
- A custom Explore of the same name behaves like any other custom profile: it uses its own prompt and tools, limits the visible parent MCP by its own `mcpServers`, uses the `main` toolset, and inherits ordinary custom agent permission semantics.

### Child MCP ownership and startup snapshot

- The connection and close lifecycle of the MCP adapter belongs to the parent runtime. The child only waits for and reuses the startup snapshot saved by the parent `mcpStartupPromise`, and does not re-call parent `status()` or `listTools()` at creation.
- `mcpServers` accepts only a list of parent server name strings; omitted or empty means no extra restriction. A non-empty list restricts the snapshot exactly by the descriptor's original `serverName`, and only descriptors connected at startup are visible.
- Wildcard/inherited tool sets and explicit MCP tool validation use the same scoped snapshot; an explicit tool is matched by its full model-visible name and the server is not inferred by splitting `mcp__<server>__<tool>`.
- The child holds a snapshot-backed borrowed port: `status()` / `listTools()` only replay the fixed snapshot, `callTool()` delegates to the parent; connect, reconnect and disconnect are all rejected, and child close does not propagate to the parent.
- This is fixed startup-snapshot semantics: a new descriptor that appears after parent startup through OAuth or reconnect enters the subagent candidate tool set only after the parent runtime is rebuilt.

```text
Parent startup -> MCP snapshot -> parent registry
                         |
Child spawn     -> scoped fixed snapshot -> provider tools -> parent.callTool
                         |
Child finish    -> no parent MCP cleanup
```

### SendMessage current scope

- `to` must be a `local_agent` task/agent id still addressable in the current runtime `RuntimeTaskRegistry`. Name aliases and cross-runtime delivery are currently not supported, and the target is not rediscovered from the disk artifact alone after the task was evicted from the registry.
- The provider-visible description and field notes cover only the local-agent subset; unsupported ZCode team protocols such as teammate mailbox, shutdown and plan approval do not enter the tool description.
- A running agent with an active message sink gets direct delivery into the current turn, returning `steered` or `queued`; with no sink or on sink delivery failure it goes into that task's pending message queue.
- When a terminal agent still keeps its profile and child session id, `SendMessage` reuses the original child session and resumes it in the background; when the target, profile or child session metadata is missing it returns a structured failure.
- The model-visible success texts for queued and terminal resume are fixed as: `Message queued for delivery to ${to} at its next tool round.`; `Agent "${to}" was stopped (${status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${outputFile}`. `steered` is a ZCode active-turn extension and keeps its existing separate text.
- A terminal resume continues to publish only `SubagentSpawned(background=true, resumed=true)`; in the same projection V4 reuses the original `agentId` / `childSessionId` to restore the running row and cancellable background work, and keeps the original `Agent` tool call's `parentToolCallId` as the row display anchor. It must not be overwritten with this `SendMessage` call id, and `BackgroundTaskStarted` must not be emitted again for the same resume; Stop keeps using the existing runtime task abort path.
- `status: "success"` only means the message was accepted by `queued`, `steered` or `resumed_background`; it does not mean the target agent has read it, accepted the task or replied.
- Lowercase `send_message` is a separate session mailbox tool and does not reuse the local-agent routing, output or display semantics of `SendMessage`.
- There is currently no standalone generic resume tool, and fork, worktree, team or cross-session mailbox capabilities are not implicitly folded into `SendMessage`.

### RespondToCoordinator current scope

- `SendMessage` stays parent/main-only. A running child receives steer input marked `Message from coordinator:` at a legal round boundary after the current tool batch ends, without interrupting a single running tool or parallel batch.
- A child exposes the child-only `RespondToCoordinator` only when the coordinator response port is configured, `taskType === "subagent_child"` and it is not disabled by the global `toolDisallowlist`. The Explore runtime adds this child control tool back after the final allowlist intersection; Plan mode allows it through an explicit capability, not by disguising session mutation as read-only.
- `RespondToCoordinator` only enqueues the reply into the parent runtime command queue and does not end the child's current task; enqueue success does not mean the parent has read, persisted or replied.
- After the response command is drained by the parent, the full `<summary>` / `<message>` carrier is written to the parent model history and session store with source `subagent_message` and visibility `model-only`. It does not enter user-visible messages, the session title or `ReadSessionContext`, but raw session export, diagnostics, storage budgets and compact must treat it as possibly containing this content.
- The synthetic user message source `subagent_message` is not the `SessionEventType.SubagentMessage` lifecycle/progress event, nor a child transcript mirror. Full contract: [Subagent RespondToCoordinator](../../../../../../docs/subagent-respond-to-coordinator.md).

### SendMessage and TaskStop display projection

- Tool output and model content keep their own provider-visible contracts; display-layer data is generated through a separate `ToolResultDisplayPayload` and must not modify the model-visible result backwards.
- `local_agent_message` contains only the business `status`, optional `error` and optional `message`; `error` and `message` are each limited by a 4 KiB UTF-8 budget.
- `task_stop` contains `taskId`, `taskType`, optional `command`, `message` and optional `truncated`; `command` and `message` are each limited by a 16 KiB UTF-8 budget.
- The display is generated from the handler's raw output, delivered through live `tool_call_result.result.display`, and written into the versioned metadata of the completed tool part; it must not be mixed into hook additional context.
- The Desktop/Web display spec is in `docs/ui/tool-display-rendering.md`; the deferred CLI TUI adaptation and its acceptance conditions are recorded in `TODO(TUI display parity)` of [Tool Change Chain](./00-tool-change-chain.md).

## ZCode design conclusions

The first version should not write `SubagentTool` as one giant tool. It splits into a set of stable interfaces:

- `SubagentTool`: model-visible schema, permission entry, result serialization.
- `AgentDefinitionRegistry`: loads built-in/project/user/plugin/policy agents, handles overrides, parse failure reports and capability filtering.
- `ToolPoolResolver`: resolves available tools by agent policy, permission mode and async/fork/team.
- `SubagentContextFactory`: creates the isolated `ExecutionContext`, owning trace, abort, read cache, content replacement and the app state proxy.
- `AgentRuntime`: runs the query loop, consumes the message stream, triggers hooks, skills and MCP cleanup.
- `SubagentTaskService`: manages foreground/background state, progress, kill, auto-background and notification.
- `SessionStorePort`: session messages/parts, session entries, resume hydration.
- `SubagentMessageRouter`: delivers messages by agentId/name, supporting the pending queue and stopped resume.
- `WorktreeIsolationPort`: creates, detects changes, cleans up and restores worktrees.
- `RemoteAgentPort`: remote agent eligibility, bundle, launch, status, notification.

Minimum test set:

- Omitting `subagent_type` selects `general-purpose` when fork is off and goes to fork when fork is on.
- unknown agent type and denied agent type return different structured errors.
- Required MCP succeeds after pending; failed or no tools gives an actionable error.
- The agent tool pool correctly excludes `AskUserQuestion`, `TaskOutput`, recursive `Agent` and so on.
- An async agent returns `async_launched` and produces a task notification on completion.
- `SendMessage` to a running agent enters the pending queue; a stopped agent can resume from persisted session history.
- A worktree with no changes is auto-cleaned; with changes the path and branch are kept.
- A fork child inherits the parent system prompt, tool pool and thinking config, and recursive fork is forbidden.
- A sync agent can be backgrounded and continues to finish under the same task id.
- abort, silence timeout, exception, no assistant message and missing session history all have stable errors; abort must cover the case where the child runner/model promise never settles and the outer `Agent` can still stop waiting, and silence timeout must cover the case where the child has no session event at all and the promise never settles.
- All spawn, tool call, hook, MCP, task state, notification and resume events carry the same `traceId` and record the parent session/turn/toolCall/span relationship.
