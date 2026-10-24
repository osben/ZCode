# Bots: adopt project identity `[hostId, projectId]` with persisted-state migration

Related: `specs/bot-remote-command.md` (`/remote`), `specs/upstream-sync-final-ledger.md` (`## bots`).
Full history: `git show 4fc3816c5a414e0d02ba22f5a2d6823f06718680:specs/bots-project-identity-migration.md`

## 1. Problem

The fork's bot workspace identity was the remote workspace identity string
`remote:server:<owner>:<path>` (or an `ssh://…` authority form) plus `workspacePath`. Upstream 3.16.1
moved bot workspaces to the project catalog: a candidate id is `projectSelectionId([hostId, projectId])`,
and the context carries `projectId`, `hostId`, `additionalDirectories`. Upstream tests are not edited
to match the fork; the fork moves.

## 2. Owners

| Concern                                              | Single owner                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project catalog (candidates, roots, hosts)           | `project-catalog` (`readProjectCatalog(deps)`), fed by `projectService` and `remoteProjectService`                                                            |
| Project execution snapshot (`additionalDirectories`) | `projectService.prepareSession`, called only by `bindProject`                                                                                                 |
| Bot context and bot config persistence               | `BotsRepo` (`bots/repo.ts`), always via `updateContext` / `writeConfig` under the file lock                                                                   |
| Legacy identity -> project mapping                   | `upgradeLegacyContext` (single mapper, used by lazy upgrade and by the startup migration)                                                                     |
| Remote identity string build/parse                   | `@zcode/shared` `remote-workspace-identity.ts` only (`buildRemoteHostWorkspaceIdentity`, `remoteHostIdFromWorkspaceIdentity`, `parseRemoteWorkspaceIdentity`) |
| `/remote` link minting                               | Desktop main (unchanged); bot process only sends the bridge request                                                                                           |

## 3. Id mapping (lossless, no string guessing)

- Legacy identity `I = remote:server:<owner>:<path>` (or any authority form) splits as
  `hostId = remoteHostIdFromWorkspaceIdentity(I)` and `path = parseRemoteWorkspaceIdentity(I).workspacePath`.
  The round trip `buildRemoteHostWorkspaceIdentity(hostId, path) === I` must hold; otherwise the key is unmappable.
- Local (no identity): `hostId = ownerHostId ?? "local"`, legacy id is the bare path.
- New candidate id: `projectSelectionId(project)`, a JSON array string `[hostId, projectId]`.
- The fork `/remote` bridge still receives `workspacePath` and `workspaceIdentity`. For a project on
  a remote Host, `workspaceIdentity = buildRemoteHostWorkspaceIdentity(hostId, primaryRootPath)` is
  derived from `hostId`, never hand-written in business code.

## 4. Migration algorithm (persisted state)

Files (all under the app config dir, all v3 schema, unchanged shape):
`bot-config.v3.json` (`bots[].allowedWorkspaces`), `bot-state.v3.json` (`bots[key]`: `workspaceId`,
`workspaceIdentity`, `workspacePath`, `hostId`, `projectId`, `additionalDirectories`).

Trigger: `botsService.ensureBotStorageMigrated` (before any bot read), once per process after the v3
files exist. A failure is logged and never blocks bot reads; unmigrated entries keep their legacy
form and are retried on the next start and by the lazy path. The migration is not inside
`repo.readState`, because the project catalog is not available there.

Steps (`botsService.migratePersistedBotProjectIdentities`):

1. Plan the config: map each `allowedWorkspaces` key with `normalizeBotWorkspaceIdentities` +
   `normalizeConfiguredAllowedWorkspaces`, which use the upstream `resolveCanonicalWorkspaceId` rule.
   A remote key maps only to the single candidate whose `workspaceIdentity` equals it. Zero or
   several candidates keep the key verbatim (unmappable).
2. Plan the state: for each entry without `hostId`, call `upgradeLegacyContext`. Only an entry that
   gets a unique `projectId` is written; an unmatched entry is left unchanged.
3. Backup, once, before the first write: `BotsRepo.backupBeforeProjectIdentityMigration()` copies
   `bot-config.v3.json` and `bot-state.v3.json` to `bot-config.v3.pre-project-identity.json` and
   `bot-state.v3.pre-project-identity.json` with `COPYFILE_EXCL`, each under its file lock. An
   existing backup is never overwritten. No backup is written when nothing changes.
4. Write: the config through `writeBotConfig`; the contexts through `repo.updateContext` (a context
   that already has `hostId` is left alone).
5. Idempotent: a value already in `[hostId, projectId]` form, or a context that already has `hostId`,
   is skipped. A second run writes nothing and leaves the files byte-identical.
6. Known semantics: the upstream lazy upgrade (`readContext`) can still record `hostId` on an
   unmatched remote context with `projectId: null`, and keeps its legacy `workspaceId`. Such a
   context resolves no candidate, so it authorizes nothing new. The migration itself never writes an
   unmatched context.

