# ZCode CLI Hooks Design v2

## Document scope

Hooks capability spec, maturity `L3 Implementation Contract`. It defines events, configuration,
runtime boundaries, permission interaction, observability, and test requirements, and together with
root `docs/hooks-runtime-contract.md` is the acceptance basis for the existing 7 events.

Hooks do not scatter business logic into user scripts; they provide auditable, cancellable,
testable extension points at the key safety boundaries of the agent loop. Core still only expresses
intent — no direct filesystem, network, child process, or environment variable access; all external
I/O converges through adapters/ports.

Design choices:

- Layered config sources (user/project/local/policy settings, plugin hook, session hook, builtin
  hook); a hooks config snapshot is captured at startup so mid-session config changes cannot cause
  behavior drift.
- Full event semantics: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`,
  `UserPromptSubmit`, `SessionStart`, `Stop`, `PreCompact`, `PostCompact`, etc.
- Matchers are regexes over event-relevant fields: tool events match `tool_name`, session start
  matches source, compact matches trigger.
- Execution supports per-hook timeout, abort, progress events, stdout/stderr capture, JSON output,
  and exit code 2 blocking.
- Decision aggregation priority: deny/block first, then ask, then allow; hooks may modify tool
  input, add context, and (P1) replace tool output.
- Type-safe hook names, separate input/output, stable ordering, plugin-level capability
  aggregation; security requires workspace trust, managed policy switches, plugin root isolation,
  hook deduplication, and Windows shell/path handling.

Rejected: default shell string commands, excessive first-version events, hooks scattered in the
UI/AppState layer, and implicit state changes through mutable output — hook results must be
eventized and schema-validated.

## Design goals

1. Extension points on the NL->Code main path: user input, before/after tool execution, permission
   requests, session start/end, before stop, before/after compaction.
2. All hook inputs and outputs have runtime schemas; cross-process, config, plugin, and SDK
   boundaries never rely on TypeScript types alone.
3. Hook execution carries and propagates `traceId`, `sessionId`, `turnId`, `toolCallId`.
4. Hook side effects converge through adapters (`HookExecutionPort`, `HttpClient`, `ExecutionPort`).
5. Hook results influence agent behavior only through explicit `HookDecision`, never by mutating
   core internal state.
6. Hook progress, results, failures, and blocks enter the session event stream; the UI only consumes
   projections.
7. No new `ZCODE_` environment variables in the first version; configuration goes through config
   files, CLI/session overrides, or SDK injection.

## Non-goals (first version)

- No new hook events beyond the existing 7.
- No prompt hook, agent hook, file watcher hook, or worktree hook.
- No `if`, `once`, or `asyncRewake`.
- Hooks cannot bypass plan mode, explicit deny rules, sandbox, or tool contracts.
- Large hook output is never injected directly into model context.

## P0 event set

| Event                | Trigger point                                  | Blockable           | Modifiable                        | Model-visible output                                 |
| -------------------- | ---------------------------------------------- | ------------------- | --------------------------------- | ---------------------------------------------------- |
| `SessionStart`       | after session create/resume, before first turn | no                  | may append session context        | yes, budget-limited                                  |
| `UserPromptSubmit`   | before user input enters a turn                | yes                 | may append context; raw text kept | yes, budget-limited                                  |
| `PreToolUse`         | after input schema validation, before perms    | yes                 | may replace full tool input       | may append context                                   |
| `PermissionRequest`  | permission service returns ask, before broker  | yes                 | may allow, deny, or replace input | no, except deny reason                               |
| `PostToolUse`        | after tool success, before result to model     | no                  | may append context; P1: replace   | yes, budget-limited; stdin gets full `tool_response` |
| `PostToolUseFailure` | after tool failure, before error to model      | no                  | may append recovery context       | yes, budget-limited                                  |
| `Stop`               | before turn completes                          | yes, may force more | may append feedback context       | yes                                                  |

Implementation status: contracts/config schema/runner declare and support exactly these 7 events;
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure` are wired into the tool
executor; `SessionStart`, `UserPromptSubmit`, `Stop` are wired into the runtime main path, and
`PreToolUse.additionalContext` is model-visible. P1 candidates: `PreCompact` / `PostCompact`,
`SubagentStart` / `SubagentStop`, `ModelRequest` / `ModelResponse`, `ConfigChange`,
`CommandExecuteBefore`.

