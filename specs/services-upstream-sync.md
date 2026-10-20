# Services and Server Upstream Sync (3.16.1, PR 8a/8b)

Status: in progress, part of the upstream 3.16.1 sync series. Base `aac47556` (v3.15.1), target `0a1fc56d` (v3.16.1). `pendingUpstreamCommit` stays at `0a1fc56d`. Upstream `main` has moved to `3c5b2276`; it is not the target.

## Scope

- 8a (#200): upstream additive modules (`project`, `project-catalog`, `project-workspace-navigation`, `remote-projects`, `task-facts`, `task-groups` contract and repository, `bot-project-runtime`, `window-project-directory`, `source-server-workspace`, `source-server-management`, `packages/server/src/source-server`), the standalone source-server exports in `node.ts`, and the merged closure they need.
- 8b: host assembly and settings, plus the fork-hard merges listed under Deferred. Fork-hard files that have not been merged keep their HEAD version in this PR.

## Ownership

- Project membership and source-server workspace identity are owned by the Services layer (`project`, `source-server-workspace`). The Node host (`createServerHostServices`) composes them. It holds no task or session state.
- Tasks-index storage is owned by the fork barrier (`project-storage/startup.ts`, run by the desktop tasks storage worker). `migrateApplicationStorage` is the standalone-host entry to the same `TaskIndexRepo.ensureReady()`. Desktop does not call it.
- Automations and off-peak repos are fork-owned (3-way, not merged) and keep their lazy initialization.
- Fork-only settings (`memoryIndexAsContext`, `incognitoDefaults`, `worktree*`, `voiceDictation`, `resourceTelemetryEnabled`, ...) live in the fork sidecar. They are never written to `setting.json` (AGENTS.md).
- Settings HOME resolution: per call (`getSettingsFile()` reads the current environment). Upstream's per-instance `ZCODE_DESKTOP_HOME_DIR` resolution is not taken. Decided by the coordinator.

## Settings (`setting/setting.ts`, `setting/settingService.ts`)

- Taken from upstream: `WorkspaceSettingsProjection` type; `providerFamilyDomainUpdatedAt` in the `update` expected-account snapshot.
- Layered on the fork: `setWorkspaceProjection(reader)` binds one projection (second bind throws). The projection is applied to base settings before the fork sidecar is merged, so fork keys are never parsed by the projection schema.
- Connection-mapping writes bump `providerFamilyDomainUpdatedAt` under the write lock. A supplied expected version must match, otherwise the write fails with `Account connection settings changed`. The version is optional: callers without it keep the old behavior. Requiring it (upstream `CAS required`) waits for the UI/desktop PR.
- `ensureDefaultProject` stays on `ISettingService` as a compatibility member. Remove it in the final sync PR, after its fork consumers are synced.
- Tests: `test/settingServiceWorkspaceProjection.test.ts` proves fork keys survive a projected write, stay out of `setting.json`, and that the version bumps and rejects stale snapshots.

## Standalone host (`node.ts`)

- Added: `createServerHostServices`, `migrateApplicationStorage`, `createLocalServices` options `projectStorageHostId` (accepted, see Deferred) and `sourceServerWorkspaceService` (registered when provided), and `serviceAuthorityMode: "standalone-server"` (already in shared).
- Exports for the server CLI: `createServerHostServices`, `SourceServerWorkspaceAliasRepo`, `SourceServerWorkspaceIdentityChannelServer`, `SourceServerWorkspaceIdentityMapper`, `scopeConversationShareServiceForAttachment`.
- Tests: `test/serverHostServicesAssembly.test.ts` (exports resolve; an empty source-server id is rejected before storage opens).

## Single owners

- `repairSubagentTaskIndex`: the fork copy (`zcode-agent/repairSubagentTaskIndex.ts`) stays the only owner. Its behavior differs from upstream's copy: it filters by provider, includes archived sessions, and soft-deletes (`updateTaskState`). Upstream calls `removeSubagentIndexRow`, which the fork does not have. The upstream copy in `task-facts/` is deleted and removed from `task-facts/module.ts`.
- `task-groups` repository: unwired. Nothing in the live runtime imports `task-groups/repository.ts`. It becomes live with the UI sidebar PR, where the grouped view switches to this owner. Until then the fork grouped view (`taskIndexRepo` group parts, `zcodeTaskListTypes.ts`, `zcodeTaskService*`, index exports, `zcodeGroupedTaskView*` tests) stays on the fork owner and is deferred.
- `startup-storage/` and `project-storage/startup-entry.ts`: added, not wired. No consumer. The fork `project-storage/startup.ts` (`prepareTasksIndexStorage`) stays the only live barrier.

## Deferred (not in 8b yet)

Each file below keeps its fork HEAD version. A fork-wins three-way merge was tried and rejected: upstream deletions of lines the fork still uses left files syntactically broken or referring to missing members. The remaining work needs per-hunk review.

- `session/taskIndexRepo.ts`: non-group upstream hunks. The group parts are deferred to the UI sidebar PR.
- `zcode-agent/zcodeAgentService.ts`: needs `additionalDirectories`, `projectId` and `independentPlanSupport` (the fork deleted `independentPlanSupport.ts`). Also `onDynamicPluginUiToolResult`.
- `zcode-agent/zcodeTaskServiceAdapter.ts`, `zcode-agent/zcodeTaskIndexSyncer.ts`: coupled to the zcodeAgentService changes and to `moveGroupedTaskToTop`.
- `window-controller/windowController.ts`: upstream adds a method that `windowHostControllerService.ts` (fork incognito) does not implement yet.
- `oauth/oauthService.ts`: needs `repo.loadCachedSessionTokens`, `runSessionMutation`, and `onDidChangeSession`. Hand-resolved hunks exist but were not applied.
- `bots/botsService.ts`: upstream changes `BotsServiceDeps`, which the unsynced desktop `remoteWorkspaceServiceCollection.ts` consumes. Fork `/remote` is kept. The `botRemote*` deletions are not applied.
- `packages/server/src/http.ts`: fork-wins merge produced a syntax error. Left at HEAD.
- Upstream deletions not applied: `bots/botRemoteRuntimeServices.ts`, `bots/botRemoteWorkspaceBridge.ts`, `storage-startup.ts`, `tasksDatabase/startup.ts`, `zcode-agent/repairSubagentTaskIndex.ts` (fork owner kept).
- Test files deferred from 8a: `botsProjectBinding`, `credentialCacheRecovery`, `oauthSessionEvents`, `providerBuiltinRefreshFailure`, `serviceCollectionExposure`, `projectWorkspaceNavigation`, `conversationShareToolSnapshot`, `conversationShareWorkflowSnapshot`, `sourceServerWorkspaceAliasRepo` (three files: `no such table: tasks` against the DB test helper), `server/test/staticRoutePathContainment`.

## Shims

- None in the code path. `node.ts` additive exports and the `ensureDefaultProject` compatibility member are listed above and removed in the final sync PR.

## Acceptance scenarios

1. `pnpm typecheck` is green for the whole monorepo. Unsynced consumers (desktop, ui, cli) keep the APIs they use.
2. The five server-cli exports resolve from `@zcode/services/node` (test: `serverHostServicesAssembly.test.ts`).
3. Fork features survive. This PR does not change the incognito, deletion, worktree, deep-link, voice, telemetry, bots `/remote`, relay, `fork_workspace_pins`, usage-rollup or execution-worktree files. Their existing tests pass.
4. Upstream contract tests (`src/**/contract.test.ts`) run and pass.
5. Fork-only tables and columns keep the `fork_` prefix. No upstream migration definition changes.
6. Settings: fork keys survive a projected write and never reach `setting.json`; connection versions are monotonic and stale snapshots are rejected.
