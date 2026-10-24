# Custom Commands

## Goal

User-defined slash commands as reusable prompt templates. The first version follows Claude Code's
legacy `.claude/commands/*.md` format closely enough for common commands to migrate, while keeping
ZCode's runtime boundaries: discovery and file I/O live in adapters, execution is owned by command
center, permissions stay scoped to a single invocation, and TUI/ZCode app-server only render command
surfaces.

This is for NL -> Code workflows such as `/review`, `/fix-issue 123`, `/commit`, `/test auth`. A
custom command is not a new local CLI command and does not run arbitrary UI code.

## User contract

- `.zcode/commands/review.md` invokes as `/review`; `.claude/commands/review.md` and
  `.agents/commands/review.md` likewise when the respective compatibility is enabled.
- `/help` and TUI slash suggestions list custom commands with description, source, and argument
  hint.
- `zcode commands list` lists discoverable custom commands without starting a model turn.
- Headless `zcode --prompt "/review"` and ZCode app-server prompt commands can invoke custom
  commands that do not require terminal-only interaction.
- Built-in commands always win over same-named custom commands; a custom `/help`, `/model`,
  `/skill`, etc. is ignored and reported as a diagnostic rather than shadowing local control
  commands.

## File format

```markdown
---
description: Review current changes
argument-hint: [scope]
allowed-tools: Read, Grep, Bash(git diff *)
model: main
---

Review the current diff for correctness, tests, and maintainability.

Scope: $ARGUMENTS
```

Frontmatter fields:

- `description`: optional string. If missing, use the first non-empty markdown line, capped for
  display. Empty commands are invalid.
- `argument-hint`: optional string shown by TUI after completing `/command `.
- `allowed-tools`: optional comma or array list using ZCode permission rule syntax. It can grant
  only invocation-scoped allowances and never overrides global deny rules.
- `model`: optional `main`, `lite`, or configured `provider/model` one-turn override. Unknown model
  refs fail before starting a model turn.
- `disable-noninteractive`: optional boolean. When true, omit the command from ZCode app-server and
  headless command lists.

Reserved P1/P2 fields: `arguments` (named argument metadata), `when_to_use` (model-facing discovery
text), `context: inline | fork` (future subagent execution mode), `effort` (one-turn reasoning
effort override), `shell` (shell profile for dynamic shell expansion).

Plugin compatibility adds `skills`: optional comma or array list of skill names loaded before
running this prompt command. The command expander renders an explicit instruction to call the
`Skill` tool for those names; it does not load the skill body directly.

Unknown frontmatter keys produce warnings and do not fail the command.

Common dynamic syntax from the compatible format — `$ARGUMENTS`, `$1`, `$2`, `@file`, and shell
injection blocks such as ``!`git status` `` — must go through ZCode adapters and permission
contracts, never ad hoc string replacement (see Prompt Expansion).

## Naming

Command names use `^[a-z0-9][a-z0-9:-]{0,63}$` after normalization. Spaces, path separators,
leading dots, and uppercase-only distinctions are invalid. Names are case-insensitive at
invocation. Subdirectories use a stable colon namespace:

```text
.zcode/commands/review.md          -> /review
.zcode/commands/frontend/review.md -> /frontend:review
```

This avoids collisions and matches the command-center model better than showing two files as the
same `/review`.

## Discovery roots

Discovery is adapter-owned and receives `workingDirectory`, config, trace, and abort signal. Core
and TUI must not scan the filesystem directly.

Default roots, in priority order:

1. `commands.roots[]` from config, nearest entry first.
2. Project native roots from cwd up to worktree root: `.zcode/commands/**/*.md`.
3. Project `.agents` compatibility roots: `.agents/commands/**/*.md`.
4. Project Claude compatibility roots: `.claude/commands/**/*.md`.
5. User native root: `~/.zcode/commands/**/*.md`.
6. User `.agents` compatibility root: `~/.agents/commands/**/*.md`.
7. User Claude compatibility root: `~/.claude/commands/**/*.md`.

Config shape:

```ts
commands: {
  enabled: boolean;
  roots: string[];
  metadataBudget: number;
  maxCommandBytes: number;
  compatibility: {
    agents: boolean;
    claude: boolean;
  };
}
```

Plugin command roots are specified by [`plugin-compat.md`](plugin-compat.md), projected as
`source: "plugin"` roots using this same markdown command format.

No `ZCODE_*` environment variable is introduced for this feature. If a future environment override
is needed, it must be specified separately with precedence, error behavior, and tests.

## Contracts

A command contract package beside skill contracts:

```ts
type CustomCommandScope = "project" | "user" | "system" | "admin";
type CustomCommandSource = "zcode" | "agents" | "claude" | "plugin";

interface CustomCommandMetadata {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
  rootPath: string;
  scope: CustomCommandScope;
  source: CustomCommandSource;
  allowedTools: string[];
  model?: string;
  disableNonInteractive: boolean;
  frontmatterKeys: string[];
}

interface CustomCommandPort {
  discoverCommands(request, options): Promise<CustomCommandLoadOutcome>;
  loadCommand(request, options): Promise<CustomCommandContent>;
}
```

The adapter returns structured diagnostics for scan failures, invalid names, duplicate names,
invalid frontmatter, unsupported dynamic syntax, and oversized files. Diagnostics surface through
`zcode commands list --verbose`, `doctor` verbose output, and debug logs.

## Invocation flow