## Hook configuration

`RuntimeConfig` gains a `hooks` field:

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 60000,
    "maxOutputBytes": 32768,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash|Write|Edit",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["scripts/check-tool.mjs"],
              "enabled": true,
              "timeoutMs": 30000
            }
          ]
        }
      ]
    }
  }
}
```

Rules:

- `events.<event>[]` is a matcher list with stable order.
- `matcher` is a regex string; tool events match the tool name.
- Persisted config supports `process` and `command` hook types; in-memory `callback` hooks are a
  core/SDK injection capability only and are never written to config.
- `process` must use `command + args[]`, executed through adapter spawn/execFile semantics without
  default shell concatenation.
- `command` uses an explicit shell execution mode, mainly for Claude Marketplace compatibility;
  Windows shell/path fallback is owned by ExecutionPort.
- Each hook's `enabled` defaults to `true`; `enabled:false` hooks are skipped before Runner
  registration.
- `command.async:true` is fire-and-forget: stdout cannot block, modify input, or inject context;
  background completion/failure still emits a lifecycle event.
- Process hook input arrives as stdin JSON; stdout parses as hook output; stderr goes to diagnostics
  and the hook result event.
- Config merging keeps the existing precedence: system < user < project < session < env < CLI. No
  environment variable entry point in P0.

## Hook input contract

All hook inputs inherit the base fields: `hookEventName`, `sessionId`, `turnId`, `traceId`, `cwd`,
`mode`, `agentName`, `timestamp`.

Event-specific fields:

- `PreToolUse`: `toolCallId`, `toolName`, `toolInput`, `riskLevel`, `sideEffectScope`
- `PermissionRequest`: `requestId`, `toolCallId`, `toolName`, `toolInput`, `reason`, `riskLevel`,
  `sideEffectScope`
- `PostToolUse`: `toolCallId`, `toolName`, `toolInput`, full `toolResponse`, `toolResultPreview`,
  `artifactRefs`
- `PostToolUseFailure`: `toolCallId`, `toolName`, `toolInput`, `error`, `isInterrupt`
- `UserPromptSubmit`: `prompt`, `attachmentsSummary`
- `SessionStart`: `source`
- `Stop`: `responsePreview`, `toolCallCount`

The model still only receives tool results bounded by the result budget; the Claude-compatible
boundary passes the full structured `tool_response` to the hook. `toolResultPreview` and artifact
references are ZCode extensions and cannot replace `tool_response`.

## Hook output contract

One unified JSON output:

```json
{
  "continue": true,
  "reason": "optional human-readable reason",
  "suppressOutput": false,
  "systemMessage": "optional user-visible message",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {}
  }
}
```

Event-specific output:

- `PreToolUse`
  - `permissionDecision`: `allow | ask | deny`
  - `permissionDecisionReason`
  - `updatedInput`: full replacement input; must re-pass tool input schema validation.
  - `additionalContext`
- `PermissionRequest`
  - `decision.behavior`: `allow | deny`
  - `decision.updatedInput`
  - `decision.permissionUpdates`
- `UserPromptSubmit`
  - `additionalContext`
  - `continue: false` blocks this prompt.
- `SessionStart`
  - `additionalContext`
- `PostToolUse` / `PostToolUseFailure`
  - `additionalContext`
- `Stop`
  - `continue: false` or no output means the turn may end.
  - `continue: true` with `additionalContext` injects feedback into the next model request.
  - `continue: true` without `additionalContext` is a no-op, avoiding empty loops.

Non-JSON stdout never enters model context in P0; it is recorded as a hook diagnostic event. Unknown
JSON fields are ignored and do not fail the hook; type errors on known fields are a single-hook
contract violation.

### Event-aware semantics

`continue` does not mean the same action on every event:

- `UserPromptSubmit continue:false`: block this prompt — no user message written, no model request,
  return the hook reason.
- `PreToolUse continue:false`: block this tool, equivalent to hook deny.
- `PermissionRequest continue:false`: deny this permission request, equivalent to hook deny.
- `PostToolUse` / `PostToolUseFailure continue:false`: P0 does not block a finished tool; records a
  hook blocked event and reason.
- `SessionStart continue:false`: P0 ignores the block, records a blocked diagnostic; the session
  continues.
- `Stop decision:"block"`: continue with another model round only when a reason or
  `additionalContext` exists.
- For compatibility with existing ZCode configs, `Stop continue:true` with `additionalContext` also
  continues another round.

## Decision priority

Tool execution path:

1. `ToolExecutor` validates the original input.
2. `HookRunner.run(PreToolUse)`.
3. If any hook returns deny, the tool does not execute; record hook blocked and tool error.
4. If a hook returns `updatedInput`, use the full replacement input and re-validate the schema.
5. `PermissionService.checkPermission` applies static policy to the effective input.
6. Explicit deny rules, plan-mode write bans, and tool contract hard guards cannot be bypassed by a
   hook allow.
7. If ask is required, `PermissionRequest` hooks and the interactive broker race concurrently (see
   `permission-responder-race.md`): the broker response channel is established first, and the hook
   chain starts at the same time.
8. The first decision wins: a hook allow/deny/modify arriving first closes the race and aborts the
   broker wait; a user broker response arriving first closes the race and aborts the hook chain. A
   hook with no decision or a failure counts as withdrawing, leaving the broker waiting alone. A
   hook decision is no longer guaranteed to precede the user response; use `PreToolUse` deny or a
   permission deny rule for a user-irrevocable forced deny.
9. After tool success run `PostToolUse`; after failure run `PostToolUseFailure`.

Aggregation rules:

- deny/block > ask > allow > passthrough.
- Multiple `updatedInput`: apply the last valid full replacement input in execution order. If later
  validation fails, attribute it as a hook contract violation; the tool does not execute.
- Multiple `additionalContext` are concatenated in hook order, bounded by the hook result budget.
- `Stop` may force at most 3 consecutive continuations; afterwards the turn ends with a hook
  diagnostic, preventing infinite hook loops.

## Runtime architecture

Module boundaries:

- `packages/contracts/src/hooks/`: hook event enum, hook input/output JSON schema, hook config
  schema, hook result/error types.
- `packages/core/src/hooks/`: `HookRunner`, `HookRegistry`, matcher resolver, decision aggregator.
- `packages/adapters/src/hooks/`: `NodeProcessHookExecutionAdapter`; later `HttpHookAdapter`.
- `packages/bootstrap`: assembles the hook registry and adapter from config, injects `HookRunner`
  into `AgentRuntime`.

Core boundaries:

- Core does not `spawn`, read config files, or read `process.env` directly.
- Process hooks use the existing execution adapter or a dedicated `HookExecutionPort`; both must
  support timeout, abort, output truncation, cwd, and Windows executable resolution.
- The hook runner returns structured `HookRunResult` only and never writes to the UI.
- Runtime lifecycle hooks fire through one place, `packages/core/src/runtime/methods/hooks.ts`,
  instead of being scattered across the turn loop.
- Lifecycle hook additional context is injected into message history as a synthetic user/system
  reminder; the original user text is never modified by a hook.

## Session events and observability

Session events:

- `hook_run_started`
- `hook_run_progress`
- `hook_run_completed`
- `hook_run_failed`
- `hook_run_blocked`

Event payloads carry at least: `hookRunId`, `hookEventName`, `hookSource`, `matcher`, `hookIndex`,
`toolCallId` or `requestId`, `durationMs`, `outcome`, `stdoutPreview`, `stderrPreview`,
`outputBytes`, `truncated`.

Logging:

- All hook logs carry `traceId`.
- Default logs never record full `toolInput`, full prompts, or secrets.
- Verbose/debug may record fuller hook I/O through controlled artifacts.
- Hook failure does not crash the turn by default, unless the event semantics allow blocking and the
  hook explicitly blocks/denies.

## Security and cross-platform

- P0 supports `process` argv form and explicit-shell `command` form; the latter is for Claude
  Marketplace compatibility.
- Windows resolution of `.cmd` / `.exe`, paths with spaces, and cwd failures is owned by the adapter.
- `process` does not default to a shell; only `command` may use pipes, redirection, and other shell
  syntax.
- The process hook cwd defaults to the session working directory.
- Relative paths in hook config resolve against the config file's directory, not the process cwd.
- Hook output size is limited; overflow goes to an artifact or is truncated.
- Hook timeout must cancel the child process and record `hook_timeout`.
- Cancellation propagates the abort signal and leaves no pending promise.
- User/project hooks must eventually integrate workspace trust or equivalent confirmation; in P0 the
  TUI/CLI may default to requiring explicit `hooks.enabled` for local project config.

## Implementation phases

Phase 1 (spec + contract) is complete: this document, hook event/config/input/output/result schemas
in contracts, `hooks` in the config schema (no execution unless `hooks.enabled:true` is set
explicitly), config parser and schema tests.

Phase 2 (core runner) is complete: matcher resolver and decision aggregator; in-memory callback
hooks for unit tests and later SDK/ZCode app-server integration; `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PostToolUseFailure` wired into `ToolExecutor`; hook session
events.

Phase 3 (runtime lifecycle hooks) is complete: `AgentRuntime` keeps one shared `HookRunner`;
`SessionStart` fires after context init and before the first user prompt enters the model, with
`source=startup|resume|clear|compact`; `UserPromptSubmit` fires before user input becomes message
history — blockable, may append context, never modifies the original prompt; `Stop` fires before
completing a turn with no client-side tool call and may inject feedback for another round.

Phase 4 (diagnostics + hardening) is complete: lifecycle events carry stdout/stderr preview, output
bytes, truncated, and duration; relative process hook paths resolve against the config source
directory, or the session working directory when the source is unknown; tests for timeout/cancel,
invalid JSON, exit code 2, and the stop continuation limit.

Phase 5 (process adapter) is complete: Node process hook adapter with stdin JSON, stdout JSON, stderr
diagnostics, timeout, abort, output truncation; config-file hooks run for real.

Phase 6 (user-facing integration; desktop/Web shared settings page done): the settings page lists
user/project config, legacy import-only config, and enabled/disabled plugin hooks; supports add,
edit, delete, per-entry enable/disable, and legacy one-click import; writes only
`.zcode/config.json`. After a config change the deferred draft session is discarded so the next send
uses the new runtime snapshot. TUI progress and recent execution results remain future enhancements.

Phase 7 (expanded events, open): wire compact hooks; evaluate HTTP / prompt / agent hooks; shell
command and plugin hooks are done.

## Test requirements

- Config schema accepts valid hooks config and rejects unknown hook events, invalid hook types, and
  non-array `args`; merge keeps precedence stable; default config enables no hook.
- `PreToolUse` deny blocks tool execution and emits hook/tool events; `updatedInput` is re-validated
  and invalid input fails without executing the tool; hook allow does not override explicit deny
  rules or plan mode.
- `PermissionRequest` allow skips the broker and executes the tool; deny skips the tool and removes
  the pending permission.
- `PostToolUse` `additionalContext` counts against the model-visible tool result budget.
- Abort cancels waiting hooks, including lifecycle hooks.
- `SessionStart` runs exactly once before the first turn; resume source is distinguishable.
- `UserPromptSubmit continue:false` blocks before the user message is written and the model request
  is started; `additionalContext` from `UserPromptSubmit`/`SessionStart` reaches the next model
  request.
- `Stop continue:true + additionalContext` triggers one more model round and is protected by the
  continuation cap; exceeding the cap records a diagnostic and ends the turn normally.
- `PreToolUse additionalContext` reaches the model-visible tool result on both success and failure
  paths.
- Hook lifecycle events include stdout/stderr preview, output bytes, truncated, duration.
- Process hooks: stdin receives structured JSON; valid stdout JSON parses; non-JSON stdout only
  records a diagnostic; stderr never enters model context; timeout kills the child process and
  records `hook_timeout`; Windows paths, `.cmd`, and spaced paths are at least covered by adapter
  unit-test simulation.
- TUI can show hook running/completed/blocked; session resume does not re-run historical hooks; hook
  events correlate to their turn/tool call by `traceId`.

## Key decisions

- Full event semantics with deny > ask > allow priority, typed hook names, and stable order.
- `process` is the cross-platform default; `command` remains as an explicit shell compatibility
  form, distinguished by type.
- Hooks never mutate core state directly; they return explicit decision/context/input replacement.
- The permission hook does not replace the permission system; it only provides an automated decision
  entry during the `ask` stage.
- All hook I/O is observable, cancellable, testable, and attached to one trace chain.
