# Themes（палитры интерфейса и настройки терминала）

> Статус: **реализация**. Проверено кодом, юнит-тестами и в браузере (web, палитры light/dark). WebGL, Electron и TUI не запускались (см. §8). Документ фиксирует решения, принятые при реализации, и отмечает то, что сознательно не сделано.
>
> Ориентиры: `packages/ui/src/useTheme.ts`, `packages/ui/src/store/index.ts`, `packages/ui/src/styles.css`, `packages/ui/src/terminal/TerminalSession.tsx`, `apps/zcode-cli/packages/tui/src/theme/defaults.ts`. Перед правкой ищи по символу, номера строк ориентировочные.

## 0. Как исполнять

- Порядок: spec → палитры (состояние и CSS) → выбор палитры в настройках → WebGL → i18n → CLI → проверка.
- После каждой итерации: `pnpm typecheck`, `pnpm lint` (0 ошибок в изменённых файлах; предсуществующие `max-lines` в CLI не учитываются), `npx oxfmt --check <изменённые файлы>` (не репозиторный `pnpm fmt`), `pnpm architecture:check --changed`.
- Решения, которых нет в таблице ниже, согласовать с пользователем, а не выбирать самостоятельно.

## 1. Решения

| #   | Решение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Палитра и режим — два независимых выбора. Режим: `light` / `dark` / `system`. Палитра: `neutral`, `zai` и 8 акцентных палитр.                                                                                                                                                                                                                                                                                                                                                                                             |
| D2  | **Не подтверждено.** CLI хранит `ui.theme` в собственном конфиге (`~/.zcode/config.json`, `apps/zcode-cli/packages/contracts/src/config/index.ts:79,300`). Desktop не передаёт тему в CLI (в `packages/` нет `ui.theme`/`--theme`). Поэтому CLI получает **отдельный** ключ `ui.palette` и не синхронизируется с desktop. Мост desktop→CLI не строим. Вопрос пользователю остался без ответа; решение принято самостоятельно и требует подтверждения до слияния.                                                          |
| D3  | Хранение desktop/web — как у существующей темы: localStorage + broadcast между окнами (`BROADCAST_FIELDS`). Серверная запись не нужна: CLI не читает тему desktop, а кросс-устройственная синхронизация не запрашивалась.                                                                                                                                                                                                                                                                                                 |
| D4  | WebGL-рендерер xterm — переключатель в настройках терминала, по умолчанию **выключен**. При ошибке активации аддон освобождается явно (`dispose()`), терминал остаётся на DOM. При потере WebGL-контекста — откат на DOM без падения. Флаг читается через `useZCodeStoreWithDefault(…, false)`: без `StoreProvider` он молча равен «выключено». Число одновременных WebGL-контекстов в браузере не проверено.                                                                                                             |
| D5  | Список палитр фиксирован. Палитры не загружаются извне и не добавляются пользователем.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D6  | Акцентная палитра переопределяет `--color-brand`, `--color-accent`, `--color-primary`, `--color-primary-foreground`, а в светлом блоке ещё `--color-ring`. Без `--color-primary` кнопки, переключатели, чекбоксы и бейджи (около 56 мест `bg-primary`) не меняются, и выбор палитры почти не виден. **Принято самостоятельно**, пока пользователь был недоступен; требует подтверждения.                                                                                                                                  |
| D7  | Поверхности (фон, боковая панель, шапка, панели, карточки, всплывающие окна, поля ввода) тонируются акцентом палитры (см. §2). Видимая боковая панель на web/Windows/Linux — это `--color-background-win-alt`; на macOS — `--color-background-alt` (vibrancy), который выражен через win-alt. Оба тонируем. Текст и выделения (`--color-selected`, `--color-hover`) не меняются. **Принято по прямому запросу пользователя** («я думал что будет менятся и фон и т.д.»); интенсивность тинта требует визуальной проверки. |

## 2. Палитры