1. TUI, headless CLI, or ZCode app-server submits `/name args`.
2. Command center parses built-ins first.
3. If no built-in matches, command center asks the custom command registry for `name`.
4. Command center loads the markdown body through `CustomCommandPort`.
5. Command center expands safe placeholders and builds a synthetic prompt.
6. Permission service evaluates any invocation-scoped `allowed-tools` and model override.
7. The app submits the expanded prompt to the normal runtime with trace, abort, event forwarding,
   and session persistence intact.

The visible transcript shows the user invocation (`/review auth`) and a small command-loaded
marker. The full markdown body is stored as hidden model-visible command context, not re-rendered
as user chat text.

## Prompt expansion

P0 expansion:

- Strip YAML frontmatter.
- Replace `$ARGUMENTS` with the raw argument tail.
- Replace `$1`, `$2`, ... with parsed positional arguments, using a small cross-platform parser
  supporting whitespace separation and quotes. Do not delegate argument parsing to a shell.
- If the template references no `$ARGUMENTS`/positional placeholder and the user supplied args,
  append:

```text
User arguments:
<args>
```

Dynamic expansion:

- `@file` references are P1: resolve through the file-system adapter, respect workspace/path
  permissions, and produce attachment-style model context rather than raw string concatenation.
- ``!`command` `` and fenced `!` shell blocks are P1: execute through `ExecutionPort`, carry
  trace/span IDs, obey timeout/output limits, and require permission before execution. In P0 they
  fail closed with a clear unsupported-dynamic-syntax diagnostic.

## Permissions

`allowed-tools` is not a way for a repository file to bypass user policy.

- Global disallowed tools always win.
- Invocation-scoped allowed tools expire after the command turn.
- Built-in and user-scope commands may apply `allowed-tools` directly when the permission service
  accepts the rule syntax.
- Project-scope commands with `allowed-tools` require trust/approval before the scoped allowlist is
  applied. In non-interactive mode, lack of approval is a command error rather than silent fallback.
- Invalid `allowed-tools` entries are diagnostics and are not applied.
- The command body never directly calls tools; it only influences the next model turn.

## UI and ZCode app-server

TUI:

- Suggestions merge built-ins and custom commands; built-ins sort first, custom commands by name.
- Rows show `/name`, `argument-hint`, short description, and a source suffix such as
  `project/zcode` or `user/claude`.
- Tab completion inserts `/name `.
- If discovery fails, suggestions still show built-ins and `/commands` can show diagnostics.

ZCode app-server:

- Advertises custom prompt commands through `available_commands_update`; excludes commands with
  `disable-noninteractive: true`.
- `/help` includes only app-advertised built-ins and compatible custom commands; local-only
  management commands such as `/model`, `/resume`, `/mcp` are not exposed through custom command
  discovery.
- In stdio/app protocol mode the agent is the single source of truth for the slash command list:
  app-supported built-ins (`/goal`, `/workflow`, `/compact`, `/init` and the app-only `/plan`) plus
  discovered compatible custom prompt commands. UI clients must not rebuild this list from app-side
  command services.
- Protocol rows carry `source: "builtin" | "custom"` so clients can hide unsupported built-ins
  while still showing user-defined commands; rows without `source` are treated as built-in for
  compatibility.
- Built-in command names and aliases are reserved: a custom command matching an internal built-in
  is not advertised, so no UI row is later parsed as a different built-in. Built-in prompt commands
  (`/init`, `/workflow`) are expanded by `bootstrap/src/builtin-prompt-command.ts` before
  custom-command lookup; the custom resolver returns "not found" for every reserved name, so a
  custom `workflow.md` can neither shadow the built-in nor bypass a feature gate on it.

CLI:

- `zcode commands list`: human list; `--json`: structured metadata and diagnostics.
- `zcode commands inspect <name>`: resolved metadata and file path; body only with `--verbose`.

## Observability

Each invocation emits structured runtime/session events:

- `custom_command_discovered` for debug-only discovery summaries.
- `custom_command_invoked` with command name, source, scope, path hash, and whether scoped
  permissions/model override were requested.
- `custom_command_expanded` with body byte count, argument count, dynamic expansion count, and
  redacted diagnostics.

Logs must not include the full command body, full arguments for sensitive commands, API keys, or
shell output beyond existing adapter truncation rules.

## Tests

- Adapter discovers `.zcode/commands`, `.agents/commands`, and `.claude/commands` with
  deterministic priority.
- Duplicate names keep the higher-priority command and produce a diagnostic.
- Built-ins cannot be shadowed.
- Frontmatter parses `description`, `argument-hint`, `allowed-tools`, `model`,
  `disable-noninteractive`.
- `$ARGUMENTS` and `$1`/`$2` expansion work with quoted args on Windows, macOS, and Linux.
- Unsupported `!` dynamic shell syntax fails closed in P0.
- `allowed-tools` is scoped to one invocation and respects deny rules.
- TUI suggestions include custom commands and argument hints.
- `zcode --prompt "/custom args"` expands and submits a normal runtime turn.
- ZCode app-server advertises only noninteractive-compatible custom commands.
- Command diagnostics are available in `zcode commands list --json`.

## Open phases

P1:

- `@file` references through the file-system adapter.
- ``!`command` `` through `ExecutionPort` with permission prompts, timeout, cancellation, output
  truncation, and trace spans.
- Command reload/invalidation when TUI stays open across file changes.

P2:

- Plugin-provided commands with namespace isolation.
- Forked/subagent command execution.
- Command usage telemetry and a diagnostics UI in debug tools.
- Consider unifying prompt commands and skills in a shared metadata index while keeping `/skill`
  autonomous loading separate from user-invoked `/command`.
