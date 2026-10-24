# Command Center

## CLI Process Identity

The CLI command name stays `zcode` for compatibility with the existing npm `bin`, scripts, help
and doc examples. The OS-visible Node process name must be set uniformly to `zcode-cli`, so `ps`,
Activity Monitor, Task Manager or the ZCode app-server parent-process panel never shows just
`node` or an unstable script name.

The entry layer sets `process.title = "zcode-cli"` before loading bootstrap, TUI, provider,
storage or any module that may start async tasks. This adds no `ZCODE_*` environment variable and
does not depend on the platform shell, binary file name or how the user launched it; plain Node
bundles, the `tsx` dev entry and SEA binaries share the same process-name constant.

`zcode doctor --json` must report both `cli.processName` and `runtime.processTitle`, and plain
`zcode doctor` output also shows the current process name, so scripts and manual diagnostics can
verify the running process honors the contract.

ZCode's slash-command entry lives on the CLI/bootstrap side, not the TUI side. The TUI only hands
user input to one `submitPrompt` function and renders progress from runtime events.

The TUI slash-command suggestion list is in
[`tui-slash-command-suggestions.md`](./tui-slash-command-suggestions.md). The suggestion list only
consumes the read-only command surface exposed by the command center; it owns no execution logic.

Currently registered built-in commands:

- `/btw <question>`: answers a short side question out of band; creates no normal turn, writes
  neither question nor answer into the main session context, and does not interrupt a running
  main turn. See [`btw-side-question.md`](./btw-side-question.md).
- `/compact [instructions]`: goes through the existing core manual compact path; may carry
  summary instructions.
- `/expert [status|resume|stop|<task>]`: starts or manages an expert workflow; with a task it
  switches the current session to `yolo` by default and schedules multiple agent activities
  through the workflow runtime.
- `/effort [list|<level>]`: queries or switches the current session's reasoning/thinking depth;
  levels come from the current model catalog/config reasoning metadata. The interactive TUI uses
  a `/model`-style candidate popup inside the composer and submits an explicit
  `/effort <level>`. `/variant` is an input-compatibility alias.
- `/fork [latest|checkpointId]`: forks a new session from a workspace checkpoint; no argument or
  `latest` uses the newest checkpoint, otherwise it forks by checkpoint id.
- `/help [command]`: local read-only slash-command help; creates no session, sends no model
  request, accesses no external I/O. With an argument it shows only the target command's usage;
  the argument may be given with or without the leading `/`.
- `/login`: logs in through the ZCode/Z.AI CLI OAuth device flow; the command layer calls the
  bootstrap login service and creates no normal model session. Once Init returns the authorize
  URL, it must immediately be shown as an assistant transcript message, so SSH/remote-terminal
  scenarios don't only open a browser on the host while the user has no copyable link.
- `/locale [auto|en-US|zh-CN]`: queries or switches the current UI language and persists the
  requested value to the config file; `/language` is an input-compatibility alias.
- `/logout`: clears the ZAI login state from the shared credential store; creates no normal model
  session.
- `/mcp [list|status|connect <server>|disconnect <server>]`: queries or manages the MCP server
  connections visible to the current session; the command layer only calls the MCP management
  interface exposed by the app/server.
- `/mode [plan|build|edit|yolo]`: queries or switches the current TUI session's permission mode;
  typing `/mode` in the interactive composer opens a local popup in the same shape as `/model`,
  and a chosen entry submits an explicit `/mode <mode>`. `edit` auto-accepts file-editing tools
  like `Write`, `Edit`, `ApplyPatch`; other high-risk or non-editing operations still confirm
  under the build policy. `auto` may be displayed but cannot be entered from the TUI yet.
- `/model [list|main|lite|provider/model]`: queries or switches the current session's main model;
  candidates come from `model.main`, `model.lite` and all configured `provider.*.models`; state
  is kept by the app/server and the TUI holds no model state.
- `/new`: starts a new root session and switches subsequent TUI prompts to it. It sends no model
  request, does not resume the latest session, and does not copy the old session's transcript or
  checkpoints; permission mode/model and other session runtime config re-initialize from the
  current CLI/TUI configuration. Creation errors bubble up and the TUI shows them as a normal
  command failure. `/clear` is its alias with identical behavior.
- `/resume [sessionId]`: with an argument, resumes that session; without, resumes the most
  recently active root session in the current directory. `sessionId` is the ZCode session id,
  usually shaped like `sess_...` — the `sessionId` field in CLI JSON output — not `traceId`,
  `turnId`, `messageId` or `toolCallId`. `/continue` is an alias of `/resume`.
