# Fork-Only App Settings Sidecar

Fork-owned app settings live in a dedicated sidecar file, `~/.zcode/v2/fork-settings.json`, instead of the upstream-shared `~/.zcode/v2/setting.json`.

## Why

The upstream ZCode app shares `setting.json` with this fork. Every upstream write re-parses the file through the upstream settings schema and silently deletes every key that schema does not know. Any fork-only key placed in `setting.json` therefore gets wiped the moment the user runs the upstream build — this already deleted the selected voice dictation model once (2026-10-14). The repository rule in `AGENTS.md` requires fork-only state in fork-owned storage; this is that storage for app settings.

## Registry

`packages/shared/src/forkAppSettings.ts` is the single source of truth:

- `FORK_SETTING_KEYS` lists every fork-owned key. Current set: `voiceDictation`, `codingPlanLimitAutoContinueDefaultEnabled`, `worktreeLocationMode`, `worktreeCustomLocationPath`, `worktreeBranchPrefix`, `worktreeProjectOverrides`.
- `forkAppSettingsStoredSchema` (what the sidecar persists: only explicitly set values), `forkAppSettingsSchema` (effective view with materialized defaults, read tolerance: a damaged value drops only itself) and `forkAppSettingsPatchSchema` (strict, used on save).
- `splitForkSettingsPatch` routes a patch by key; `pickForkSettings` / `extractLegacyForkSettings` extract the fork keys from a raw `setting.json` object for the one-time migration.

Fork keys must never be added to `appSettingsObjectSchema` / `appSettingsPatchSchema`. A contract test in `packages/shared/test/appSettings.test.ts` fails if a registered key leaks back into the main schema. Before adding a new fork-only key, check it against the upstream settings schema: the key must not exist there, and it must be added to `FORK_SETTING_KEYS` in the same change.

## Service behavior (`packages/services/src/setting/settingService.ts`)

- `get()` returns `{...settingJson, ...forkSettingsJson}` — consumers (all renderer-side today) keep reading `settings.voiceDictation` etc. from the same `ISettingService` surface.
- `update(patch)` splits the patch by `FORK_SETTING_KEYS`: fork keys merge into the sidecar, everything else into `setting.json`. Both writes happen inside the same serialized settings write queue.
- **Defaults are never persisted.** The sidecar stores only explicitly set keys (`forkAppSettingsStoredSchema` has no defaults); the effective view consumers see (`forkAppSettingsSchema`) materializes defaults in memory. Consequence: changing a default in a future build reaches everyone who never touched the setting.
- The sidecar is only ever written by fork code with atomic writes; upstream builds do not know the file and never touch it.

## One-time migration

On the first `get()` or `update()` that observes fork keys still living in `setting.json` (pre-sidecar data), inside the write queue:

1. Seed the sidecar with those values; on conflict the sidecar wins.
2. Persist `setting.json` without the fork keys (the schema already strips them).

Before seeding, the legacy source is re-read under the sidecar lock, so only fork keys still present in `setting.json` are seeded and a stale snapshot can never restore a value another instance already cleared. The migration is idempotent. Known limitation: an older fork build (predating the sidecar) still writes fork keys into `setting.json`; the next new-build read re-migrates, but between those two runs upstream writes can strip what the old build wrote.

## Data-directory moves

`copyDataDirectory` excludes `fork-settings.json` the same way it excludes `setting.json` — both live at the default homedir location and are not migrated to a custom data root.
