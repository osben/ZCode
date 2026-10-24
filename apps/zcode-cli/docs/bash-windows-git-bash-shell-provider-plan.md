# Windows Shell Provider

Current-state spec for the Windows side of the Bash shell provider. Both stages shipped: Git Bash
auto-resolution with an internal shell injection point, and the user-configurable "Integrated
terminal shell" setting. `Bash` stays a provider-visible tool and `ExecutionPort` stays the only
process boundary; shell selection happens only on the internal
`command.shellProfile === "posix-bash"` execution path.

## Shell resolution priority

1. A `shellOverride` with `source === "user-config"`, a still-executable path and a supported
   Windows dialect wins.
2. Otherwise auto-detect Git Bash:
   - `C:\Program Files\Git\bin\bash.exe`
   - `C:\Program Files (x86)\Git\bin\bash.exe`
   - `git.exe` found in PATH, inferring `..\..\bin\bash.exe`
3. Otherwise fall back to `ComSpec ?? "cmd.exe"`.

There is no Windows startup gate: missing Git Bash is a fallback condition, not a startup
failure, and ZCode never requires Git Bash, MSYS2, Cygwin or WSL to run the built-in `Bash` tool.
No environment variable selects the shell; explicit selection only enters through the internal
`shellOverride`. The generic `ExecutionPort` shell mode on Windows keeps using
`ComSpec` / `cmd.exe` and ignores `shellOverride`; argv-mode `.cmd` / `.bat` / `.exe` resolution
is unchanged.

## Path conversion

Windows and Git Bash paths convert in both directions:

- Windows -> Git Bash: `C:\repo` or `C:/repo` -> `/c/repo`; UNC `\\server\share` ->
  `//server/share`; otherwise replace backslashes with slashes.
- Git Bash -> Windows: `//server/share` -> `\\server\share`; `/cygdrive/c/repo` -> `C:\repo`;
  `/c/repo` -> `C:\repo`; otherwise replace slashes with backslashes.

## Provider shape

The Git Bash provider is not a bare shell path:

- `type: "bash"`, `shellPath`, `detached: true`.
- `buildExecCommand(command, options)`: builds the POSIX shell wrapper, optionally sources the
  shell snapshot, disables `extglob` / zsh extended glob, executes the user command via
  `eval <quoted command>`, writes `pwd -P` to the cwd capture file, and converts temp/cwd file
  paths to Git Bash paths before embedding them in the shell script on Windows.
- `getSpawnArgs(commandString)`: `["-c", "-l", commandString]` without a snapshot; skips `-l`
  with a snapshot.
- Spawn env contains `SHELL=<shellPath>` and `GIT_EDITOR=true`; env key handling reuses the
  existing case-insensitive Windows semantics.
- Spawn `cwd` stays a Windows host path; Node accepts it for Git Bash.
- cwd capture is dialect-aware: `cmd` uses the `%ERRORLEVEL%` / `exit /b` wrapper, POSIX dialects
  use `$?` / `pwd -P`; Git Bash readback paths are converted back to Windows paths before
  `statSync`. The provider is resolved once per execution — the cwd wrapper must not re-run the
  resolver and observe a different override/auto-detection result.
- Result content (artifact/log paths) stays Windows host paths; the model never sees `/c/...`.
- Output decoding keeps the existing Windows decoder; Git Bash output is usually UTF-8.
- Background Bash does no cwd capture but still resolves the shell.

## Provider-visible boundary

- The provider-visible `Bash` tool name never changes; on Windows the model still sees `Bash`
  even when Git Bash executes internally.
- The shell provider only affects the executor, not tool exposure or tool description branches.
- If ZCode later adds a provider-visible `PowerShell` tool, the main prompt's shell tool wording
  must be re-evaluated; that is outside this design.

## User setting: integrated terminal shell

- UI label: `集成终端Shell` (zh-CN) / "Integrated terminal shell" (en-US); first option
  `自动选择` / "Auto".
