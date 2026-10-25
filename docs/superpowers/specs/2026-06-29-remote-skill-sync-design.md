# SSH Remote Skills Sync Design

Skills are read from the runtime's filesystem: local workspaces read local user/project skills; SSH/Docker/WSL remote workspaces read skills already present on the remote machine. `SettingsSyncService` only imports from an external Agent into the same runtime, and `RemoteConnection` exposes only `services` to upper layers — the internal `IRemoteBackend.upload()` must not be surfaced to the renderer for this. This design adds a restricted skill-sync path instead.

Goals:

- Sync local user-level skills to a connected SSH workspace's remote user-level `~/.zcode/skills`.
- Local candidates follow local user-level discovery semantics: `~/.zcode/skills` plus the compat directory `~/.agents/skills`; when a `.agents` skill of the same name is already covered by `.zcode` (by directory name, skill name, or real `SKILL.md` path), only the `.zcode` version shows. Discovery recurses into group directories and follows directory symlinks; the remote receives plain directory contents, never symlinks.
- Per-item and select-all selection. Existing same-name remote skills are skipped by default, never overwritten.
- Results show synced / skipped / failed and refresh the remote skill list.
- Entry points clearly target "this SSH host" — not a global setting.
- Remote workspace `workspaceIdentity` / `remoteSessionId` routing boundaries hold; remote requests never fall through to local services.

Non-goals (v1): no overwriting remote skills; no task right-click entry (sync is a host/workspace action, not task-level); no one-click sync for disconnected SSH history entries (needs a temporary session — separate future design); no plugin-managed/system skills or local plugin install state; no default writes to remote project `.zcode/skills`; no generic remote file-write API.

## UI

One shared dialog, `RemoteSkillSyncDialog`, opened by three entry classes:

1. Remote workspace header/overflow menu "同步 Skill" (sync skills), also in the left workspace row's `...` menu — both shown only when the current workspace is a connected SSH remote.
2. `Settings > Skills` "同步 Skill", shown only when the recent/current workspace is a connected SSH remote; the section shows the current context (e.g. `SSH user@host · /home/dev/project`) so the list and target are clearly remote.
3. SSH connection dialog helper entry, only after connection in the directory-selection/connected stage — never next to the login form.

`SettingsPage` mixes a global shell with workspace-scoped sections: `PluginsSection`, `CommandsSection`, `SubagentsSection` already take `activeWorkspacePath`/`activeWorkspaceIdentity`; `SkillsSection` must also take `workspacePath`, `workspaceIdentity`, `remoteSessionId`, `remoteTarget` explicitly, not read the tab store implicitly.

Dialog contents:

- Top shows the target SSH host and remote user-level directory.
- A compact alert icon next to the title with an existing tooltip component: syncing migrates local skills but does not guarantee dependencies or system environments; if a skill fails remotely due to environment, permissions, or missing dependencies, the user installs them on the remote server manually. Hover-only; takes no list space and does not affect wrapping.
- List of local user-level skills: name, description, source path, sync status. Descriptions collapse to one line; expand/collapse is an icon button on the name row; clicking the card body toggles selection while clicking the checkbox, name label, or expand button does not double-toggle. Candidates match the settings page's "personal" skills (not just `~/.zcode/skills` — also `~/.agents/skills`, group directories, directory symlinks).
- A `显示远端已存在` (show remotely existing) checkbox filter shares the target-host row, wraps on narrow screens, defaults checked. Unchecking only hides `remoteStatus.exists === true` rows — no re-fetch, no state change; if nothing remains, an empty state says only remotely existing skills are available and suggests re-checking. The dialog height stays constant; only the inner list scrolls (no size jumps).
- One `全选` (select all) checkbox: unchecked / indeterminate / checked map to none, some missing items selected, all remote-missing items selected; unchecking clears the selection. Counts and select-all always track only syncable remote-missing items; hidden items cannot be synced.
- Remote-missing skills are checked by default; existing ones default unchecked, labeled "已存在，将跳过" (already exists, will skip). The submit button shows the selected count; the completion page shows synced/skipped/failed detail.

## Service boundary

A restricted sync service, not a generic file write:

