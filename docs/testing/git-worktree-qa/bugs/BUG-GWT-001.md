# BUG-GWT-001: Открытие папки с пробелами + unicode через второй экземпляр (`--open-workspace`) детерминированно роняет ПЕРВИЧНОЕ приложение (Electron process singleton)

- Severity: S2 (крах всего приложения по единственному программному пути открытия проекта; обход — нативный диалог выбора папки или ASCII-путь — не проверялся; сопутствующий дефект — зависший второй инстанс блокирует перезапуск)
- Кейсы: A6 (FAIL 2/2; статус/diff/ветки для R7 не проверены — проект не открылся ни разу)
- Окружение: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build, sandbox HOME), Electron 41.0.3 (`packages/desktop/package.json:111`)

## Воспроизведение с нуля

1. Фикстура R7: `"$QA_ROOT/bin/make-fixtures.sh R7"` → `$QA_ROOT/repos/проект с пробелами ü` (ветки `main`/`feature/a`/`release`).
2. Запустить QA-приложение (М 2.7): `"$QA_ROOT/bin/qa-run.sh" "$ELECTRON_BIN" . --remote-debugging-port=9339`, дождаться порта.
3. Открыть проект вторым экземпляром (М 3.6):
   `cd "$REPO/packages/desktop" && "$QA_ROOT/bin/qa-run.sh" "$ELECTRON_BIN" . --open-workspace="$QA_ROOT/repos/проект с пробелами ü"`
4. Результат: первичное приложение погибает в ту же секунду (CDP 9339 перестаёт отвечать, окно закрывается); в `$QA_ROOT/logs/electron.log`:
   `[ERROR:chrome/browser/process_singleton_posix.cc:779] additional_data_size exceeds payload length`.
5. Повтор после перезапуска приложения — тот же крах за ≤2 с (2/2). Зависший второй инстанс («ZCode QA») держит singleton userData; новые запуски молча выходят, пока его не убить.

## Ожидание

- Кейс A6: «статус, diff, ветки работают для проекта с пробелами/unicode в пути» (`$QA_ROOT/cases/A6.md`; спека: `docs/git/branch-switching-service-design.md` — git-сервис по `workspacePath`, без ограничений на символы пути).
- М 3.6 QA-PROMPT: второй экземпляр с `--open-workspace=<абсолютный путь>` — штатный способ открыть папку; путь с пробелами/unicode — валидный путь macOS.
- Electron API (`app.requestSingleInstanceLock(additionalData)` / `second-instance`): `additionalData` — произвольный сериализуемый JS-объект; строковые значения с любыми Unicode-символами и пробелами легальны и обязаны доходить до первичного инстанса без разрушительных побочных эффектов.

## Факт

- Обе попытки: первичное приложение (pid 55507, затем 77796) погибает сразу после запуска второго экземпляра; в `electron.log` дважды `process_singleton_posix.cc:779 additional_data_size exceeds payload length` (строки 27101, 28538).
- Второй инстанс (pid 77918) остаётся жив, держит singleton userData и блокирует перезапуск: новый инстанс (78022) молча выходит. После kill дерева приложение поднялось (pid 90773), сессия восстановилась.
- Git-состояние R7 не изменилось (проект так и не открылся). Статус/diff/ветки в UI для R7 не проверены — единственный программный путь открытия роняет приложение.
- Что НЕ воспроизводит крах (байтовая симуляция механизма, см. «Причина»): путь только с пробелами без не-Latin-1 символов; путь только с unicode без пробелов.

## Доказательства

- Протокол кейса: `$QA_ROOT/cases/A6.md` (хронология, pid-ы, 2/2).
- Краш-строки: `$QA_ROOT/logs/electron.log:27101` (pid 55507) и `:28538` (pid 77796).
- Скриншот восстановления после краха: `$QA_ROOT/evidence/A6-3-app-restarted.png`.
- Вывод байтовой симуляции механизма — в разделе «Причина».

## Причина

