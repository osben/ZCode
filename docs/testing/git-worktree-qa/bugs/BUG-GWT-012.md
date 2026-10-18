# BUG-GWT-012: Сырой ICU-plural шаблон в диалоге guard переключения ветки

- Severity: S4 (косметика/текст; семантика guard не нарушена — список задач и cancel работают)
- Кейсы: B6
- Окружение: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build)

## Воспроизведение с нуля

1. Фикстура R1 (basic): репозиторий с коммитами на `main` (QA-PROMPT §4).
2. QA-приложение: открыть проект `basic`, запустить живую сессию с сообщением, дающим running-задачу на 10+ секунд (например «Run these six commands…» — 5-6 отдельных bash-вызовов).
3. Через ~3 секунды после старта задачи: status panel → branch switcher → выбрать `release`.
4. Появляется guard-диалог «Switch branch?» — читать текст описания под заголовком.
5. Или без UI, минимальная проверка механизма (то, что делает рендерер):

```ts
import { createIntl } from "@/i18n/createIntl.js";
import enUS from "@/i18n/locales/en-US.js";
// → "…for {count, plural, one {# running task} other {# running tasks}}:" — plural не рендерится
createIntl("en-US", { "en-US": enUS }).formatMessage(
  { id: "branchSwitchGuard.description" },
  { count: 1, branch: "release" },
);
```

## Ожидание

Спека `specs/composer-branch-switcher-semantics.md` §2: guard — это confirm-диалог, перечисляющий затронутые активные задачи с осмысленным текстом количества («Switching the branch changes the working tree for N running task(s): …»), т.е. число и слово должны быть отрендерены, а не выведены как шаблон.

## Факт

- В описании диалога виден сырой ICU-шаблон: «Switching to release changes the working tree for {count, plural, one {# running task} other {# running tasks}}:» — `{branch}` подставляется, `{count, plural, …}` НЕ рендерится ни в одной локали.
- 2/2 воспроизведения в кейсе B6 (диалог при running-задаче checkout-сессии).
- Git до/после: `main`, без изменений (switch отменён через Cancel — guard работает).
- Ошибок в логах приложения нет.

## Доказательства

- `$QA_ROOT/evidence/B6-2-guard-dialog.png` — диалог с сырым `{count, plural, …}` в тексте.
- `$QA_ROOT/evidence/B6-3-guard-both-running.png`, `$QA_ROOT/evidence/B6-4-guard-worktree-excluded.png` — то же в других сценах кейса B6.
- `$QA_ROOT/cases/B6.md` — полная запись кейса (PASS по guard + BUG raw-plural).
- Красный тест: `packages/ui/test/branchSwitchGuardI18n.test.ts` → «BUG-GWT-012: …» (вывод ниже).

## Причина

- Подтверждено (механизм, без вложенного plural — это один plural верхнего уровня рядом с простым плейсхолдером `{branch}`):
  - `packages/ui/src/v4/composer/branchSwitchGuard.tsx:144-150` — описание диалога форматируется через `intl.formatMessage({ id: "branchSwitchGuard.description" }, { count, branch })`.
  - `packages/ui/src/i18n/createIntl.ts:28-37,60-62` — `formatMessage` после lookup делает только наивную подстановку `replaceAll("{key}", value)`; ICU-синтаксис `{count, plural, one {…} other {…}}` этой функцией не разбирается вообще: в шаблоне нет литерального токена `{count}`, поэтому весь фрагмент `{count, plural, …}` остаётся в выводе как есть. `{branch}` при этом подставляется — что и наблюдается.
  - `packages/ui/src/i18n/locales/en-US.ts:5193-5194` (а также `zh-CN.ts:4887`, `uk-UA.ts:4884`) — сообщение `branchSwitchGuard.description` записано с инлайн-ICU-plural, тогда как intl-слой проекта plurals поддерживает только через отдельный API `formatPlural` (`createIntl.ts:63-74`), который ждёт в каталоге отдельные ключи `id.one`/`id.few`/`id.many`/`id.other` (конвенция, используемая всеми остальными plural-сообщениями, например `sessionManager.count.sessions`, `chat.codeComments`). Т.е. сообщение написано в формате, который движок не умеет, и передано в API, который его не обрабатывает.
- Гипотеза: — (причина подтверждена на всех слоях: каталог → intl-движок → вызов в компоненте; воспроизведено юнит-тестом с реальным `createIntl` + реальным каталогом en-US).

## Предлагаемое исправление

Слой UI/i18n, без новых зависимостей: привести `branchSwitchGuard.description` к конвенции проекта — разбить на простой префикс с `{branch}` (`formatMessage`, например `branchSwitchGuard.descriptionPrefix` = "Switching to {branch} changes the working tree for") + plural-семейство для количества (`formatPlural` с ключами `branchSwitchGuard.taskCount.one/.few/.many/.other` = "{count} running task(s)") во всех трёх каталогах, и собрать их в `branchSwitchGuard.tsx` (134-158). После фикса снять `it.fails` с теста — он станет красным ровно на момент появления фикса.

## Тест

`packages/ui/test/branchSwitchGuardI18n.test.ts`, unit (jsdom + @testing-library/react; реальные `ZCodeIntlProvider` и каталог en-US — проверяется именно production-путь форматирования; замоканы только task-list hook, toast и диалоговые примитивы; без sleep/таймаутов):

`it.fails("BUG-GWT-012: guard dialog renders the localized plural instead of the raw ICU template")` — открывает guard-диалог с одной running-задачей (count = 1, branch = "release") и проверяет, что текст диалога содержит подставленную ветку `release`, НЕ содержит сырого `{count, plural` и содержит осмысленное «1 running task».

Красный прогон без маркера (`"$QA_ROOT/bin/real-run.sh" "$NODE_BIN" scripts/run-vitest.mjs run packages/ui/test/branchSwitchGuardI18n.test.ts`):

```
 ❯ unit packages/ui/test/branchSwitchGuardI18n.test.ts (1 test | 1 failed) 15ms
     × renders the localized plural count instead of the raw ICU template 14ms

 FAIL  unit packages/ui/test/branchSwitchGuardI18n.test.ts > branch switch guard dialog i18n > renders the localized plural count instead of the raw ICU template
AssertionError: expected 'Switch branch?Switching to release ch…' not to contain '{count, plural'

Expected: "{count, plural"
Received: "Switch branch?Switching to release changes the working tree for {count, plural, one {# running task} other {# running tasks}}:Reply with OK onlyCancelSwitch branch"

 ❯ packages/ui/test/branchSwitchGuardI18n.test.ts:94:22
    92|     expect(text).toContain("release");
    93|     // The count must be rendered as localized text, not leaked as a r…
    94|     expect(text).not.toContain("{count, plural");
      |                      ^
    95|     expect(text).toContain("1 running task");
    96|   });

 Test Files  1 failed (1)
      Tests  1 failed (1)
```

С маркером `it.fails`: `Tests  1 expected fail (1)` — зелёный; станет красным, когда баг починят (тогда маркер снять).