- `neutral` — базовые токены `:root` / `.dark` без палитры. Миграция его не использует: старые значения переходят в `zai` (см. §4).
- `zai` — полный скин: классы `theme-zai-light` / `theme-zai-dark` ставятся только для него. Все старые значения (`light`, `dark`, `system`, `zai-*`) мигрируют в `zai`; он же значение по умолчанию.
- `ocean`, `forest`, `ember`, `violet`, `slate`, `rose`, `sand`, `mint` — переопределяют `--color-brand`, `--color-accent`, `--color-primary` и `--color-primary-foreground` (D6). `--color-accent` = `color-mix(in oklab, <hex> 12%, transparent)` в light и 16% в dark. В светлом блоке также задаётся `--color-ring: var(--color-primary)`. Поверхности (D7) тонируются акцентом в OKLab, значения записаны готовыми hex: `--color-background` — 10% поверх `#fafafa` (light) и 12% поверх `#171717` (dark); `--color-sidebar` — 22% поверх `#f5f5f5` (light) и 10% поверх `#0a0a0a` (dark); `--color-card`, `--color-popover`, `--color-input` — 5% поверх `#ffffff` (light) и 9% поверх `#262626` (dark). Видимая боковая панель на web, Windows и Linux рисуется корневым элементом окна (`DesktopWindowFrame.tsx:43`) через `--color-background-win-alt`; компоненты `--color-sidebar` не читают. Поэтому win-alt тонируется отдельно: 12% поверх `#e5e5e5` (light) и 12% поверх `#262626` (dark), значения в таблице ниже. Светлая панель темнее фона (отношение ≈ 1.22–1.23), тёмная светлее (≈ 1.20–1.24). `--color-background-alt` (macOS с vibrancy и свёрнутая панель `WorkspaceSidebarCollapsedRail.tsx`) каждый блок палитры задаёт явно: `color-mix(in oklab, var(--color-background-win-alt) 60%, transparent)`, та же формула, что в `.theme-zai-dark`. Без этого на macOS палитра не меняла боковую панель. `--color-header` и `--color-panel` повторяют sidebar в light и background в dark, как и базовые токены. Текст (`--color-foreground`) не меняется. `--color-primary-foreground`: `#fafafa` в light и `#0a0a0a` в dark.

Акцентные цвета (light / dark), одинаковые для `--color-brand` и `--color-primary` в каждом режиме:

| Палитра | light     | dark      |
| ------- | --------- | --------- |
| ocean   | `#2563eb` | `#60a5fa` |
| forest  | `#15803d` | `#4ade80` |
| ember   | `#c2410c` | `#fb923c` |
| violet  | `#7c3aed` | `#a78bfa` |
| slate   | `#475569` | `#94a3b8` |
| rose    | `#be185d` | `#f472b6` |
| sand    | `#a16207` | `#facc15` |
| mint    | `#0f766e` | `#2dd4bf` |

Поверхности (D7): фон / боковая панель / карточка. `--color-header` и `--color-panel` совпадают с боковой панелью в light и с фоном в dark. Значения сверены с `styles.css`.

| Палитра | light фон | light боковая | light карточка | dark фон  | dark боковая | dark карточка |
| ------- | --------- | ------------- | -------------- | --------- | ------------ | ------------- |
| ocean   | `#e4ecfb` | `#c6d7f7`     | `#f4f8ff`      | `#20262e` | `#12171d`    | `#2c3037`     |
| forest  | `#e5eee6` | `#c8dbcb`     | `#f4f9f5`      | `#202b23` | `#121b14`    | `#2c342e`     |
| ember   | `#f7e8e3` | `#efcfc5`     | `#fdf6f3`      | `#2e241e` | `#1d1610`    | `#372f2a`     |
| violet  | `#ece9fb` | `#d7d0f7`     | `#f7f6ff`      | `#25242e` | `#16151d`    | `#302f37`     |
| slate   | `#e7e8eb` | `#cccfd5`     | `#f5f6f7`      | `#242527` | `#151618`    | `#2f3031`     |
| rose    | `#f7e6e9` | `#efcad1`     | `#fef5f6`      | `#2e2227` | `#1d1318`    | `#372d31`     |
| sand    | `#f2eae4` | `#e4d4c5`     | `#fbf7f3`      | `#2d291e` | `#1d1a11`    | `#36332a`     |
| mint    | `#e4eceb` | `#c7d8d6`     | `#f4f8f7`      | `#1f2a28` | `#111a18`    | `#2b3432`     |

