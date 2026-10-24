# ZCode Hooks implementation status

> Purpose: a fast orientation to ZCode hooks' layered architecture, supported capabilities, and known gaps and evolution directions.
>
> Updated 2026-07-10. Related specs: `docs/plugin-hooks-compat.md`, `apps/zcode-cli/docs/design/v2/hooks.md`

---

## 1. Architecture layers (read first)

ZCode hooks are **not a single module** — there are two layers whose behavior can differ:

| Layer                | Path                                                                                                     | Responsibility                               | Actually executed?              |
| -------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------- |
| **UI / settings**    | `packages/services/src/hooks/hooksService.ts`<br>`packages/ui/src/store/hooksStore.ts`                    | read, display, edit, and write runtime hooks config | takes effect via `.zcode/config.json` |
| **CLI runtime**      | `apps/zcode-cli/packages/core/src/hooks/`<br>`apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts` | trigger, execute, aggregate decisions in the agent loop | **yes**                    |

**Key conclusion**: the UI layer can read legacy hooks from `.claude/settings.json` / `.agents/settings.json`, but the **runtime does not automatically execute** them. Only hooks written into `.zcode/config.json` or injected by **enabled plugins** run in a session.

---

## 2. Runtime-supported events (7)

Defined in `apps/zcode-cli/packages/contracts/src/hooks/index.ts`

| Event                | Trigger point                                     | Blocking                            | Main code entry                                     |
| -------------------- | ------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `SessionStart`       | after session create/resume, before first prompt  | no (P0 ignores `continue:false`)    | `runtime/methods/hooks.ts` → `turn.ts` / `resume.ts` |
| `UserPromptSubmit`   | user input enters the turn, before message history write | yes                           | `runtime/methods/turn.ts`                            |
| `PreToolUse`         | after tool input schema validation, before permission check | yes                        | `tool/executor/hook-flow.ts`                         |
| `PermissionRequest`  | permission returns `ask`, before broker UI        | yes                                 | `tool/executor/hook-flow.ts`                         |
| `PostToolUse`        | after tool success, before result serialization to the model | no                          | `tool/executor/hook-flow.ts`                         |
| `PostToolUseFailure` | after tool failure                                | no                                  | `tool/executor/hook-flow.ts`                         |
| `Stop`               | just before the turn completes                    | yes (can continue, max 3 times)     | `runtime/methods/turn-stop.ts`                       |

`SessionStart` `source` matcher values: `startup | resume | clear | compact`.

---

## 3. Hook types

| Type                   | Runtime support | Notes                                                                     |
| ---------------------- | --------------- | ------------------------------------------------------------------------- |
| `process`              | yes             | argv form: `command` + `args[]`, executed via `ExecutionPort`, **no default shell** |
| `command`              | yes             | shell string, for Claude plugin compatibility (e.g. superpowers `run-hook.cmd`) |
| `prompt`               | no              | LLM-evaluated hook                                                        |
| `agent`                | no              | agentic verifier hook                                                     |
| `http`                 | no              | HTTP POST hook                                                            |
| `callback` / `function` | tests/SDK only | `InMemoryHookRunner` in-memory callback; not a persisted user-config form  |

Entry point: `apps/zcode-cli/packages/core/src/hooks/configured-runner.ts`

---

## 4. Configuration sources and merge order

### 4.1 Runtime-effective config

1. **User**: `~/.zcode/cli/config.json` → `hooks` field
2. **Project**: `<workspace>/.zcode/config.json` → `hooks` field
3. **Plugin**: enabled plugins' `hooks/hooks.json` or manifest `hooks` field

Merge logic: `mergeRuntimeHooks()` in `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`
→ user/project hooks first, **plugin hooks appended after**.

Plugin discovery spec in `docs/plugin-hooks-compat.md`:

- manifest priority: `.zcode-plugin` > `.claude-plugin` > `.codex-plugin`
- standard path `hooks/hooks.json` auto-loads
- unknown events log a warning without blocking plugin load

### 4.2 Settings-page sources and write-back

`hooksService.loadHooks()` reads in order:

```
project: .zcode → .agents → .claude
user:    .zcode → .agents → .claude
```

Source behavior:

- ZCode native: `process` / `command` are editable and individually toggleable; user/project write back to the matching `.zcode/config.json`.
- Legacy Claude/Agents: shown import-only and disabled; one-click import copies them into a ZCode hook of the same scope — never silently executed or written back to legacy files.
- Plugins: the settings page shows plugin name, event, matcher, command, and plugin enabled state read-only from the plugin runtime catalog; enable/disable stays in plugin management.

