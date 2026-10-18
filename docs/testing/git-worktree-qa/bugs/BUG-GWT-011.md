# BUG-GWT-011: Строка конфликтного (UU) файла в Review pane не имеет бейджа «Conflicted»; i18n-ключи `git.section.conflicted`/`git.kind.conflicted` не используются

- Status: FIXED (fix wave 2, 2026-10-18: unit + live confirmed in RT2; marker removed)

- Severity: S4 (косметика/информативность: единственный намёк на конфликт в свёрнутой строке — неинформативное `+0−0`; сам diff с маркерами конфликта и функциональные блокировки мутаций веток работают)
- Кейсы: A8 (PASS с дефект-наблюдением)
- Окружение: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build, sandbox HOME)

## Воспроизведение с нуля

1. Фикстура R10 `merge-conflict` (`$QA_ROOT/bin/make-fixtures.sh R10`): `main` и `feature/a` меняют одну строку `src/lib.txt`; `git merge feature/a` оставляет конфликт неразрешённым. Ground truth: `u UU src/lib.txt` в `git status --porcelain=v2`.
2. Открыть `$QA_ROOT/repos/merge-conflict` как проект в QA-приложении (`qa-run.sh "$ELECTRON_BIN" . --open-workspace=…`), Review pane (источник «Not staged»).
3. Строка `src / lib.txt +0 −0` отображается, но без какого-либо статуса: в HTML строки — иконка+путь, `+0 −0`, chevron; текста «Conflicted» нет ни бейджем, ни заголовком секции.
4. Раскрытие строки показывает корректный `diff --cc` с маркерами `<<<<<<< HEAD` / `=======` / `>>>>>>>` — т.е. данные о конфликте до UI доходят, теряется только маркировка строки.

## Ожидание

- `docs/git/requirements.md` §4.1 (File List), строка ~162: «Non `Not staged` items can display status badge, e.g. `Untracked`, `Conflicted`, `Staged`».
- `docs/git/requirements-review.md` (~строка 54, Requirement List): «Non `Not staged` items can display status badge — Completed / Accepted — Includes `Staged` / `Untracked` / `Conflicted` / `Branch comparison` etc.» — бейдж Conflicted декларирован принятым.
- Переводы для бейджа уже лежат во всех локалях: `git.section.conflicted` / `git.kind.conflicted` = «Conflicted» (en-US), «Конфлікти»/«Конфлікт» (uk-UA), «冲突» (zh-CN).

## Факт

- В Review pane (Unstaged) конфликтный файл рендерится как обычная строка: иконка, путь, `+0 −0`, chevron — ни бейджа «Conflicted», ни заголовка секции Conflicted (см. `$QA_ROOT/cases/A8.md`, шаг 3).
- `rg "git.section.conflicted|git.kind.conflicted"` по `packages/ apps/ scripts/` вне файлов локалей даёт 0 ссылок в продуктовом коде — ключи мёртвые (виден только новый тест BUG-GWT-011).
- Функционально конфликт обрабатывается правильно: переключение/создание веток блокируется сервисным guard'ом `conflicts-present` (`packages/services/src/git/repo/gitCliRepo.ts:1643`, тост «Repository still has unresolved conflicts.»), diff показывает маркеры конфликта.

## Доказательства

- `$QA_ROOT/cases/A8.md` — протокол кейса (шаг 3: HTML строки без бейджа; шаг 4: diff с маркерами).
- Скриншоты: `$QA_ROOT/evidence/A8-1-review-conflict.png` (строка без бейджа), `$QA_ROOT/evidence/A8-4-conflict-diff.png` (раскрытый diff с маркерами конфликта).
- Красный прогон теста — в разделе «Тест» ниже.

## Причина

