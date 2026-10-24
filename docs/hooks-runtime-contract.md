# Hooks Runtime Contract

> Status: implementation spec
>
> This document is the shared acceptance basis for ZCode's current hooks implementation, the desktop settings page, and the automated tests.

## Goals and boundaries

Ten supported events:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`
- `PreCompact`
- `PostCompact`
- `SessionEnd`

Candidate future events (`SubagentStart`, `SubagentStop`, `Notification`, `Interrupt`, `WorktreeCreate`, `WorktreeRemove`, etc.) are recorded in `docs/specs/hooks-future-events.md`; until they enter this contract, the UI must not write them and docs must not mark them supported. Every supported event must form a complete loop: config loadable, matcher semantics clear, stdin Claude-Code-compatible, stdout able to affect the corresponding runtime behavior (except diagnostic-only events), failures observable, and an independent automated test.

Persisted hook types are limited to:

- `process`: `command + args[]`, executed via argv, no shell.
- `command`: a full shell command, for Claude Marketplace plugin compatibility.

This round does not implement `prompt`, `agent`, `http`, or `callback` persisted config, nor `if`, `once`, or `asyncRewake`. Those fields and new events must not be written by the UI or marked supported in docs.

## State ownership

```text
user config + enabled plugin hooks
  -> executable RuntimeConfig
  -> HookRunner

project/workspace Hook declarations
  -> isolated discovery candidate
  -> immutable bundle/declaration digests
  -> rollout gate + managed policy + Trust admission
  -> admitted project registrations or blocked lifecycle

HooksService / conversation projection
  -> 设置 → 钩子 → 工作区
  -> Runtime-owned review command
  -> atomic Trust mutation / supersede / revoke
