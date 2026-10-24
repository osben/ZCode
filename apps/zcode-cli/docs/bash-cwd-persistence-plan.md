# Bash Cwd Persistence

Current-state spec. Bash cwd persistence is implemented: each Bash call still spawns a new shell
process, but after a successful foreground command the adapter captures the final `pwd -P` and
writes it back to the current runtime's `workingDirectory`, so the next Bash/tool call executes
from the updated cwd.

**Behavior:** the command wrapper appends `eval <user command> && pwd -P > <cwdFile>`; after the
command finishes, the main process reads the cwd file and updates the internal shell cwd when it
changed. The next Bash call still spawns a new shell, only with the recorded cwd. No long-lived
shell child process is kept, and env/alias/function are never persisted.

**Persistence boundary:** only the current `AgentRuntime` instance's `workingDirectory` is
updated. Bash `cd` is not written back to `SessionInfo.directory/path`: `directory` still drives
session listing and `--continue` discovery filtering, and `path` drives workspace/display/fork
ownership; letting them drift with in-tool `cd` would change session discovery and workspace
ownership. `workspaceRoot` / `projectID` / persisted message `path.root` keep the stable
workspace identity from context initialization; only the execution semantics `workingDirectory`
/ message `path.cwd` may follow Bash `cd`.

## Provider-visible cwd reset

After a successful main-thread foreground Bash execution, if the final cwd leaves the session
project boundary, the runtime must reset back to the session root and append
`Shell cwd was reset to <root>` to the Bash stderr. This is not a separate `<system-reminder>`
and not a serializer-built message; it belongs to the Bash tool result's provider-visible
content. `resolvedCwd` stays an internal field and must never enter provider-visible output
directly.

## Non-goals

- No shell provider selection logic (`/bin/sh` vs bash/zsh).
- No timeout auto-background.
- No change to provider-visible `tool_result` content outside the cwd reset case.
- No cwd capture for hooks or plugin-configured commands.
- No cwd update from background Bash.
- No persistence of shell env, alias, function or shell options.
- No writing Bash `cd` back to the session store; restore/continue semantics need separate
  design and must not let workspace ownership fields drift with in-tool cwd.

## Isolation constraints

Cwd capture must stay inside Bash foreground execution and must not leak into generic shell or
generic tool behavior:

- Foreground Bash calls capture cwd by default; that is the Bash-specific semantics.
- For the generic execution adapter / generic `mode: "shell"` request,
  `captureCwdAfterSuccess` defaults to false. Only
  `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts` may set it for foreground Bash.
- Configured hooks (`packages/core/src/hooks/configured-runner.ts`) keep the original
  `mode: "shell"` path: no `captureCwdAfterSuccess`, no runtime cwd update.
- `NodeExecutionAdapter` never wraps all `mode: "shell"` commands with the cwd wrapper; only
  requests explicitly carrying `captureCwdAfterSuccess: true`.
- The cwd capture file uses the system temp directory, never the persisted output directory, so
  an unwritable output directory cannot change Bash success rates.
- `setWorkingDirectory` exists only as the Bash handler's channel for consuming
  `result.resolvedCwd`; the executor never infers cwd updates from tool output text.
- Bash `cd` updates only the current runtime's `workingDirectory`; `workspaceRoot` keeps the
  workspace boundary from context initialization so Read/Edit/Glob/Agent tools do not drift
  workspace ownership with the cwd.
- `resolvedCwd` must not be written into `BashOutput`, `formatBashModelContent`, the tool result
  serializer or history persistence; only the actual reset may expose the
  `Shell cwd was reset to <root>` copy.
- failed / timed_out / cancelled / spawn_error / backgrounded results never update cwd.
- Bash tool metadata stays `concurrentSafe: false`; if parallel Bash is ever allowed, cwd update
  ordering needs separate design.
- Windows supports cwd capture; the wrapper is chosen by the actual shell dialect
  (cmd-compatible `%ERRORLEVEL%` / `exit /b` for cmd, POSIX `$?` / `pwd -P` for Git Bash, with
  path conversion), never applying a POSIX wrapper to a cmd shell. A future explicit PowerShell
  shell would need its own wrapper.

## Caller impact

| Caller | Behavior |
| --- | --- |
| Bash foreground | Handler sets `shellProfile: "posix-bash"` and `captureCwdAfterSuccess: true`, consumes `ExecutionResult.resolvedCwd` on success. In-project cwd persists; out-of-project cwd resets to `workspaceRoot` with the reset stderr appended. |
| Bash background | Goes through `executionPort.start`; the request sets no cwd capture and the adapter's `start()` removes the capture field. No cwd update, no reset; background stdout/stderr path behavior unchanged. |
| subagent Bash | `AgentRuntime` maps `taskType: "subagent_child"` to `runtimeScope: "subagent"`. Does not consume `resolvedCwd`, does not reset, appends no provider-visible cwd copy; subagents never change cwd. |
| failed / timeout / cancelled / spawn_error Bash | The adapter returns `resolvedCwd` only when `status === "completed" && exitCode === 0`; the policy accepts only that state. No cwd update, no reset, so failed commands cannot pollute the session cwd. |
| configured hooks / plugin command hooks | Call `ExecutionPort.run({ command: { mode: "shell" } })` without `shellProfile` or `captureCwdAfterSuccess`. No capture, no runtime cwd update; hooks keep using the current runtime cwd as their execution directory. |
| generic `ExecutionPort` shell request | Contract default `captureCwdAfterSuccess: false`; `cwd-capture` only activates on explicit true with `mode: "shell"`. Non-Bash callers never persist cwd via shell mode. |
| Read/Edit/Write/Glob/Grep/Agent/Workflow | Resolve paths and permission boundaries through `context.workingDirectory` and the stable `context.workspaceRoot`. They only see the execution cwd after a successful Bash update; workspace root / project identity never drifts. |
| MCP / memory / hooks context / history persistence | Read the runtime's current `workingDirectory`; message `path.root` uses the stable `workspaceRoot`. Message `path.cwd` may reflect Bash cwd; `path.root`, project id and session discovery do not change. |
| symlink workspace | The context root may be a user-supplied symlink; cwd capture uses `pwd -P` / realpath for the physical path. The policy compares both logical and realpath-equivalent boundaries so in-project physical children are not misjudged as outside. |
| Windows shell | Foreground cwd capture uses a cmd-compatible wrapper; the cwd policy uses the current Node runtime platform and does not pass platform through `ToolExecutionContext` / executor. Windows path normalization (drive letter, extended drive prefix, Git Bash `/c/...` alias) is covered by the shared tool path normalizer, not Bash-specific code, and never infers platform from path strings. Helper unit tests may pass `win32` explicitly. |

## Acceptance criteria

- After a successful foreground Bash `cd`, later tool calls in the same runtime use the new cwd.
- failed / timeout / cancelled / background results never update cwd.
- When main foreground Bash successfully leaves the workspace boundary, the provider-visible Bash
  result appends `Shell cwd was reset to <root>`; no other cwd case adds copy.
- Hooks and configured shell commands are unaffected.
- Non-Bash tools and generic `mode: "shell"` requests keep their default behavior.
- Bash `concurrentSafe` stays `false`.
