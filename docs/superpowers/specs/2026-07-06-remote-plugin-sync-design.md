# SSH Remote Plugin Sync Design

## Background

SSH remote already syncs user-level Skills (copies the local user skill directory to remote `~/.zcode/skills`) and user-level MCP (imports local MCP config into remote `~/.zcode/cli/config.json`). Both follow an explicit, one-way, no-overwrite model. Plugins are more complex than Skill/MCP: a plugin is a combination of plugin directory, `plugins.dirs`, enabled/options, marketplace cache, installed records, builtin suppression, plugin data, and skills/commands/hooks/MCP runtime projections. SSH sync therefore handles each type separately and never treats local runtime state as portable config.

## Supported scope

### User-level inline plugin

- Source: inline plugins pointed to by `plugins.dirs` in the local user `~/.zcode/cli/config.json`.
- Manifests: `.zcode-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`.
- Plugin id: `<manifest.name>@inline`.
- Sync: local `pluginSyncService` exports an archive; remote `pluginSyncService` imports it to `~/.zcode/plugins/<plugin-dir>`.
- Config: on successful import, append the remote absolute path to remote `plugins.dirs` in `~/.zcode/cli/config.json`.
- Enabled: if the local `plugins.enabledPlugins[pluginId]` is a boolean, sync it to remote user config.
- Options: if local `plugins.options[pluginId]` exists, sync only non-sensitive, non-`file`/`directory` primitive options declared in the manifest `userConfig`. After remote import, re-read the remote plugin schema and write via `plugins/configure` only keys whose remote schema has the same key with a compatible type, merged with the remote's existing options.
- Conflicts: skip when the remote already has the same plugin id or the target directory exists; never overwrite.
- Components display: detect `skills`, `commands`, `hooks`, `mcp` from the manifest or directory.

### Installed marketplace plugin

- Source: `getPluginsOverview().installedPlugins` from the local Agent (marketplace plugins with an installed record).
- Plugin id: `<plugin-name>@<marketplace>` from the installed record.
- Scope: `user` and `workspace`; remote install keeps the local scope.
- Sync: do not copy the local cache. Call `installPlugin({ marketplace, pluginName, scope })` on the remote and let the remote marketplace resolver reinstall the same plugin.
- Remote marketplace source: if the remote lacks a marketplace with the same name and the local source serializes as `github`, `git`, or `url`, call `addPluginMarketplace` on the remote first, then install.
- Local marketplace source: if the remote lacks the marketplace and the local source is `file`, `directory`, or a fully exportable `settings` source, mirror the source directories needed by the selected plugins and their same-marketplace dependency closure to remote `~/.zcode/plugins/marketplace-sources/<marketplace-id>-<hash>`, call `addPluginMarketplace` with that remote directory, then install.
- Enabled: after a successful remote install, call `setPluginEnabled` to match the local state.
- Options: after a successful remote install, re-read the remote schema and sync `plugins.options[pluginId]` under the same safe-subset rules as inline; never send sensitive, path-like, or schema-incompatible keys.
- Conflicts: if the remote already has the plugin id, treat it as installed — no reinstall, overwrite, or upgrade.

### Builtin / official plugin

- Source: official plugins shipped with ZCode: `android-emulator`, `browser`, `document-skills`, `ios-simulator`, `restore-legacy-sessions`, `skill-creator`, `zcode-guide`.
- Plugin id: `<name>@zcode-plugins-official`.
- Policy: no manual sync via the plugin sync dialog. Builtin plugins are native product capability and must be deployed with the remote ZCode Agent resource. Do not add a "manually sync builtin plugin" entry — it would turn a native capability into a user remediation step and could mis-import official plugins as inline plugins.
- Remote resource layout: `glm/<platform>/packages/<plugin-package>` goes into the remote resource bundle and deploys to `~/.zcode/server/agents/glm/packages/<plugin-package>`.
- Seeding: on remote agent startup the existing official plugin filesystem seed materializes these assets at `~/.zcode/plugins/cache/zcode-plugins-official/<name>/<version>`.
- Asset whitelist: `.zcode-plugin`, `skills`, `commands`, `hooks`, `.mcp.json`, and `docs` are all seedable assets. `browser` has no MCP runtime but `runtimeFeatures.browserDocumentationRoot` points to `docs/`; if missing, `agent.browsers.documentation()` degrades.
- Deploy validation: if the remote already has `zcode.cjs` and wrapper but lacks `packages/*-plugin/.zcode-plugin/plugin.json`, deployment must not be skipped — refresh the `glm` component and complete the packages.
- Archive permissions: local-download upload and dev-mode upload regenerate the tar on the desktop side; directory entries must use the cross-platform stable POSIX `0755`, never raw local `stat.mode`. Windows implements only limited permission semantics; passing its mode through writes directories without execute bits that the remote cannot traverse or delete after unpacking.
- Corrupt legacy migration: legacy `0644` packages keep breaking the pre-unpack `rm -rf`. When deployment detects an unreachable builtin manifest and the packages root exists, first repair owner `rwX` on that product-owned directory, then refresh assets; never recursively modify user plugin directories. If a remote plugin page shows 0 builtin plugins, first check whether `~/.zcode/server/agents/glm/packages/*-plugin` deployed together with `zcode.cjs` — missing assets are a resource build/deploy problem, not a user sync problem.

