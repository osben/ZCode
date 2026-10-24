# Plugin hooks compatibility spec

## Background

ZCode supports official plugins, inline plugins, skills, commands, MCP servers, and plugin-level hooks. Existing plugins such as `superpowers` typically put startup context injection in `hooks/hooks.json` and use shell command hooks, plugin-root variables, and `SessionStart` `additionalContext` output.

This spec defines ZCode's compatibility boundary for plugin hooks: `.zcode-plugin/plugin.json` plugins are a first-class form, while Claude / Codex plugin manifest discovery order stays compatible.

## Manifest discovery order

A plugin root is searched for manifests in this order:

1. `.zcode-plugin/plugin.json`
2. `.claude-plugin/plugin.json`
3. `.codex-plugin/plugin.json`

`.zcode-plugin` always wins; when an external plugin has both Claude and Codex manifests, the Claude manifest wins over the Codex one. This order governs plugin metadata, skills / commands / MCP / hooks declarations, and the plugin id.

## Hooks discovery

When a plugin is enabled, ZCode collects its hooks during plugin discovery and merges them into the runtime hooks:

### Trust boundary

- Plugin hooks share the plugin's enable/disable state; once a plugin is disabled, new sessions no longer inject its hooks, and the settings page still shows the declarations read-only.
- Currently enabled third-party marketplace plugins can execute `command` shell hooks exactly like official plugins, and the child process inherits the Agent process environment. Enabling a plugin therefore grants it local command execution and inherited environment variable reads.
- There is no separate hook trust switch or per-plugin hook authorization today. Install source, plugin code review, and plugin enable/disable are the existing security boundary; if workspace trust is introduced later, it must intercept uniformly before runtime injection, not merely hide things in the settings page.

### Loading rules

- The standard location `hooks/hooks.json` is loaded automatically.
- The manifest `hooks` field is additive: a relative JSON file path, an inline hooks object, or an array of both.
- `hooks/hooks.json` uses the `{ "description"?: string, "hooks": { ... } }` wrapper shape.
- Inline manifest hooks use the bare `{ "SessionStart": [...] }` shape.
- The standard `hooks/hooks.json` auto-loads; a manifest must not point at the same file again — duplicates are diagnosed and skipped.
- Only hook events the current ZCode runtime supports are loaded; unknown events log a warning without blocking plugin load.

Plugin hooks reach the runtime only when the plugin is enabled. User/project hooks run first, plugin hooks after. Deduplication across plugins must include the plugin root, so multiple plugins using `${ZCODE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}` templates cannot overwrite each other.

## Hook types

ZCode keeps the existing `process` hook and adds the compatible `command` hook:

- `process`: argv form — `command` is the executable, `args` the argument array.
- `command`: shell string form — `command` runs through the system shell.

`command` hook fields:

- `command: string`
- `timeout?: number` in seconds, Claude hook config compatible.
- `timeoutMs?: number` in milliseconds, preferred internally by ZCode.
- `statusMessage?: string`
- `async?: boolean`

`async: true` is fire-and-forget: the runtime starts the command and moves on without reading its stdout for decisions, so a background hook cannot block, alter tool input, or inject context; completion and failure still emit hook lifecycle events.

## Plugin variables

Plugin hook subprocesses receive these environment variables:

- `ZCODE_PLUGIN_ROOT`: the plugin's install root.
- `ZCODE_PLUGIN_DATA`: the plugin's persistent data directory.
- `ZCODE_PLUGIN_ID`: `<name>@<marketplace>`.
- `ZCODE_PLUGIN_NAME`: the plugin manifest name.

For compatibility with existing plugins, these are also injected and substituted:

- `CLAUDE_PLUGIN_ROOT`
- `CLAUDE_PLUGIN_DATA`

`${ZCODE_PLUGIN_ROOT}`, `${ZCODE_PLUGIN_DATA}`, `${CLAUDE_PLUGIN_ROOT}`, and `${CLAUDE_PLUGIN_DATA}` inside command strings are replaced with the corresponding paths before execution. The replacement values come from the plugin discovery phase's resolved root / data path, never from the user environment.

## Hook stdin compatibility fields

The ZCode runtime keeps camelCase `HookInput` as its internal contract; the stdin delivered to plugin hook subprocesses must additionally carry the snake_case aliases common in the Claude Marketplace, so scripts reading only the old fields run, without breaking ZCode's own fields:

