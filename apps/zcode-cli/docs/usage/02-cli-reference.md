# 02 · CLI reference

## Common entry points

```sh
zcode
zcode --prompt "任务说明" --cwd /absolute/path/to/project --mode yolo --json
zcode doctor --json
zcode skills list --json
zcode commands list --json
zcode plugins list --json
zcode hooks trust status --workspace /absolute/path/to/project --json
```

With no arguments the TUI starts. `--prompt`/`-p` requires non-empty text; do not treat `-p` as a flag without a value, and do not use a bare positional argument in place of the prompt. (In the sample, "任务说明" means "task description".) `app-server` is the protocol server entry, not an ordinary Q&A command for batch tasks.

## Flags

- `--cwd <path>`: the effective working directory for this call, used for project configuration, skill discovery and session ownership.
- `--mode plan|build|edit|yolo|guarded`: set the permission mode explicitly. `--prompt` defaults to `yolo`; older builds may lack guarded.
- `--attach <path>`: add a local attachment, repeatable. Actual media support also depends on the selected model.
- `--resume <sessionId>`: resume the given session; `--continue`/`-c` resumes the most recent session of the current directory. The two are mutually exclusive.
- `--target <objective>`: set or advance the session target; mutually exclusive with `--prompt`. Use `--target-replace` to replace an existing target.
- `--disallowed-tools <names>` / `--disallowedTools <names>`: remove whole tools for this run, comma- or space-separated; not persisted. `Bash(git *)` still removes the entire `Bash`; it is not a command-matching rule.
- `--json`: output JSON where the command supports it; not every subcommand or error path returns JSON.
- `--output-format text|json|stream-json`: controls ordinary prompt output; takes precedence over `--json`.
- `--workflow-mode disabled|onDemand|alwaysOn`: in the current source used for prompt, target and TUI; default `disabled`. Older builds may reject this flag.
- `--memory-bench`: only with `--prompt`; enables automatic memory extraction and waits for extraction to finish; memory must be enabled first.
- `--browser-use=headless`: explicitly enable the CLI-managed headless browser; `--browser-executable <absolute-path>` can name the browser. The latter cannot be used alone.
- `--locale auto|en-US|zh-CN`, `--no-color`, `--verbose`: language, color and extra diagnostics.
- `--version`/`-v`: version; `-v` is not verbose.

Plugin commands also support `--scope`, `--available`, `--all`, `--keep-data` and other options; see [Plugins](10-plugins.md). `--force-mcs` is a dedicated diagnostic option for Anthropic interfaces, not a general evaluation switch.

Do not use `--print`, `--model`, `--settings`, `--max-turns`, `--allowed-tools` or `--permission-mode`, which the parser does not support. If a runtime limit is needed, enforce it in the evaluation process manager; do not invent CLI token or turn budget flags.

## JSON and streaming output

The JSON example for an ordinary prompt shows structure only; the exact fields can change with the build:

```json
{
  "sessionId": "sess_example",
  "traceId": "trace_example",
  "response": "ready",
  "eventCount": 4,
  "projection": { "status": "idle", "turnCount": 1 }
}
```

`stream-json` is NDJSON: events are output line by line, and a normal end outputs a result line with `type: "result"`. Run `JSON.parse` per line; do not treat the whole file as one JSON object. Keep the raw record of unknown event types; do not judge success by a fixed event count.

Local commands such as `--prompt "/help"` can return text early; even with `--output-format json` this does not imply the result structure of an ordinary prompt. Such calls only verify that the flags are accepted, not the full output protocol.

stdout holds business output and stderr holds diagnostics separately. Error paths may have only stderr; check the process exit status before parsing results. A process that ends successfully does not mean the task passed grading; combine tool execution, file artifacts and an independent judging result.

## Exit and cancellation

Common flag or runtime errors return exit code `1`; successful entry points usually return `0`. For signal cancellation, record the raw exit code, the signal and the timeout flag; do not normalize them to "no output". A permission denial may be handed to the model as a tool error and the run continues for another round, so tool failure cannot be detected from the process exit code alone.

For the ending semantics of resume, goal and background workflows, see [Sessions](06-sessions.md).
