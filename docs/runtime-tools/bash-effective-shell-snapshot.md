# Bash Effective Shell Snapshot

## Background

The Bash tool's shell selection affects three kinds of behavior:

- Which shell actually runs Bash commands.
- Which Shell the provider-visible `# Environment` shows.
- The execution environment and prompt environment inherited by Explore subtasks.

These used to be read separately from environment variables, the execution adapter and settings/runtime
config, so "the shell the model sees" and "the shell Bash actually runs" could differ. This document defines
the unified runtime contract.

## Core contract

The runtime keeps a session-level `ExecutionShellSelection`, the Bash tool's effective shell snapshot. A new
session starts uninitialized; the current candidate shell is initialized as the session-start snapshot only
just before the first user prompt is truly accepted.

- Ordinary session creation and deferred-draft warm-up do not resolve the user-configured shell selection.
- `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts` is the sole owner of the session shell environment, responsible for initialization, reading, EnvInfo patch, persistence and resume restoration.
- Before the session first accepts input, the unified user-execution boundary reads the current shell candidate once from the owning Host through the `user-execution` scope of `session/requestRuntimePreferences`, and `initializeSessionShellEnvironmentIfNeeded()` then initializes. The request waits at most 15 seconds; on timeout the first user execution is blocked with a protocol error, with no retry and no silent fallback to another shell.
- The `Shell` field of the initial `# Environment` shows only the `display.name` of this session-start snapshot.
- The Bash tool executes with the same selection.
- The Explore subtask's prompt environment and child runtime inherit the same selection.
- If the user switches shell within a session, the current session is not hot-updated; the user must create a new session for it to take effect.
- A deferred draft session is only a hidden warm-up state of a new conversation, not a stable session the user has started. Warm-up creation does not read the user-configured shell selection.
- legacy `session/send`, V4 `sendText`, create/resume/subscribe carry no shell candidate; the Host read happens only at the Agent's unified first-user-execution boundary, so desktop/mobile or individual command entries cannot each maintain a branch.
- The app layer's ordinary prompt, goal external activity, expert workflow and script workflow share the same user-execution boundary. Any entry that creates the first user-visible fact, starts a model turn or a workflow child agent must call this boundary first to initialize the shell snapshot, before persisting the session or creating the child runtime.
- The Protocol's `session/create` / `session/resume` accept no shell candidate, so callers do not mistake them as a way to override the session shell at creation or resume.
- When the session is first truly persisted, the runtime writes the creation-time shell selection into `session_entry`.
- On cold resume the core runtime reads this persisted selection first to rebuild the runtime config instead of re-reading the latest settings.
- Cold resume first checks whether the persisted selection is still usable: `legacy-shell` may have no path; the Windows `cmd.exe` fallback keeps being accepted under its original semantics; any other concrete shell path must still be an executable file. If invalid, the old path is not handed to the Bash executor, and it falls back to the current selection the resume entry has already resolved.
- A legacy session with no persisted selection, or whose persisted selection is invalid, can only be restored best-effort by the current auto-resolution logic; when the historical `# Environment` Shell differs from the current execution shell, the model must be told through a `shell_environment_change` attachment. When a Windows legacy session is taken over by the current auto Git Bash, a one-time Git Bash shell reminder is inserted even if the historical `# Environment` has no reliable Shell field, so the model does not keep using old shell habits.

## Bash Runtime `.sh` snapshots

The Bash tool runtime has three similarly named snapshots with different responsibilities:

1. session shell selection snapshot
   - Managed by `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`.
   - Decides the session's effective shell, the provider-visible `# Environment` Shell field and the shell display Explore inherits.
   - Not hot-updated by settings switches after session creation.