| ZCode field      | Claude alias      | Events                                                                    | Notes                                            |
| ---------------- | ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `hookEventName`  | `hook_event_name` | all events                                                                | existing compatibility field, kept               |
| `sessionId`      | `session_id`      | all events                                                                | existing compatibility field, kept               |
| `toolName`       | `tool_name`       | `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` | lossless alias                                   |
| `toolInput`      | `tool_input`      | `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` | lossless alias, original input structure kept    |
| `toolCallId`     | `tool_use_id`     | `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` | lossless alias, current ZCode tool call id       |
| `toolResponse`   | `tool_response`   | `PostToolUse`                                                             | full structured output of the successful tool    |
| `isInterrupt`    | `is_interrupt`    | `PostToolUseFailure`                                                      | marks whether the error came from an interrupt   |
| `transcriptPath` | `transcript_path` | all events                                                                | temp transcript file path of the current session |

`PostToolUse` also keeps ZCode's `toolResultPreview`, but Claude-compatible scripts must read the full `tool_response`; the preview is not a substitute for the structured result. `PostToolUseFailure.error` is always a string externally.

## Hook output

ZCode keeps the standard `hookSpecificOutput`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "..."
  }
}
```

For compatibility with other plugin runtimes it also accepts:

- top-level `additionalContext`
- `additional_context` in the Cursor hooks output format

Both are normalized into the current hook event's `additionalContext`, then injected into the runtime's `hook_context` system reminder.

## Claude Code tool compatibility

When ZCode runs Claude Code plugins, tool-name translation must live in the structured runtime layer, not in per-plugin prompt text:

- `Task` is exposed as the Claude Code compatible tool name, delegating to the ZCode `Agent` subagent handler; both share schema, permission capabilities, result budget, and background task semantics.
- Without a configured subagent port, neither `Agent` nor `Task` is registered; when subagents forbid recursive subagents, both are filtered from the available tool list.
- `toolName` in tool hook stdin stays the actual tool name; hook matchers match through the compatibility alias — `Agent` matches a `Task` matcher and `Task` matches an `Agent` matcher.
- If `ApplyPatch` is re-enabled, hook matchers may accept Claude Code plugins' `Write` / `Edit` matchers without changing the actual toolName.

The full subagent compatibility boundary is in `docs/subagent-compatibility.md`.

## Built-in Superpowers

`superpowers` ships as an official built-in plugin:

- Main manifest is `.zcode-plugin/plugin.json`.
- Disabled by default; skills/hooks reach the runtime only after the user explicitly enables it.
- Provides `skills/` and `hooks/hooks.json`.
- The `SessionStart` hook injects `using-superpowers` context on `startup|clear|compact`.
- ZCode appends no dedicated tool mapping to the Superpowers `SessionStart` output; `Task` / `Agent` compatibility is handled by the generic tool registration and hook matcher alias layer, so an external `.claude-plugin` Superpowers needs no changes to its original files.

Superpowers plugin skills support both bare names and fully qualified aliases. The model context shows `superpowers:<skill>` first; the bare name remains a compatibility alias only.

Official plugin packaging must cover both the CLI SEA and the Electron desktop runtime bundle, and the management page and runtime default-enable policies stay consistent.
Official plugins seeded into the user cache must keep the executable bit; executable wrappers/scripts under `hooks/` must not land as `0644`, or macOS/Linux raises `permission denied` when `SessionStart` executes them directly.

## Verification

The implementation must cover:

- `.zcode-plugin`, `.claude-plugin`, `.codex-plugin` manifest priority.
- Auto-loading of `hooks/hooks.json`.
- Merging of manifest `hooks` files and inline hooks.
- `command` hooks executing through the shell with ZCode / Claude compatible environment variables.
- `SessionStart` `additionalContext` injected into `hook_context`.
- The `Task` tool dispatching a ZCode subagent as the Claude Code compatible alias.
- `Agent` / `Task` hook matcher alias interoperability, with hook input keeping the actual tool name.
- The `superpowers` official plugin defaulting to off; skills/hooks exposed after explicit enable.
- `Skill(skill="superpowers:test-driven-development")` loading the Superpowers skill; the bare name still works.
- No dedicated ZCode tool mapping injected into Superpowers `SessionStart`.
- Hook wrappers such as `hooks/run-hook.cmd` in the official plugin cache staying executable.
- `pnpm typecheck`
- `pnpm lint`
