# Upstream sync: CLI fork divergences

Status: active during the upstream 3.16.1 apps/zcode-cli sync (PRs #201 onward). Each item is a deliberate
difference from upstream 3.16.1 (`0a1fc56d`) that the fork keeps. Remove an item when the upstream design
is adopted or the final sync PR retires the compatibility member.

## Divergences kept by the fork

| Area                            | Upstream 3.16.1                                                        | Fork behavior                                                                                                                                                                                         | Where                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Idle / off-peak Bash background | Idle turns reuse the explicit and auto-on-timeout background lifecycle | Idle turns reject `run_in_background` and never auto-background. A background notification turn runs without the user's `turnExecutionModel`, so it must not run a full agent loop on the user's plan | `core/src/tool/handlers/bash.ts`; test `core/tests/bash-handler.test.ts` ("rejects explicit background Bash in idle turns") |
| Tool Search deferral of LSP     | LSP is a regular built-in                                              | The LSP tool is `shouldDefer: true` (non-resident under the upstream tool-search rule)                                                                                                                | `core/src/tool/handlers/lsp.ts`                                                                                             |
| UI locale in file config        | Unknown locale rejects the whole config file                           | Unknown locale is ignored (`.catch(undefined)`), so an older build can read a newer config (`specs/ukrainian-locale.md`)                                                                              | `adapters/src/config/schema.ts`; test `adapters/tests/config.test.ts`                                                       |
| Zhipu account fixtures          | Account mode read without a `type` tag                                 | `zhipuAccountMode` reads only `zhipu-account` access; fixtures carry the tag                                                                                                                          | `adapters/src/model/account-access-mode.ts`; test `adapters/tests/runner-options.test.ts`                                   |

## Temporary compatibility members (remove in the final sync PR)

- `UpdateSessionInput.timeArchived`, `ListSessionsInput.includeArchived`, session `time.archived` (fork archive column).
- `SchemaMigrationRow` re-export in `adapters/src/storage/session-store/rows.ts`; `ensureParentDir` in `paths.ts`.
- `trimTruncatedUtf8Tail` in `adapters/src/fs/text-metadata.ts` (fork tail trim; upstream uses `getUtf8CompletionBytes`).
- `buildEnvInfoSection` argument order: fork's `executionWorktree` third, upstream's `additionalDirectories` fourth.

## Review

Each item needs the user's confirmation. The bash idle-background rule is the only one that changes runtime
behavior versus upstream's design.
