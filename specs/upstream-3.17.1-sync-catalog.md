# Upstream 3.17.1 — каталог изменений для синка форка

Status: research catalog (2026-10-30), рабочий документ для планирования sync PR.
База форка: `3c5b2276` (v3.16.2) → цель: `a60ba6a7` (tag `v3.17.1`, upstream main).

## 1. Ключевые цифры синка

| Метрика                                | Значение                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Дифф апстрима                          | 5230 файлов, +216 552 / −611 504 строк                                                                                     |
| Файлов, тронутых и форком, и апстримом | 1644                                                                                                                       |
| Пробный merge: конфликтных файлов      | **1281** (998 код `.ts/.tsx/.mjs`, 267 `.md`, 13 locale/json, 3 прочие)                                                    |
| По пакетам                             | ui 416, services 145, desktop 117, shared 87, web 30, server 24, zcode-server-cli 16, provider-node 16, provider 12        |
| Природа форковых правок                | в основном перевод комментариев zh→en + реbrand; медиана 12 строк/файл, p90 114                                            |
| Апстрим удалил тестов                  | 2050 файлов; из них 637 были тронуты форком (modify/delete конфликты)                                                      |
| Собственные тесты форка                | bootstrap-инфра (scripts/\*.test.mjs, apps/dev-docs, locale/theme tsx-тесты) + 4 пост-bootstrap (title-фиксы в CLI/shared) |