### Runtime projection refresh after sync

- Refresh the remote plugin management store so the settings page shows the new install state immediately.
- Refresh the remote workspace's shared skill store and invalidate the deferred draft session so the `$` skill list and later session preparation see new plugin skills.
- Call remote `commandsService.list` and write the result to the current remote workspace's `zcodeSessionStore.slashCommands`, so the `/` menu shows new plugin commands without switching sessions or opening command settings.
- Reload the remote MCP store's user-directory sources to refresh plugin-contributed MCP state in the UI.

## Data flow

```text
inline:
本机 base pluginSyncService
  -> listLocalUserPluginCandidates()
  -> exportPluginsArchive(pluginIds)
  -> SSH remote pluginSyncService.importPluginsArchive(archive)
  -> 远端 ~/.zcode/plugins/<plugin-dir>
  -> 远端 ~/.zcode/cli/config.json plugins.dirs / enabledPlugins

marketplace installed:
本机 base zcodeAgentService
  -> getPluginsOverview() / listPlugins()
  -> 已安装 marketplace candidates
远端 zcodeAgentService
  -> getPluginsOverview()
  -> addPluginMarketplace(source)    # 仅 github/git/url 且远端缺 marketplace 时
  -> pluginSyncService export/import source archive
  -> addPluginMarketplace(remote mirrored source dir) # file/directory/settings 且远端缺 marketplace 时
  -> installPlugin(marketplace, pluginName, scope)
  -> setPluginEnabled(pluginId, enabled)
  -> listPlugins()
  -> configurePlugin(pluginId, merged portable options)

builtin official:
远端 resource build
  -> glm/<platform>/zcode.cjs
  -> glm/<platform>/packages/*-plugin
SSH deploy
  -> ~/.zcode/server/agents/glm/zcode.cjs
  -> ~/.zcode/server/agents/glm/packages/*-plugin
远端 agent 启动
  -> filesystem seed
  -> ~/.zcode/plugins/cache/zcode-plugins-official/<name>/<version>
```

The UI always uses base services for local enumeration/export and current-workspace services for remote state checks and imports. The remote workspace's service collection must pass `pluginSyncService` and `zcodeAgentService` through as remote services, so imports or installs never write back to the local machine.

## Security and conflict policy

- Archive paths must be safe relative paths; reject absolute paths, `..`, backslashes, Windows drives, and empty paths.
- Archives accept only directories and regular files; reject symlinks, devices, sockets, and other special files.
- Validate a legal manifest inside the plugin directory both before and after import.
- Inline candidate directory names normalize from the plugin root basename; on conflict, skip without touching existing remote directories.
- Inline remote dedup checks both the target directory and inline plugin ids already registered in remote `plugins.dirs`.
- Marketplace remote dedup is by installed plugin id; if it exists, do not reinstall.
- Archives have a size limit to protect remote host memory and disk.
- Marketplace sync depends on remote network, remote marketplace source, and remote resolver. On failure, surface the error; never implicitly fall back to the local cache.
- `plugins.options` sync only locally saved portable primitive values — never treat manifest defaults as user config. Merge with the remote's existing configuredOptions on write, so the replacement semantics of `plugins/configure` cannot delete remote keys.
- `sensitive`, `file`, and `directory` options are never auto-synced; they need credential store or path mapping and are only flagged in the UI as requiring manual remote configuration.
- The local marketplace source mirror contains only the source directories needed by selected plugins and their same-marketplace dependency closure; reject symlinks, absolute archive paths, `..`, Windows drives, and special files.
- A `settings` source can mirror only when the manifest entry is a network source or explicitly points to a readable local directory source; relative paths whose source root cannot be recovered from the synthetic manifest get no cache fallback.
- If the remote already has a marketplace with the same name, never replace the source; source hash / manifest hash differences belong to a separate reconcile flow.