Боковая панель (`--color-background-win-alt`):

| Палитра | light     | dark      |
| ------- | --------- | --------- |
| ocean   | `#ced7e8` | `#2d343c` |
| forest  | `#ced9d0` | `#2e3930` |
| ember   | `#e4d2cd` | `#3d322b` |
| violet  | `#d6d3e9` | `#33313c` |
| slate   | `#d1d3d5` | `#323335` |
| rose    | `#e4cfd4` | `#3c2f35` |
| sand    | `#ded5cd` | `#3c382c` |
| mint    | `#ced7d6` | `#2d3836` |

Контраст текста на поверхностях: ≥ 4.5:1 против `#404040` (light) и `#e5e5e5` (dark) для всех восьми поверхностных токенов, включая `--color-background-win-alt`. Проверяет тот же тест.

Контраст акцентного цвета проверяет `packages/ui/test/themeContrast.test.ts`: минимум 3:1 для UI-элементов против приближённых фонов `#fafafa` / `#171717`, а не против отрисованных поверхностей. Тот же тест сверяет hex в `styles.css` с реестром. `--color-primary-foreground` проверяется на ≥ 4.5:1 против primary в обоих режимах.

## 3. Владелец состояния

- `packages/ui/src/useTheme.ts` — типы `Theme` (`light` / `dark` / `system`), `ResolvedTheme`, `ThemeSelection`; `migrateThemeSelection`, `readStoredThemeSelection`, `applyTheme(mode, palette = DEFAULT_THEME_PALETTE)`. `applyTheme` ставит классы на `<html>`: `dark`, `theme-zai-*` (только для `zai`) или `palette-<id>` (только для акцентных). Хук `useTheme` удалён; из `@zcode/ui` экспортируются только типы.
- `packages/ui/src/lib/themePalettes.ts` — чистый реестр палитр: id и акцентные hex для light/dark (метки i18n UI строит по ключу `settings.themePalette.<id>`). Без IO.
- `packages/ui/src/styles.css` (блоки примерно на строках 749–870; в каждом светлом блоке задан `--color-ring`) — `.palette-<id>` (light) и `.palette-<id>.dark` (dark). `.palette-<id>.dark` (0,2,0) специфичнее `.palette-<id>` (0,1,0), поэтому тёмный вариант перекрывает светлый. Блоки стоят после базовых тем, поэтому перекрывают `:root` и `.dark`.
- `packages/ui/src/store/index.ts` — `theme` и `palette` в zustand; `palette` входит в `BROADCAST_FIELDS`. Входящий broadcast нормализуется через `migrateThemeSelection` и `isThemePalette`, эхо гасится флагом `applyingBroadcast`.
- `packages/ui/src/store/systemThemeSync.ts` — слушатель `prefers-color-scheme` (`createSystemThemeSync`). Переприменяет тему только при режиме `system`. Вынесен из store из-за лимита 400 строк.
- `packages/desktop/src/renderer/src/main.tsx`, `resource-manager.tsx` — bootstrap через `migrateThemeSelection` и `applyTheme`.
- `packages/web/src/main.tsx` — вызывает `applyTheme` и `readStoredThemeSelection`. `packages/web/index.html` (inline-bootstrap) дублирует логику классов, потому что не может импортировать `@zcode/ui`. Изменения `applyTheme` нужно переносить в `index.html` вручную.
- `terminalWebglEnabled` — в store, localStorage `zcode-terminal-webgl`. Флаг локальный и не входит в `BROADCAST_FIELDS`. Подключение аддона — `packages/ui/src/terminal/terminalWebglRenderer.ts`.