Вывод: конфликты массовые, но семантически мелкие. Стандартное разрешение: взять код апстрима + перевести новые zh-комментарии на английский (правило форка) + сохранить форковые точечные изменения (см. список форковых PR #353–#360).

## 2. Инфраструктура (HIGH RISK для merge)

### Electron 41.0.3 → 44.7.0

- `electron-builder` ^26.8.1→26.17.0, `electron-updater` ^6.8.3→6.8.10 (оба запинены); минимум macOS 13.0.
- npm postinstall больше не качает Electron → новый async «runtime prep» вход для dev-старта и node-pty rebuild.
- `clipboard.readImage()` удалён → async `clipboard.read()/write()`; текстовые clipboard API возвращают Promise.
- overrides: `@electron/rebuild>node-abi: 4.37.0`, `electron-to-chromium: 1.5.452`; новые патчи `@aiden0z/pptx-renderer@1.2.4`, `@extend-ai/react-xlsx@0.16.0`.
- Даунгрейд 44→41 ломает IndexedDB — принято апстримом как известное ограничение.
- Спека: `docs/electron/electron-44-upgrade.md`.

### Ретирем юнит-тестов (~538k строк) и новый тест-пайплайн

- Удалены юнит-тесты пакетов (ui −292k, services −121k, desktop −88k, shared −34k строк); provider/provider-node/rpc/server/web/zcode-server-cli/client — тестовые каталоги целиком.
- Замена: vitest-проект `engineering` из манифеста `scripts/engineering-test-files.json` (157 файлов, maxWorkers 1) + 72 колокализованных теста в `packages/ui/src`.
- **Конфликт с форком**: форк имеет собственный пайплайн (`test:unit` с `forkIsolatedTests`, `test:node` tsx-список, `test:relay`, scripts-тесты). После merge нужно: принять удаление апстрим-тестов (кроме форковых), перенести форковые тесты в новую схему (манифест/tsx-список), разрешить modify/delete на 637 файлах.
- Root scripts: `test`/`test:unit`/`test:coverage` удалены → `test:engineering(:affected)`, `provider:regression(:report)`; `lint-staged` удалён полностью (dep, config, wrapper); pre-push = `check-push-worktree.mjs` + `check:e2e-remote-targets` + stale-doc-phrases + `test:engineering:affected`.

### Протокол

- v2 `zcode-protocol/index.ts`: +16 схем (в осн. аддитивно) — sessionLifecycle (ensureReady/stop/restart), workspace MCP trust review, automation pause/list params, provider runtime headers + `ZCODE_PROVIDER_CONFIG_NETWORK_ERROR = -32032`, runtime capabilities (`rowsRange` residency).
- v4: +3 метода (`v4/conversation/inputPrediction`, `v4/storage/sessionData/measure`, `v4/storage/sessionDataPurge`); существующие не тронуты — skew-safe.

### Прочее

- CI/workflows не менялись (`.github` в дропе нет); изменён `.husky/pre-push`.
- Новый гейт: `scripts/verify-electron-builder-binaries-mirror.mjs` (SHA-256 проверка builder-бинарей на зеркале).
- Фикс distribution: платформенный node-pty prebuild больше не затирает darwin prebuild (краш resize терминала).
- `architecture-policy.yaml` +614/−12: новые managed-модули (conversation-telemetry-engine/service, remote-input-prediction).
- 3.16.2→3.17.1 версии, zcode-cli 0.17.0→0.17.1; `pnpm-lock.yaml` +2377/−600 — конфликт неизбежен.

## 3. Каталог багфиксов (77 задокументированных)

Статусы: **done** = implemented/verified; **partial**; **pending** = задокументирован, фикса нет (апстрим сознательно не менял бизнес-логику в батче e2e-promotion).

### Desktop main/host (13)

| #   | Фикс                                                                | Статус         |
| --- | ------------------------------------------------------------------- | -------------- |
| 01  | join ждёт первый renderer attach (remote join race)                 | partial        |
| 02  | shared session ownership: «новая задача» не убивает logical session | pending (план) |
| 03  | страница устройств не блокируется миграционной статистикой          | done           |
| 04  | каталог 000/0400 не подвешивает сессию (readdir-проверка)           | done           |
| 05  | reconnect после смены SSH-порта читает полный Connection Profile    | done           |
| 06  | единый wizard-интент: автообновление/аутентификация/переустановка   | done           |
| 07  | переустановка сохраняет install.json (identity + история)           | done           |
| 08  | SSH-пароль не удаляется при холодном reproject                      | done           |
| 09  | symlink → realpath identity                                         | pending        |
| 10  | история задач не зависит от доступности корня                       | pending        |
| 11  | холодный старт после смены data dir (Main создаёт workspace dir)    | done           |
| 12  | Electron quit: окно не закрывается                                  | pending        |
| 13  | restart host races (два точечных фикса Host)                        | done           |

### UI renderer (28)

| #   | Фикс                                                   | Статус               |
| --- | ------------------------------------------------------ | -------------------- |
| 14  | create_source телеметрия проекта                       | pending              |
| 15  | edit/fork используют выбранную модель Composer         | pending              |
| 16  | порядок кадров первой отправки нового проекта          | pending              |
| 17  | ошибка источника плагинов не теряется                  | pending              |
| 18  | Escape закрывает редактор проекта                      | pending              |
| 19  | tooltip-контракт файлового дерева                      | done (спека/тесты)   |
| 20  | git find скроллит к совпадению                         | pending              |
| 21  | человеческое сообщение для oversized image             | pending              |
| 22  | webview-guest браузера не уничтожается при смене draft | pending              |
| 23  | offpeak-модель не протекает в resumed composer         | pending              |
| 24  | login guard после гидрации                             | pending              |
| 25  | меню thinking в Start Plan                             | done (test-only)     |
| 26  | trajectory store за E2E-гейтом                         | pending              |
| 27  | mobile home vs career-onboarding                       | pending/needs-triage |
| 28  | кнопка подтверждения смены identity на карточке        | done                 |
| 29  | wizard test entry                                      | done (test-only)     |
| 30  | cold start siblings acceptance                         | done (тесты/доки)    |
| 31  | открытие старых задач после апгрейда                   | done (test-only)     |
| 32  | «показать в боковой панели» фокусирует проект          | pending              |
| 33  | reload renderer: навигация на задачу другого проекта   | pending              |
| 34  | конфликт идентичности не ломает project picker         | pending              |
| 35  | прогресс авто-reconnect виден                          | partial              |
| 36  | баннер опционального обновления устройства             | pending              |
| 37  | фокус после «Edit project»                             | pending              |
| 38  | текст блокировки версии («обновите десктоп»)           | partial              |
| 39  | индикатор running задачи в сайдбаре                    | pending              |
| 40  | карточка прогресса свернутого wizard                   | done (устарел)       |
| 41  | текст startup-reconnect соответствует коду             | pending              |

### CLI / server (15)

| #   | Фикс                                                        | Статус           |
| --- | ----------------------------------------------------------- | ---------------- |
| 42  | повторный /compact при авто-сжатии                          | pending          |
| 43  | query не продолжается после закрытия runtime                | pending          |
| 44  | fatal-причина Core не затирается «Timed out»                | done             |
| 45  | ready-wait 10s→25s на медленных удалёнках                   | done             |
| 46  | stale lock: boot_id+starttime вместо голого PID             | done             |
| 47  | legacy-lock (3.16.2) без identity                           | pending decision |
| 48  | reuse в фазе starting ждёт ready (port:null)                | done             |
| 49  | числовой UID без passwd не роняет Core                      | done             |
| 50  | systemd: daemon-reload/enable/start + detached fallback     | done             |
| 51  | восстановление повреждённого release + кнопка переустановки | done             |
| 52  | orphan supervisor: status.json только под замком            | done             |
| 53  | общий HOME на двух хостах                                   | pending decision |
| 54  | необъяснённые SSH-таймауты                                  | needs-info       |
| 55  | ssh in-flight hang: dispose реjектит соединение             | done             |
| 56  | systemd linger для user-сервиса                             | pending decision |

### Services (11)

| #   | Фикс                                                         | Статус      |
| --- | ------------------------------------------------------------ | ----------- |
| 57  | /mode в Feishu-группе                                        | pending     |
| 58  | cron-задача теряет cronAutomationId                          | pending     |
| 59  | первый submit не ждёт 15с config-gateway                     | pending     |
| 60  | subagents из доп. корней попадают в запрос                   | pending     |
| 61  | config.json writer: strict-read+merge+atomic                 | done        |
| 62  | mobile-replayable не вызывает sync-методы (allowlist)        | done        |
| 63  | MCP writers: strict read + atomic (0600)                     | done        |
| 64  | dependency hints без ложных срабатываний                     | done        |
| 65  | кэш remote identity (SSH-чаты −200ms)                        | done (P0-1) |
| 66  | «установить и продолжить» не теряет пароль (profileId в RPC) | done        |
| 67  | локальный setting.json.lock не блокирует admission           | pending     |

### Remote-control UX (6)

| #   | Фикс                                                                 | Статус                          |
| --- | -------------------------------------------------------------------- | ------------------------------- |
| 69  | единая presentation-модель соединения (5 состояний) + контракт логов | done                            |
| 70  | wizard P0 (retry-цикл, reuse, disable, WSL/Docker тексты)            | partial (переоткрыт reuse-хинт) |
| 71  | safeguards настроек (Enter, rollback, двойные ошибки)                | done                            |
| 72  | follow-ups формы (port:0, paste ssh://, Docker dropdown, фокус)      | done                            |
| 73  | типографика страницы устройств                                       | pending design                  |
| 74  | ошибка при живом соединении ≠ «连接失败»                             | pending                         |

### Кросс-области (4)

| #   | Фикс                                                                         | Статус                |
| --- | ---------------------------------------------------------------------------- | --------------------- |
| 68  | edit-resend рядом с title-update (revision conflict)                         | pending               |
| 75  | порядок tool-history после resume/edit/fork (declarationIndex+snapshotIndex) | done                  |
| 76  | открытие папки из Finder: принадлежность проекта                             | done                  |
| 77  | share API 503                                                                | pending investigation |

Итого: **done 35, partial 4, pending 38**. Из pending ~19 — осознанный батч e2e-promotion («записано, бизнес не трогали»), 6 ждут решения продукта.

## 4. Каталог фич

### Крупные (L, зависимые друг от друга)

| Фича                                   | Объём                                                     | Зависимости                                                           |
| -------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Data Sync на удалённые устройства      | ui 19 файлов ~3.9k строк + services 16 файлов ~2.4k       | source-settings attachment (skill/plugin/mcp/user-config-sync каналы) |
| Settings scope по устройствам          | ~800 строк ui                                             | Data Sync                                                             |
| Управление проектами + purge данных    | ~3.2k ui + services project/data + CLI session-data-files | v4 sessionData measure/purge                                          |
| Перезапуск задачи (session lifecycle)  | CLI session-lifecycle + host/services ~1.7k               | поколенческая семантика событий                                       |
| Общий CLI для беспроектных воркспейсов | zcode-agent ~1.7k                                         | пул процессов Host                                                    |
| Conversation telemetry V4              | shared ~3.7k + services + ui ~6.1k                        | TelemetryCore, ARMS adapter                                           |

### Средние (M)

| Фича                                                   | Объём                              | Платформы          |
| ------------------------------------------------------ | ---------------------------------- | ------------------ |
| file-open-apps (системные ассоциации)                  | 11 файлов ~885 строк, desktop main | desktop            |
| file-menu (открыть в приложении / сохранить копию)     | 14 файлов ~917 строк               | desktop + web      |
| image-preview-editor (кадрирование/стирание/аннотации) | 10 файлов ~843 строки              | desktop            |
| Mobile input prediction (ghost hints)                  | 164 строки схемы + CLI sidecar     | mobile+desktop+CLI |
| workspace-mcp-trust                                    | CLI bootstrap                      | CLI + UI           |
| Local TTFT телеметрия                                  | ~1.1k строк                        | desktop local      |
| Electron 44                                            | инфраструктура                     | desktop            |
| Sites-панель (zcode-site плагин)                       | plugin                             | desktop            |
| Официальный endpoint для команд плагинов               | CLI bootstrap + протокол           | CLI                |

### Малые (S, изолированные)

- Модели: Kimi K3.1 Pro (+highspeed, 8 записей), MiniMax M3.1 Flash GA (4 записи) — конфиг-файлы.
- `request-security-edition` — чистый контракт-модуль shared.
- web `saveFile` (до 50 MiB) — packages/web platform.
- mobile-log канал — payload поверх relay.
- resident-rows-range — capability + forward.
- provider-provisioning-status — сервис Host (для страницы Data Sync).
- topic-resource-relay — 4 файла host.
- UI-мелочи: Personalization (`~/.zcode/AGENTS.md` редактор), YOLO-подтверждение, контекстное меню ссылок.
- react-scan dev-инструмент.
- mobile push notifications — L на деле (серверная часть).

## 5. Рейтинг «что легче портировать» (для выборочной стратегии)

S-уровень, малая дивергенция форка, нет скрытых зависимостей:

1. Модели Kimi/MiniMax (конфиги).
2. CLI stability-фиксы #44–#52, #55 (supervisor/lock/ssh) — apps/zcode-cli, реальные пользовательские баги.
3. Writer-hardening #61/#63/#64 — защита config.json/MCP от порчи.
4. Wizard follow-ups #72, settings safeguards #71.
5. request-security-edition, web saveFile, mobile-log, resident-rows-range.
6. UI-мелочи: Personalization, YOLO-подтверждение, link context menu.

M-уровень (самодостаточные, но объёмные): file-open-apps + file-menu, image-preview-editor, input prediction, MCP trust, Electron 44.

L-уровень (поштучно не портировать — зависимые сети): Data Sync (+scope, +provisioning-status), project management, restart, shared CLI, telemetry.

## 6. Открытые решения

1. Стратегия: полный merge (путь форка по specs/fork-branch-model.md) vs выборочный порт (растущая дивергенция, повторные конфликты при будущем merge).
2. Тестовый пайплайн после merge: перенос форковых тестов в engineering-манифест vs сохранение параллельного fork-пайплайна.
3. Electron 44: принимать в том же PR или отдельным шагом (форк имеет свои нативные зависимости).
4. pending-баги апстрима (38 шт., в т.ч. 19 e2e-promotion): фиксить форку самостоятельно или ждать апстрим.
