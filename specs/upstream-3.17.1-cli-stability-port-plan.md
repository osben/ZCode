# Порт CLI stability-фиксов 3.17.1 — план (разведка)

Status: ready-for-implementation, рабочий план порта юнитов A–H (багафиксы #44–#52, #55 из каталога `upstream-3.17.1-sync-catalog.md`).
База: `3c5b2276` → цель: `a60ba6a7`. Апстрим-синк — один сквош; промежуточных коммитов фиксов в репо нет — хунки выделяются из диффа, тесты форк пишет сам (апстрим-тесты в синке удалены).

## Правила переноса

- Whole-file checkout **запрещён** для `cli.ts`, `supervisor.ts`, `ssh-backend.ts`, UI-файлов remote-connection-flow — апстрим перемешал фиксы с вне-скоупным редизайном restart/stop, а форк независимо дописывал в те же файлы (host-key UI +125 строк, atomic lock publish).
- Whole-file checkout **разрешён** для `serviceManager.ts`, `immutableRelease.ts` (форк-дивергенция — только переводы комментариев).
- Порядок: A, D, H — независимы; B → C; E → F; G-CLI → G-UI.

## Юниты

### A — #49 userInfo на числовом UID (S, независимый)

`packages/shared/src/node.ts` — новая `resolveServerOsUser()` (~25 строк перед экспортом `acquireFileLock`); `packages/zcode-server-cli/src/server-core/http.ts` — `identity.osUser` → `resolveServerOsUser()` (1 строка).
Форк: аддитивно, чисто. Тесты: новый юнит-тест `resolveServerOsUser` (mock `userInfo` c ENOENT/`uv_os_get_passwd`); проверить `test/coreHttp.test.ts`.

### B — #44+#45: fatal-причина Core не затирается + ready-wait 25s (M)

`supervisor/supervisor.ts` (`coreFatalMessage` в `handleCoreMessage`/fatal, `exitReason` reason:fatal обрезка 500 в `handleTerminal`, очистка в `clearCoreScopedStatus`); `cli.ts` (`describeStartupStatus`, `startupWaitError` с кодами `remote-connection-timeout/unknown`, минимальные хунки `waitForPersistedStatus` — переплетён с вне-скоупными изменениями); `contracts.ts` (`SERVER_READY_WAIT_TIMEOUT_MS = CORE_READY_TIMEOUT_MS + 10_000`); `server/source-server/sourceServerTransportRuntime.ts` (новый `readStructuredCommandCode`); `transportAdapter.ts` (пропуск публичного кода через `SourceServerTransportOperationError`).
Форк: supervisor/transportAdapter/runtime == base; cli/contracts — только переводы. Тесты: `test/supervisor.test.ts`, `test/cli.test.ts`/`test/daemonRegistration.test.ts` (текст `(state=…, last exit: …)`), `packages/server/test/sourceServerTransportAdapter.test.ts`.

### C — #48: reuse `starting` Supervisor ждёт ready (S, после B)

`cli.ts` — `waitForControlReady(layout)` + ветка reuse `state === "starting"` ждёт ready вместо `exit 0, port:null`. Соседние строки ветки содержат вне-скоупные изменения — отделять вручную. Тесты: кейс «reuse starting дожидается ready».

### D — #50: systemd register раздельно + detached fallback (S, независимый)

`platform/serviceManager.ts` (`stage: "load"|"start"`, `isServiceLoadFailure`, `enable --now` → `daemon-reload`/`enable`/`start`; файл брать целиком); `cli.ts` runServe — try/catch `registerService`, `serviceFallbackReason` в stderr и json. Тесты: `test/serviceManager.test.ts`; `test/daemonRegistration.test.ts:114` переписывается («load-фейл → fallback с причиной»).

### E — #46: boot_id+starttime identity в lock.ts (M, требует адаптации!)

Форк **реально** переписал взятие замка (атомарная публикация record через `link(2)`+fsync, `publishRecord`/`tryAcquireRecoveryGate`; см. `test/lockAtomicPublish.test.ts`) — апстрим-хунки НЕ встают. Identity вшивать в контент внутри `publishRecord`; `isHolderAlive` делать async (`readProcessIdentity`: linux `/proc/<pid>/stat` starttime + boot_id; darwin `ps -o lstart=` c `LC_ALL=C TZ=UTC`; EPERM → «мёртв»), await во всех 4 местах вызова. Whole-file checkout **запрещён** (откатит форк-фикс гонки частичного record). Тесты: identity mismatch → stale; legacy-замок без identity → по PID; EPERM → stale; `lockAtomicPublish` проходит.

### F — #52: status.json под замком + stepdown孤儿 (M, после E; `readLoss` можно раньше)

`runtime/lock.ts` — `readLoss(): "missing"|"taken"|null` (аддитивно, встаёт чисто); `runtime/statusSnapshot.ts` (`canWrite` параметр `createStatusPersister`); `supervisor.ts` (`ownsServerRoot`, `stepDownAfterServerRootLost`, `onServerRootLost`); `cli.ts` — `onServerRootLost: (loss) => process.exit(loss === "missing" ? 1 : 0)`. Тесты: перестаёт писать snapshot после подмены замка; exit-коды 1/0.

### G — #51: повреждённый release (CLI: M; UI: M/L)

CLI: `runtime/immutableRelease.ts` — `inspectExistingRelease` → `"match"|"damaged"`, `replaceDamagedRelease` (rename в `.damaged-*`, откат c `AggregateError`); файл брать целиком. Тесты: `releaseInstaller.test.ts:303,345`, `componentCache.test.ts:226` («content mismatch → conflict» меняется на «damaged → замещается»).
UI (отдельно/опционально): `packages/ui/src/lib/sourceServerUpdateAction.ts` (`resolveSourceServerReinstallAvailability`, `getSourceServerReinstallConfirmation`), `RemoteConnectionDialogContent.tsx`, меню карточки устройства, i18n `settings.source.reinstallRemoteService*` — только reinstall-хунки (апстрим перемешал с downgrade/lifecycle, у форка в `remote-connection-flow/index.ts` свои +125 строк).

### H — #55: dispose реjектит in-flight SSH connect (M, независимый, требует адаптации!)

`packages/server/src/remote/ssh-backend.ts` — `failPendingConnect`, регистрация в `ensureConnected` (общий `settle()`), вызов в `dispose()`, удаление недостижимого `if (this.disposed)` в `handleReady`. Форк **реально** дивергировал (host-key verification, `additionalVerificationPrompted`, лишний await в `ensureConnected`) — руками. Тесты: `sshBackend.test.ts:331,359` семантика меняется; добавить «dispose во время connect → немедленный reject» (banner-then-close).

## Вне скоупа (перемешано в тех же файлах)

Редизайн restart/stop апстрима: `runRestart`, `stop --wait`, `stopSupervisorAndWait`, `reapForkedSupervisor`, удаление control `restart`, liveness-watchdog Core, downgrade-маркер, unresponsive-код control. Не переносим поштучно — придёт с полным merge.
