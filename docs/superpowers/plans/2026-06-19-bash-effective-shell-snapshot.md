# Bash Effective Shell Snapshot Implementation Plan

> Superseded by `docs/superpowers/plans/2026-06-23-session-shell-environment-owner.md`, which
> centralizes shell lifecycle ownership in `session-shell-environment.ts`.
> The plan shipped; current semantics are specified in `docs/runtime-tools/bash-effective-shell-snapshot.md`.

**Goal:** Unify Bash tool shell resolution, provider-visible environment text, Explore subagent
execution, and mid-conversation shell-change notifications around one effective Bash shell snapshot.

**Architecture:** A session-scoped effective Bash shell descriptor (`ExecutionShellSelection`) is
resolved once at session create/resume and consumed by context assembly, Bash execution, and Explore
subagents. Runtime shell changes update the execution descriptor immediately and append a
provider-visible mid-conversation system notice instead of rewriting the initial `# Environment`
system context.

## Invariants

- Session-start `EnvInfo.shell` is the effective Bash shell snapshot at session create/resume time;
  it is derived from the effective descriptor, not raw `SHELL`/`ComSpec` detection.
- Active-session shell changes never rewrite historical `# Environment` messages and never call a
  context refresh; they are provider-visible through one `shell_environment_change` mid-conversation
  system attachment per distinct effective shell change (deduplicated by source, dialect,
  `display.name`, and path).
- Bash execution, `EnvInfo.shell`, the Explore prompt, and the Explore child runtime consume the
  same effective shell descriptor.
- Bash tool execution keeps bash/zsh/Git Bash/CMD semantics, not raw `$SHELL` echo semantics.
- When no preferred shell is found, the existing generic shell fallback stays available; the
  refactor must not turn a previously executable environment into an immediate spawn error.
- Absolute shell paths stay out of provider-visible text; `display.name` carries only stable names
  (`"bash"`, `"zsh"`, `"Git Bash"`, `"CMD"`, `"system shell"`).
- Resume preserves chronological truth: the initial shell snapshot stays initial, later shell
  changes stay later notices.

## Acceptance criteria

- Bash execution consumes the same descriptor announced to the model; Explore prompt and Explore
  child Bash execution consume the parent descriptor.
- `shellOverride` on `ExecutionCommand` is runtime-provided and only honored when
  `shellProfile === "posix-bash"`; generic shell execution ignores it.
- Resolver selection precedence: explicit user `git-bash`/`cmd` config (`source: "user-config"`),
  then auto-detected Git Bash / POSIX bash/zsh (`source: "auto-detected"`), then
  `source: "legacy-fallback"` with `dialect: "legacy-shell"` and `display.name: "system shell"`.
- Windows candidate detection (Task 9) was deliberately deferred: extra per-user install paths
  (for example `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`) are added only when release feedback
  confirms the missed path, and explicit selection still wins over every auto candidate.
