# Services and Server Upstream Sync (3.16.1, PR 8a/8b)

Status: draft, part of the upstream 3.16.1 sync series. Base `aac47556` (v3.15.1), target `0a1fc56d` (v3.16.1). `pendingUpstreamCommit` stays at `0a1fc56d`; upstream `main` has moved past it and is not the target.

## Scope

- 8a: upstream additive modules (`project`, `project-catalog`, `project-workspace-navigation`, `remote-projects`, `task-facts`, `task-groups` contract, `bot-project-runtime`, `source-server-workspace`, `source-server-management`, `packages/server/src/source-server`), the standalone source-server pieces of `node.ts` (exports only), and the merged closure they need: `zcode-agent/zcodeAgentConnectionScope.ts` (without `onDynamicPluginUiToolResult`), `highspeed/highspeedCardService.ts`, `packages/server/src/remote/{remoteAssetPreflight,remoteAssetInstaller}.ts`.
- 8a leaves `setting/setting.ts` and `setting/settingService.ts` at HEAD (see Deferred).
- 8b: modifications of fork-hard files that merge upstream logic with fork features: `setting/settingService.ts`, `window-controller/windowHostControllerService.ts`, `session/taskIndexRepo.ts`, `node.ts` (`createServerHostServices`, `createLocalServices` options), `zcode-agent/{zcodeAgentService,zcodeTaskServiceAdapter,zcodeTaskIndexSyncer}.ts` (plus `onDynamicPluginUiToolResult`), `bots/botsService.ts`, `oauth/oauthService.ts`, `packages/server/src/http.ts`, and the deferred test files listed below.

## Deferred

- `setting/setting.ts`: upstream removes `ensureDefaultProject` from `ISettingService`. Fork consumers (`settingService.ts`, `settingService.test.ts`, `settingsSyncService.test.ts`, `botsService.fixtures.ts`) still use it. Kept at HEAD in 8a. Upstream `settingService.ts` also adds `WorkspaceSettingsProjection`, a projection hook (`setWorkspaceProjection`), and a `providerFamilyDomainUpdatedAt` CAS. 8b merges these on top of the fork sidecar paths (`splitForkSettingsPatch`, `readForkSettings`, `maybeSeedLegacyForkSettings`, `createSettingsWriteQueue`). The HOME resolution conflict (per-call `getSettingsFile()` in the fork vs per-instance `ZCODE_DESKTOP_HOME_DIR` upstream) must be decided explicitly in 8b.
- `createServerHostServices` (`node.ts`): needs `createLocalServices` to accept `projectStorageHostId`, `sourceServerWorkspaceService` and `serviceAuthorityMode: "standalone-server"`, plus `migrateApplicationStorage`. Moves to 8b.
- `zcodeAgentConnectionScope.ts` `onDynamicPluginUiToolResult`: needs the upstream `IZCodeAgentService` member. Moves to 8b with `zcodeAgentService.ts`.
- `startup-storage/` and `project-storage/startup-entry.ts` are added but not wired (no consumer). The fork `storage-startup.ts` and `tasksDatabase/startup.ts` stay the only live barrier.
- Tests deferred because their subject is a fork-hard or 8b file: `botsProjectBinding`, `botsService.permissionsWorkspace` (HEAD version kept), `credentialCacheRecovery`, `oauthSessionEvents`, `providerBuiltinRefreshFailure`, `serviceCollectionExposure`, `projectWorkspaceNavigation`, `serverHostServices` (and its fixture), `conversationShareToolSnapshot`, `conversationShareWorkflowSnapshot`, `sourceServerWorkspaceAliasRepo` (three files, `no such table: tasks` against the DB helper), `server/test/staticRoutePathContainment`. HEAD versions are kept for `nodeApiClient*`, `credentialService`, `oauthUnauthorizedLogout`, `terminalService`, `pluginStoreOrderConfig`, `pluginManagementService`, `zcodeAgentService.mcpTelemetry`, `conversationSharePublicProjection`, `dockerBackendDockerCommand`, `sshAuth`, `wslBackend`.
- Upstream deletions not applied: `bots/botRemoteRuntimeServices.ts`, `bots/botRemoteWorkspaceBridge.ts` (fork `/remote` feature), `storage-startup.ts`, `tasksDatabase/startup.ts`, `zcode-agent/repairSubagentTaskIndex.ts`, and the related tests.

## Ownership

- Project membership and source-server workspace identity are owned by the Services layer (`project`, `source-server-workspace`). The Node host (`createServerHostServices`) composes them; it does not hold task or session state.
- The SQLite tables for projects and source-server aliases are owned by `project-storage` and `sourceServerWorkspaceAliasRepo` (landed in PR 7a / #196). This PR does not change their schema.
- Fork-only state (incognito, `fork_workspace_pins`, bots `/remote`) is not moved into upstream modules. It keeps its current owner.

## Interfaces that must resolve from `@zcode/services/node`

| Export                                       | Source                                                                  | Consumer                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `createServerHostServices`                   | `node.ts`                                                               | `packages/zcode-server-cli` (parked sync). Moved to 8b. |
| `SourceServerWorkspaceAliasRepo`             | `session/sourceServerWorkspaceAliasRepo.ts`                             | server CLI                                              |
| `SourceServerWorkspaceIdentityChannelServer` | `source-server-workspace/sourceServerWorkspaceIdentityChannelServer.ts` | server CLI                                              |
| `SourceServerWorkspaceIdentityMapper`        | same file                                                               | `createServerHostServices`                              |
| `scopeConversationShareServiceForAttachment` | `conversation-share/conversationShareConnectionScope.ts`                | server CLI                                              |

## Shims

Every shim is listed here and in the PR body, and is removed in the final sync PR.

- `node.ts` appends additive exports only: `SourceServerWorkspaceAliasRepo`, `SourceServerWorkspaceIdentityChannelServer`, `SourceServerWorkspaceIdentityMapper`, `scopeConversationShareServiceForAttachment`. They are not shims, but 8b must keep them. `createServerHostServices` is not exported yet.
- The `IZCodeAgentService` member `onDynamicPluginUiToolResult` is deferred, not shimmed.

## Acceptance scenarios

1. `pnpm typecheck` stays green for the whole monorepo. Unsynced consumers keep the APIs they use.
2. The four 8a exports resolve from `@zcode/services/node`. `createServerHostServices` resolves after 8b.
3. Fork features survive: incognito sessions, session deletion cascade and permanent erase, worktree open and identity, deep links, voice dictation, resource telemetry, bots `/remote`, self-hosted relay, `fork_workspace_pins`, usage rollup, execution worktree. Existing fork tests keep passing.
4. Upstream contract tests (`src/**/contract.test.ts`) run and pass.
5. Fork-only tables and columns keep the `fork_` prefix. No upstream migration definition changes.
