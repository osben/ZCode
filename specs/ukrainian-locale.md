# Ukrainian Locale（украинский язык интерфейса `uk-UA`）

> Статус: **план, готовый к передаче исполнителю**. Код не менялся. Все пути, символы и номера строк проверены на checkout `dev` (номера строк — ориентир: перед правкой ищи по символу).
>
> Базовая линия на момент плана: `pnpm typecheck` — OK; `pnpm lint` — 0 ошибок, 70 предупреждений; `pnpm architecture:check --changed` — 0 нарушений; `pnpm --dir apps/zcode-cli/packages/i18n typecheck` — OK.
>
> Ревизия 2 (ревью плана по коду `dev` 66b0293): дополнены F2 (`autoUpdater`), F4 (три конвенции плюралов, 35 семейств), F10 (`cuaPermissionPanelMessages`, тернарник CUA), F14 (баг community в web), таблица монтирований Provider, I0 (третий потребитель `localeSchema`: `pendingPostUpdateReleaseNotes` тоже может сбросить все настройки), I1/I3 (preload Coding Plan не трогать), раздел 6 (`pnpm install`); добавлены решения D13–D14.

## 0. Как исполнять этот план

- Итерации выполняются **строго по порядку** I0 → I9. Каждая итерация — отдельный коммит/PR, после каждой зелёные `pnpm typecheck`, `pnpm lint` (0 ошибок, предупреждений не больше 70 + новых не добавлять), `pnpm fmt:check`, `pnpm architecture:check --changed` и тесты, перечисленные в итерации.
- Решения D1–D12 (раздел 4) приняты: D5, D6 и D11 пользователь подтвердил 2026-10-09, остальные приняты по рекомендации. D13 и D14 добавлены ревью и подтверждены пользователем 2026-10-09. Если в ходе работы возникнет решение, которого нет в таблице, его нужно согласовать с пользователем, а не выбирать самостоятельно.
- I0–I2 не меняют видимое поведение для `zh-CN`/`en-US` (кроме явно оговорённых улучшений фолбэка). Если тест или ручная проверка показывает изменение текста для zh/en — это ошибка.
- Правила репозитория, которые действуют здесь: комментарии к исправлениям багов — на китайском (причина + основание); логирование в UI — `packages/ui/src/logger.ts`, в сервисах — `createServiceLogger(scope)`; платформа — только через `IPlatformService`, не `window.zcode`; кросс-пакетные импорты — через публичные входы (`@zcode/shared` и т. п.).
- Ничего не коммитить в `main` напрямую; пользователь сам решает про коммиты и PR.

## 1. Продуктовые правила

- Новая локаль `uk-UA` наравне с `zh-CN` и `en-US`: выбор в настройках (Settings → язык) и в меню футера сайдбара, плюс режим `system`.
- `system`: тег ОС `uk*` → `uk-UA`; `zh*` (включая `zh-TW`, `zh-HK`) → `zh-CN`; всё остальное → `en-US`. Для существующих языков поведение не меняется.
- Цепочка фолбэка UI-строк: `<локаль> → en-US → id`. Украинский интерфейс **никогда** не показывает китайский текст. Исключения: серверный контент без английской версии (release notes, D14) и community в web (D13).
- Внешние сервисы, которые знают только `zh-CN`/`en-US` (сайт шаринга, Coding Plan webview, community URL, release notes, feedback API), получают «сервисную» локаль: `uk-UA → en-US`.
- Множественное число — по CLDR (`Intl.PluralRules`). У `uk` есть формы `one / few / many / other` (1 файл / 2 файли / 5 файлів / 1,5 файла).
- Названия языков в списках — эндонимы, одинаковые во всех каталогах: «中文简体», «English», «Українська».

## 2. Текущее состояние

### 2.1 Владелец и поток (desktop + web)

```text
Settings Select (settingsPageHelpers.tsx ~296-318) ──┐ guard: SettingsPage.tsx:1278
Sidebar footer radio (WorkspaceSidebarFooter.tsx ~245-262) ┤ guard: WorkspaceSidebar.tsx:745
                                                      ▼
ZCodeIntlProvider.setLocalePreference      (packages/ui/src/i18n/IntlProvider.tsx — единственный владелец в окне)
  ├─ localStorage "zcode-locale-preference"           (кэш окна; в web приоритетнее settings)
  ├─ broadcast "state:locale" {preference, resolvedLocale} → другие окна
  └─ settingService.update({locale, localePreference}) → setting.json (appSettingsSchema)

useRootPlatformEffects.ts:555  platform.setApplicationLocale(locale)
  → IPC SetApplicationLocale  (desktopMainIpcPlatform.ts:230-237, localeSchema.safeParse)
  → main applyApplicationLocale (desktop/src/main/index.ts:2098)
       ├─ меню приложения / трей (desktopApplicationMenu.ts, shared/src/desktopMenu.ts)
       ├─ CUA indicator (windowsCuaOperationIndicatorContent.ts)
       ├─ Finder workflow (desktopFinderOpenFolderWorkflow.ts, macOS)
       └─ send ApplicationLocaleChanged → все окна
             └─ UpdateStatusWindowRoot.tsx:60-76 пересоздаёт Provider с initialLocale

Старт main: settings.locale (index.ts:1937-1946) ?? resolveSystemApplicationLocale()
            (desktopApplicationMenu.ts:33-38: app.getPreferredSystemLanguages()[0] ?? app.getLocale(), zh/en)
```

Другие точки монтирования `ZCodeIntlProvider`:

| Место                                                             | Источник локали                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Главное окно desktop (`desktop/src/renderer/src/main.tsx:328`)    | settings + localStorage + `resolveSystemLocale` хоста          |
| Экран старта БД desktop (`desktop/src/renderer/src/main.tsx:168`) | флаг `?locale=` (`:135-139`), иначе localStorage → хост        |
| Web (`packages/web/src/main.tsx:454`)                             | `settingService` + `broadcastService`; localStorage важнее     |
| `UpdateStatusWindowRoot.tsx:76` (монтируется из `main.tsx:366`)   | `initialLocale`, пересоздаётся по `onApplicationLocaleChanged` |
| `resource-manager.tsx:59`                                         | без пропсов → localStorage → navigator                         |
| `ConversationShareReadonlyTimeline.tsx:1151`                      | `initialLocale` из маршрута шаринга                            |

Важно:

- Флаг `preferSettingServiceLocale` в `IntlProvider.tsx` (`:76-90, 148, 227-259`) **никем не передаётся** — мёртвый код. Отдельного мобильного входа в `packages/web/src` нет; web/mobile ведут себя одинаково.
- Desktop **не передаёт** локаль CLI-агенту. CLI/TUI определяет язык сам (см. 2.2).
- `ErrorBoundary.tsx:6-7, 64-90` не использует Provider: статически импортирует оба каталога, сам читает `zcode-locale-preference` и `navigator.language`.

### 2.2 Два независимых i18n-стека

| Стек                    | Каталоги                                        | Тип                                                        | Объём                                      |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| UI (desktop, web)       | `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` | `Record<string, string>` (полноту компилятор не проверяет) | en 5 876 ключей, zh 5 875; ~425 KB на язык |
| CLI/TUI (`@zcode/i18n`) | `apps/zcode-cli/packages/i18n/src/locales/*.ts` | `ZCodeCopy` (полноту проверяет TS)                         | ~360 строк                                 |