## Boundaries: unsupported or not guaranteed

| Boundary                                                               | Current state                                                                                                                                                                   | Example                                                                                                                                                                                           | Should it be supported                                                                                                                                                      | Future direction                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marketplace cache fallback / copying `installed_plugins.json` directly | Not implemented; deliberately excluded by design                                                                                                                                | Local `canva@claude-plugins-official` cache has downloaded code but the remote is offline; install fails, cache is not shipped over                                                               | No by default. Cache may contain local build artifacts, absolute paths, stale resolver output, or platform-specific files; copying it is not equivalent to a remote install | If offline mode is needed, build an explicit "offline mirror sync": user opts in, cache is copied with manifest/source/sha/version validation, remote installed record written, marked as not equivalent to marketplace reinstall     |
| Full `plugins.options` sync                                            | Safe subset supported; no sensitive, `file`, `directory`, or remote-schema-missing/incompatible keys, and defaults are not synced as user config                                | Local `region="cn"` syncs; `token` (sensitive) or `workspaceDir="/Users/dev/project"` does not                                                                                                    | Keep extending with path mapping and credential store; no default full copy                                                                                                 | Later: options diff detail, path-mapping confirmation, credential store writes; for now only non-sensitive primitive merge                                                                                                            |
| Plugin `data/`                                                         | Not implemented                                                                                                                                                                 | Plugin stores indexes, session cache, tokens, temp files in local `data/`; the remote runtime should regenerate them                                                                              | Mostly no                                                                                                                                                                   | Only plugins with explicit migration semantics get opt-in data migration: the plugin declares migratable files and versions, the host performs a controlled import                                                                    |
| Builtin / restorable builtin / suppressed builtin state                | Assets deploy natively with the remote resource; user state sync not implemented                                                                                                | Local disabled `android-emulator@zcode-plugins-official`, but the remote is Linux without the same iOS/Android runtime; syncing the state could hide usable remote tools                          | Assets must be supported; enable/suppress state is optional and must not mix into normal plugin sync                                                                        | Fix remote resource build/deploy validation first. If state sync is added later, make it a separate "builtin plugin enable-state sync" that writes enabled/suppressed only when the remote has the same id, source, and compatibility |
| Uninstalled marketplace candidate plugins                              | Not implemented                                                                                                                                                                 | Discover page shows `formatter@team-market` not installed locally; the sync dialog does not list it                                                                                               | Usually not needed. Sync means "bring plugins this machine uses to the remote", not bulk market installs                                                                    | If needed, sync marketplace sources or add a remote Discover install entry instead of putting it into local plugin sync                                                                                                               |
| Exact marketplace version match                                        | Incomplete; only guarantees same marketplace + plugin name installs and returns the same plugin id                                                                              | Local `demo@team-market` 1.0.0; remote marketplace already at 1.1.0, remote may install 1.1.0                                                                                                     | Yes, especially to reproduce experiment environments                                                                                                                        | Add version/source lock/sha to the protocol; candidates carry installed-record source/sha; remote installs by lock and validates version/source/sha after install, failing on mismatch                                                |
| `file` / `directory` / `settings` marketplace sources on the remote    | Source mirror supported; does not replace an existing remote marketplace and cannot recover every synthetic `settings` source root                                              | Local marketplace points to `/Users/dev/plugins/marketplace.json`; sync mirrors the needed source, then installs remotely                                                                         | Yes, but never guess remote paths                                                                                                                                           | Explicit source mirror only (current design): pack only the selected plugins' dependency closure; do not replace existing remote marketplaces; unrecoverable `settings` local relative sources fail without cache fallback            |
| Cross-marketplace dependency source mirror                             | Not implemented                                                                                                                                                                 | `hello-world@hello-market` depends on `shared@base-market`; only `hello-market`'s closure is mirrored, cross-market dependencies fail                                                             | Yes, with a separate design for multi-marketplace sync order and conflicts                                                                                                  | Extend the mirror plan to recursively enumerate dependency marketplaces, check each on the remote, and show the marketplace list to be synced in the UI                                                                               |
| Forced full-chain stop abort                                           | Not guaranteed; protocol-level cancel exists only for marketplace add/install with an operationId; inline archive export/import and `setPluginEnabled` are not forcibly aborted | Stop during a slow git clone sends `plugins/cancelOperation` if the remote is in a cancellable add/install; during local export or remote enabled-write it only stops waiting / skips later items | Keep the current granularity to avoid affecting the local plugin settings page and ordinary plugin-management RPC                                                           | Optionally add operationId/AbortSignal to archive export/import, but only the remote sync entry may pass an operationId                                                                                                               |
| Hover sync log equal to remote shell/stdout                            | Not guaranteed; the log shows steps, RPC methods, operationIds, error diagnostics, and stop/cancel outcomes — not the resolver's full internal git/fetch/copy stdout/stderr     | User sees `RPC plugins/install code-review@claude-plugins-official (...)` but not the full internal `git clone` stdout                                                                            | Richer diagnostics yes, but not high-frequency low-level logs in the UI by default                                                                                          | Add an operation progress event to the plugin protocol; subscribe or throttle only when the user opens the log                                                                                                                        |
| Update/overwrite of an existing same-id remote plugin                  | Not implemented; skipped as existing                                                                                                                                            | Local `canva@claude-plugins-official` 1.0.0, remote has 0.9.0; no auto upgrade                                                                                                                    | Yes, as a separate mode                                                                                                                                                     | Add a compare/reconcile mode: show version/source/enabled diffs; user picks skip, reinstall, upgrade, or overwrite                                                                                                                    |