- `/rewind [latest|checkpointId]`: goes through the core checkpoint/rewind path, viewing the
  newest checkpoint or restoring workspace files to a target checkpoint.
- `/skill`: read-only listing of skills discoverable in the current working directory; creates no
  session, sends no model request, calls no `Skill` tool.
- `/skill <name> [task]`: forces the next prompt to first load the named skill, then continue the
  task.
- `/workflow [what the workflow should accomplish]`: built-in prompt command, same path as
  `/init`: TUI/headless recognize only the name and pass the raw text to `submitPrompt`; the
  bootstrap builtin prompt resolver expands it into "first load the built-in `dynamic-workflows`
  skill with the `Skill` tool, then write a script calling `CreateWorkflow`"
  (`$ARGUMENTS` substituted). Both the command text and the skill are bundled with the CLI; no
  plugin is required. The App protocol side is gated by the dynamic-workflow gray release
  (`docs/dynamic-workflow/launch.md`, "Gray release"); TUI/headless are gated by the process
  argument `--workflow-mode` — with the default `disabled` the `/` panel and `/help` omit the
  command, a hand-typed `/workflow` in the TUI gets a local hint and no model request, and
  headless errors with exit code 1. `workflow` is a reserved name: same-named custom commands
  are neither broadcast nor expanded.
- `/dwf [list|cancel [runId]|resume <runId>]`: lists, cancels or resumes this session's dynamic
  workflow runs (`docs/dynamic-workflow/launch.md`, "`/dwf`"). Under
  `--workflow-mode disabled`, `list`/`cancel` work as usual; `resume` is rejected with the same
  disabled message before contacting the server.
- `/goal [pause|resume|clear|replace <objective>|<objective>]`: queries or manages the current
  session goal; after setting or resuming an active goal, the runtime keeps advancing it while
  idle and not in plan mode. `/target` is a compatibility alias that only accepts old client and
  old script input; help, suggestions and new docs must show `/goal`.

All `/goal` write operations go first through the goal/target compatibility interface exposed by
bootstrap/app, and the runtime then writes the compatible `target_changed` session event. The
TUI, ZCode app-server and future replay/debug projections consume that event; they never parse
command reply text to determine goal state.

Process-level CLI commands:

- Global `--cwd <path>`: the effective working directory for this CLI command. It serves as the
  session `workingDirectory`, the dotenv lookup start, the skill-discovery directory, the
  `--continue`/`/resume` latest-session query directory and the `doctor` report directory.
  Relative paths resolve against the CLI startup directory into absolute paths; empty,
  nonexistent, inaccessible or non-directory paths must produce a clear error at the CLI entry
  boundary without creating an app/session or sending a model request. The implementation must
  not call `process.chdir()`, which would pollute the Node process hosting the TUI, ZCode
  app-server, multiple sessions and background tasks. `--cwd` is a CLI-argument override; no
  `ZCODE_*` environment variable is added — a future environment-variable form must first add
  purpose, precedence, error behavior and test coverage to a spec.
- Global `--prompt <text>`: the script-friendly single-turn headless entry. Without an explicit
  `--mode`, the CLI must create the runtime with `yolo` permission mode so headless prompts
  without an interactive broker don't stall in approval flows on the common file-write and
  command-execution paths; an explicit `--mode build|edit|plan|yolo` still wins. This default
  applies only to the `--prompt` entry; it does not change the initialization mode of the
  no-argument TUI, `zcode tui`, ZCode app-server sessions or a standalone `--target`.
- Global `--browser-use=headless`: explicitly enables CLI-managed CDP Browser Use for `--prompt`,
  `--target` and the TUI. On first backend discovery the CLI starts a native headless Chromium
  and only returns a `type: "cdp"` descriptor after the CDP handshake. This argument does not use
  `agent-browser` and does not change the browser-use plugin/node_repl model entry; when the
  plugin is disabled no Chromium may be started. `zcode app-server` must fail closed with this
  argument, so Desktop/Web Remote shared-host chains never gain a second browser runtime.
- Global `--browser-executable <absolute-path>`: the Chrome/Chromium executable used by
  `--browser-use=headless`; cannot be used alone. When omitted, only locally installed browsers
  and the Playwright cache are searched — P0 does not download over the network. Path or
  executability errors must happen before app/session creation; the implementation uses
  cross-platform path/fs APIs and argument-array spawn, no shell, and does not default to adding
  `--no-sandbox`.