CLI определяет язык из `ui.locale` в своём конфиге (`adapters/src/config/schema.ts:213`) и `LC_ALL/LC_MESSAGES/LANG/LANGUAGE`/Intl (`i18n/src/locale.ts` `normalizeLocale`). Неизвестный `uk` → `undefined` → следующий кандидат → `en-US`. Стек не зависит от desktop, поэтому его можно отложить (I8).

## 3. Находки и ограничения

### Блокеры (без переработки `uk-UA` сломает данные или покажет китайский)

- **F1. Невалидная `locale` сбрасывает ВСЕ настройки.** `localeSchema = z.enum(["zh-CN","en-US"])`, `localePreferenceSchema` (`shared/src/validationAppSettings.ts:35-36`) используются в `appSettingsObjectSchema` (`:422, :425`). При ошибке разбора `settingService` берёт `defaultSettings()` (`services/src/setting/settingService.ts:147-155`), а `update` (`:314-317`) сливает patch с дефолтами и **записывает** результат, то есть настройки теряются навсегда. То же делает `desktop/src/main/startupWorkspace.ts:19-26`. Проверено: `appSettingsSchema.safeParse({locale:"uk-UA"}).success === false`. CLI: `uiSchema.locale` — строгий enum, `ZCodeConfigFileSchema.parse` бросает исключение (`schema.ts:213, 391`). Старые версии задним числом не исправить, отсюда D6.
- **F2. Ветки «не en — значит zh».** Для `uk-UA` они покажут китайский:
  - `services/src/bots/botsService.ts:407, 551, 589, 653, 1321, 1435, 4179, 4603`; `bots/messages.ts:254`; `bots/replyFormatter.ts:352`
  - `ui/src/ErrorBoundary.tsx:88`; `ui/src/lib/conversationShareError.ts:297, 316, 319, 321`
  - `ui/src/updateReleaseNotes.ts:21-25`: для любой локали, кроме zh, фолбэк идёт в `releaseNotesByLocale["zh-CN"]`
  - `desktop/src/main/autoUpdater.ts:777-786` `pickFallbackReleaseNotesMarkdown`: `menuLocale → zh-CN → en-US`. Из него собирается `payload.markdown` (дефолт release notes), когда в фиде нет общего `releaseNotes`
  - `web/src/main.tsx:245` (community URL). Это **уже существующий баг**: локаль берётся из `document.documentElement.lang`, а в обычном web-приложении `lang` всегда `"en"` из `index.html` (меняется только на странице шаринга, `:121`). Поэтому community в web сейчас всегда открывается в `zh-CN` даже для `en-US`. По D13 **не исправляется** в рамках задачи
  - Не баг: `ui/src/lib/taskTimelineGroups.ts:39` `weekStartsOn = en ? 0 : 1`. Для uk понедельник правилен, не трогать.
- **F3. Фолбэк каталога ведёт в `zh-CN`, а не в `en-US`.** `createIntl` (`IntlProvider.tsx:113-127`): `MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]`, где `DEFAULT_LOCALE = "zh-CN"` (`shared/src/protocol.ts:110`). Отсутствующий ключ возвращает сырой `id`, фолбэка между языками нет.
- **F4. Плюралов нет.** `formatMessage` умеет только `{key}`. В коде **три** конвенции выбора формы по `count === 1`, всего 35 семейств (проверено на `dev`; пути от `packages/ui/src`):

  **A. Суффиксы `.one` / `.other|.many`** — 18 семейств:

  | Семейство                                              | Формы сейчас                   | Место вызова                                                                       |
  | ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
  | `settings.resourceGroup.item`                          | one/other                      | `settings/SettingsResourceGroupHeader.tsx:17`                                      |
  | `chat.codeComments`                                    | **one/many**                   | `AssistantCodeCommentCards.tsx:86`, `v4/composer/CodeCommentAttachmentChip.tsx:28` |
  | `chat.webElements`                                     | **one/many**                   | `v4/composer/WebElementContextAttachmentChip.tsx:38`                               |
  | `chat.pptxElements`                                    | **one/many**                   | `v4/composer/PptxElementReferenceChip.tsx:31`                                      |
  | `chat.toolCall.workflow.timeline.roster.unlisted`      | **one/many**                   | `components/workflow-timeline/WorkflowRoll.tsx:99-100`                             |
  | `chat.changeSummary.filesChanged`                      | one/other                      | `v4/ConversationFileSummaryPanel.tsx:88`                                           |
  | `settings.memory.viewer.memoryCount`                   | one/other                      | `settings/MemorySettingsViewer.tsx:55` (ключ собирается шаблоном)                  |
  | `settings.memory.viewer.itemCount`                     | one/other                      | мест вызова нет (`rg` пусто) — ключи только переименовать/перевести                |
  | `chat.toolCall.changesGroup.{file,tool}`               | one/other                      | `ToolCallBlocks/renderers/changes-group.tsx:193-198`                               |
  | `chat.toolCall.executeGroup.command`                   | one/other                      | `ToolCallBlocks/renderers/execute-group.tsx:24`                                    |
  | `chat.toolCall.explore.bucket.{search,list,file}`      | one/other                      | `ToolCallBlocks/renderers/explore.tsx:131-147`                                     |
  | `chat.toolCall.cua.group.{event,message}`              | one/other                      | `ToolCallBlocks/renderers/cua-group.tsx:191-204`                                   |
  | `chat.toolCall.workflow.script.summary.{phases,steps}` | **`.one` + база без суффикса** | `app-shell/WorkflowWorkspaceSidePane.tsx:82-90` (`countLabel`)                     |

  **B. Суффикс `One` в имени ключа** (`xxxOne` / `xxx`) — 12 семейств, префикс `chat.toolCall.workflow.` сокращён до `…`:

  | Ключи                                                                                | Место вызова                                                                                     |
  | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
  | `workflows.hub.invalid{One,}`                                                        | `settings/saved-workflows/SavedWorkflowProjectGroup.tsx:419`, `SavedWorkflowGlobalGroup.tsx:236` |
  | `…list.count{One,}`, `…list.invalid{One,}`                                           | `ToolCallBlocks/renderers/list-saved-workflows.tsx:174, 183`                                     |
  | `…listRuns.count{One,}`                                                              | `ToolCallBlocks/renderers/list-workflow-runs.tsx:47`                                             |
  | `…models.count{One,}`                                                                | `ToolCallBlocks/renderers/list-models.tsx:274`                                                   |
  | `…feedback.count{One,}`                                                              | `ToolCallBlocks/renderers/workflow-diagnostics.tsx:64`                                           |
  | `…getRun.subagent.{toolCalls,steps}{One,}`                                           | `ToolCallBlocks/renderers/get-workflow-run-roster.tsx:162, 215`                                  |
  | `…getRun.phase.rounds{One,}`, `…getRun.health.{failures,cachedSteps,leftover}{One,}` | `ToolCallBlocks/renderers/get-workflow-run-situation.tsx:66, 188, 198, 219`                      |

  **C. Пары слов** (`xxx` / `xxxs`) — 5 семейств. Хелпер `count(format, one, many, value)` в `components/workflow-timeline/timeline-summary.ts:45` (`chat.toolCall.workflow.card.{phase/phases, agent/agents, agentWorking/agentsWorking, artifact/artifacts}`) и `components/workflow-timeline/WorkflowRunDigest.tsx:139` (`chat.toolCall.workflow.digest.question/questions`).

  Не плюральная пара: `chat.toolCall.workflow.card.round` / `card.rounds` (`timeline-summary.ts:208`) выбираются по `active`, а не по числу, и показываются только при `rounds >= 2`. Но `card.rounds` («{count} rounds») для uk всё равно нужны формы few/many — это строка с `{count}` вне семейств (правило раздела 7).

  Как искать (контрольная проверка I2): `rg -n '=== 1' packages/ui/src -g '*.ts*' -g '!**/locales/**'` (ловит и многострочные тернарники, и шаблонные строки) (~115 совпадений, большинство не про текст) плюс `rg -n '[a-z]One"' packages/ui/src -g '*.ts*' -g '!**/locales/**'` (13 совпадений, все — конвенция B); каждое совпадение классифицировать вручную. Поиск только по `".one"` пропускает конвенции B/C и шаблоны вида `` `…${n === 1 ? "one" : "other"}` ``.

  Значение `count` в местах вызова передаётся по-разному: `String(n)`, число или `n.toLocaleString()` (последнее даёт разделители тысяч). `formatPlural` не должен менять это поведение (см. I2).
  - `.many` здесь означает «не один» и конфликтует с CLDR-категорией `many` в украинском. Переименовать в `.other`.
  - Суффикс `.other` используется и в **не**плюральных ключах (`feedback.module.other`, `settings.plugins.store.category.other`, `settings.usage.modelChart.other`, `occupationOnboarding.other`, `resourceManager.storage.category.other` …). Поэтому плюрализация должна быть **явной** (отдельный метод), а не автоматической в `formatMessage`.
  - 25 en-строк используют «(s)» (например, `conversationShare.*`, `bots.setup.bound`, `feedback.time.daysAgo`, `automations.schedule.customYearly`), а около 263 строк содержат `{count}`-подобные плейсхолдеры. В uk их переводят нейтральной формулировкой («Файлів: {count}») или переводят в плюральное семейство — правило в разделе 7.