2. shell init snapshot
   - Managed by `apps/zcode-cli/packages/adapters/src/exec/shell-init-snapshot.ts`.
   - On POSIX/Git Bash the adapter first runs a snapshot creation script with a login shell, sources the user's rc files, and writes functions, aliases, shell options and PATH into `shell-snapshots/snapshot-${shell}-${timestamp}-${random}.sh` under ZCode storage.
   - Export policy for functions/options/aliases: exported only when the user rc exists, single-underscore completion functions filtered, options/aliases output capped at 1000 lines, and `winpty` aliases filtered under Git Bash/MSYS/Cygwin.
   - The snapshot creation script writes the file using the adapter-side host path; Git Bash path conversion happens only when a later real command sources the snapshot.
   - After successful creation, later Bash tool commands source this snapshot first and then run the real command with a non-login shell, i.e. the spawn args change from `-c -l <command>` to `-c <command>`.
   - On creation failure it degrades to the original behavior and keeps `-c -l <command>`.
   - Hot resume that still reuses the same adapter/manager can keep reusing the in-process ready snapshot.
   - Cold resume does not restore the snapshot file path; after restoring the session shell selection, the first Bash toolcall recreates the shell init snapshot.
   - Cold resume or a new adapter does not scan/revive old snapshots and does not reuse same-named files by session/hash; a new process creates a new random snapshot file, and old leftovers are handled only by retention cleanup.
   - Before every real Bash command the cached snapshot file is re-checked for accessibility; if the file is lost, this run falls back to a login shell and does not skip `-l`.
   - If the user cancels the command or closes the adapter during snapshot creation, the real model command is not spawned.
   - Snapshots created by the current process are unlinked on a best effort at `NodeExecutionAdapter.close()`; abnormal leftovers are cleaned by retention cleanup.
   - Retention cleanup by default deletes top-level `.sh` files in `shell-snapshots/` with mtime older than 30 days.
   - CMD and legacy shell neither create nor source a shell init snapshot.

3. ZCode startup script snapshot
   - Generated and materialized by `apps/zcode-cli/packages/adapters/src/exec/bash-startup-script.ts` from the execution request's `bashPrelude`; the core-side `bash-startup.ts` descriptor no longer exists.
   - This script is ZCode internal execution infrastructure, not provider-visible prompt content, and does not change the tool schema.
   - The `rg` fallback is always kept; whether `find` / `grep` map to `bfs` / `ugrep` is decided by the enhanced-search startup preference fixed when the root Session runtime materializes, enabled by default.

Execution order: source the shell init snapshot first, then the ZCode startup script, and finally run the model command and the cwd capture trailer. The snapshot file path is not persisted as session state; after cold resume the adapter lazily creates a new random snapshot based on the restored shell selection. An old file cannot be restored directly as a ready snapshot.

## Selection structure

`ExecutionShellSelection` is the only shell selection data structure across contracts, adapters, core and bootstrap.

- `dialect`: execution wrapping semantics, currently `posix`, `git-bash`, `cmd` or `legacy-shell`.
- `source`: where the selection came from, currently `auto-detected`, `user-config` or `legacy-fallback`.
- `path`: the resolved executable path. A legacy fallback may have no path.
- `display.name`: the provider-visible stable name, such as `zsh`, `bash`, `Git Bash`, `CMD`, `system shell`. Absolute paths must not be shown here.
- `id` / `label`: metadata for settings items or diagnostics display, not a provider-visible contract.

Runtime config uses only `bashShellSelection` as the source of truth. The underlying execution adapter's
command still carries this selection in the existing `shellOverride` field, but the runtime / tool context no
longer keeps a second `bashShellOverride` state.

## Resolution rules

macOS / Linux:

- Prefer an available `zsh` / `bash`.
- If `$SHELL` itself is an executable `zsh` or `bash`, it can be used directly.
- If the user uses a non-Bash-compatible shell such as `fish`, `fish` is not taken as the Bash tool shell; keep searching `PATH` and fixed paths for `zsh` / `bash`.
- When no `zsh` / `bash` is found, return `legacy-fallback`, keeping the old generic shell fallback behavior.

Windows:

- When the user explicitly selects Git Bash, that selection is used first.
- When the user explicitly selects CMD, CMD is used first.
- In auto mode Git Bash is resolved first.
- When Git Bash is not found return `legacy-fallback`, keeping the old cmd / ComSpec fallback behavior.

## Prompt and cache

`# Environment` is a session-start snapshot and is not rewritten when the user switches shell within the same
session. This avoids breaking the prompt-cache through a whole-system-context mutation.

Switching shell does not append a `shell_environment_change` attachment to an existing session. Because Bash
execution still uses the session-start selection, the initial `# Environment` the model sees stays consistent
with the real Bash execution environment.

The exception is a cold resume of a legacy/no-usable-snapshot session: such a session has no stable
session-start shell selection to restore, so the runtime can only continue with the currently resolved
selection. If on Windows auto Git Bash finally takes over, a short reminder is inserted through
`shell_environment_change` telling the model that later Bash commands currently run with Git Bash. This is
not an in-session shell hot update and does not read the user's latest settings to override an existing
usable snapshot.