## Summary of conclusions

Implemented: explicitly bringing plugins that already work locally to an SSH remote — inline plugins via directory archive copy, installed marketplace plugins via remote reinstall of the same name. Both paths handle only remote-missing items and never overwrite remote plugins by default.

Still to build, but never by simple full copy: the path/secret subset of `plugins.options`, marketplace version locking, cross-marketplace dependencies, diff handling for existing remote plugins/marketplaces, and fuller remote operation logs. Direct sync risks secret leaks, unusable local paths, remote version drift, unclear cross-market source order, log overload, or overwriting remote state — build these as previewable, chooseable, verifiable reconcile/progress flows.

Not recommended by default: implicit cache fallback, copying `installed_plugins.json`, and normal plugin `data/`. None is guaranteed equivalent to a remote reinstall; `data/` may also contain tokens, indexes, and temp state. If offline capability is truly needed, expose it as a separate "offline mirror sync" mode that states it is not equivalent to a marketplace reinstall.

Not part of this sync flow: uninstalled marketplace candidates (belongs to remote Discover or marketplace source sync) and builtin/suppressed builtin state (depends on the remote OS and builtin availability; do compatibility checks before syncing enable state).

For builtin plugins, missing assets are a remote resource build/deploy problem, not a manual sync problem.

## UI behavior

- Expose the plugin sync entry only in SSH remote workspaces; no new entry for WSL/Docker/local.
- The plugin settings page keeps the same SSH-target banner, top-right sync entry, and dialog style as the Skill/MCP settings pages.
- Remote sync entries in the workspace menu, task menu, and settings pages uniformly use capitalized technical nouns: `同步 Skill` / `Sync Skill`, `同步 MCP` / `Sync MCP`, `同步 Plugin` / `Sync Plugin` — never lowercase regardless of entry location or language.
- The dialog lists locally syncable inline plugins and installed marketplace plugins with source path, version, components, and whether the remote already has them.
- For configured options, the dialog shows a summary: how many local portable primitive configs will auto-sync, and how many need manual remote configuration (sensitive, path-like, or missing local schema). Remote-schema-missing or incompatible keys are reported in the sync log and skipped.
- The dialog shows remote-existing items for confirmation; only remote-missing items are checked by default. Remote-existing items are unselectable and never reinstalled.
- Show a hooks/MCP risk notice: after sync, plugin hooks/MCP run in the SSH host environment.
- After clicking "Sync selected", the dialog keeps the selected plugin cards and shows queued / syncing / synced / failed / stopped status on each card instead of switching to a single global loading card.
- The currently syncing card shows a loading state; the loading icon opens a scrollable log overlay with that plugin's sync steps — export, import, marketplace add, install, enabled-write, operationId, and failure or stop reason. It is not a full relay of the remote resolver's internal shell/stdout.
- Every unfinished plugin has an individual stop button during sync. Stop marks that plugin stopped, records "已停止" in the results, and the queue continues with the remaining plugins.
- For marketplace add/install, stop additionally calls remote `cancelPluginOperation(operationId)`. The agent server aborts that operation's `AbortSignal`, and the adapter must forward the signal to cancellable steps such as git clone / fetch / local copy. If cancel fails or the remote version does not support it, the UI still marks stopped and continues, logging the degraded reason.
- Stop does not cancel ordinary plugin-management operations without an operationId, nor forcibly abort inline archive export/import or `setPluginEnabled`; local workspace plugin settings installs / marketplace adds / updates are unaffected.
- After a successful sync with syncable options, call remote `plugins/configure` with the merged options. This applies only to the remote sync entry and does not change local settings-page save semantics.
- After sync completes, refresh the remote plugin store, shared skill store, commands store, the current workspace's slashCommands, and MCP store state.