## 4. Миграция

- `zcode-theme`: `light` → (`zai`, `light`); `dark` → (`zai`, `dark`); `system` → (`zai`, `system`); `zai-light` → (`zai`, `light`); `zai-dark` → (`zai`, `dark`); пусто или неизвестно → (`zai`, `dark`).
- Все старые значения мигрируют в `zai`, потому что HEAD уже рисовал их как zai. В `git show HEAD:packages/ui/src/useTheme.ts` функция `normalizeThemePreference` (строки 21–25) превращала `light`/`dark` в `zai-light`/`zai-dark`, а `applyTheme("system")` (строки 60–80) ставил классы `theme-zai-*`. Миграция в `neutral` сменила бы внешний вид, что нарушает критерий 1.
- Новый ключ `zcode-theme-palette` для палитры. Если его нет или значение неизвестно, палитра — `zai`.
- Миграция выполняется при каждом чтении и не пишет обратно в `zcode-theme`.

## 5. Терминал

- Цвета терминала берутся только из токенов `--color-terminal-*` (`packages/ui/src/terminal/terminalTheme.ts`, `TERMINAL_THEME_TOKENS`). Палитры эти токены не задают, поэтому **смена палитры не перекрашивает терминал**. Это принятое решение; оно отличается от исходного плана и требует подтверждения.
- Смена режима (`light` / `dark` / `system`) перекрашивает xterm: `TerminalSession.tsx` наблюдает за атрибутом `class` на `<html>` через MutationObserver (строки ~356–364, ~489–498, ~859–865). Палитровые классы тоже запускают observer, но итоговые цвета те же. Проверено чтением кода, не запуском.
- WebGL: `@xterm/addon-webgl@^0.18.0` (peer `@xterm/xterm ^5.0.0`). `@xterm/xterm` остаётся на `^5.5.0`; переход на 6 вне scope. Подключение в `terminalWebglRenderer.ts`: исключение при активации (например, нет WebGL2) → аддон освобождается, терминал остаётся на DOM; потеря WebGL-контекста → откат на DOM. `TerminalSession` вызывает `setTerminalWebglRenderer` в трёх местах: при создании терминала в боковой панели (`TerminalSession.tsx` ~426), при создании в нижней панели (~794) и в эффекте переключения флага (~1102–1103), который включает или выключает рендерер на уже открытом терминале без перезагрузки.

## 6. CLI

- Новый ключ `ui.palette` (`apps/zcode-cli/packages/contracts/src/config/index.ts:79–80,260,300`, тип `UiThemePalette`): `neutral | zai | ocean | forest | ember | violet | slate | rose | sand | mint`, по умолчанию `neutral`. Сохраняется в `~/.zcode/config.json`: `adapters/src/config/schema.ts` объявляет ключ, иначе zod его отбрасывает. Некорректное значение приводится к `undefined`. В `config-factory.ts` нет трекера источника для `palette`; это не исправлено.
- D7 (поверхности) в TUI не применяется: переопределяются только акценты.
- TUI: все потребители читают тему через `activeTuiTheme()` (`apps/zcode-cli/packages/tui/src/theme/state.ts`). `resolveTuiThemeTokens(mode, palette)` (`tui/src/theme/palettes.ts`) переопределяет только `primary`, `accent` и `borderActive` для акцентных палитр в режиме `light` или `dark`. `neutral` и `zai` ничего не переопределяют.
- TUI не может импортировать `@zcode/ui`, поэтому таблица акцентов продублирована (`ACCENT_OVERRIDES`). Её нужно держать в синхроне с `themePalettes.ts` вручную. Тестов в `packages/tui` нет; проверено typecheck и lint.