- Подтверждено (наш слой корректен; дефект целиком внутри Electron 41 / пропатченного Chromium `process_singleton_posix.cc`):
  - Наш код формирует данные вторичного инстанса правильно: `packages/desktop/src/main/index.ts:2183` — `app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv))`; `packages/desktop/src/main/desktopDeepLinkUrl.ts:251-258` кладёт путь в `additionalData.openWorkspacePath` (объект `{ openWorkspacePath: "<путь>" }`). Это документированное использование API.
  - Electron сериализует `additionalData` V8 ValueSerializer'ом (`blink::CloneableMessage`, `shell/browser/api/electron_api_app.cc`, `RequestSingleInstanceLock`) и отправляет по singleton-сокету сообщением `...\0<additional-data-size>\0<сырые байты>`.
  - Первичный инстанс токенизирует всё сообщение upstream-кодом Chromium: `chrome/browser/process_singleton_posix.cc`, `SocketReader::OnSocketCanReadWithoutBlocking` → `base::SplitString(str, std::string(1, '\0'), base::TRIM_WHITESPACE, base::SPLIT_WANT_ALL)` — каждый токен обрезается по пробельным байтам с обоих концов. Затем патч Electron 41 (`patches/chromium/feat_add_data_parameter_to_processsingleton.patch`) склеивает токены обратно через `\0` и сверяет: `if (additional_data_size > remaining_args.size()) LOG(ERROR) << "additional_data_size exceeds payload length"` — это и есть строка 779.
  - Механизм порчи (проверен эмпирически, Node `v8.serialize` = тот же ValueSerializer + симуляция `TRIM_WHITESPACE`-токенизации и склейки): путь R7 содержит кириллицу (символы > U+00FF) → V8 сериализует строку как two-byte UTF-16LE, где каждый ASCII-символ это `XX 00`, а каждый пробел — `20 00`: байт `0x20` оказывается вплотную к разделителю `\0` и УСЕКАЕТСЯ обрезкой пробелов. Для точного пути R7: объявленный размер 166 байт, после round-trip парсера — 163 (потеряны ровно 3 пробела) → срабатывает проверка на 779 → уведомление отброшено, ACK первичный не отправляет → вторичный инстанс по семантике POSIX singleton считает первичный зависшим, убивает его и забирает singleton (наблюдаемое: первичный мёртв ≤2 с; зависший вторичный держит userData; новые инстансы молча выходят).
  - Изоляция «пробелы vs unicode» (та же симуляция): путь только ASCII+пробелы — blob one-byte, NUL-байтов нет, потерь нет (краха НЕТ); путь только unicode без пробелов — NUL-байты есть, но ни один не соседствует с пробельным байтом, потерь нет (краха НЕТ); триггер — именно комбинация: хотя бы один символ > U+00FF (переводит строку в two-byte сериализацию) И хотя бы один ASCII-пробел. Симуляция: `R7 exact: declared=166 received=163 -> CORRUPT`; `ASCII only with spaces: 60/60 intact`; `Unicode, no spaces: 78/78 intact`; `/Users/osben/про ü: 62/61 CORRUPT`.
  - Это известный баг Electron, исправленный апстримом: electron/electron#52020 (симптомы 1-в-1, вплоть до строки 779), фикс electron/electron#52025 (`TRIM_WHITESPACE` → `KEEP_WHITESPACE`), смержен 2026-07-27, бэкпортирован в 42/43/44-x-y и НЕ бэкпортирован в 41-x-y (проверено: в патче ветки `41-x-y` замена `KEEP_WHITESPACE` отсутствует, 0 вхождений; в `main` — есть, строки 252-253 патча).
- Гипотеза (не проверено на уровне приложения — QA-приложение в этой сессии остановлено):
  - Точное поведение вторичного инстанса в бинарнике 41.0.3 (получает ли он лок после убийства первичного или висит на полпути) — вывод сделан по наблюдаемым эффектам (первичный убит, вторичный держит singleton) и совпадению с описанием #52020, а не трассировкой самого вторичного инстанса.
  - Обходные пути (нативный диалог / переименование в ASCII) не проверялись.

## Предлагаемое исправление

- Основное: обновить Electron с 41.0.3 до ≥42.x, содержащего electron#52025 (проверить по release notes, что фикс вошёл в конкретный минор).
- Альтернатива app-side, если обновление заблокировано: в `createDeepLinkSingleInstanceData` (`packages/desktop/src/main/desktopDeepLinkUrl.ts`) кодировать путь (например, `encodeURIComponent`/base64), а в `extractOpenWorkspacePathFromSingleInstanceData` — декодировать; тогда V8-blob остаётся one-byte и без пробельных байтов у `\0`-границ, баг не триггерится. Решение протестировать на round-trip `extractOpenWorkspacePathFromArgs([`--open-workspace=${encoded}`])` (юнит-слой, `packages/desktop/test/desktopDeepLinkUrl*.test.ts` по образцу).
- Сопутствующее: устойчивость к «вторичный инстанс убил первичный и держит singleton» — после апгрейда уходит; самостоятельно не чинить (поведение Chromium).

## Тест

- Путь: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-open-workspace-unicode-singleton.test.ts` (метка `BUG-GWT-001` в комментарии; оставлен в `pending` по `.agents/skills/e2e-case-lifecycle/SKILL.md`).
- Слой: E2E (WDIO, запуск второго экземпляра приложения из спеки). Причина выбора: причина целиком внутри пропатченного Chromium/Electron `process_singleton` — на нашем коде юнит-слой не воспроизводим (наши функции `createDeepLinkSingleInstanceData`/`extractOpenWorkspacePathFromSingleInstanceData` ведут себя корректно; дефект проявляется только при реальном межпроцессном handshake Electron).
- Статус: **not run (E2E pending)** — WDIO в QA-сессии не запускался (QA-приложение остановлено, М 7.2 для этого маршрута требует только файл спеки). Красный прогон приложения уровня кейса зафиксирован самим кейсом A6 (FAIL 2/2).