## State boundaries

- The local inline service only reads local user config and plugin directories; it never modifies local config/cache/data.
- Remote inline import writes only the remote user plugin root and remote user config.
- Marketplace sync installs only through the remote Agent plugin protocol; it never writes the remote marketplace cache or `installed_plugins.json` directly. For local `file`/`directory`/`settings` sources it writes only the remote source mirror directory, then installs via remote `addPluginMarketplace` and `installPlugin`.
- Builtin plugin assets are owned by remote resource build and deploy; the plugin sync service never writes them into the remote user plugin directory.
- Identity/isolation keeps `workspaceIdentity?.trim() || workspacePath`; execution paths keep using `workspacePath`.
- desktop-continuous and mobile replayable are unchanged. Mobile `/remote` still uses the existing remote host service via shared-host attachment; no separate runtime.

## Acceptance scenarios

| ID             | Scenario                                                                                              | Assertion                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPS-INLINE-01  | Local `plugins.dirs` has a legal inline plugin, remote missing                                        | Imported to remote `~/.zcode/plugins/<dir>`; remote config gains the path                                                                           |
| RPS-INLINE-02  | Remote already has the inline plugin id                                                               | Skipped; directory not overwritten, config not rewritten                                                                                            |
| RPS-INLINE-03  | Remote target directory exists                                                                        | Skipped; directory not overwritten                                                                                                                  |
| RPS-INLINE-04  | Local inline plugin contains a symlink                                                                | Export fails; no arbitrary host path is packed to the remote                                                                                        |
| RPS-INLINE-05  | Local inline plugin has a boolean enabled override                                                    | Remote config syncs the same enabled state                                                                                                          |
| RPS-MKT-01     | Installed marketplace plugin, remote missing but marketplace exists                                   | Remote `installPlugin` installs it, then `setPluginEnabled`                                                                                         |
| RPS-MKT-02     | Installed marketplace plugin, remote missing marketplace, source is `github`/`git`/`url`              | Remote `addPluginMarketplace` first, then install                                                                                                   |
| RPS-MKT-03     | Remote already has the marketplace plugin id                                                          | Candidate shows as existing; not selected by default; not reinstalled                                                                               |
| RPS-MKT-04     | Remote marketplace install fails                                                                      | Candidate shows failed with remote install diagnostics; no local cache fallback                                                                     |
| RPS-MKT-05     | Local marketplace plugin enabled=false                                                                | Remote writes the same disabled state after successful install                                                                                      |
| RPS-MKT-06     | Remote missing marketplace, source is `directory` with local plugin sources                           | Export selected plugins and same-marketplace dependency sources; import as remote source mirror; add marketplace from the remote directory; install |
| RPS-MKT-07     | Local marketplace source is `file`                                                                    | Sync the marketplace JSON and its relative plugin source directories; remote install does not depend on local paths                                 |
| RPS-MKT-08     | Local source is `settings` with a network entry                                                       | Export normalized marketplace JSON; remote adds the marketplace from it and installs                                                                |
| RPS-MKT-09     | Local source is `settings` with an unrecoverable local relative source                                | Sync fails with "source root cannot be recovered"; no cache fallback                                                                                |
| RPS-OPT-01     | Plugin has saved non-sensitive primitive options                                                      | After import/install, read remote schema, merge with remote options, write keys via `plugins/configure`                                             |
| RPS-OPT-02     | Plugin has sensitive, file, or directory options                                                      | Not auto-synced; result log prompts manual remote configuration                                                                                     |
| RPS-OPT-03     | Remote schema lacks the option key or type is incompatible                                            | Key not written; local legacy-schema config never pushed into remote config                                                                         |
| RPS-OPT-04     | Remote already has other options                                                                      | Portable keys sync while remote keys are preserved; `plugins/configure` replacement semantics does not delete them                                  |
| RPS-UX-01      | Syncing multiple plugins, one slow on the remote                                                      | Dialog keeps the plugin list; only the current card shows loading; hover shows that item's sync log                                                 |
| RPS-UX-02      | Clicking a plugin's stop during sync                                                                  | That plugin becomes stopped and the queue continues; if the current step is marketplace add/install, a remote cancel for that operationId is sent   |
| RPS-UX-03      | Result page shows failures                                                                            | Right-side status uses compact badges, not tall button-like containers                                                                              |
| RPS-UX-04      | Long sync log                                                                                         | The log overlay scrolls; long logs never use non-interactive tooltips                                                                               |
| RPS-BUILTIN-01 | Production remote resource build                                                                      | `glm/<platform>` contains both `zcode.cjs` and `packages/*-plugin/.zcode-plugin/plugin.json`                                                        |
| RPS-BUILTIN-02 | Remote has the same `zcode.cjs` version but lacks builtin packages                                    | Deploy must not skip the ZCode Agent; it must complete `~/.zcode/server/agents/glm/packages/*-plugin`                                               |
| RPS-BUILTIN-03 | Dev-mode SSH deploy of local `zcode.cjs`                                                              | Uploads local official plugin packages; remote `plugins list` discovers `source:"official"` plugins                                                 |
| RPS-BUILTIN-04 | Windows / macOS / Linux desktop re-packing builtin packages tar for SSH upload                        | All tar directory entries are `0755`; the remote can `rm -rf ~/.zcode/server/agents/glm/packages` and refresh normally                              |
| RPS-BUILTIN-05 | Remote has legacy non-traversable `~/.zcode/server/agents/glm/packages`, builtin manifest check fails | Deploy repairs owner `rwX` first, then refreshes packages; no manual chmod                                                                          |

