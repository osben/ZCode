# Bash Shell Provider (current implementation)

Updated: 2026-07-15. This file records current behavior, not a pending plan. The Bash execution
work has shipped and has since expanded to Windows, session shell snapshots, startup sources and
the embedded search prelude.

## Current contract

The Bash tool creates:

```ts
command: {
  mode: "shell",
  command: input.command,
  shellProfile: "posix-bash",
}
```

`shellProfile` is an internal execution-port profile: only the Bash tool sets it; generic shell,
hooks and configured runners must not inherit it. The adapter resolves a real shell for this
profile and spawns directly with `shell: false` where possible; when it cannot resolve one it
returns an explicit `legacy-shell` selection and degrades to the legacy system shell.

## Shell selection

```text
session persisted selection (when valid)
  -> user-config selection (new sessions only)
  -> platform auto-detect
  -> legacy system shell fallback
```

POSIX:

- Prefer `$SHELL` when it is bash/zsh and executable.
- Otherwise search bash/zsh in PATH and `/bin`, `/usr/bin`, `/usr/local/bin`,
  `/opt/homebrew/bin`, following the user shell preference.
- The provider sets `SHELL=<resolved path>` and `GIT_EDITOR=true`, and spawns that binary
  directly.

Windows:

- An explicit user selection may be Git Bash or CMD.
- Without an explicit selection, look up the default Program Files Git Bash, then infer it from
  the `git.exe` location.
- Git Bash uses `dialect=git-bash`, `shell=false`; CMD uses `dialect=cmd` and the cmd shell.
- With no usable selection, fall back to the legacy system shell.

The provider injects only the generic variables listed above plus ZCode-named variables; it does
not introduce environment variables named for other products.

## Session snapshot

The shell is session-start configuration, not a global setting re-read per Bash call:

- `bashShellSelection` is initialized before the first real user execution; a deferred draft may
  refresh the Environment context before that first run.
- The selection is saved as session entry `runtime:bash_shell_selection`.
- Cold resume prefers the persisted selection; when the path is stale it records staleness and
  falls back to the currently available selection.
- Shell setting changes only affect new sessions; existing sessions keep the selection from
  their creation time.
- An old Windows session with no usable snapshot whose shell changed at resume gets a
  provider-visible `shell_environment_change` insert, so the model does not keep assuming the
  old shell syntax.

workspace path/identity does not participate in shell identity; actual executable availability is
judged by the Agent runtime environment. Remote sessions therefore use the remote machine's
shell, not the desktop host's `$SHELL`.

## Startup source and embedded search

`bash-startup-script.ts` applies only to the `posix-bash` profile:

- Materializes a 0600 source script in the session `bash-startup/` directory under ZCode storage.
- Converts Git Bash paths to its readable form.
- Optional leading sources and the embedded search prelude are sourced in order as
  `. <quoted path>`.
- CMD/legacy dialects do not inject POSIX sources.
- The script file name contains a content hash; identical content is reused.

This chain puts bundled search preludes such as bfs/ugrep into the real Bash environment. It does
not change the model-visible command, nor turn generic execution into Bash.

## cwd persistence

Foreground Bash `captureCwdAfterSuccess` remains implemented by the execution adapter's cwd
capture plan:

```text
prepare command
  -> apply startup sources
  -> wrap cwd capture
  -> resolve shell provider
  -> spawn
  -> on exit 0 read resolvedCwd
  -> runtime.setWorkingDirectory
```

Background Bash clears cwd capture at start and does not update the session cwd. The shell
provider must not build a second cwd file or move cwd persistence into the core handler.

## Code and tests

- `packages/contracts/src/interfaces/execution.port.ts`
- `packages/core/src/tool/handlers/bash.ts`
- `packages/core/src/runtime/methods/session-shell-environment.ts`
- `packages/core/src/runtime/methods/bash-shell-snapshot.ts`
- `packages/adapters/src/exec/bash-shell-provider.ts`
- `packages/adapters/src/exec/bash-startup-script.ts`
- `packages/adapters/src/exec/cwd-capture.ts`
- `packages/adapters/tests/exec.test.ts`
- `packages/adapters/tests/bash-startup-script.test.ts`
- `packages/core/tests/bash-handler.test.ts`

Tests cover POSIX bash/zsh syntax, Windows Git Bash/CMD, fixed directories and PATH fallback,
legacy fallback, env overlay, cwd capture, background behavior, startup sources, snapshot
restore/stale fallback, and generic shell not reading the Bash profile.

## Boundaries

- The shell provider does not promise full interactive rc/profile behavior; startup arguments and
  source policy are defined by the adapter tests.
- A persisted executable may be stale on resume; degrade and leave a notice. Never block session
  recovery to preserve a historical shell.
- The Bash tool's provider-visible behavior contract is
  `apps/zcode-cli/docs/design/v2/tool/04-bash.md`; this file only describes selection/execution
  architecture.