```

- Hook execution rights live only in the `apps/zcode-cli` agent runtime.
- The UI and `packages/services` only manage config and read-only source display; they never execute hooks.
- Every session start captures a hook config snapshot. Config changes are guaranteed only for new sessions; after saving in settings, close unused deferred draft sessions so the next first-run does not keep the old snapshot.
- A remote workspace's HooksService must come from the remote service collection. `workspacePath` is used for file reads/writes; UI cache and concurrent-request isolation use `workspaceIdentity?.trim() || workspacePath`.

## Configuration sources and merge

| Source                         | Runtime executes | Settings edits | Effect rule                                                      |
| ------------------------------ | ---------------- | -------------- | ---------------------------------------------------------------- |
| `~/.zcode/cli/config.json`     | yes              | yes            | user hooks run first                                             |
| workspace `.zcode/config.json` | conditional      | yes            | runs after rollout is on and exact Trust/policy admission passes |
| enabled plugin hooks           | yes              | no             | runs per the existing plugin source rules                        |
| `.agents/settings.json`        | no               | no             | read-only display; explicit import into `.zcode` allowed         |
| `.claude/settings.json`        | no               | no             | read-only display; explicit import into `.zcode` allowed         |

Merge constraints:

1. The runtime executable config directly merges only user and enabled-plugin hooks; workspace project hooks stay in an isolated immutable snapshot side-channel. Before admission, no executable callback may be created; discovery diagnostics uniformly use `config_project_hooks_pending_trust`, and the runtime blocked reason further distinguishes pending, feature-disabled, policy, store failure, and snapshot mismatch.
2. `hooks.enabled:false` in one trusted source disables only that source's hooks, never other sources.
3. Plugin hooks inject into the runtime only while the plugin is enabled; after disabling, new sessions stop executing them.
4. Each `process` / `command` supports `enabled?: boolean`, default `true`. The runner must skip `enabled:false`, not merely hide or gray it out in the UI.
5. The UI writes `.zcode` hooks back only to the original user/project files, never touching plugin, `.agents`, or `.claude` files.
6. Unknown extension fields on a single hook must round-trip in the settings service and be accepted by the agent config schema; the runtime may ignore fields it does not recognize without invalidating the whole config file.

Example:

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 60000,
    "maxOutputBytes": 32768,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Write|Edit",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["scripts/check-write.mjs"],
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

## Matcher contract

Matcher rules:

- Missing, empty string, and `*`: match all.
- Only letters, digits, underscore, and `|`: match as an exact name or exact name list.
- Other strings: match as a JavaScript regex; an invalid regex means the matcher does not run and a diagnostic is logged.
- Tool events match `tool_name`, also accepting ZCode aliases such as `Agent` / `Task`.
- `SessionStart` matches `source`.
- `PreCompact` / `PostCompact` match `trigger` (`manual` / `auto` / `partial` / `reactive` / `session_memory`).
- `UserPromptSubmit`, `Stop`, and `SessionEnd` have no matcher query; even with a matcher configured, the group's hooks run.

## Claude-compatible stdin

All hook stdin is single-line JSON plus a newline, keeping both ZCode camelCase fields and Claude Code snake_case fields.

Base fields:

- `session_id`
- `transcript_path`
- `cwd`
- `permission_mode`
- `hook_event_name`
- `agent_type` (when present)

Event fields:

| Event                | Required Claude-compatible fields                                        |
| -------------------- | ------------------------------------------------------------------------ |
| `SessionStart`       | `source`; optional `agent_type`, `model`                                 |
| `UserPromptSubmit`   | `prompt`                                                                 |
| `PreToolUse`         | `tool_name`, `tool_input`, `tool_use_id`                                 |
| `PermissionRequest`  | `tool_name`, `tool_input`; optional `permission_suggestions`             |
| `PostToolUse`        | `tool_name`, `tool_input`, `tool_use_id`, full `tool_response`           |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, string `error`, `is_interrupt` |
| `Stop`               | `stop_hook_active`, `last_assistant_message`                             |
| `PreCompact`         | `trigger`; optional `custom_instructions`                                |
| `PostCompact`        | `trigger`                                                                |
| `SessionEnd`         | `reason`                                                                 |

`PreCompact` / `PostCompact` stdin also carries the ZCode extension fields `preCompactTokenCount` / `postCompactTokenCount` (camelCase, estimates) with no Claude-compatible alias. `SessionEnd.reason` currently has only `close`, reserved to distinguish exit reasons later.

`PostToolUse.tool_response` is the tool handler's full structured output; `toolResultPreview` stays as a ZCode extension field but cannot replace `tool_response`.

ZCode has no Claude JSONL transcript file, so the configured runner creates a temporary compatible transcript per hook: Stop contains at least the last assistant message; other events provide at least an existing, readable JSONL file. The temporary directory is cleaned up after the hook finishes.

## stdout, exit codes, and event effects

stdout rules:

- Empty stdout: success, no extra effect.
- Non-JSON stdout: success, diagnostic only, never injected into model context.
- Valid JSON starting with `{`: known fields validated and consumed.
- Unknown JSON fields are ignored and never fail the whole hook.
- A known field with the wrong type, or a wrong `hookSpecificOutput.hookEventName`: that hook fails; failures are isolated per hook.

Exit code rules:

- `0`: success, parse stdout.
- `2`: request blocked; produces the matching block/deny on blockable events; Stop produces one continue round.
- Other non-zero: recoverable hook failure that never crashes the whole turn.

Event output effects:

| Event                | Blocking                   | Can modify                                         | Model-visible context                                           |
| -------------------- | -------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `SessionStart`       | no                         | no                                                 | `additionalContext` injected before the first round             |
| `UserPromptSubmit`   | yes                        | never modifies the original prompt                 | `additionalContext` injected before this round                  |
| `PreToolUse`         | yes                        | `updatedInput`, then re-run tool schema validation | both success and failure tool results carry `additionalContext` |
| `PermissionRequest`  | yes                        | on allow may return `updatedInput` and permissions | no                                                              |
| `PostToolUse`        | no                         | does not replace tool output this round            | appends `additionalContext`                                     |
| `PostToolUseFailure` | no                         | no                                                 | appends recovery `additionalContext`                            |
| `Stop`               | yes — means do not stop    | no                                                 | block reason/context injected next round, max 3 consecutive     |
| `PreCompact`         | yes — skip this compaction | no                                                 | no (diagnostic)                                                 |
| `PostCompact`        | no                         | no                                                 | no (diagnostic)                                                 |
| `SessionEnd`         | no                         | no                                                 | no (best effort)                                                |

`PreCompact` fires after `compactActiveConversationImpl` determines there is content to compact and before `CompactStarted` is written; when blocked, the call returns `outcome: "skipped"` and writes no compact timeline failure. `PostCompact` fires only after a real compaction completes successfully (history replaced); early skip, failure, and mid-retry never fire it. Microcompact does not pass through these two events. `SessionEnd` fires exactly once at the start of the session facade's `close()` memoized block, before `beginShutdown()`; it shares a 5-second total budget, timeouts mark the hook cancelled, hook failures only log and never block close. A hard kill or crash gives no delivery guarantee (same semantics as Claude Code).

Compatibility fields:

- Top-level `decision:"approve"|"block"`.
- Top-level `continue:false` blocks on `UserPromptSubmit`, `PreToolUse`, and `PermissionRequest`; on `PreCompact` it means skip this compaction.
- Stop uses `decision:"block"`; for compatibility with published ZCode configs, `continue:true` with `additionalContext` also continues one round.
- `PreCompact` / `PostCompact` / `SessionEnd` do not accept `hookSpecificOutput`; a returned one is rejected by the schema and counted as that hook's recoverable failure.
- `PermissionRequest` accepts both Claude's `updatedPermissions` and the ZCode legacy field `permissionUpdates`.
- `suppressOutput:true` stops projecting hook stdout; it does not suppress structured decision/context.

`PreToolUse` failure results include the hook's own deny, a later permission denial, and tool handler failure; these early-return paths must also keep any `additionalContext` already produced — never append only on handler success or throw paths.

## async contract

`command` hooks support `async:true`:

1. The agent continues the current event immediately after starting the command, without waiting for exit.
2. Async stdout cannot block, modify input, or inject context; such output is ignored.
3. The background command is still governed by timeout and caller cancellation; on caller cancel the command must be terminated and a `outcome: "cancelled"` hook lifecycle event emitted.
4. The background promise must catch errors and never produce an unhandled rejection.

`process` hooks stay synchronous this round. `asyncRewake` is not in this round's capability claims.

A `SessionEnd` async command hook is not guaranteed to finish before process exit: once the close budget (5 seconds) is exhausted or the process exits, the background command is cancelled/killed and its output has no effect.

## Settings page contract

The hooks settings page must use the same components on desktop and Web UI and satisfy:

- `.zcode` hooks support create, edit, delete, enable/disable, and user/workspace scope.
- The form supports the 10 events, `process` / `command` types, matcher, argv, timeout, `statusMessage`, and command async.
- `.agents` / `.claude` hooks are marked compatibility sources — not directly editable or toggleable — with explicit import into `.zcode`.
- Plugin hooks are grouped separately; the list read-only shows event and command, with the group title and plugin icon expressing provenance. matcher, type, source path, and effective enabled stay as data facts, not stacked into list rows.
- The plugin hook User/Workspace tabs use only the authoritative scope from the overview install record. When the overview degrades or the install record is missing, keep `unknown` — never default to User; unknown-scope hooks stay visible in both tabs with a "scope unknown" label, avoiding fabricated provenance or silent data loss.
- Plugin hook enabling follows plugin settings; the hooks page creates no second override system.
- Copy supports `zh-CN` / `en-US`, semantic colors, and existing controls; on narrow screens content and actions must not overlap.
- The page states clearly: changes apply to new sessions.
- The page follows the shared information architecture of the MCP, Skills, and Commands settings pages: the shared Scope menu on top, the current scope's hook total, and a search entry; within a scope, groups are `Installed`, specific plugins, and `Legacy`.
- After a search, only groups with matching hooks are shown; with no results, a unified empty state replaces zero-count group headers.
- Groups use one rounded surface list container with item dividers. A hook item leads with the event as title; commands use `font-mono text-ui-sm`; directly configured hooks show a toggle and open editing from the whole row; plugin hooks are read-only with the plugin icon; compatibility sources show Import.
- Creating a hook from the current scope preselects that scope; the form reuses `PluginScopeMenu`. Editing an existing hook cannot migrate scope. With no workspace available, the menu offers User only.
- The create/edit pages reuse the resource settings pages' back link, title, and description hierarchy; desktop and mobile Web share the responsive layout.
- HooksSection must receive and pass through `workspaceIdentity`; remote-workspace read, write, and session invalidation are isolated by `workspaceIdentity?.trim() || workspacePath`.

## Acceptance matrix

| ID    | Event                | Proof point                                                                                                 | Automation layer         |
| ----- | -------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| HK-01 | `SessionStart`       | startup matcher, snake_case stdin, first-round context                                                      | core + desktop E2E       |
| HK-02 | `UserPromptSubmit`   | prompt stdin, matcher does not filter, block/context                                                        | core + desktop E2E       |
| HK-03 | `PreToolUse`         | tool matcher, deny/ask/allow, updatedInput, context; all three early-failure exits keep context             | core + desktop E2E       |
| HK-04 | `PermissionRequest`  | fires only on the ask path, allow/deny/modify, permission updates                                           | core + desktop E2E       |
| HK-05 | `PostToolUse`        | full `tool_response`, context                                                                               | core + desktop E2E       |
| HK-06 | `PostToolUseFailure` | string error, interrupt, recovery context                                                                   | core + desktop E2E       |
| HK-07 | `Stop`               | last assistant, transcript, block continuation cap                                                          | core + desktop E2E       |
| HK-11 | `PreCompact`         | trigger matcher, `custom_instructions` stdin, block skips this compaction                                   | core                     |
| HK-12 | `PostCompact`        | fires only after real successful compaction; skip/failure do not fire; diagnostics do not affect the result | core                     |
| HK-13 | `SessionEnd`         | exactly once on close, 5-second total budget, hook failure never blocks close                               | core + bootstrap         |
| HK-08 | Config/source        | user+project+plugin order, per-hook disabled really skipped                                                 | adapter/bootstrap/core   |
| HK-09 | Settings             | `.zcode` writable, legacy importable, plugin read-only visible                                              | service/UI + desktop E2E |
| HK-10 | Executors/async      | process argv, command shell/fire-and-forget, parent cancellation, background lifecycle, error isolation     | core + desktop E2E       |

The full window-level suites use `HK-LC-01`, `HK-EF-01`, `HK-ST-01`, `HK-UP-01`, defined in `docs/testing/hooks-e2e-coverage-matrix.md`. Parent cancellation stays in core's deterministic AbortSignal test; window level verifies that an async command really starts/completes and its stdout decisions cannot retroactively change the already-continued event.