## 7. Что не делаем в этой итерации

- Список «Недавние» палитры — не реализуется: достаточно Select.
- Акцентные палитры строятся на базе `neutral`, а не `zai`. Комбинация «фон zai + акцент» не поддерживается.
- Токен `--color-ring` используется в `styles.css:1602` и примерно в 46 местах (`ring-ring`, `border-ring`, `outline-ring`), но в базовых темах не определён. Это предсуществующая проблема: кольцо фокуса без цвета во всех темах, включая zai. Палитры задают его только в светлых блоках (D6). Глобальное определение — отдельная задача. Кроме того, глобальная супрессия фокуса (`styles.css:121–127`) скрывает и цветные кольца палитр (§9).
- Выделения (`--color-selected`, `--color-hover`), бордеры и текст не перекрашиваются (D7).
- Серверное хранение палитры (см. D2/D3).
- Кастомные палитры пользователя.

## 8. Критерии приёмки

1. Старые значения `zcode-theme` дают тот же внешний вид, что и до изменения (`light`/`dark`/`zai-*`). _Миграция проверена тестом; внешний вид не проверен._
2. Смена палитры в настройках меняет primary-контролы, кольца фокуса и поверхности (фон, боковая панель, карточки) без перезагрузки. _Web: проверено в браузере (классы `<html>`, CSS-переменные, `localStorage`, восстановление после reload) в light и dark. Desktop (Electron) и визуальная оценка не проверены. Оговорка: кольца фокуса меняются как переменная, но визуально невидимы из-за глобальной супрессии фокуса (`styles.css:121–127`, §9)._
3. Смена режима (`light` / `dark` / `system`) перекрашивает открытый терминал. Смена палитры терминал не перекрашивает (см. §5). _Проверено чтением кода; вручную не проверено._
4. Переключатель WebGL включает и выключает рендерер без перезагрузки; при ошибке WebGL терминал работает на DOM. _Не запускалось: WebGL в Electron не проверен._
5. В CLI `ui.palette` меняет акценты TUI; без ключа поведение прежнее. _Проверено typecheck и lint; TUI не запускался._
6. Все три языка (`en-US`, `zh-CN`, `uk-UA`) содержат новые ключи. _Проверено `i18nCatalogParity.test.ts`._
7. Тесты миграции, контраста и валидации проходят. _`themeMigration.test.ts` (10) и `themeContrast.test.ts` (6): 16 из 16 проходят. Контраст считается по приближённым фонам (§2)._

## 9. Открытые вопросы

- D2: подтвердить независимый ключ CLI `ui.palette` без моста с desktop.
- §5: нужно ли перекрашивать терминал палитрой. Сейчас не перекрашивает.
- WebGL по умолчанию выключен и не синхронизируется между окнами. Подтвердить.
- Названия палитр и акцентные hex выбраны самостоятельно.
- D6: подтвердить, что палитры переопределяют `--color-primary` и `--color-ring`. Это меняет кнопки, переключатели и чекбоксы.
- D7: подтвердить интенсивность тинта поверхностей после визуальной проверки в браузере и Electron.
- Определить `--color-ring` глобально в базовых темах или оставить решение локальным для палитр.
- Программно и клавиатурно вызванный фокус не даёт `box-shadow`. Причина найдена при проверке 2026-10-10: глобальное правило `styles.css:121–127` (`*:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }`, предсуществующее) подавляет фокус-стили на самом сфокусированном элементе. Поэтому `--color-ring` от палитр меняется как переменная, но визуально виден только в wf-\* компонентах (там outline рисуется на контейнере через `:has()`); на кнопках, полях и переключателях кольца нет. Это не связано с `:focus-visible`. Показ фокуса и глобальный ring — отдельная задача, в эту фичу не входят.
- Ручная проверка: визуал палитр в Electron, WebGL, bootstrap `index.html`, конфиг CLI, TUI.
