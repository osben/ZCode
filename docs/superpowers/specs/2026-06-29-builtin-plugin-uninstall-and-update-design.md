# Built-in Plugin Uninstall & Plugin Update Design

Scope: the plugin management page (1) allows uninstalling built-in (official/bundled) plugins and (2) surfaces per-plugin updates end to end. Previously: marketplace plugins could install/uninstall and any plugin could enable/disable, but built-ins (`source: "official"`, seeded from the app bundle) had only a toggle — the uninstall button was hidden and no-op (built-ins are absent from the installed-records file) — and the backend `pluginsUpdate` path was unwired to the agent service, store, and UI with no "update available" detection.

## Hard constraints from the code

C1 — Built-ins re-seed on every resolve, and multiple readers materialize them. `seedBundledOfficialPlugins` (`bootstrap/src/app/bundled-plugins.ts`) runs on every `resolveZCodePlugins` via `resolveOfficialPluginRoots`, writing each bundled plugin into `storageRoot/cache/<marketplace>/<name>/<version>` (skipped only on a matching content-hash marker). Deleting cache files is futile — the next resolve recreates them. And more than one reader scans official plugins, so suppression must thread through all of them:

- `bootstrap/src/plugins.ts` `resolveZCodePlugins` → `resolveOfficialPluginRoots` → `seedBundledOfficialPlugins`.
- `bootstrap/src/app/startup-marks.ts:24` `resolveStartupPlugins` → `resolveOfficialPluginRoots` (independent call).
- `bootstrap/src/app/plugin-facade.ts` in-session facade (caches `enabledPlugins`).
- `packages/services/src/skills/skillsService.ts:818` `resolvePluginSkillRootDescriptors` directly calls `scanOfficialPluginCacheRoots(pluginStorageRoot)` and force-default-enables official ids via `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`.
- `packages/services/src/commands/commandsService.ts:406` `resolvePluginCommandRootDescriptors` — same pattern.

C2 — the UI installed list/detail renders from `plugins/list` (`ZCodePluginInfo`), with extra per-plugin fields join-patched by id (see `installedAt` at `PluginsSection.tsx:118`). A new `updateAvailable` field must live on `ZCodePluginInfo` or be join-patched the same way; the overview's `installedPlugins` alone never reaches the detail panel.

## Decisions (locked with product)

| Question                                    | Decision                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uninstall built-in semantics                | Permanent + reversible hide, with full purge of plugin user state: persistent suppression surviving restart and upgrades; cache files deleted; `enabledPlugins[id]`, `options[id]`, and the plugin `data/` dir removed. Restore re-seeds a clean plugin — config/data are NOT restored; uninstall fully clears.                   |
| Update detection                            | Detect & badge; show only when newer.                                                                                                                                                                                                                                                                                             |
| Update scope                                | Marketplace (`cache`) plugins only.                                                                                                                                                                                                                                                                                               |
| Update freshness                            | Cached manifest; a "Check for updates" action re-pulls on demand.                                                                                                                                                                                                                                                                 |
| Restore of an uninstalled built-in          | Via catalog through a dedicated restore action, not the marketplace install path.                                                                                                                                                                                                                                                 |
| Non-semver version diff                     | Show "version changed", not "update available" (only `semver.gt` is an update).                                                                                                                                                                                                                                                   |
| Official marketplace name                   | Locked: user-added marketplaces may not claim `zcode-plugins-official` / `claude-plugins-official`.                                                                                                                                                                                                                               |
| Installed record vs built-in classification | `installed_plugins.json` wins: an exact installed record always uninstalls through the marketplace path even when its cache lives under `zcode-plugins-official`; only ids without an installed record may enter built-in suppression. Marketplace uninstall also removes stale suppression markers left by older buggy versions. |
| Update vs running session                   | Next session only; the UI shows a "takes effect in new sessions" note.                                                                                                                                                                                                                                                            |
| Concurrency safety                          | Lightweight in-process per-storageRoot async mutex around install/update/uninstall/restore; cross-process file locking is a non-goal.                                                                                                                                                                                             |

## Architecture

Suppression state — single source of truth in user config: `plugins.suppressedBuiltins: string[]` beside `enabledPlugins`/`options` in the same file with atomic-write helpers, so app upgrades never overwrite it. A shared resolver exposes the suppression set and resolved official roots so the CLI bootstrap and the desktop services apply identical logic:

- `resolveOfficialPluginRoots({ storageRoot, suppressedBuiltins })` skips seeding for suppressed ids and removes leftover cache roots.
- `writeOfficialMarketplace()` omits suppressed plugins from the synthetic manifest.
- `skillsService`/`commandsService` filter `scanOfficialPluginCacheRoots` results through the same set (read from the CLI config they already load), so suppressed built-ins contribute no skills/commands.

