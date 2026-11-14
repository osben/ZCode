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

The runtime keeps a runtime-level `ExecutionShellSelection` (`config.bashShellSelection`), the Bash tool's effective shell. The selection is not persisted: new sessions and cold resume both read the user's current shell setting, and like other environment fields a change is announced to the model through the environment notice.

- Ordinary session creation and deferred-draft warm-up do not resolve the user-configured shell selection.
- `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts` is the sole owner of the session shell environment, responsible for initialization, reading and the EnvInfo patch before the first send.
- Before a new session first accepts input, the unified user-execution boundary reads the current shell candidate once from the owning Host through the `user-execution` scope of `session/requestRuntimePreferences`, and `initializeSessionShellEnvironmentIfNeeded()` then initializes. The request waits at most 15 seconds; on timeout the first user execution is blocked with a protocol error, with no retry and no silent fallback to another shell.
- Cold resume works like a new session: the resume entry initializes the selection with the same read before restoring history, and does not use the shell of the session's creation.
- Bash tool execution, the `Shell` field (`display.name`) of the `# Environment` notice, the Explore subtask's prompt environment and the child runtime all use the same selection.
- No hot update while the runtime is alive: if the user switches the shell setting inside one runtime, the current session keeps the already initialized selection; new sessions use the new value at once, and existing sessions use it at their next cold resume.
- A deferred draft session is only a hidden warm-up state of a new conversation, not a stable session the user has started. Warm-up creation does not read the user-configured shell selection.
- legacy `session/send`, V4 `sendText`, create/resume/subscribe carry no shell candidate; the Host read happens only at the Agent's unified user-execution boundary and the resume entry, so desktop/mobile or individual command entries cannot each maintain a branch.
- The app layer's ordinary prompt, goal external activity, expert workflow and script workflow share the same user-execution boundary. Any entry that starts a model turn or a workflow child agent must call this boundary first to initialize the shell, before starting the turn or creating the child runtime.
- The Protocol's `session/create` / `session/resume` accept no shell candidate, so callers do not mistake them as a way to override the session shell at creation or resume.
- A `runtime/bash_shell_selection` session entry written by an older version is no longer read and is not migrated.

## Bash Runtime `.sh` snapshots

The Bash tool runtime has three similarly named snapshots with different responsibilities:

1. session shell selection
   - Managed by `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`.
   - Decides the current runtime's effective shell, the provider-visible `# Environment` Shell field and the shell display Explore inherits.
   - Not hot-updated by settings switches while the runtime is alive; it is not an `.sh` file and is not persisted.

2. shell init snapshot
   - Managed by `apps/zcode-cli/packages/adapters/src/exec/shell-init-snapshot.ts`.
   - On POSIX/Git Bash the adapter first runs a snapshot creation script with a login shell, sources the user's rc files, and writes functions, aliases, shell options and PATH into `shell-snapshots/snapshot-${shell}-${timestamp}-${random}.sh` under ZCode storage.
   - Export policy for functions/options/aliases: exported only when the user rc exists, single-underscore completion functions filtered, options/aliases output capped at 1000 lines, and `winpty` aliases filtered under Git Bash/MSYS/Cygwin.
   - The snapshot creation script writes the file using the adapter-side host path; Git Bash path conversion happens only when a later real command sources the snapshot.
   - After successful creation, later Bash tool commands source this snapshot first and then run the real command with a non-login shell, i.e. the spawn args change from `-c -l <command>` to `-c <command>`.
   - On creation failure it degrades to the original behavior and keeps `-c -l <command>`.
   - Hot resume that still reuses the same adapter/manager can keep reusing the in-process ready snapshot.
   - Cold resume does not restore the snapshot file path; after the current shell selection is initialized, the first Bash toolcall recreates the shell init snapshot.
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

Execution order: source the shell init snapshot first, then the ZCode startup script, and finally run the model command and the cwd capture trailer. The snapshot file path is not persisted as session state; after cold resume the adapter lazily creates a new random snapshot based on the current shell selection. An old file cannot be restored directly as a ready snapshot.

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

The model learns the current shell only through the environment notice; there is no separate shell reminder. Notice rules are in `apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`; the shell-related part:

- Every request compares the `display.name` of the current selection with the Shell of the latest environment notice in history.
- The first notice is the full `# Environment`, with the current selection as Shell.
- Afterwards, when the shell differs (usually a cold resume read a new setting), an ` - Shell: <new> (was <old>)` line is appended under `# Environment update`; when the latest notice's Shell is empty (an old Windows session) no `(was ...)` is written.
- The notice is written to the store with the request and restored in place by hydration on cold resume, so it is compared only with the latest notice: with an unchanged setting nothing is appended again, and A -> B -> A announces every change. The history prefix already sent stays unchanged across cold resumes.
- System and tool definitions carry no shell, so switching shell does not rewrite the prefix already sent.
- The environment notice is an input attachment and obeys the same skip rule: if the first turn after a cold resume is a new-turn notice (`task_notification` / `subagent_reply`), the first request collects no input attachments, and a shell change is announced only in the next request after the tool result. In that one request the model may still write commands for the old shell while Bash already ran with the new one. The same holds for cwd and other environment fields, and shell gets no separate exception.
- When an old Host returns `-32601`, or the Agent is not yet connected to a Host and gets `-32020`, the CLI keeps its automatic resolution; other protocol, resolver or transport errors fail as they are. Cold resume follows the same rule: in these two cases the shell the user chose (such as CMD) does not take effect and the automatic result is used, and the change is likewise announced to the model through the environment notice.
