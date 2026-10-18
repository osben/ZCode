# Incognito session runtime

Product rules, protocol and UI live in the root `specs/incognito-session.md`. This document owns the CLI side: where the frozen profile enters the runtime and the single override point for each capability.

## Profile source

- `AgentRuntimeConfig.incognito?: IncognitoProfile` (`@zcode/shared`). Absent means a normal session; every code path below is a no-op without it, so normal sessions are byte-identical.
- A capability is off when `incognitoExcludes(config.incognito, key)` is true (profile present and the key is `false`).
- Set by `createRecord` from `session/create` params (v4 `createSession` → handler pick list → v4 bridge → legacy params). Cold resume passes the persisted `SessionInfo.incognito` into `materializeSessionRecord`, because plugins, MCP, hooks, agents, output style and prompt overrides are composed in `createZCodeApp` before core `resume` runs.
- The CLI's own resume paths (TUI `--resume`/`--continue` and headless `-p --resume`) resolve the target through `resolveResumeSession`, which returns the persisted `SessionInfo.incognito` alongside the id; the app factory receives it in `runtimeConfig.incognito` before `createZCodeApp` composes capabilities. A profiled session resumed in the CLI therefore keeps its frozen capabilities instead of running fail-open as a normal session.
- A v4 prepared-worktree activation (`createSession` with `preparedSessionId`) carries the profile on the activation request. The bridge compares it with the row's stored profile (`getSession(...).incognito`) before reuse: a mismatch — including an absent profile on an incognito row, or a profile on a normal row — is rejected, and materialization uses the stored profile when one exists. The prepare step (`worktreePreparation`) cannot carry `incognito` at all (see the root spec's Protocol section).
- Persisted by `ensureSessionPersisted` (first send) through `CreateSessionInput.incognito` into `session.fork_incognito` (set once, see `local-setting-migrations.md`). Sessions created with `importedHistory` persist through `persistImportedSessionHistory` instead: the import write carries the profile, because the `app.resume()` that follows marks the runtime persisted and first-send persistence never runs.
- Never read from Settings or Host runtime preferences.

## Override points

Bootstrap owns composition; core reads `incognito` only for the instructions and skills-listing gates, persistence, inheritance and dream.

| Capability              | Owner                                                                                                              | Off means                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `plugins`               | `resolveStartupPlugins` (bootstrap)                                                                                | Empty plugin outcome: no plugin skills, hooks, MCP (incl. `node_repl`), LSP, agents, features.         |
| `mcp`                   | `resolveAppRuntimeConfig` MCP merge                                                                                | User/project/protocol MCP servers dropped; plugin servers follow `plugins`.                            |
| `hooks`                 | `resolveAppRuntimeConfig` (`hooks: undefined`) + `createZCodeApp` (no workspace hook snapshot)                     | No configured, plugin or workspace hooks, no workspace hook trust review; internal mailbox hooks stay. |
| `customAgents`          | `createZCodeApp` (built-in fallback snapshot, no per-turn Host read) + `resolveAppRuntimeConfig` (inline profiles, `builtInModelSelectionOverrides`) | Built-in agents only, on their default models: user/project-configured model overrides for `Explore`/`general-purpose` are dropped with the profiles. |
| `memory`                | `resolveAppRuntimeConfig` memory block                                                                             | `memory.enabled = false`: no memory root, recall, extraction, `/dream`, agent persistent memory.       |
| `outputStyle`           | `createZCodeApp` (disk load skipped) + `resolveAppRuntimeConfig` (value dropped)                                   | No output-style section or reminders.                                                                  |
| `systemPromptOverrides` | `createZCodeApp` (disk load skipped) + `resolveAppRuntimeConfig` (value dropped)                                   | Built-in section texts.                                                                                |
| `projectInstructions`   | `ensureContextInitialized` (core)                                                                                  | No user or project `AGENTS.md` in the context snapshot (subagents inherit the snapshot).               |
| `skills`                | `createContextBuilderFromSnapshot` (core)                                                                          | No skills listing block; skill discovery, catalog and the Skill tool stay.                             |

## Inheritance

- Fork, stable fork and side chat: `buildForkedSessionInput` copies the parent row's profile; `registerForkedSession` passes it into `materializeSessionRecord`.
- Task-tool subagents: the explicit child config list carries `incognito`.
- Workflow children spread the parent runtime config, so they inherit it.

## Dream

`selectProjectDreamSessions` skips sessions whose profile has `memory: false`, so another session's `/dream` never reads an incognito transcript.

## Capability

`runtime/capabilities` returns `incognitoSession: true` only once all of the above is in place.

## Limitation

The CLI TUI cannot create incognito sessions. Resuming one (TUI or headless) re-applies the persisted profile: `resolveResumeSession` reads `SessionInfo.incognito` and the app factory forwards it into `createZCodeApp`'s `runtimeConfig`, so an incognito session created in Desktop and resumed in the CLI keeps every frozen capability instead of running fail-open with plugins, MCP, hooks, `AGENTS.md` and memory extraction.