### Дублирование и мёртвый код

- **F5. Валидатор локали продублирован:** `IntlProvider.tsx:42`, `SettingsPage.tsx:1278`, `WorkspaceSidebar.tsx:745`, `ErrorBoundary.tsx:69`, `desktop/src/renderer/src/main.tsx:137`, CLI `i18n/src/locale.ts:17`. Ещё одна копия есть в `desktop/src/preload/codingPlanWebview.ts:127, 141`, но её **заменять нельзя**: код находится внутри функции, которую сериализует `contextBridge.executeInMainWorld` (комментарий на `:125`: тело не компилируется TS), поэтому импорты там недоступны. Для uk это безопасно: в webview приходит уже нормализованная локаль (`ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts:201, 310` отдают `zh-CN`, иначе `en-US`).
- **F6. Детектор системного языка продублирован** (`startsWith("zh") ? zh : en`): `IntlProvider.tsx:167`, `ErrorBoundary.tsx:80`, `desktop/src/renderer/src/desktopPlatform.ts:161`, `desktop/src/main/desktopApplicationMenu.ts:37`, `web/src/auth/webAuthLocale.ts:61`, CLI `normalizeLocale`.
- **F7. Собственные union-типы вместо `Locale`:** `BotMessageLocale` (`bots/messages.ts`), `WebAuthLocale`, `ConversationShareLandingLocale`, `CodingPlanWebviewLocale` (`shared/src/channels.ts:472`), `FeedbackSubmission.locale` (`shared/src/feedback.ts:89`, `ui/src/feedback/feedbackSubmitSubmission.ts:56`), `TestActions.getLocale/setLocale` (`ui/src/test-actions.ts:24-26`), `botsService.ts:208` `Record<"zh-CN"|"en-US",…>`, `providerTemplateNameMapDataSchema` (strict `zh-CN|en-US`, это бренды — не расширять), CLI `SupportedLocale`/`UiLocale` (`contracts/src/config/index.ts:279-280`), `GlobalLocale` (`shared-types/src/index.ts:16`).
- **F8. Мёртвое состояние:** Zustand `locale` (`ui/src/store/index.ts:112-113, 214, 267-270, 476`): ключ `zcode-locale`, дефолт `"zh-CN"`, участвует в `BROADCAST_FIELDS`, читателей нет. Его broadcast-обработчик принимает только строку, а Provider шлёт объект. `LocaleSwitcher.tsx` экспортируется из `i18n/index.ts`, но нигде не используется. `preferSettingServiceLocale` (см. 2.1) тоже мёртв. Ключ `settings.memory.viewer.disabled` есть только в en и нигде не используется. **По D11 всё это остаётся без изменений.**
- **F9. 47 веток `=== "zh-CN"` / `startsWith("zh")`** вне каталогов. Для uk они молча дают английский. Это не баг, но такие места остаются непереведёнными: `workDuration`, `memoryUpdatedAt`, `draftSuggestedPromptItems`, `automationTemplateCatalog`, `savedWorkflowLaunchPrompt`, раздел Coding Plan, `forceUpdatePrompt`, `embeddedBrowserJavaScriptDialog`, `autoUpdater`, `main/index.ts:865` (`resolveExternalWorkspaceConfirmationCopy`), `main/index.ts:1317` (`isZh` в подтверждении выхода), `desktopOAuthDeepLink.ts:142` (там уже `TODO(i18n)`). Полный список: `rg -n '=== "zh-CN"|startsWith\("zh' packages -g '*.ts' -g '*.tsx' -g '!**/locales/**' -g '!**/dist/**'`.
- **F10. `Record<Locale, …>`, которые TS заставит дополнить** после расширения `Locale`: `shared/src/desktopMenu.ts:61`, `shared/src/conversation-share.ts:14`, `desktop/src/main/about.ts:60`, `desktop/src/renderer/cuaPermissionPanelMessages.ts:12` (панель разрешений Computer Use: 7 строк), `desktopWindowsOpenFolderContextMenu.ts:8`, `desktopFinderOpenFolderWorkflow.ts:10`, `services/src/conversation-share/conversationShareService.ts:236`, `ui/src/lib/builtinSkillI18n.ts:44`, `ui/src/i18n/IntlProvider.tsx:23`, `ui/src/i18n/LocaleSwitcher.tsx:8` (не используется, но остаётся по D11 — дописать метку `"uk-UA": "Укр"`). `Partial<Record<Locale,…>>` (`remoteAppConfig.ts:11`, `update.ts:8`, `protocol.ts:357`, `desktop/src/main/autoUpdater.ts:80`, `postUpdateReleaseNotesPayloadSchema` через `localeSchema`) компилятор пропустит — нужен явный фолбэк.
  - Компилятор **не** заставит дополнить `desktop/src/main/windowsCuaOperationIndicatorContent.ts:14-17` `indicatorCopy`: это тернарник `locale === "zh-CN" ? zh : en`, а не `Record`. Для uk он молча даст английский. Там же **ширина окна в px** под текст (zh 234, en 308) — для uk её нужно подобрать.

### Прочие ограничения

