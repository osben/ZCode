# Порт writer-hardening фиксов 3.17.1 — план (разведка)

Status: ready-for-implementation. Фиксы #61/#63 из каталога `upstream-3.17.1-sync-catalog.md`; #64 отложен (лежит внутри data-sync слоя, которого в форке нет).
База: `3c5b2276` → цель: `a60ba6a7`. Экспорты смотреть в `packages/services/src/node.ts` (named-блок `./fs/atomicFileUtils.js`, ~строка 111 апстрима).

## Порядок портов

### Юнит 1 (#61a, S): writer-утилита

`packages/services/src/fs/atomicFileUtils.ts` — из апстрима взять ТОЛЬКО writer-половину: `JsonObjectFileUnreadableError`, `readJsonObjectFileForUpdate` (ENOENT→{}, иначе throw), `updateJsonObjectFile` (read→update→`atomicWritePrivateTextFile(path, json+"\n", [])`). `pathExists`/`writeFileAtomically` НЕ брать (потребители только в data-sync).
Зависимость `atomicWritePrivateTextFile` из `@zcode/shared/node` уже в форке (`packages/shared/src/node/privateFilePersistence.ts:135`, совместимо, 0600). Экспорт в `packages/services/src/node.ts`.
Тесты: расширить `packages/services/test/atomicFileUtils.test.ts` (strict-read, atomic-merge).

### Юнит 2 (#61b, S): сервисные писатели

- `packages/services/src/commands/commandsService.ts` — `writeUserCliConfig` → `updateUserCliConfig(update)`; вызовы в `setCommandEnabled`, `saveCommandFromDescriptor` (×2), rename-миграция override.
- `packages/services/src/hooks/hooksService.ts` — `writeZCodeHooksConfig` → `updateJsonObjectFile`; убрать import `workspaceHookConfigMutation`.
- `packages/services/src/skills/skillsService.ts` — `writeSkillEnabledMap` → `updateJsonObjectFile`; `readCliConfigFile` остаётся для read-only.
  Форк-дивергенция: только переводы комментариев (+ hooks: события PreCompact/PostCompact/SessionEnd — не пересекаются).
  Тесты: `commandsService.test.ts`, `hooksService.test.ts`, `skillsService.test.ts` — corrupt→reject с сохранением байтов, preserve-other-fields.

### Юнит 3 (#61c, S/M): settingsSyncService

- `addMcpServerToZcodeConfig` (~1103) и `addPluginDirToConfig` (~1134): loose-read+`writeJsonFile` → `updateJsonObjectFile`; `writeJsonFile` (1129) удалить.
- Миграционная половина: `importPluginsForAgent` (~2043) — catch с `rm(targetPath, {recursive,force})`; `importMcpServersForAgent`/`importPluginsForAgent` — `catch {}` → `catch (error) { log.warn(...) }`.
- Форк уже имеет stability-ханки в этом файле (atomicWriteFile+withFileLock в копировании AGENTS.md ~2248) — после порта убрать неиспользуемый import `writeFile`.
  Тесты: `settingsSyncService.test.ts` (corrupt→reject+байты целы).

### Юнит 4 (#63, M): mcpUserDirectory

`packages/desktop/src/main/mcpUserDirectory/index.ts`:

- удалить `readUserCliConfig`/`writeUserCliConfig` (на `readJsonObject`/`writeTextAtomic`);
- `cleanupLegacyMcpEnabledOverride` — strict pre-check + `updateJsonObjectFile`;
- `writeServerEnabledToFile` — `hasServer` strict pre-check + `updateJsonObjectFile` c `removeLegacyMcpEnabledOverride` внутри;
- legacy-enable миграция в `readDirectoryServersFromFile` — `updateJsonObjectFile` + `logger.warn` вместо `console.warn` (import `../logger.js` есть);
- `writeZCodeServersToFile` → `updateZCodeServersInFile(scope, workspacePath, update)` c migrate-then-mutate;
- `saveCliMcpToUserDirectory` — переписать на updater.
  Зависит от экспортов юнита 1. data-sync-половина (mcpDataSync.ts, home-rewrite) НЕ портируется.
  Тесты: `packages/desktop/test/mcpZcodeAgent.test.ts` — corrupt→reject без изменения байтов, 0600 после записи, сохранение чужих полей.

### #64 — отложен

`findMissingDataSyncDependencies` и wiring живут в `packages/ui/src/data-sync/` + `packages/services/src/data-sync/` (в форке отсутствуют). Форма фикса (source∩¬target; keys undefined → нет вердикта) учитывается при будущем порте data-sync кластера.