## Test plan

- `packages/services/test/pluginSyncService.test.ts`: inline candidate enumeration, export/import, conflict skip, safe paths, enabled state.
- `packages/services/test/pluginSyncService.test.ts`: marketplace source archive export/import for `directory`, `file`, `settings`; local dependency closure; unrecoverable source-root failure.
- `packages/ui/test/remotePluginSyncDialog.test.ts`: inline/marketplace row construction, default selection, remote-existing filter, marketplace source serialization, result rendering.
- `packages/ui/test/remotePluginSyncDialog.test.ts`: non-network source missing remotely — source mirror first, then `addPluginMarketplace(remotePath)`, then install.
- `packages/ui/test/remotePluginSyncDialog.test.ts`: per-item progress, single-item stop continuing later plugins, stopped result, sync log events.
- `packages/ui/test/remotePluginSyncDialog.test.ts`: options safe-subset sync, schema-incompatible skip, merge with remote options.
- `packages/ui/test/remotePluginSyncRefresh.test.ts`: after sync, the current remote workspace's `slashCommands` refresh even if the command settings page is not loaded.
- `packages/ui/test/remoteSyncActions.test.ts`: SSH-only sync entry and dialog injection.
- `packages/desktop/test/*remote*Services.test.ts`: remote service collection uses the remote `pluginSyncService` and remote Agent plugin protocol.
- `packages/server/test/remoteDeploy.test.ts`: remote bundle marker includes `plugin-sync`.
- `packages/server/test/remoteDeploy.test.ts`: ZCode Agent deploy installs the builtin `packages` directory; deploy is not skipped when builtin packages are missing.
- `packages/desktop/test/runtime-asset-scripts.test.ts`: remote asset build scripts stage official plugin packages to `glm/<platform>/packages`.
- Manual: SSH to macOS/Linux remotes; sync an inline plugin, a Claude official marketplace plugin, and a custom github/git/url marketplace plugin; check remote `installed_plugins.json`, `config.json.plugins.enabledPlugins`, and plugin cache.