- **F11. Electron упаковывает только `en-US`/`zh-CN` `.pak`** (`desktop/electron-builder.config.js:471`). Нативные строки Chromium (контекстные меню, валидация форм, spellcheck) для uk будут английскими. Имя pak-файла — `"uk"`.
- **F12. Размер бандла.** Каталоги импортируются статически (Provider и ErrorBoundary). Украинский в UTF-8 займёт примерно 600–700 KB. Lazy-load — опционально (D7).
- **F13. Длина строк.** Украинский на 15–30 % длиннее английского и в 2–3 раза длиннее китайского. `DESIGN.md:260-261` запрещает полагаться на обрезку текста.
- **F14. Внешние URL:** путь шаринга `/cn` vs `""` (`shared/src/conversation-share.ts:14-30`, `parseConversationSharePathname` возвращает только zh/en); `web/src/main.tsx:121-124` ставит `lang`/title по маршруту; `getCommunityUrlFromConfig(config, locale)` (`shared/src/remoteAppConfig.ts:61-64`) для uk вернёт `undefined`, и кнопка community исчезнет; в web `openCommunity` берёт локаль из `<html lang>` (баг, F2/D13); `helpAppConfig.ts:8-9, 38-39`; Coding Plan webview (`CodingPlanWebviewLocale`); feedback `Accept-Language` (`feedbackHttpClient.ts:428-435`).
- **F15. Тестов для каталогов нет, E2E-инфраструктуры в репозитории нет.** Есть только `node:test`-файлы (`packages/ui/test`, `packages/services/test`, `apps/zcode-cli/packages/bootstrap/test`); скрипта `test` нет. Проверено: тесты из `packages/ui` импортируют `@zcode/shared`, каталоги и алиас `@/`. `test-actions.ts` (`getLocale`/`setLocale`) — мост для внешних E2E, которых в репо нет.
- **F16. Политика архитектуры:** `maxFileLines: 400` применяется только к managed-модулям (`managedOnly: true`). `ui`/`shared`/`services`/`desktop`/`web` — `managed: false`, поэтому большой `uk-UA.ts` допустим.

## 4. Решения

| #   | Вопрос                                                                                                 | Решение (✅ — подтверждено пользователем)                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Тег локали                                                                                             | `uk-UA`                                                                                                                                                                                                                                                                                                                                                                    |
| D2  | Фолбэк UI-строк                                                                                        | `<локаль> → en-US → id` **для всех локалей** (для zh пропавший ключ покажется на английском, а не как `id` — это улучшение)                                                                                                                                                                                                                                                |
| D3  | `system` для `ru*` и прочих                                                                            | без изменений → `en-US`                                                                                                                                                                                                                                                                                                                                                    |
| D4  | Объём первой поставки                                                                                  | Desktop + Web UI + main-процесс + контентные каталоги. Боты (I7) и CLI/TUI (I8) — отдельно; до этого у них фолбэк `en`                                                                                                                                                                                                                                                     |
| D5  | Перевод                                                                                                | ✅ LLM пакетами по namespace + глоссарий (раздел 7). Ревью выполняет **агент** отдельным проходом по процедуре из раздела 7.1; ревью носителем языка не планируется                                                                                                                                                                                                        |
| D6  | Релиз защиты настроек                                                                                  | ✅ I0 выпускается **отдельным релизом**, минимум на один релиз раньше I3 (защищает от потери настроек при откате). I0 мерджится и релизится сразу; I1–I2 могут идти в следующий релиз; I3+ — не раньше релиза, следующего за I0                                                                                                                                            |
| D7  | Lazy-load каталогов                                                                                    | не делать в рамках задачи; вернуться, если после I4 заметно вырастет время первой загрузки web (сравнить размер чанка до/после `pnpm --dir packages/web build`)                                                                                                                                                                                                            |
| D8  | Язык генерации commit message (`gitCommitMessageGenerator.ts:226`)                                     | `uk-UA` → `"Ukrainian"`                                                                                                                                                                                                                                                                                                                                                    |
| D9  | `DEFAULT_LOCALE = "zh-CN"`                                                                             | не трогать                                                                                                                                                                                                                                                                                                                                                                 |
| D10 | Команды ботов (`/help`, китайские алиасы `/帮助`, `/项目`, reply-mode алиасы `botsService.ts:189-204`) | для uk оставить английские имена команд, переводить только сообщения. Украинские алиасы не добавлять                                                                                                                                                                                                                                                                       |
| D11 | Мёртвый код (F8)                                                                                       | ✅ **Не чистить** в рамках задачи. Zustand `locale`, `LocaleSwitcher`, `preferSettingServiceLocale` и ключ `settings.memory.viewer.disabled` остаются как есть; где они мешают (типы `Record<Locale,…>`, parity-тест), их минимально дополняют (см. I1–I3)                                                                                                                 |
| D12 | Видимость пункта «Українська» до окончания перевода                                                    | без runtime-флага: I3–I4 не выпускать в релиз по отдельности (держать в ветке / не мерджить в `main`, пока I4 не завершён)                                                                                                                                                                                                                                                 |
| D13 | Источник локали для community в web (`web/src/main.tsx:245`)                                           | ✅ **Не трогать.** `openCommunity` в web остаётся как есть (локаль из `<html lang>`, фактически всегда `zh-CN`) — для `uk-UA` в web community откроется на китайском. Известное исключение из правила раздела 1, вынесено в раздел 10                                                                                                                                      |
| D14 | Release notes для uk, если на сервере нет `en-US`-версии                                               | ✅ Цепочка `uk-UA → en-US → payload.markdown`. `payload.markdown` берётся из общего `releaseNotes` фида (язык определяет сервер) или из `pickFallbackReleaseNotesMarkdown`, который для не-zh локали переводится на `menuLocale → en-US → zh-CN`. Китайский для uk возможен, только если фид не содержит английского вовсе; это допустимое исключение из правила раздела 1 |

## 5. Итерации

### I0 — Защита настроек от неизвестной локали (без видимых изменений)

Цель: `setting.json` или конфиг CLI с неизвестной `locale` не ломает остальные настройки.

Файлы:

- `packages/shared/src/validationAppSettings.ts`: **только** в `appSettingsObjectSchema`:
  ```ts
  locale: localeSchema.default("zh-CN").catch("zh-CN"),
  localePreference: localePreferenceSchema.default("system").catch("system"),
  ```
  `localeSchema` экспортируется и используется в IPC (`desktopMainIpcPlatform.ts:232`), в `migrateLegacyLocalePreference` (`:227`) и как ключ `releaseNotesByLocale` в `postUpdateReleaseNotesPayloadSchema` (`:64-68`, `z.partialRecord`), поэтому сам он остаётся строгим. Последний случай опасен так же, как F1: `pendingPostUpdateReleaseNotes` (`:469`) хранится в `setting.json`, а `z.partialRecord(localeSchema, …)` с неизвестным ключом (`"uk-UA"`) не проходит разбор (проверено на zod 4.6.5) — значит, сбросятся все настройки. Сейчас туда пишутся только zh/en (`autoUpdater.ts:629`), но для защиты на будущее в `appSettingsObjectSchema` поставить `pendingPostUpdateReleaseNotes: postUpdateReleaseNotesPayloadSchema.optional().catch(undefined)`: потерять отложенные release notes лучше, чем все настройки. `appSettingsPatchSchema` (`:495, :497`) тоже остаётся строгим: неверный patch должен отклоняться.
- `apps/zcode-cli/packages/adapters/src/config/schema.ts:213`: `locale: z.enum(["auto","en-US","zh-CN"]).optional().catch(undefined)`.
- Комментарии на китайском: почему `.catch` (не терять настройки при откате версии).

Тесты:

- Новый `packages/ui/test/localeSettingsSchema.test.ts` (в `packages/shared` нет тестовой папки; `packages/ui` может импортировать `@zcode/shared`):
  - `appSettingsSchema.parse({ locale: "uk-UA", localePreference: "uk-UA", recentProjects: ["/a"] })` даёт `recentProjects` сохранённым, `locale === "zh-CN"`, `localePreference === "system"`;
  - корректные `zh-CN`/`en-US`/`system` проходят без изменений;
  - отсутствие полей → дефолты;
  - `appSettingsPatchSchema.safeParse({ locale: "uk-UA" }).success === false`;
  - `pendingPostUpdateReleaseNotes` с ключом `"uk-UA"` в `releaseNotesByLocale` → поле `undefined`, остальные настройки сохранены.