Editing a hook discards draft sessions not yet started; running sessions or sessions with history keep their config snapshot semantics.

---

## 5. Execution model

```text
Hook trigger
  → InMemoryHookRunner.run()
    → matcher regex match (no matcher = match all)
    → run matched hooks serially
      → stdin: HookInput JSON (camelCase + Claude snake_case compatible fields)
      → ExecutionPort: process(argv) or command(shell)
      → stdout: parsed as HookJSONOutput
      → processHookOutput() aggregates decisions
  → inject additionalContext / block / modify tool input
```

### 5.1 Matcher match fields

| Event                                                                      | `matchValue`                             |
| -------------------------------------------------------------------------- | ---------------------------------------- |
| `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure`  | `toolName`                               |
| `UserPromptSubmit`                                                         | no query; runs all matcher groups under the event |
| `SessionStart`                                                             | `source`                                 |
| `Stop`                                                                     | no query; runs all matcher groups under the event |

Implementation: `matchesHookMatcher()` in `apps/zcode-cli/packages/core/src/hooks/output.ts`. A simple `A|B` uses exact option matching, `*` matches all, other strings are treated as regex; tool names also accept compatibility aliases.

### 5.2 stdin / stdout contract

- **stdin**: structured `HookInput`; tool events carry `toolName` / `toolInput` / `toolCallId` plus Claude-compatible aliases `tool_name` / `tool_input` / `tool_use_id`; all events carry a temporary `transcript_path` / `transcriptPath`; `PostToolUse` carries the full `tool_response`; failure events carry a string `error` plus `is_interrupt`
- **stdout**: empty or non-JSON output counts as a successful diagnostic; JSON output validates known fields and ignores unknown ones
- **exit code 0**: success, parse stdout
- **exit code 2**: block (PreToolUse / PermissionRequest / UserPromptSubmit; Stop's continue semantics handled separately)
- **other exit codes**: non-blocking error, recorded as a diagnostic

The Claude-compatible input projection is centralized in `configured-runner-input.ts`, preventing field drift from per-event assembly.

### 5.3 Environment variables and template substitution

Injected into the subprocess (selection):

- `ZCODE_SESSION_ID` / `CLAUDE_SESSION_ID` / `CLAUDE_CODE_SESSION_ID`
- `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR`
- plugins: `ZCODE_PLUGIN_ROOT`, `ZCODE_PLUGIN_DATA`, `ZCODE_PLUGIN_ID`, `ZCODE_PLUGIN_NAME`
- compatibility: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`

Command strings support templates such as `${ZCODE_PLUGIN_ROOT}`; `${CLAUDE_SKILL_DIR}` / `${ZCODE_SKILL_DIR}` raise an explicit error when no skill context exists.

### 5.4 Decision aggregation

Priority: **deny/block > ask > allow > passthrough**

- Multiple `updatedInput`: in execution order, the **last valid one fully replaces** the input
- Multiple `additionalContext`: concatenated in order, budget-limited (lifecycle injection cap ≈ 24k chars)
- `Stop` continuation: at most 3 consecutive times (`MAX_STOP_HOOK_CONTINUATIONS`)

### 5.5 Observability

Session events (`HookRunStarted` / `Completed` / `Failed` / `Blocked`) are emitted through `InMemoryHookRunner`.
Lifecycle additional context is injected into message history as a `hook_context` attachment.
`command.async:true` runs fire-and-forget; the current turn does not wait for its output, but completion or failure still emits a lifecycle event.

---

## 6. Hook output capabilities (supported by ZCode)

### 6.1 Common fields

- `continue`, `reason` / `stopReason`
- `additionalContext`, `additional_context` (snake_case alias normalized)
- `suppressOutput`, `systemMessage`
- `hookSpecificOutput` (branched by `hookEventName`)

### 6.2 Per event

| Event                               | Output capabilities                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PreToolUse`                        | `permissionDecision` (allow/ask/deny), `permissionDecisionReason`, `updatedInput`, `additionalContext`  |
| `PermissionRequest`                 | `decision.behavior` (allow/deny), `updatedInput`, `permissionUpdates`                                   |
| `UserPromptSubmit`                  | `additionalContext`; `continue:false` blocks the prompt                                                 |
| `SessionStart`                      | `additionalContext`                                                                                     |
| `PostToolUse` / `PostToolUseFailure`| `additionalContext`                                                                                     |
| `Stop`                              | `additionalContext`; `continue:true` + context continues; `decision:"block"` compatibility              |

### 6.3 Not yet supported output fields

- `updatedMCPToolOutput`
- `initialUserMessage`
- `watchPaths` (FileChanged / CwdChanged integration)
- `WorktreeCreate.worktreePath`
- Elicitation `action` / `content`
- `PermissionDenied.retry`

---

## 7. Plugin compatibility points

For Claude Marketplace plugin hooks, ZCode covers:

- the 7 core events' semantics and decision-priority design goals
- `command` hook + Claude env vars / path templates
- `SessionStart` → `additionalContext` → `hook_context` injection
- `Stop` + `transcript_path` compatibility (ralph-loop etc.)
- plugin `hooks/hooks.json` discovery and merge
- the `hookSpecificOutput` main structure
- exit code 2 blocking semantics (tool / permission / prompt paths)
- non-JSON stdout diagnostics; unknown JSON fields ignored
- `PostToolUse.tool_response`, failure string error / `is_interrupt`
- `command.async:true` fire-and-forget

---

## 8. Known gaps and risks

### 8.1 UX boundary

The settings page clearly splits "configured hooks", "compatibility config", and "plugin hooks": only ZCode native config and enabled plugins reach the runtime; legacy config must be explicitly imported by the user. Settings changes affect new or not-yet-started drafts and never hot-modify a running session.

### 8.2 Feature gaps (rough priority)

| Priority | Gap                                                    | Note                              |
| -------- | ------------------------------------------------------- | --------------------------------- |
| P1 eco   | `PreCompact` / `PostCompact`                            | integration with context compaction |
| P1 eco   | `SubagentStart` / `SubagentStop`                        | subagent-scenario plugin dependency |
| P1 eco   | `SessionEnd`                                            | cleanup/reporting hooks           |
| P2       | `prompt` / `agent` / `http` hook types                  | advanced hook forms               |
| P2       | `asyncRewake` / `once` / `if` pre-filtering             | performance and safety refinement |
| P2       | config snapshot                                         | prevents in-session config drift  |
| P3       | Notification / Elicitation / Worktree / FileChanged etc.| full event coverage               |

The P1 plan in the design doc: `apps/zcode-cli/docs/design/v2/hooks.md`.

### 8.3 Internal special case

`AgentRuntime` additionally registers in-memory hooks when the session mailbox is enabled (`createSessionMailboxHookRegistrations`) — an internal mechanism, not a user-configured hook.

---

## 9. Key code index

| Module                    | Path                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| event / IO schema         | `apps/zcode-cli/packages/contracts/src/hooks/index.ts`                                         |
| hook runner               | `apps/zcode-cli/packages/core/src/hooks/runner.ts`                                             |
| config → callback adapter | `apps/zcode-cli/packages/core/src/hooks/configured-runner.ts`                                  |
| output parse and aggregate| `apps/zcode-cli/packages/core/src/hooks/output.ts`                                             |
| lifecycle triggers        | `apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts`                                    |
| tool-chain triggers       | `apps/zcode-cli/packages/core/src/tool/executor/hook-flow.ts`                                  |
| runtime config merge      | `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`                                  |
| plugin hook discovery     | `apps/zcode-cli/packages/adapters/src/plugins/index.ts`                                        |
| UI config read/write      | `packages/services/src/hooks/hooksService.ts`                                                  |
| shared UI types           | `packages/shared/src/hooks.ts`                                                                 |
| plugin compat spec        | `docs/plugin-hooks-compat.md`                                                                  |
| v2 design / acceptance    | `apps/zcode-cli/docs/design/v2/hooks.md`                                                       |
| 10-event contract tests   | `apps/zcode-cli/packages/core/tests/hooks-event-contract.test.ts`                              |
| desktop E2E               | `packages/desktop/test/e2e/conversation-session/conversation-session-hooks-lifecycle.test.ts`  |

---

## 10. Follow-up analysis suggestions

1. **Compact / subagent events**: survey existing plugins and marketplace dependencies to fix the minimal P1 event set.
2. **async rewake**: introduce registry/rewake state only when plugins actually depend on waking the model after background completion.
3. **Security**: define workspace trust and explicit enablement policy for project hooks.
4. **Test matrix expansion**: the 7 core events are covered; extend incrementally per new event and high-risk source — no value-free full cross-product.

---

## 11. Reference test commands

```bash
# unit tests (lifecycle + tool hooks)
pnpm --filter @zcode/core test runtime-hooks
pnpm --filter @zcode/core test tool-hook-context

# hooksService + settings page
pnpm exec vitest run packages/services/test/hooksService.test.ts packages/ui/test/hooksSection.test.ts

# full 7-event desktop lifecycle
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec './test/e2e/conversation-session/conversation-session-hooks-lifecycle.test.ts'
```
