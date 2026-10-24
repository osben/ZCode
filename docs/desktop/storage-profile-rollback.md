# Desktop storage profile rollback

## Decision

Roll back the Desktop storage profile isolation introduced by `2a9e692862` and adjusted by `8e3a2ded32`, and the
Local Host -> Agent CLI path override added by `59548dc60a` for that isolation.

After the rollback the historical semantics are restored:

- The default user data directory of Desktop, Host and the bundled Agent is uniformly `~/.zcode`.
- Directories such as `.zcode-dev` and `.zcode-beta` are no longer chosen by source-development, Stable or
  Preview.
- The settings page's `dataBaseDir` is still passed to the Host only through the existing
  `ZCODE_DATA_BASE_DIR`, for App data migration.
- The Host injects no `ZCODE_STORAGE_PROFILE`, `ZCODE_STORAGE_DIR` or `ZCODE_HOME` into child processes.
- User-level session, plugins, agents, commands, skills, logs and rollout keep using the existing `~/.zcode`
  data, so an upgrade does not look like lost history.
- Paths of `.zcode/*` inside a workspace are unchanged.

## Root cause

The storage profile injected the App's custom data root into the Host as the exact `ZCODE_STORAGE_DIR`, and that
environment was then inherited by CLI resource scanning and the Agent child process. The user's original
resources still sat in `~/.zcode`, so sessions, plugins, sub-agents and commands all went missing at runtime.
3.7.2 only overrode the CLI root at the Agent spawn boundary, so Host/UI and the Agent read two different
directories and the history could not be fully recovered.

The rollback implementation must also clean the imports of all deleted storage-profile modules, and make the
retained E2E path helper explicitly return `.zcode` under the isolated HOME. Restoring call sites while leaving
static references to `zcode-storage-root` makes the bundled Agent CLI fail at TypeScript build time; deleting the
E2E helper's old export while keeping its callers makes repo typecheck fail.

## Acceptance

| Case                 | Condition                                                        | Expectation                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| STORAGE-ROLLBACK-001 | Host started in any Desktop run form                             | no storage profile, exact storage root or `ZCODE_HOME` injected                                                                              |
| STORAGE-ROLLBACK-002 | the user configures a custom App `dataBaseDir`                   | App data migrates by existing logic; CLI user resources are still read from `~/.zcode`                                                       |
| STORAGE-ROLLBACK-003 | Stable/Preview/source-development access the same user resources | session, plugins, agents, commands, skills all keep using `~/.zcode`                                                                         |
| STORAGE-ROLLBACK-004 | open a workspace that contains `.zcode` config                   | project-level agents, commands, skills paths unchanged                                                                                       |
| STORAGE-ROLLBACK-005 | build the bundled Agent CLI and run repo typecheck               | adapters no longer reference the deleted storage-profile modules; the E2E helper resolves `.zcode` under the isolated HOME; both checks pass |