- CLI: если в `adapters` нет тестовой папки, проверить разбор разово через `node --import tsx -e` и записать в PR как пробел покрытия.

Готово, когда: тесты зелёные, `typecheck`/`lint` без новых ошибок, поведение zh/en не изменилось.

### I1 — Общие хелперы локали, явные ветки, удаление мёртвого кода (без видимых изменений)

Новый файл `packages/shared/src/locale.ts` + реэкспорт в `packages/shared/src/index.ts`:

```ts
import type { Locale, LocalePreference } from "./protocol.js";

export type ServiceLocale = "zh-CN" | "en-US";
export const FALLBACK_UI_LOCALE: Locale = "en-US";

interface LocaleMeta {
  languagePrefix: string; // "zh" | "en" | "uk"
  serviceLocale: ServiceLocale;
}
// Record<Locale, …>: при расширении Locale компилятор потребует новую запись.
const LOCALE_META = {
  "zh-CN": { languagePrefix: "zh", serviceLocale: "zh-CN" },
  "en-US": { languagePrefix: "en", serviceLocale: "en-US" },
} satisfies Record<Locale, LocaleMeta>;

export const SUPPORTED_LOCALES = Object.keys(LOCALE_META) as Locale[];
export function isLocale(value: unknown): value is Locale;
export function isLocalePreference(value: unknown): value is LocalePreference;
/** BCP-47 / POSIX тег ОС → поддерживаемая локаль или null (нормализует "_" → "-", регистр). */
export function matchSupportedLocale(tag: string | null | undefined): Locale | null;
/** Тег ОС → локаль; неизвестное → en-US; пусто → fallback (по умолчанию DEFAULT_LOCALE, как сейчас в IntlProvider). */
export function resolveSystemLocale(tag: string | null | undefined, emptyFallback?: Locale): Locale;
export function toServiceLocale(locale: Locale): ServiceLocale;
```

Семантика должна **точно** повторять текущую: `zh*` → `zh-CN`, всё остальное непустое → `en-US`, пусто → `DEFAULT_LOCALE` (`IntlProvider.tsx:164`). Проверить также поведение `desktopApplicationMenu.ts:33-38` и `webAuthLocale.ts:61` для пустого тега и сохранить его через `emptyFallback`.

Замены дублей (F5, F6):

- `ui/src/i18n/IntlProvider.tsx` (`isLocale`, `isLocalePreference`, `resolveNavigatorSystemLocale`)
- `ui/src/ErrorBoundary.tsx:64-90` (оставить статические импорты; ветку `:88` заменить выбором из `{ "zh-CN": zhCN, "en-US": enUS }[locale] ?? enUS` — для двух локалей результат тот же)
- `ui/src/SettingsPage.tsx:1278`, `ui/src/WorkspaceSidebar.tsx:745` → `isLocale(value)`
- `desktop/src/renderer/src/main.tsx:137`, `desktop/src/renderer/src/desktopPlatform.ts:161`
- `desktop/src/main/desktopApplicationMenu.ts:33-38`
- `web/src/auth/webAuthLocale.ts:61`
- `desktop/src/preload/codingPlanWebview.ts:127, 141` **не трогать**: сериализуемая функция `executeInMainWorld`, импорты недоступны (F5).
- CLI `i18n/src/locale.ts` не трогать: отдельный стек, новую зависимость на `@zcode/shared` не вводить.

Явные ветки вместо «не en → zh» (F2). Условие переворачивается на `=== "zh-CN" ? zh : en`; для двух текущих локалей результат идентичен:

- `services/src/bots/botsService.ts:407, 551, 589, 653, 1321, 1435, 4179, 4603`, `bots/messages.ts:254` (`normalizeBotMessageLocale`: `zh-CN` → zh, иначе `en-US`; `DEFAULT_BOT_MESSAGE_LOCALE` не менять), `bots/replyFormatter.ts:352`
- `ui/src/lib/conversationShareError.ts:297-321`
- `ui/src/updateReleaseNotes.ts:21-25`: `byLocale[locale] ?? (locale === "zh-CN" ? default : locale === "en-US" ? (byLocale["zh-CN"] ?? default) : (byLocale["en-US"] ?? default))`. Для zh и en поведение не меняется; для uk цепочка `uk → en → default` без zh (D14). Тест: `packages/ui/test/updateReleaseNotes.test.ts` на все три ветки (для uk — через приведение типа до I3)
- `desktop/src/main/autoUpdater.ts:777-786` `pickFallbackReleaseNotesMarkdown`: `menuLocale → (menuLocale === "zh-CN" ? zh : en) → другая`. Для zh и en результат прежний (у en сейчас `en → zh → en`, то есть фактически `en → zh`)
- `web/src/main.tsx:245` **не трогать** (D13)
- `shared/src/remoteAppConfig.ts:61-64` и вызовы `helpAppConfig.ts`: передавать `toServiceLocale(locale)`

Сузить собственные типы (F7) до `ServiceLocale`/`Locale`: `CodingPlanWebviewLocale = ServiceLocale`; `FeedbackSubmission.locale?: ServiceLocale` (+ `feedbackSubmitSubmission.ts:56` вызывает `toServiceLocale`); `test-actions.ts:24-26` → `Locale`; `botsService.ts:208` → `Record<ServiceLocale, string>` + `toServiceLocale`.

Мёртвый код из F8 **не удалять** (D11). Zustand `locale` (`store/index.ts`) не трогать вообще: он хранит произвольную строку и с `Locale` не связан. `preferSettingServiceLocale` сохранить; при замене `isLocale`/`isLocalePreference` в `IntlProvider.tsx` его ветки должны работать как раньше. `LocaleSwitcher.tsx` перевести на `isLocale` не нужно (там только `Record<Locale, string>`), его дополняют в I3.

Тесты: новый `packages/ui/test/localeSupport.test.ts`:

- `matchSupportedLocale`: `"zh"`, `"zh-TW"`, `"zh_CN.UTF-8"` → `zh-CN`; `"en-GB"` → `en-US`; `"ru-RU"`, `"uk-UA"` (до I3) → null;
- `resolveSystemLocale("")` → `DEFAULT_LOCALE`; `"de"` → `en-US`;
- `toServiceLocale`;
- `isLocale`/`isLocalePreference`.

Готово, когда: тесты и проверки зелёные; `rg -n 'startsWith\("zh"\) \? "zh-CN" : "en-US"' packages` пусто; `pnpm knip` не показывает **новых** неиспользуемых экспортов (существующие из F8 остаются).

### I2 — Движок i18n: фолбэк через en-US и явная плюрализация

1. Вынести чистую логику из `IntlProvider.tsx` в новый `packages/ui/src/i18n/createIntl.ts` (без React, чтобы тестировать):

   ```ts
   export interface IntlInstance {
     formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
     /** Явная плюрализация: id — база семейства без суффикса; values.count подставляется автоматически. */
     formatPlural(
       descriptor: { id: string },
       count: number,
       values?: Record<string, string | number>,
     ): string;
   }
   export function createIntl(
     locale: Locale,
     catalogs: Partial<Record<Locale, Record<string, string>>>,
   ): IntlInstance;
   ```

   - Цепочка: `[locale, FALLBACK_UI_LOCALE]` без дублей (D2).
   - `formatMessage`: первый каталог из цепочки, где есть `id` → иначе `id`.
   - `formatPlural`: для **каждого** каталога цепочки свой `new Intl.PluralRules(catalogLocale).select(count)` (кэшировать по локали). Для каталога берётся `${id}.${category}`, если его нет — `${id}.other`. Если в каталоге нет ни того ни другого — переходим к следующему каталогу. Иначе `${id}.other` как id. Категорию **нельзя** переносить между языками: uk `one` для 21 в en дал бы «21 file».
   - Подстановка `{count}` и `values` — как сейчас (`replaceAll`).
   - `IntlProvider.tsx` импортирует `createIntl` и `MESSAGES`; `IntlInstance` реэкспортируется из `i18n/index.ts` как раньше.

