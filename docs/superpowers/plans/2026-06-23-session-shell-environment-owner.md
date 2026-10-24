# Session Shell Environment Owner

> Historical implementation plan (2026-06-23), kept as the ownership contract. The current
> runtime contract also lives in `docs/runtime-tools/bash-effective-shell-snapshot.md`.
> This plan superseded `docs/superpowers/plans/2026-06-19-bash-effective-shell-snapshot.md`.

**Goal:** converge Bash session-start shell snapshot, provider-visible `# Environment` Shell
display, Bash executor selection, resume restore, and Explore inheritance into a single runtime
owner: `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`.

## Ownership Contract

All runtime-internal shell state read/write, `EnvInfo` shell patching, and snapshot
persist/restore go through the owner. Pre-conversation context rebuild lives in acyclic shared
helpers (`context-refresh.ts`, `context-history-entries.ts`); the owner calls the helpers and
never imports `config.ts` / `context.ts` in reverse. Bootstrap and protocol only resolve and pass
the current candidate selection; they hold no prepared/initialized state of their own.

```text
settings/current env
        |
        v
bootstrap/protocol resolves candidate selection
        |
        v
runtime.initializeSessionShellEnvironmentIfNeeded(candidate)
        |
        +--> config.bashShellSelection
        +--> EnvInfo.shell / # Environment shell
        +--> Bash tool execution context
        +--> Explore child runtime
        +--> session snapshot persist/restore
```

Owner API (in `session-shell-environment.ts`):

- `getSessionShellEnvironment(runtime): SessionShellEnvironment | undefined` — `{ selection: ExecutionShellSelection; promptShell: string }`
- `getSessionShellSelection(runtime): ExecutionShellSelection | undefined`
- `getContextSourceShellDisplayName(runtime): string | undefined`
- `initializeSessionShellEnvironmentIfNeeded(runtime, candidate): boolean` — initializes once; later candidates are ignored
- `applySessionShellEnvironment(runtime, selection, options?: { refreshPreConversationContext?: boolean }): void`
- `applySessionShellToEnvInfo(envInfo, selection): T | undefined`
- `persistSessionShellEnvironmentSnapshot(runtime, traceContext)` — wraps `persistBashShellSelectionSnapshot`
- `restoreSessionShellEnvironmentSelectionForResume(runtime, options)` — reads and resolves the persisted snapshot (`runtime:bash_shell_selection`), applies restored/fallback selection without refreshing pre-conversation context
- `announceSessionShellEnvironmentNoticeAfterResume(runtime, options)` — inserts a `shell_environment_change` drift/migration reminder, idempotent, only after `hydrateMessageHistoryFromSession` (timing matters: message history is reset during resume)

`bash-shell-snapshot.ts` is a storage codec only: persist, read, validate usability, resolve a
stale selection against a current fallback candidate. It must not mutate runtime config or message
history. `bash-shell-selection.ts` remains only as compatibility re-exports
(`setEffectiveBashShellSelection` / `getEffectiveBashShellSelection`).

## Rules

- Bash shell settings affect new sessions only; an existing session uses the session shell
  snapshot taken at its creation.
- Deferred-draft prewarm must not read the user shell setting; the candidate selection is read
  once before the first real user execution boundary.
- The Bash executor shell and the provider-visible `# Environment` `Shell` come from the same
  session shell environment.
- Resume prefers the persisted session shell snapshot. When the snapshot is stale or missing, use
  the current candidate as fallback and announce drift through the provider-visible reminder.
- macOS/Linux resolution: prefer zsh/bash; fish and other non-Bash-compatible shells are not used
  as the Bash tool shell; resolution failure falls back to legacy behavior.
- Windows resolution: explicit user choice wins; `auto` prefers Git Bash; otherwise legacy
  cmd/ComSpec fallback.
- Provider-visible text never shows absolute shell paths — only `display.name`.
- `runtime.bashShellOverride` is not a state source. Only `bashShellSelection` exists on the
  runtime; the low-level `ExecutionCommand.shellOverride` adapter boundary remains.
- Explore child runtimes inherit the parent session shell environment for both prompt shell and
  Bash execution (child config passes only `bashShellSelection` and patched `envInfo.shell`).
- `/goal`, expert workflow, script workflow, and deferred drafts all go through the same user
  execution boundary before the first persisted or executed state.
- No import cycle: `config.ts -> session-shell-environment.ts -> context-refresh.ts ->
  context-history-entries.ts`; nothing imports back into `config.ts` or `context.ts`.

## Acceptance Criteria

- New session: shell selection is undefined until the first real user execution boundary.
- First send: the current setting candidate initializes the session shell environment once; later
  sends with a different candidate are ignored.
- Bash tool execution and `# Environment` Shell use the same `ExecutionShellSelection.display.name`.
- Deferred draft prewarm does not freeze the shell setting; the first send does.
- Resume with a valid snapshot uses the persisted shell and inserts no drift reminder.
- Resume with a stale snapshot does not pass the stale path to the executor; it falls back to the
  current candidate and inserts a drift reminder when the historical Shell differs.
- Legacy resume without a snapshot uses the current candidate and inserts a drift reminder only
  when the historical Shell differs.
- Explore child runtime inherits the parent session shell environment.
- No runtime state path treats `bashShellOverride` as a second source of truth.