- Local side: enumerate syncable user-level skills and build a restricted archive for the selection — covering both roots, reusing user-level dedup semantics, including group directories and directory symlinks.
- Remote side: receive the archive and import into remote `~/.zcode/skills`, skipping existing same-name directories.

New `ISkillSyncService` registered on both the local host and the remote zcode-server services; the renderer routes through existing services:

- Local candidate reads via `useBaseWorkspaceServices()`.
- Remote status/import via the SSH workspace's remote services resolved by `remoteSessionId` / `workspaceIdentity`, never falling back to local.
- When the desktop renderer merges remote workspace services, `skillSyncService` must be overridden to the remote service like `skillsService` — otherwise imports write back to the local `~/.zcode/skills` while the UI reports remote success.
- Desktop host `init-remote` must also register the remote `skillSyncService` when exposing remote connection services, or renderer `skill-sync` channel requests time out host-side (`Channel name 'skill-sync' timed out after 1000ms`).
- The remote `zcode-server.cjs` version may match locally while the deployed bundle is stale; SSH deployment checks must probe whether the deployed server bundle contains the `skill-sync` channel and refresh the main server if missing.

Methods:

- `listSyncCandidates({ workspacePath?, workspaceIdentity? })` — local call lists local user skills; remote call queries same-name existence in remote `~/.zcode/skills`.
- `exportSkills({ skillIds })` — tar.gz binary archive with manifest; only discovered user-level skill directories.
- `importSkillsArchive({ archive, overwrite: false })` — unpacks into remote `~/.zcode/skills`; `overwrite` fixed `false` in v1; returns per-skill synced/skipped/failed.

Archive import path safety: reject absolute paths, `..` traversal, backslash paths, symlinks, and special device files; write only skill subdirectories under the target root; every skill must contain `SKILL.md`; local directory symlinks are dereferenced only at export — archives never contain symlinks or special files.

## Data flow

1. User opens the dialog from the SSH workspace header, Settings Skills, or the SSH connection dialog.
2. The dialog loads local candidates via base services and remote existing names via remote services.
3. Remote-missing items are pre-checked; the user adjusts or selects all missing.
4. Submit: local service builds the archive; remote service imports it.
5. Conflicts resolve by skill name/directory name — existing names are skipped.
6. The UI shows results, refreshes remote `ISkillsService.list()`, and triggers skill context invalidation for remote draft sessions.

## Remote/local compatibility

- Local workspaces show no sync entry; SSH remotes show it; Docker/WSL remotes do not (v1), keeping "SSH host sync" semantics off other transports.
- Mobile web remote adds no separate runtime: entering the same remote workspace host reuses shared-host attachment; the entry can stay desktop-only in v1.
- Workspace-level state lookups use `workspaceIdentity?.trim() || workspacePath`; file I/O keeps the real `workspacePath`.

## Error handling

- Remote disconnect: dialog shows disconnected and disables submit.
- No local user skills: empty state, no submit button.
- Partial failure: keep successes, show failure reasons, allow retry by reopening.
- Oversized archive: explicit server error — v1 enforces a per-sync size cap to avoid huge RPC transfers.
- Insufficient permissions: the remote service returns a `~/.zcode/skills` create/write error prompting the user to check remote user permissions.

## Tests and verification

- Unit: candidate list covers both roots and excludes plugin/system skills; `.agents` entries covered by `.zcode` don't duplicate; group-directory skills sync to the same relative directory; symlinked local skills sync as plain remote directories; exports contain only selected user skills; imports skip same names without overwriting; imports reject traversal, absolute paths, symlinks, and missing `SKILL.md`.
- UI: no entry on local workspaces; header entry on SSH remotes; Settings context + button under SSH remote context; per-item select, select-all-missing, and result display.
- Integration: after syncing, remote `ISkillsService.list()` sees the skill; existing remote skills are skipped; new/restored draft sessions see the refreshed skills context.
- Repository: `pnpm typecheck`, `pnpm lint`.

## Risks

- RPC binary transport suits small-to-medium skill directories; large assets hit the v1 cap — a later host-temp-file + backend-upload path can replace it.
- The Settings page mixes global and workspace-scoped sections; the remote context must stay explicit or users misread the sync target.
- The name/directory conflict policy stays stable: v1 skips based on remote target-directory existence and reports actual directory names in results.