- Shown on Windows only, based on host `systemService.info().platform === "win32"`, never the
  browser platform (mobile Web remote controls a Windows host through the host service).
- Selection shape (`IntegratedTerminalShellSelection`): `{ mode: "auto" }` or
  `{ mode: "shell", dialect: "cmd" | "git-bash", id, label, path }`. The enumeration service
  (`listIntegratedTerminalShells()`) lists CMD and detectable Git Bash on Windows and returns an
  empty list elsewhere. The first version supports only `cmd` and `git-bash` as Bash execution
  dialects.
- A user-selected shell maps to the Phase-1 `shellOverride` at highest priority. `自动选择`
  (or absent) clears the override and falls back to auto-detection, then `cmd.exe`.
- Settings persist through the AppSettings schema and settingService normalization
  (`integratedTerminalShell`; `auto` normalizes back to `undefined`).
- Protocol mapping: `session/create`, `session/resume` and `session/send` carry
  `integratedTerminalShell`; the host reads it from `settingService` per request, sends
  `{ mode: "auto" }` when unset to clear an existing runtime override, and strips the field for
  old strict-schema clients before retrying. Bootstrap maps the selection to
  `ExecutionShellOverride` and injects/updates the runtime config field `bashShellOverride`;
  existing sessions get `updateConfig` on resume/send. Core never depends on `AppSettings` or
  UI/service types: `AgentRuntime` injects `getBashShellOverride` into the tool executor, and
  `bash.ts` only consumes `context.bashShellOverride` when building the command. UI logic never
  enters the adapter.
- Desktop local and Web remote both work through the same host setting/system service chain; no
  separate agent runtime is created for settings changes.

## Explicit non-goals

- No WSL as a local Bash fallback. Git Bash is a Windows process sharing the Windows filesystem
  view, so it fits the existing local `ExecutionPort`. WSL is a separate Linux runtime and
  filesystem boundary (`C:\repo` vs `/mnt/c/repo` vs `/home/user/repo` vs `\\wsl$\...`): using
  `wsl.exe -- bash -lc ...` as a shell fallback would let provider-visible Bash appear to succeed
  while commands silently run in another filesystem and process environment. Design WSL as a
  remote/workspace adapter (like SSH remote workspaces), never as local Windows `Bash`.
- No provider-visible `PowerShell` tool; supporting PowerShell needs a separate tool or runtime
  semantics.
- No running local Windows workspaces through `wsl.exe`.
- No changes to generic `mode: "shell"` calls without `shellProfile`, to argv-mode
  `.cmd` / `.bat` / `.exe` resolution, to Bash permission policy, or to provider-visible Bash
  result content.

## Acceptance criteria

### Shell resolution

- On Windows with Git Bash installed, `Bash` runs Bash syntax: arrays, process substitution,
  `[[ ... ]]`, `pwd -P`.
- Without Git Bash, `Bash` still uses `ComSpec ?? "cmd.exe"` and shell resolution never errors.
- A valid injected `shellOverride` outranks auto-detection; a stale override path falls back to
  auto-detection and then cmd.
- Foreground cwd persistence works under both Git Bash and the cmd fallback; failed foreground
  commands do not persist cwd; background Bash captures no cwd and keeps writing stdout/stderr
  logs.
- UNC paths survive conversion; no shell path environment variable or Windows startup gate is
  added; WSL is never used as a local Bash fallback.

### Settings

- The Windows settings page shows the dropdown with `自动选择` plus recognized local shells; it
  is hidden on other platforms.
- Selecting Git Bash makes Bash execution requests carry `shellOverride` and use that shell;
  selecting `自动选择` drops the override and returns to auto-detection.
- Settings persist through the AppSettings schema and settingService normalization, with zh-CN /
  en-US copy.
- Desktop local and mobile Web remote keep working through the same host setting/system service
  chain; the provider-visible `Bash` tool name and result shape never change, and selecting CMD
  never fails process startup.