2. Переименовать `.many` → `.other` в 4 семействах (`chat.codeComments`, `chat.webElements`, `chat.pptxElements`, `chat.toolCall.workflow.timeline.roster.unlisted`) в **обоих** каталогах.
3. Привести все 35 семейств из F4 к виду `<база>.one` / `<база>.other` в **обоих** каталогах:
   - A: `.many` → `.other`; у `chat.toolCall.workflow.script.summary.{phases,steps}` база без суффикса → `.other`;
   - B: `xxxOne` → `xxx.one`, `xxx` → `xxx.other` (например, `workflows.hub.invalid.one/.other`);
   - C: `card.phase`/`card.phases` → `card.phases.one`/`card.phases.other` (аналогично `agents`, `agentsWorking`, `artifacts`, `digest.questions`). Хелпер `count()` в `timeline-summary.ts:45` заменить вызовом `formatPlural`.
     Перед переименованием проверить, что ключ не используется ещё где-то по полному имени (`rg -n '<ключ>' packages`), включая шаблонные строки с `${I18N_PREFIX}`.
4. Перевести все места вызова из F4 на `intl.formatPlural({ id: "<база>" }, count, values)`. Если место вызова передаёт свой `count` (`String(n)` или `n.toLocaleString()`), передавать его в `values` без изменений — `values.count` перекрывает автоподстановку, иначе изменятся разделители тысяч в zh/en. Контрольный поиск после правки — команды из F4: каждое оставшееся совпадение `=== 1` должно быть не про текст, совпадений `[a-z]One"` не остаётся.
5. Новые плюральные семейства в zh/en оформлять как `.one`/`.other`. В uk — `.one/.few/.many/.other`, и **все** uk-формы (включая `.one`) содержат `{count}`: у `uk` категория `one` выпадает и на 21, 31…, поэтому литерал «1 файл» в `.one` неверен. Для zh `Intl.PluralRules("zh").select(1) === "other"`, так что zh `.one` после перехода не используется; оставить его ради parity-теста.

Тесты:

- `packages/ui/test/intlPlural.test.ts`:
  - **эквивалентность**: для каждого семейства из F4 и `count ∈ {0,1,2,5,21}` новый `formatPlural` в zh и en даёт ту же строку, что старая логика `count === 1 ? .one : .other` (по каталогам после переименования). Если для zh `count=1` текст `.one` ≠ `.other` с подстановкой — выровнять zh `.other`, чтобы он содержал `{count}`, и зафиксировать это в PR;
  - фолбэк: ключ, которого нет в `zh-CN`, но есть в `en-US`, → английский; ключа нет нигде → `id`;
  - на синтетическом uk-каталоге: `1→one, 2→few, 5→many, 21→one, 1.5→other`; отсутствующая форма → `.other` → en-каталог с en-категорией.
- `packages/ui/test/i18nCatalogParity.test.ts` (импорт модулей каталогов, **не** regex: ключ и значение бывают на разных строках):
  - множества ключей en и zh равны, кроме явного allowlist `KNOWN_EN_ONLY_KEYS = ["settings.memory.viewer.disabled"]` (мёртвый ключ остаётся по D11; allowlist сверяется точно — лишний или устаревший элемент роняет тест);
  - для каждого ключа множество плейсхолдеров `{name}` в zh ⊆ en (для плюрального ключа сравнивать с en `.other`);
  - HTML-теги и количество `**` совпадают (7 таких значений);
  - каждое семейство с `.one` имеет `.other` (в каждом каталоге);
  - каталог `uk-UA` (с I3): ключи ⊆ (ключи en ∪ uk-плюральные формы семейств en); плейсхолдеры, HTML и `**` — как у en; у каждого переведённого семейства есть `one/few/many/other`, и каждая из этих форм содержит `{count}`.

Готово, когда: тесты зелёные, визуально в zh/en тексты не изменились (ручная проверка 3–4 мест из F4).

### I3 — Тип `uk-UA` и выбор языка (видимо, в ветке — см. D12)

- `shared/src/protocol.ts:78`: `Locale = "zh-CN" | "en-US" | "uk-UA"`.
- `shared/src/validationAppSettings.ts:35-36`: добавить `"uk-UA"` в оба enum.
- `shared/src/locale.ts`: `"uk-UA": { languagePrefix: "uk", serviceLocale: "en-US" }`; обновить тест `localeSupport` (`uk`, `uk-UA`, `uk_UA.UTF-8` → `uk-UA`).
- `packages/ui/src/i18n/locales/uk-UA.ts`: формат как у других (`const ukUA: Record<string, string> = {…}; export default ukUA;`). На этом шаге в нём только эндонимы и ключи выбора языка, остальное берётся из en по фолбэку. Подключить в `MESSAGES` и `ErrorBoundary` (`{…, "uk-UA": ukUA}`).
- Пункты выбора:
  - `ui/src/settingsPageHelpers.tsx` (~296-318): `SelectItem value="uk-UA"` с `data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "uk-UA")}`, ключ `settings.locale.uk-UA`;
  - `ui/src/WorkspaceSidebarFooter.tsx` (~245-262): `DropdownMenuRadioItem value="uk-UA"`, ключ `sidebar.settings.locale.uk-UA`;
  - значение `"Українська"` для обоих ключей во **всех трёх** каталогах;
  - обработчики уже используют `isLocale` (I1).
- Закрыть ошибки компиляции `Record<Locale, …>` (F10):
  - короткие нативные строки перевести сразу: `desktopMenu.ts`, `about.ts`, `desktopWindowsOpenFolderContextMenu.ts`, `desktopFinderOpenFolderWorkflow.ts`, `conversationShareService.ts:236`, `desktop/src/renderer/cuaPermissionPanelMessages.ts:12`;
  - CUA `indicatorCopy` (`windowsCuaOperationIndicatorContent.ts:14-17`): компилятор не подскажет (тернарник, F10). Перевести на `Record<Locale, { text; width }>` и подобрать `width`, чтобы украинский текст помещался; проверить визуально на Windows или по расчёту ширины;
  - `conversation-share.ts:14`: `"uk-UA": ""`, то есть английская версия сайта; `parseConversationSharePathname` не трогать;
  - `builtinSkillI18n.ts:44` → `Record<string, Partial<Record<Locale, string>>>`; в `resolveSkillDisplayDescription` (`:181-186`) добавить фолбэк `?.[locale] ?? ?.["en-US"]`;
  - `desktopOAuthDeepLink.ts:142`: закрыть `TODO(i18n)` полным `Record<Locale, …>`.
- `Partial<Record<Locale,…>>` (release notes, community URL) уже покрыты фолбэком/`toServiceLocale` из I1. Проверить `autoUpdater.ts:629` (цикл по `["zh-CN","en-US"]`) — оставить, так как сервер отдаёт только их.
- Coding Plan webview / preload: ничего не менять — `codingPlanEmbeddedWebview.ts:201, 310` уже сводят любую локаль к `zh-CN | en-US` (F5).
- `gitCommitMessageGenerator.ts:226`: `uk-UA` → `"Ukrainian"` (D8).
- `desktop/electron-builder.config.js:471`: `electronLanguages: ["en-US", "zh-CN", "uk"]`.