- Подтверждено (вся цепочка данных до UI цела, бейдж пропадает в слое представления):
  - `packages/services/src/git/repo/gitCliHelpers.ts:468-477` — porcelain v2 записи `u ` (unmerged, XY=UU) парсятся с `isConflicted: true`.
  - `packages/services/src/git/gitService.ts:82-84` — для unmerged-записи строится `GitFileChange` с `section: "conflicted"` и `isConflicted: true` (`gitService.ts:46`); +0/−0 отсюда же.
  - `packages/ui/src/hooks/useGitRepository.ts:85` — `SECTION_ORDER_BY_SOURCE.unstaged = ["unstaged", "untracked", "conflicted"]`; `buildSectionsForSource` (строки 240-268) честно группирует изменения в `conflicted`-секцию датасета unstaged. Данные на входе рендера есть.
  - Точка потери №1 — `packages/ui/src/GitPane.tsx:117-120`: `currentChanges = currentDataset.sections.flatMap((section) => section.changes)` выбрасывает id секции; строки строятся только как `{ kind: "file", change }` (строка 125) либо directory-строки (`GitPane/GitPaneDirectoryHeader.tsx` рендерит имя папки, не секцию). Заголовков секций в панели нет вовсе.
  - Точка потери №2 (сам баг-компонент строки) — `packages/ui/src/GitPaneChangeCard.tsx:91-128`: заголовок строки рендерит только `FileDisplayInline` (иконка+путь), `+{change.added}/−{change.removed}` (строки 117-120) и chevron. Поля `change.section`/`change.isConflicted` (равно как `isStaged`/`isUntracked`) компонентом не читаются — бейдж статуса не рендерится ни для одного вида, в т.ч. Conflicted.
  - Мёртвые ключи: `git.section.conflicted` / `git.kind.conflicted` определены во всех трёх локалях (`packages/ui/src/i18n/locales/en-US.ts:1420,1427`, `uk-UA.ts:1238,1245`, `zh-CN.ts:1323,1330`), но нигде не подключены; единственный живой потребитель `git.kind.*`/`git.section.*` — дерево файлов воркспейса (`packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx:235-241`), в карте статусов которого conflicted-статуса нет вовсе.
- Гипотеза: отсутствует (причина подтверждена до строки кода).

## Предлагаемое исправление

Слой рендерера (продуктовый код не менялся — по заданию):

- в `GitPaneChangeCard.tsx` рендерить бейдж статуса из `change.section`/`change.isConflicted` (текст — `intl.formatMessage({ id: "git.kind.conflicted" })` либо `git.section.conflicted`, ключи уже в локалях; заодно закроются Staged/Untracked/Branch comparison из той же строки спеки);
- если хочется и заголовков секций — не забыть, что `GitPane.tsx:117-125` сейчас выбрасывает id секции при flatten: его нужно прокинуть в модель строки (это необязательно для бейджа в самой строке, т.к. `change.section` сохраняется в объекте изменения);
- после фикса снять `it.fails` с теста ниже и удалить мёртвый ключ из одной из пар, если останется дубль.

## Тест

- Файл: `packages/ui/test/reviewConflictedBadge.test.ts` (новый; уровень — unit-тест компонента строки Review pane `GitPaneChangeCard`; данные мокаются объектом `GitPaneFileChange`, который сервис возвращает для porcelain `UU` — моки git тут уместны, баг чисто view-уровня; jsdom + @testing-library/react, без sleep, самодостаточен, не зависит от `$QA_ROOT`).
- Красный прогон без маркера (имя `it("BUG-GWT-011: renders the Conflicted badge on a UU (unmerged) file row")`):

```
RUN  v4.1.7 /Users/osben/Dev/ZCode-qa-20261017
 unit  packages/ui/test/reviewConflictedBadge.test.ts (1 test | 1 failed) 22ms
    × BUG-GWT-011: renders the Conflicted badge on a UU (unmerged) file row 22ms

 FAIL  unit  packages/ui/test/reviewConflictedBadge.test.ts > review pane conflicted file badge > BUG-GWT-011: renders the Conflicted badge on a UU (unmerged) file row
TestingLibraryElementError: Unable to find an element with the text: Conflicted. This could be because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to make your matcher more flexible.
 ❯ packages/ui/test/reviewConflictedBadge.test.ts:73:19
    71|     // but are never used by the Review pane row (see
    72|     // docs/testing/git-worktree-qa/bugs/BUG-GWT-011.md).
    73|     expect(screen.getByText("Conflicted")).toBeTruthy();
      |                   ^

 Test Files  1 failed (1)
      Tests  1 failed (1)
```

(Предусловия в том же прогоне прошли: строка рендерится — `lib.txt`, `+0`, `-0` находятся; падение именно по assert'у отсутствующего бейджа, не по setup.)

- После маркировки `it.fails("BUG-GWT-011: renders the Conflicted badge on a UU (unmerged) file row")`:

```
 ✓  unit  packages/ui/test/reviewConflictedBadge.test.ts (1 test) 22ms

 Test Files  1 passed (1)
      Tests  1 expected fail (1)
```

Тест станет красным, когда в строке Review pane появится бейдж Conflicted — маркер можно будет снять.