```
uninstall(built-in id)            [under storageRoot lock]
  → add id to plugins.suppressedBuiltins      (user config, atomic patch)
  → rm -rf cache dir + data dir
  → drop enabledPlugins[id], options[id]      (full purge)

every reader (resolve / startup / skills / commands)
  → reads plugins.suppressedBuiltins
  → official roots exclude suppressed; suppressed contribute nothing

restore(built-in id)              [under storageRoot lock]
  → remove id from plugins.suppressedBuiltins
  → next resolve re-seeds a CLEAN plugin (existing seeding machinery)

uninstall(marketplace id)         [under storageRoot lock]
  → exact id exists in installed_plugins.json
  → remove installed record + cache/data
  → remove enabledPlugins[id], options[id]
  → remove stale suppressedBuiltins[id] if present
```

Restore is a dedicated action, NOT marketplace install: a suppressed built-in's cache is deleted and it is absent from the synthetic official manifest, so the normal install/describe flow would throw "Bundled plugin cache directory missing" (`marketplace.ts:764` requires an existing cache dir for `filesystem`/`sea` sources). Hence a new backend op `restoreBuiltinPlugin(id)` removes the id from `suppressedBuiltins` (the seeder re-materializes on next resolve; no marketplace fetch), and the overview exposes `restorableBuiltins` (`OFFICIAL_PLUGIN_DEFINITIONS` ∩ `suppressedBuiltins`) so the catalog tab renders a Restore button distinct from Install.

Plugin update — wire the existing backend, add detection, fail loudly. The `pluginsUpdate` handler (`zcode-protocol/plugins.ts:235` `updatePlugin`) reinstalls the latest closure from the cached manifest. Changes:

- Fail loudly: aggregate diagnostics from every `installZCodeMarketplacePlugin` call; any error diagnostics fail the op, and the UI keeps the badge until the installed record's version actually changes.
- Detection is dual-track (version + sha): in `getZCodePluginsOverview`, for each installed `cache` plugin, build a "latest pin" from its manifest entry — a semver `version` if present, else the commit `sha` from `entry.source` (`readPluginSourceSha`). `comparePluginUpdate` picks the axis: version present → semver compare; else sha present → identity (differs ⇒ `update-available`; installed has no sha ⇒ `version-changed`); neither ⇒ `none`. The sha track matters because the Claude official marketplace pins versions almost entirely via `source.sha` — of 243 plugins measured, only 14 carry a top-level `version` and 192 use sha — so a version-only check left ~229/243 official plugins permanently `none`. Local-path entries (no version/sha) are Phase 2: `docs/plugin-marketplace-update-detection-handoff.md`.
- Surface `updateStatus` + `latestVersion?` (version or a short 7-char sha label), joined into the UI's installed view model per C2.
- `semver` lives in `adapters`; `comparePluginVersions` falls back to `!==` when unparseable; `comparePluginUpdate` wraps it for the version axis.

```
"Check for updates" (installed tab) → updateMarketplace(null) (existing git re-pull, sequential)
  → reload overview → badges refresh
update click → store.updatePlugin(id) → agentService.updatePlugin() → RPC pluginsUpdate
  → on success reload overview; on diagnostics show error, keep badge
  → note: effect applies to NEW sessions
```

Lock official marketplace names: `addMarketplace` (`marketplace.ts:254`) sets `id: loaded.manifest.name` unguarded, letting a user-added marketplace overwrite the official synthetic manifest. Guard added: reject (or namespace) added/updated marketplaces whose resolved `manifest.name` is `zcode-plugins-official` or `claude-plugins-official` unless it is the built-in seeding path, with a clear error in the add popover.

Concurrency lock: the desktop talks to one app-server process, so an in-process async mutex keyed by `storageRoot` serializes install/update/uninstall/restore (each does read-modify-write across `installed_plugins.json`, cache dirs, and config) via `withPluginStorageLock(storageRoot, fn)`.

## Implementation surface

CLI (`apps/zcode-cli`):