Готово, когда: можно выбрать «Українська» в обоих местах; выбор сохраняется в `setting.json` (`locale: "uk-UA"`, `localePreference: "uk-UA"`); меню приложения переключается через `ApplicationLocaleChanged`; непереведённые строки показываются по-английски; китайского нет нигде. Ручная проверка `pnpm dev:desktop` и `pnpm dev:web`.

### I4 — Перевод UI-каталога (~5 876 ключей)

- Пакеты по префиксам (раздел 7), по одному PR на 1–3 пакета. После каждого пакета зелёный `i18nCatalogParity` и выполненное агентское ревью (раздел 7.1).
- `settings.memory.viewer.disabled` не переводить (мёртвый, D11); в проверке полноты он входит в тот же allowlist.
- После последнего пакета включить в parity-тесте проверку **полноты**: ключи uk ⊇ ключи en, где для плюральных семейств вместо `.one/.other` ожидаются `.one/.few/.many/.other`.
- Строки с «(s)» и `{count}` вне плюральных семейств — правило из раздела 7.

Готово, когда: проверка полноты зелёная; сделан визуальный проход по F13 (I9 можно начинать параллельно с последними пакетами).

### I5 — Форматирование дат и чисел

- Переписать на `Intl.RelativeTimeFormat` / `Intl.NumberFormat` / `Intl.DateTimeFormat(locale)` вместо веток по `zh-CN` (F9): `workDuration`, `conversationWorkDuration`, `memoryUpdatedAt`, usage stats; `commit.tsx:106` (сейчас жёстко `Intl.RelativeTimeFormat("en")`).
- Вне рамок: 27 вызовов `toLocaleString()` без локали — они следуют ОС, а не приложению (поведение уже существующее).

Готово, когда: эти места для uk показывают украинский формат, а вывод для zh/en не изменился (юнит-тест на функцию, если она чистая).

### I6 — Контентные каталоги и остальные `zh-CN`-ветки

- Пройти список из F9 (`rg` в F9). Каждое место либо перевести на ключ UI-каталога или `Record<Locale,…>`, либо оставить английский фолбэк с явным решением в PR.
- builtin skills (`builtinSkillI18n.ts`): добавить `uk-UA`. Automation templates, suggested prompts, saved workflows, official plugin definitions: `*_i18n` уже поддерживает префикс языка через `resolveLocalizedText` (`shared/src/plugin-display-name.ts`), проверить ключ `uk`.
- Main-процесс: `forceUpdatePrompt`, `embeddedBrowserJavaScriptDialog`, `autoUpdater` диалоги, `main/index.ts:865` и `:1317`.
- Имена провайдеров: `resolveProviderTemplateName` (`provider-config.ts:296-306`) уже падает в en. Передавать `toServiceLocale(locale)`, строгую схему не расширять (это бренды).

### I7 — Боты

- `BotMessageLocale` (`bots/messages.ts`) расширить до `Locale`, добавить украинские сообщения; `normalizeBotMessageLocale` → `uk-UA`.
- Ветки из F2 (уже явные после I1) дополнить uk. Источник локали — `settings.locale` (кэш `botsService.ts:1000`).
- Команды — D10: имена английские, алиасы не добавлять.

### I8 — CLI/TUI (`apps/zcode-cli`)

- `SupportedLocale` (`contracts/src/config/index.ts:279`), `GlobalLocale` (`shared-types/src/index.ts:16`), `SUPPORTED_LOCALES`/`isSupportedLocale`/`normalizeLocale` (`i18n/src/locale.ts`: `uk`/`uk-*` → `uk-UA`), `uiSchema.locale` enum (+ `.catch` из I0 остаётся), каталог `i18n/src/locales/uk-UA.ts` (`ZCodeCopy` — TS проверит полноту), `/locale`-команда.
- Проверка: `pnpm --dir apps/zcode-cli/packages/i18n typecheck`, тесты `apps/zcode-cli/packages/bootstrap/test` (если касаются).

### I9 — QA

- Визуальный проход длинных строк (F13): Settings, табы, футер сайдбара, composer-чипы, tool-call заголовки, диалоги, mobile-ширина в `pnpm dev:web` (DevTools 375 px), светлая и тёмная темы.
- Сценарии приёмки из раздела 9 — вручную (E2E-инфраструктуры нет, F15). Записать результаты в PR.

## 6. Проверка

Обязательно после каждой итерации (из корня). В свежем worktree сначала `pnpm install --frozen-lockfile` (без `node_modules` не работают ни проверки, ни `oxfmt`, ни `node --import tsx`); базовую линию перепроверить на своей базе перед I0 (на `dev` 66b0293 подтверждено: lint 0 ошибок / 70 предупреждений, typecheck OK).

```bash
pnpm typecheck
pnpm lint            # 0 ошибок; предупреждений не больше базовых 70
pnpm fmt:check       # при необходимости: pnpm exec oxfmt <files>
pnpm architecture:check --changed
```

Тесты запускаются **из каталога пакета** (из корня алиас `@/` не резолвится):

```bash
cd packages/ui && node --import tsx --test test/localeSettingsSchema.test.ts test/localeSupport.test.ts test/updateReleaseNotes.test.ts test/intlPlural.test.ts test/i18nCatalogParity.test.ts
cd packages/services && node --import tsx --test test/<file>.test.ts   # если добавлены тесты ботов (I7)
```

Дополнительно: `pnpm knip` (I1), `pnpm --dir apps/zcode-cli/packages/i18n typecheck` (I0, I8).

| Тест (новый)                                    | Итерация | Что доказывает                               |
| ----------------------------------------------- | -------- | -------------------------------------------- |
| `packages/ui/test/localeSettingsSchema.test.ts` | I0       | неизвестная локаль не стирает настройки      |
| `packages/ui/test/localeSupport.test.ts`        | I1, I3   | хелперы `shared/src/locale.ts`               |
| `packages/ui/test/updateReleaseNotes.test.ts`   | I1       | release notes без zh для uk (D14)            |
| `packages/ui/test/intlPlural.test.ts`           | I2       | фолбэк и CLDR-плюралы, эквивалентность zh/en |
| `packages/ui/test/i18nCatalogParity.test.ts`    | I2–I4    | ключи, плейсхолдеры, разметка, полнота       |

Пробелы (не покрыты автотестами, только ручная проверка): синхронизация окон через broadcast, меню main-процесса, `.pak` Chromium, раскладка длинных строк, CLI-схема (если в `adapters` нет тестов).

## 7. Руководство по переводу (I4)

Пакеты (по размеру): `settings.*` 1 845 (разбить по второму сегменту), `chat.*` 1 345 (разбить: `chat.toolCall.*`, остальное), `feedback.*` 291, `bots.*` 259, `automations.*` 174, `conversationShare.*` 165, `git.*` 154, `workflows.*` 105, `offPeak.*` 89, `codeViewer.*` 71, остальные ~80 префиксов — одним-двумя пакетами. Список префиксов: `node --import tsx -e "import('./packages/ui/src/i18n/locales/en-US.ts').then(m=>{const c={};for(const k of Object.keys(m.default)){const p=k.split('.')[0];c[p]=(c[p]||0)+1}console.log(c)})"`.

Правила:

- Источник — `en-US.ts`; `zh-CN.ts` использовать для уточнения смысла.
- Сохранять дословно `{placeholders}`, HTML-теги, `**`, `\n`, ведущие и замыкающие пробелы, сочетания клавиш (`⌘`, `Ctrl`), пути, команды, URL.
- Строки с «(s)» и `{count}` вне плюральных семейств переводить нейтрально, с числом после двоеточия: «Файлів: {count}». Если строка часто видна и нейтральная форма звучит плохо — завести плюральное семейство (en `.one/.other`, zh `.other`, uk 4 формы) и перевести место вызова на `formatPlural`.
- Обращение на «ви», интерфейсный стиль коротких действий («Зберегти», «Скасувати»), без кальки с русского.
- Не переводить: ZCode, Z.ai, GLM, Coding Plan, Start Plan, MCP, Git, имена моделей и провайдеров, названия команд (`/help`), `CLAUDE.md`/`AGENTS.md`.
- Глоссарий (стартовый; расширять в PR):

  | en                                                                        | uk                                                                  |
  | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
  | workspace                                                                 | робочий простір                                                     |
  | task / session                                                            | завдання / сеанс                                                    |
  | conversation                                                              | розмова                                                             |
  | agent / subagent                                                          | агент / субагент                                                    |
  | skill                                                                     | навичка                                                             |
  | plugin / marketplace                                                      | плагін / маркетплейс                                                |
  | automation / workflow                                                     | автоматизація / робочий процес                                      |
  | memory                                                                    | пам'ять                                                             |
  | commit / branch / diff                                                    | коміт / гілка / diff                                                |
  | settings                                                                  | налаштування                                                        |
  | Official Marketplace, Personal Source, Featured, Installed (`CONTEXT.md`) | Офіційний маркетплейс, Особисте джерело, Рекомендоване, Встановлені |

### 7.1 Агентское ревью перевода (D5)

Ревью выполняет **отдельный проход агента**: новая сессия или субагент, а не тот же контекст, в котором делался перевод. Ревью проходит каждый пакет перед мерджем.

1. Автоматика: `i18nCatalogParity` зелёный (плейсхолдеры, HTML, `**`, плюральные формы).
2. Агент проверяет каждую строку пакета (en → uk) по списку:
   - смысл совпадает с en (при сомнении сверяться с zh);
   - термины соответствуют глоссарию; одинаковые en-строки переведены одинаково;
   - нет русизмов и калек с русского (например, «на протязі», «приймати участь», «слідуючий», «співпадати»), нет русских букв `ы э ъ ё`; апостроф единообразный (`'`);
   - обращение на «ви», повелительное наклонение для кнопок;
   - для плюральных семейств: формы `one/few/many/other` грамматически верны для 1, 2, 5, 21, 1,5;
   - длина: строки длиннее en более чем в 1,5 раза для кнопок, табов и пунктов меню (ключи с `button`, `tab`, `menu`, `action`, `title` в имени) выписать в список для визуальной проверки I9 или сократить.
3. Механическую часть пункта 2 (русские буквы, апостроф, длина) оформить в `i18nCatalogParity` как проверки над `uk-UA`: запрещённые символы роняют тест, а длина только выводит отчёт.
4. Результат ревью записать в описание PR: число проверенных строк, исправленные строки (ключ, было → стало), список длинных строк для I9.

## 8. Версионный перекос

| Комбинация                                                | Поведение                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Новый desktop пишет `uk-UA`, затем откат на версию без I0 | **сброс всех настроек** при следующей записи (F1). Именно поэтому D6       |
| Откат на версию с I0, но без I3                           | язык → `zh-CN`/`system`, остальные настройки сохранены                     |
| Новый desktop + web из того же хоста                      | ассеты от того же процесса — версии совпадают                              |
| Remote workspace host старой версии                       | читает свой `setting.json`; `uk-UA` туда не пишется, пока host не обновлён |
| Внешние сайты (share, coding plan, community, feedback)   | получают `toServiceLocale` → `en-US`                                       |
| CLI до I8 при `LANG=uk_UA.UTF-8`                          | `en-US` (без изменений)                                                    |

## 9. Сценарии приёмки

| #   | Подготовка                                                | Действие                                                      | Ожидание                                                                                                         | Доказательство                         |
| --- | --------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | язык zh                                                   | Settings → «Українська»                                       | UI сразу на украинском; после перезапуска сохраняется; `setting.json`: `locale` и `localePreference` = `"uk-UA"` | ручная проверка + файл                 |
| 2   | два окна desktop                                          | сменить язык в первом                                         | второе окно переключается, цикла broadcast нет                                                                   | ручная проверка, логи                  |
| 3   | ОС на украинском, `localePreference: system`              | запуск                                                        | UI, меню приложения, трей — украинские                                                                           | ручная проверка (macOS/Windows)        |
| 4   | web (`pnpm dev:web`)                                      | выбрать «Українська» в футере                                 | язык применяется, после перезагрузки сохраняется (localStorage)                                                  | ручная проверка                        |
| 5   | `uk-UA`, ключ отсутствует в uk                            | открыть экран                                                 | английский текст, не китайский и не `id`                                                                         | `intlPlural.test.ts` + ручная          |
| 6   | `uk-UA`                                                   | 1 / 2 / 5 / 21 файл в сводке изменений                        | «1 файл / 2 файли / 5 файлів / 21 файл»                                                                          | `intlPlural.test.ts`                   |
| 7   | `uk-UA`                                                   | ErrorBoundary, ошибки шаринга, сообщения ботов, release notes | украинский или английский, **никогда** китайский                                                                 | ручная + тесты I1                      |
| 8   | `setting.json` с `"locale":"xx-XX"` и другими настройками | запуск, затем любое изменение настроек                        | остальные настройки сохранены, язык по умолчанию                                                                 | `localeSettingsSchema.test.ts`         |
| 9   | `uk-UA` (desktop и web)                                   | поделиться разговором; открыть community                      | ссылки ведут на английскую версию (кроме community в web — D13); кнопка community видна                          | ручная                                 |
| 10  | `uk-UA`, узкое окно и 375 px web                          | пройти основные экраны                                        | длинные подписи не ломают раскладку                                                                              | ручная (I9)                            |
| 11  | `zh-CN` и `en-US`                                         | пройти места из F4                                            | тексты не изменились                                                                                             | `intlPlural.test.ts` (эквивалентность) |

## 10. Вне рамок

- Смена `DEFAULT_LOCALE` (D9); другие языки, включая `ru`.
- Lazy-load каталогов (D7).
- Чистка мёртвого кода из F8 (D11): Zustand `locale`, `LocaleSwitcher`, `preferSettingServiceLocale`, `settings.memory.viewer.disabled`.
- Вызовы `toLocaleString()` без явной локали (27 мест).
- Украинская версия внешних сайтов (share, coding plan, community, release notes на сервере).
- Исправление выбора локали community в web (`web/src/main.tsx:245`, D13): сейчас всегда `zh-CN`, для uk тоже.
- Украинские алиасы команд ботов (D10).

## 11. Расхождение с seed-графом

- `graph-drift-candidate`: в `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` нет узла для i18n/локали. Предлагаемый узел `capability.ui-locale`: владелец `ZCodeIntlProvider` (`packages/ui/src/i18n/IntlProvider.tsx`), persistence — `setting.json` `locale`/`localePreference` (`appSettingsSchema`), канал `state:locale`, main — `applyApplicationLocale` + `ApplicationLocaleChanged`; отдельный узел для CLI `@zcode/i18n`. Граф не редактировался: контракт `docs/skills/feature-boundary-graph.md`, на который ссылается файл, в checkout отсутствует.