No new state version key is added. The schema shape does not change, so the upstream build (same v3
reader) keeps reading the file. Any fork-only marker lives in a `fork_`-prefixed sidecar file, never
in `setting.json`; none is needed because the migration is idempotent per entry.

## 5. No widening

- Only an exact `(hostId, rootPath)` match against an existing catalog project is mapped. No project
  is created.
- Multiple matches (same cwd in several projects) leave the key unmapped; upstream rule "same cwd in
  multiple projects does not widen permission".
- `additionalDirectories` are never copied into a migrated context. They come only from `bindProject`
  (`prepareSession`), which runs on a user action.
- An unmappable key is kept verbatim. It matches no new candidate, so it authorizes nothing new. The
  bot loses access to that workspace until it is re-bound. This is a deliberate loss, not a widening.

## 6. Rollback

- Restore `bot-config.v3.json` and `bot-state.v3.json` from the `*.pre-project-identity.json` copies.
- A fork build that reads the migrated file sees `[hostId, projectId]` keys it does not know, so it
  degrades to unauthorized for those bots. Restoring the copies is the only supported downgrade.

## 7. `/remote` flow

```mermaid
sequenceDiagram
  participant Chat as Bot chat
  participant Bot as botsService (host proc)
  participant Cat as project catalog
  participant Main as Desktop main
  participant Relay as relay/phone
  Chat->>Bot: /remote
  Bot->>Bot: withAuthorizedContext(message, "remote")
  Bot->>Cat: readProjectCatalog (context projectId -> root)
  Bot->>Main: bridge request {workspacePath, workspaceIdentity, hostId}
  Main->>Main: ensure bot window remote session (idempotent)
  Main-->>Bot: link ready (URL minted by owner)
  Bot-->>Chat: localized reply with link
  Main-->>Relay: QR / URL mint (owner: desktop main)
```

Owner of the runtime and URL minting: desktop main. The bot only requests and forwards.

## 8. Acceptance scenarios

1. Upstream bot tests (`botsProjectBinding`, `botsService.permissionsWorkspace`, `botsService.messageFlow`,
   `botsService.groups`) pass with the upstream id format, with no assertion loosened.
2. `botsService.remoteLink` passes: `workspaceIdentity` stays `remote:server:test-owner:/tmp/workspace`.
3. Legacy state with a unique remote project: after startup the context has `hostId`, `projectId`,
   and `workspaceId = [hostId, projectId]`; the allowed key is `[hostId, projectId]`.
4. Legacy key with no matching project: kept verbatim; authorization is not widened.
5. Same cwd in two projects: not mapped; no new candidate is authorized.
6. Migration run twice: second run writes nothing (files byte-identical).
7. Backup files exist before the first migrated write and are not overwritten by a later run.
8. `/remote` from a private chat with the migrated context dispatches the bridge request with the
   derived `workspaceIdentity`, and fails with the existing localized error when the workspace is
   not authorized.
9. Production wiring: `node.ts` passes `projectService`, `remoteProjectService`, and `ownerHostId`
   to `createBotsService`. Remote Hosts supply `botsService` through the Source connection; the
   desktop `remoteWorkspaceServiceCollection.ts` does not build it (section 9).

## 9. Change ledger (outcome)

- `botsService.ts` is the upstream 0a1fc56d model merged onto the fork; the fork `/remote` types
  (`mintWebRemoteLink`) and the `ZCodeAgentAppRuntimePreferences` import are kept.
  `BotRemoteWorkspaceTarget` gains optional `hostId`; `BotRemoteWorkspaceService` gains optional
  `resolveWorkspace`.
- `workspaceHelpers.ts` is upstream's again: the fork's path-based `resolveCanonicalWorkspaceId`
  rewrite kept legacy keys from matching a project candidate (failed the upstream
  permissionsWorkspace test). The upstream rule is a single unique `workspaceIdentity` match — the
  exact-match rule of section 4 step 1.
- New: `BotsRepo.backupBeforeProjectIdentityMigration`, the `config.ts` backup file names, and
  `ensureBotStorageMigrated` now also running `ensureProjectIdentityMigrated`.
- Wiring: `node.ts` passes `projectService`, `remoteProjectService`, `ownerHostId:
projectStorageHostId`. The desktop local-global collection that passed the Host's project channel
  to bots was removed (see `specs/upstream-sync-final-ledger.md`, `local-global collection
removal`); `remoteWorkspaceServiceCollection.ts` no longer carries a bots project-channel
  fallback. Server remote Bot project binding is unchanged.
- Tests: none of the four upstream test files and no assertion was edited; `botsService.fixtures.ts`
  gained a no-op `backupBeforeProjectIdentityMigration` on the in-memory repo (test infrastructure).
  New: `botsProjectIdentityMigration.test.ts` (real file-backed repo: migration, idempotency,
  unknown key, two projects with the same identity, unmatched context). Fork `/remote` tests
  (`botsService.remoteLink`) pass with fork identities; `specs/bot-remote-command.md` behavior is
  unchanged.