1. `adapters/src/config/schema.ts` `pluginsSchema`: `suppressedBuiltins: z.array(z.string().min(1)).optional()`.
2. `contracts/src/plugins/index.ts` `PluginConfig`: `suppressedBuiltins: string[]` (normalized to `[]`).
3. `adapters/src/config/file-config.adapter.ts`: `addSuppressedBuiltinInFileConfig` / `removeSuppressedBuiltinInFileConfig` (atomic, idempotent).
4. `bootstrap/src/app/bundled-plugins.ts`: seeder/resolver take `suppressedBuiltins`; skip + rm suppressed; `writeOfficialMarketplace` omits suppressed.
5. `bootstrap/src/plugins.ts`: pass `config.plugins.suppressedBuiltins` through `resolveZCodePlugins`; `uninstallZCodeMarketplacePlugin` for `source !== "cache"` suppresses + purges (bypassing the installed-records `return null`) under the storage lock; new `restoreBuiltinPlugin`; `getZCodePluginsOverview` computes update status + `restorableBuiltins` with `semver`/`compareVersions`; `updatePlugin` aggregates diagnostics and fails on error; `withPluginStorageLock` wraps mutating ops.
6. `adapters/src/plugins/marketplace.ts` `addMarketplace`/`updateMarketplace`: official-name guard.

Shared services (`packages/services`):

7. `skills/skillsService.ts` + `commands/commandsService.ts`: filter official cache roots through `suppressedBuiltins` via a shared helper (no duplicated suppression logic).

Protocol (`packages/shared/src/zcode-protocol/index.ts`):

8. `zcodeInstalledPluginSummarySchema`: `updateAvailable?`, `latestVersion?`; same on `ZCodePluginInfo` or joined in the UI per C2.
9. Overview result: `restorableBuiltins` (array of available-plugin summaries).
10. New `pluginsRestoreBuiltin` method (workspace + pluginId params); `pluginsUpdate` schema already present.

Services client (`packages/services/src/zcode-agent/`):

11. `zcodeAgent.ts` `IZCodeAgentService`: `updatePlugin`, `restoreBuiltinPlugin`.
12. `zcodeAgentService.ts`: both via `client.request(...)` with the 5-minute plugin timeout.

UI store (`packages/ui/src/store/pluginManagementStore.ts`):

13. `updatePlugin(id)` and `restoreBuiltin(id)` actions mirroring `installPlugin`.

UI components (`packages/ui/src/settings/`):

14. Enriched installed view model joining `plugins/list` with overview update fields (C2).
15. `InstalledPluginManagement.tsx`: Update badge + button when `updateAvailable` (cache only) with a "version changed" variant; "takes effect in new sessions" note; built-in detail shows Uninstall.
16. `PluginsSection.tsx` `uninstallable` (~L398): official built-ins are uninstallable; `inline` stays non-uninstallable.
17. Catalog tab: `restorableBuiltins` with a Restore button → `restoreBuiltin`.
18. "Check for updates" button on the installed tab → `updateMarketplace(null)`.
19. Built-in uninstall confirm copy: states it fully removes plugin data/config and the plugin is restorable/re-downloadable.
20. i18n strings.

## Testing

- bundled-plugins/resolve (vitest): a suppressed built-in stays gone across simulated re-resolve/re-seed; restore re-materializes a clean plugin; cache+data removed on uninstall; `writeOfficialMarketplace` omits suppressed.
- Services layer: skills/commands scanners exclude suppressed built-ins.
- Config: suppression add/remove patches are atomic and idempotent.
- Overview detection: `update-available` only when the manifest version is strictly greater; `version-changed` on non-semver; `none` on equal.
- Update handler: aggregates diagnostics, fails on error, badge persists until the version changes.
- Marketplace name guard: adding a manifest named `zcode-plugins-official` is rejected.
- Lock: concurrent uninstall + update on one storageRoot serialize without corrupting `installed_plugins.json`.
- Services client: `updatePlugin`/`restoreBuiltinPlugin` issue correct RPCs.
- UI: Update badge/button + "new sessions" note; built-in Uninstall; restorable built-ins show Restore in the catalog; update existing mocks.
- Run `npm run lint && npm test` in `apps/zcode-cli`; UI/services package tests.

## Known limitations (deferred)

- No cross-process locking or rollback journaling (in-process lock only). A crash mid-uninstall can leave config/cache briefly inconsistent; the next resolve self-heals seeding, but transactionally repairing a half-written `installed_plugins.json` is out of scope.
- No marketplace trust hardening (signed manifests, pinned SHA, rejecting HTTP for executable-hook sources, downgrade protection) beyond name-locking.
- No dependency pruning or reverse-dependency guards on update: the closure reinstalls without removing now-orphaned deps.
- No manifest-driven "update plan" (preview of pending updates with old/new versions, source revision, dependency impact); this iteration does per-plugin update + per-marketplace refresh.

## Non-goals

- No version-comparison UI for built-ins (they track the app version).
- No auto-update or background update checks.
- No change to the still-hidden plugin-import dialog.