- Global `--workflow-mode <disabled|onDemand|alwaysOn>`: decides the dynamic-workflow surface of
  this process's TUI and headless (`--prompt`, `--target`) sessions, with the same semantics as
  the server-side `dynamicWorkflow.mode` (`docs/dynamic-workflow/launch.md`, "The standalone CLI:
  `--workflow-mode`"). **Default is `disabled`.** Values are normalized by the shared
  `normalizeDynamicWorkflowMode` (exact spelling, surrounding whitespace ignored); an invalid
  value errors at the CLI entry, lists the three accepted values and exits 1 without creating an
  app/session. `app-server`/`agent-server` get their mode from the Host and reject the argument
  with a scope error; session-less subcommands (`login`, `plugins`, `skills`, `doctor`, ...) also
  reject it. The entry folds the mode once into two explicit runtime fields —
  `dynamicWorkflowEnabled = mode !== "disabled"` and
  `dynamicWorkflowToolsOnDemand = mode === "onDemand"` — written into every app this process
  creates (including `/new`, `/resume`, forks). The mode is not persisted; resuming into a
  different mode switches silently. No environment variable or config key is added.
- Global `--target <objective>`: headless goal compatibility, equivalent to running
  `/goal <objective>` in the headless session; the CLI must reuse the command center's goal
  semantics rather than inventing a target-only control flow. With `--resume` / `--continue` it
  applies to the restored session; otherwise to the newly created session. `--target` does not
  combine with `--prompt`; use `--prompt "/goal ..."` when the explicit slash-command form is
  needed. The implementation must not turn `--target` into an environment variable.
- Global `--target-replace`: the explicit override confirmation for `--target`. If the session
  already has a goal and `--target-replace` is not given, the CLI must return a clear local error
  — never silently overwrite the goal, never send a model request. `--target-replace` alone is an
  error.
- `zcode skills list`: read-only listing of skills discoverable in the current working directory.
  It reuses bootstrap's skill-discovery interface, starts no TUI, creates no session, sends no
  model request; `zcode skills` equals `zcode skills list`. Plain output shows name, scope/source,
  description and path; `--json` outputs structured skills and diagnostics; `--verbose` appends
  diagnostics to the plain output.
- `zcode commands list`: read-only listing of custom prompt commands discoverable in the current
  working directory. It reuses bootstrap's custom-command discovery interface, starts no TUI,
  creates no session, sends no model request; `zcode commands` equals `zcode commands list`.
  Plain output shows `/name`, argument hint, scope/source, description and path; `--json` outputs
  structured commands and diagnostics; `--verbose` appends diagnostics.
- `zcode login`: logs in through the ZCode/Z.AI CLI OAuth device flow; after browser
  authorization it writes sensitive tokens into `~/.zcode/v2/credentials.json` shared with the
  desktop Z Code, and only patches non-sensitive provider/model defaults in
  `~/.zcode/cli/config.json`. `--no-browser` only prints the authorize URL without opening a
  browser, and keeps polling.
- `zcode logout`: clears the ZAI login state from the shared credential store; if
  `oauth:active_provider` is currently `zai`, the active provider is cleared too.
- `zcode doctor`: outputs runtime and packaging-assumption checks; the single process-level entry
  for CLI health checks and smoke tests.

`zcode hello` is no longer a supported command. The CLI keeps no greeting/smoke-test command
without business meaning; scripts, docs and tests use `zcode doctor` or `zcode --version` to
express health-check intent.

ZCode protocol clients carry session/config operations through native protocol capabilities, so
only read-only help and prompt-type commands are broadcast:

- `help`: matches `/help [command]`; bootstrap returns the current ZCode app-server command
  surface directly, creating no model turn.
- `compact`: matches `/compact [instructions]`.
- `workflow`: matches `/workflow [what the workflow should accomplish]`,
  `source: "builtin"`, broadcast right after `goal`; when the gray gate is closed the row is not
  broadcast at all and a hand-typed `/workflow` is not expanded.
- `goal`: matches `/goal [pause|resume|clear|replace <objective>|<objective>]`; bootstrap reads
  and writes the session goal locally; with an existing goal both `/goal <objective>` and
  `/goal replace <objective>` are treated as replace, and state keeps projecting through the
  compatible `target_changed` / `_meta.zcode.target`; `/target` remains only an input
  compatibility alias and is not broadcast to new clients.
- `skill`: matches `/skill <name> [task]`; bootstrap rewrites it into an explicit `Skill` tool
  call requirement. ZCode app-server-side skill discovery stays with the protocol-native skill
  UI; the bare `/skill` command is not interpreted as a listing.

The App's "plan mode" is a Composer-local list action whose selection reuses the standard Plan
toggle; the protocol catalog no longer broadcasts `/plan [task]` and the CLI provides no matching
prompt expansion. `plan` stays a reserved name so a custom command cannot take over that entry.
App-side interaction: [plan-mode quick entry](../../../../../docs/plan-slash-command.md).

ZCode app-server `/help` shows only the commands it broadcasts; local-only commands such as
`/mode`, `/model`, `/resume`, `/mcp` must not be mixed in, so clients never see local TUI
operations they cannot execute.

`/btw` is not in the ZCode app-server `available_commands_update` for now. Once clients have
side-result UI, they should ask through the `zcode.dev/session/sideQuestion` extension method,
not receive `/btw` as a normal prompt command or have it injected into the main session.

ZCode app-server command broadcast uses the `available_commands_update` session update; these
commands are never stuffed into `initialize` or `session/new` response bodies, and the transport
layer never understands ZCode command semantics.

Command recognition, argument parsing and session switching live in the command layer; the UI
only triggers and displays results. A future command palette, custom commands or MCP prompt
commands extend the command center — specific command branches never go into the TUI.

Successfully handled slash commands record the raw command text best-effort through the
input-history port for TUI `Up` recall; e.g. recalling `/help` restores `/help`, not a lost local
command or the expanded prompt. A history write failure must not affect the command response.
`/login` forms carrying sensitive parameters such as API keys are never written to history.

The custom prompt command design is in [`custom-commands.md`](./custom-commands.md). It is
planned as a dynamic command source for the command center: markdown files only define reusable
prompt templates, discovery and reading go through adapters, TUI/ZCode app-server consume only
the read-only command surface, and final execution still enters a normal runtime turn. The P0
goal is compatibility with the common `.claude/commands/*.md` shape, prioritizing native
`.zcode/commands` and `.agents/commands`, and bringing high-risk capabilities like
`allowed-tools`, `model` and dynamic shell/file expansion under the permission and I/O
boundaries.

`/help` test coverage:

- The slash-command parser recognizes `/help` and `/help model` as known commands.
- Executing `/help` creates no app, sends no model prompt, and returns the current command
  surface.
- With a history source available, the command center records `/help` as `slash_command` but
  never records API-key login commands.
- Non-interactive `zcode --prompt /help` prints the same command surface without creating a
  runtime.

CLI process identity test coverage:

- The process-name constant set by the entry layer is `zcode-cli`, and the plain command name is
  still `zcode`.
- `zcode doctor --json` outputs `cli.processName = "zcode-cli"` and
  `runtime.processTitle = "zcode-cli"`.
- Plain `zcode doctor` output includes the current process name for manual diagnostics.

Headless `--prompt` test coverage:

- Without `--mode`, the permission mode passed to the runtime for `--prompt` is `yolo`.
- `--prompt --mode build|edit|plan|yolo` keeps the explicit override; the headless default never
  rewrites it.

CLI Browser Use test coverage:

- `--browser-use` accepts only `headless`; `--browser-executable` alone or with an invalid path
  fails before app creation.
- prompt/TUI inject the same managed CDP runtime into the current app; session replacement closes
  the old context and leaks no tabs.
- With the browser-use plugin disabled, generic node_repl still works but no Chromium starts and
  no browser broker is injected.
- app-server rejects the headless argument, preserving Desktop/Web Remote shared-host ownership.
- A real Chromium E2E on Linux without `DISPLAY` must go through MCP node_repl, the plugin
  browser-client, the broker and the port; mocks calling the adapter directly cannot impersonate
  the full Browser Use chain.

`--workflow-mode` test coverage (launch.md DWG-14 to DWG-17):

- TUI and `--prompt` default to `dynamicWorkflowEnabled: false`; `onDemand` / `alwaysOn` write
  the corresponding two booleans; the TUI's `/new` and `/resume` reuse the same pair; invalid
  values exit 1 without creating an app.
- `app-server`, `agent-server`, `login`, `skills` exit 1 with the argument; `--prompt`,
  `--target`, `tui` accept it.
- Under `disabled` the TUI's `/` suggestions and `/help` omit `workflow`; `/workflow` gives a
  local hint and does not call `submitPrompt`; `/dwf list`/`cancel` work as usual; `/dwf resume`
  does not call `resumeWorkflowRun`.
- Under `disabled`, headless `-p "/workflow ..."` errors with exit 1 and creates no app; with
  `--workflow-mode alwaysOn` it goes through the normal prompt path as before.

Headless `--target` test coverage:

- `--target` alone follows the headless `/goal ...` semantics; together with `--prompt` it errors
  at the CLI entry boundary.
- `--target-replace` allows overwriting an existing goal; `--target-replace` alone is an error.
- Both `--prompt "/goal ..."` and a standalone `--target ...` go through the same command-center
  goal semantics; `--prompt "/target ..."` stays compatible for now; when headless cannot
  interactively confirm a replace it must return a clear error, never silently drop the
  selection.

## TUI `/model` persistence

When `/model <target>` successfully switches the main model, the app/server must update both the
current runtime's model ref and the `model` main-model selection in the config file, so the model
shown in the TUI is not just in-memory state. The TUI still only calls the command center and
never reads or writes config files directly.

In the interactive TUI, typing `/model` or `/model ` in the composer opens a command-shaped model
popup above the input; the popup filters by model id, alias, name and the generated
`/model <provider/model>` command text. Rows show the model name on the left and a muted provider
name right-aligned. Up/Down moves the highlight, Enter submits the switch as an explicit
`/model <provider/model>`, Tab only completes the highlighted model into the input. Submitting
bare `/model` and `/model list` keeps the plain-text list for copying, troubleshooting and
non-popup clients.

The persistence target is chosen from the loaded config sources: prefer the project config
containing model config, then the user config containing model config. Environment variables,
CLI overrides and session injections are runtime overrides only, never `/model` persistence
targets. With no writable config source or a failed write, `/model` returns failure and the
current runtime model stays unchanged.

The config write patches only the main model selection: a string-shaped `model: "provider/model"`
stays a string; an object-shaped `model.main` is replaced while `model.lite`, `provider`, `mcp`,
`skills`, `permission` and other fields are preserved. Writes go through the config adapter for
atomic writes and cross-platform path handling, and logs never print sensitive fields such as API
keys or headers.

Test coverage:

- The config adapter patches the main model under both string and object model shapes while
  preserving other fields.
- bootstrap `setModel()` updates the runtime model only after the config write succeeds.
- TUI `/model` wiring keeps going only through app/server `setModel()`, with no new business state
  in the TUI layer.

## TUI `/effort` reasoning depth

`/effort` is a local command-center command that sends no model request. It only affects the
current session's main-model reasoning/thinking provider options, and writes the successfully
chosen level to `local_setting(model.reasoningLevel)` as a global preference for later new
sessions to reuse when the current model supports it. `/variant` is a fully equivalent input
alias; help and new docs show `/effort` as the primary command.

Available levels come from the current model's catalog/config reasoning metadata. With no
reasoning metadata, reasoning disabled, or an empty level, the command returns the local hint
"当前模型不支持 effort selection" and creates no normal turn. When the user inputs an
unsupported level, it returns the currently available list and keeps the runtime provider options
unchanged.

In the interactive TUI, typing `/effort`, `/effort `, `/variant` or `/variant ` opens a local
candidate popup in the same shape as `/model`, showing and filtering the available levels; Tab
completes the current candidate into an explicit `/effort <level>`, and Enter also submits as an
explicit `/effort <level>`. The TUI only consumes the level list exposed by the app/server; it
never parses reasoning metadata itself or stores business state. Submitting bare `/effort`,
`/variant`, `/effort list` or `/variant list` returns a plain-text list for copying,
troubleshooting and non-popup clients.

On success the app/server must update the runtime `modelProviderOptions` and return the new
`thoughtLevel` projection to the TUI/ZCode app-server. A failed global-preference write logs a
structured warning, but the current session's switched runtime state stays successful — a local
preference-storage failure must not block the user from continuing.

Test coverage:

- The slash-command parser recognizes `/effort` and `/variant` as the same command and preserves
  `rawName`.
- Typing `/effort` or `/variant` in the composer opens the local candidate popup; Tab/Enter
  selection submits an explicit `/effort <level>`.
- The command center returns a plain-text list for bare `/effort` or `/effort list`; for
  `/effort <level>` it only calls app/server `setThoughtLevel()` and sends no model prompt.
- bootstrap `setThoughtLevel()` updates the runtime provider options, returns `thoughtLevel`, and
  best-effort writes the global reasoning-level preference.
- Later new sessions read the global reasoning level when no explicit runtime provider options
  exist; if the current model does not support it, fall back to the model's default reasoning
  level.

## TUI `/locale` persistence

`/locale` is a local command-center command that sends no model request. Without an argument it
shows the current effective locale and configurable values; with `auto`, `en-US` or `zh-CN` it
calls the app/server `setLocale()` and returns the new effective locale to the TUI. The TUI only
consumes the `locale` projection from the result and re-selects the copy catalog; it never reads
or writes config files or stores business state.

The persistence target follows the UI-language config ownership: if the current project config
explicitly contains `ui.locale`, update that project config; otherwise update the user config,
creating `~/.zcode/cli/config.json` when missing. CLI `--locale` is a current-process override,
but after a successful `/locale` the TUI may override the locale used by later `/new` and
`/resume` app creation in the current process.

The write patches only `ui.locale` and must preserve `model`, `provider`, `mcp`, `skills`,
`permission` and other fields. `auto` persists the requested value; the current-process effective
locale still resolves from adapter detection, defaulting to `en-US` when no supported language is
detected. A failed write returns a clear error and keeps the current effective locale unchanged.

Test coverage:

- The slash-command parser recognizes `/locale` and `/language` as the same command.
- Executing the `/locale` query creates no model turn.
- Executing `/locale zh-CN` calls app/server `setLocale()` and returns the `locale` projection
  for the TUI to switch copy catalogs.
- The config adapter patches or creates `ui.locale` while preserving other config fields.
- bootstrap `setLocale()` updates the effective locale only after the config write succeeds.
- CLI TUI wiring makes apps created by later `/new` use the new locale override.

## TUI `/new` behavior

`/new` is the TUI session-switch command; `/clear` is its fully equivalent alias. The command
center uses the `newApp` factory provided by bootstrap/CLI to create a new app/runtime with no
`sessionId` and no `resume` flag, and sets it as the active app. The new app immediately gets a
new session id; the current persistence implementation still writes to the session store on the
session's first turn per runtime rules. The TUI keeps calling only `submitPrompt`, never touches
the session store and stores no business session state.

The response to the TUI must contain the new session id, so the user can copy it to `--resume` or
`/resume <sessionId>` after the first turn persists. The response must also ask the TUI to reset
the current session projection, so the new session panel doesn't keep showing old todos, tokens
or background-terminal state. When a session-reset result carries no `restoredMessages`, the TUI
must clear the current transcript before appending the local command confirmation; results that
do carry `restoredMessages` (like `/resume`) replace the display with the restored transcript. If
the current client provides no `newApp`, return a clear unavailability message; if app creation
fails, keep the original error chain for the TUI's existing error display.

Test coverage:

- The slash-command parser recognizes `/new` as a known command.
- The parser recognizes `/clear` as an alias of `/new` and preserves the original `rawName` for
  help and audit display.
- Executing `/new` calls no model prompt, does not run `/resume`'s latest-session resolution, and
  returns the new session id.
- Executing `/clear` reuses `/new`'s path and returns the same session-reset/session-id result.
- CLI TUI wiring sends subsequent prompts to the newly created active app after `/new`.
- The TUI transcript merge clears old messages on a session reset without `restoredMessages`, so
  a new session doesn't keep occupying the old session's display space.

## Auth Login Setup

`/login`, `/logout` and the process-level `zcode login` / `zcode logout` share the bootstrap
service of [`auth-login.md`](./auth-login.md). OAuth, browser opening, credential reads/writes
and config patching all live in the adapter/bootstrap layer; core reads no environment
variables, makes no direct network requests and writes no config files.

Saving a token reuses the desktop Z Code's `~/.zcode/v2/credentials.json` encrypted key-value
store. `~/.zcode/cli/config.json` only patches non-sensitive provider/model fields and preserves
existing `mcp`, `skills`, `permission` config; new configuration uses the provider-first shape
and does not restore the bak's flat `provider/model/baseURL/apiKey` configuration.

Test coverage:

- The slash-command parser recognizes `/login` and `/logout` as known commands.
- Executing `/login` and `/logout` creates no app and sends no model prompt.
- The process-level `zcode login` prints the authorize URL and the logged-in user through an
  injected bootstrap login service.
- The process-level `zcode logout` prints the cleanup result through an injected bootstrap logout
  service.
