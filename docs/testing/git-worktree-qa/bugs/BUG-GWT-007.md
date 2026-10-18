# BUG-GWT-007: «Open worktree» для stale-ветки молча открывает несуществующий каталог как проект

- Severity: S3 (есть обход: закрыть ghost-проект и нажать «Prune stale» на setup-странице)
- Кейсы: E4
- Окружение: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build)

## Воспроизведение с нуля

1. Фикстура R11 (`make-fixtures.sh R11`): репозиторий `$QA_ROOT/repos/has-worktrees` с worktree-записями `live`, `stale` (папка удалена `rm -rf` без `git worktree prune` → запись prunable), `locked`.
2. В Settings → Worktrees задать для `has-worktrees` project override `branchPrefix = sta` (чтобы введённое имя `stale` скомпозировалось в существующую ветку `stale`).
3. Открыть `has-worktrees` как проект → `Cmd+K` → «New task in worktree» → выбрать `has-worktrees` → в поле Branch name ввести `stale`.
4. Наблюдать: подсказка «This branch already exists; the new worktree will check it out.», кнопка «Open worktree» (указывает на `has-worktrees-wt/stale`), Start отключён (ветка занята prunable-записью).
5. Кликнуть «Open worktree».

Факт: палитра закрывается, в сайдбаре появляется проект `stale` с empty-state композером. Ни ошибки, ни предупреждения о несуществующем каталоге (нет тоста и missing-бейджа). В логах создаётся подписка v4-conversation на workspace `has-worktrees-wt/stale` (несуществующий путь). `git worktree list` не меняется (автопруна нет — это ожидаемо и корректно).

## Ожидание

- `docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md`, WT-04: «Создание worktree прошло, открытие workspace/draft завершилось ошибкой — показан существующий путь и доступен повторный запуск без создания второго worktree» — открытие несуществующего каталога должно считаться ошибкой и показываться как восстановимая (путь + retry), а не проходить молча.
- Матрица E4 (`QA-PROMPT.md` §6, блок E): «Ветка `stale` (папка удалена) → восстановимая ошибка, без автоматического prune».
- `docs/git/worktree-operations.md` §pruneWorktrees: stale-записи удаляются только явным действием prune — открытие не должно ни прунить, ни притворяться, что каталог есть.

## Факт

- Git до/после: 4 записи `git worktree list --porcelain`, `stale` остаётся prunable; диск `has-worktrees-wt/` содержит только `live/` и `locked/` — каталог не воссоздан. Автоматического prune НЕ произошло (OK).
- UI: ghost-проект `stale` открыт как обычный workspace (empty-state композер), без ошибки/бейджа; создана черновая сессия и подписка `v4-conversation` на несуществующий путь (`sess_78d99fdd…` в логах).
- Новых `error`/`warn` в логах нет — открытие не считается ошибкой ни в одном слое.

## Доказательства

- `$QA_ROOT/evidence/E4-1-stale-offer.png` — оффер «Open worktree», Start disabled.
- `$QA_ROOT/evidence/E4-2-after-open-click.png` — ghost-проект `stale` открыт, ошибки нет.
- `$QA_ROOT/evidence/BUG-GWT-007-red-run.txt` — красный прогон теста до маркера.
- `$QA_ROOT/evidence/BUG-GWT-007-green-run.txt` — прогон с `it.fails` (33 passed + 1 expected fail).
- Скриншоты не коммитить; они остаются в `$QA_ROOT`.

## Причина

- Подтверждено (код):
  - `packages/ui/src/command-center/CommandCenterDialog.tsx:1049-1090` — эффект existing-branch оффера берёт `listWorktrees` → `findWorktreeForBranch(...)` (`packages/ui/src/command-center/worktreeTaskFlow.ts:387-392`) и сохраняет `match.path` в `worktreeExistingBranchWorktreePath` без какой-либо проверки существования каталога. Porcelain-список легитимно содержит stale/prunable-записи (`docs/git/worktree-operations.md` §listWorktrees Parsing Rules: `prunable` игнорируется на этом слое, у `GitWorktreeEntry` нет флага stale).
  - `packages/ui/src/command-center/CommandCenterDialog.tsx:2050-2063` — кнопка «Open worktree» по клику вызывает `closeDialog(); openTaskWorkspace(worktreeExistingBranchWorktreePath)` напрямую, без валидации пути.
  - `packages/ui/src/command-center/CommandCenterDialog.tsx:1271-1298` — `openTaskWorkspace` обрабатывает только reject `onCreateTaskInWorkspace`; открытие несуществующего каталога завершается успешно, поэтому контракт WT-04 (ошибка открытия → путь + retry) не срабатывает.
  - Контраст: соседний путь восстановления при создании уже делает нужную проверку — `packages/ui/src/command-center/worktreeCreation.ts:108-135` вызывает `gitService.verifyWorktreeUsable` (`packages/shared/src/git.ts:203-214`, возвращает `{ok:false, reason:"missing-directory"|"missing-git-link"}`) и на stale-записи возвращает recoverable-ошибку `commandCenter.worktree.error.worktreeMissing`. Оффер в палитре обходит эту проверку.
- Гипотеза (не проверено): слой открытия workspace (`handleCreateTaskInWorkspace` в `packages/ui/src/App.tsx` и ниже) также не проверяет существование каталога — поэтому ghost-workspace и подписка v4-conversation создаются без ошибки; глубже (Host/main) не исследовалось.

## Предлагаемое исправление

Направление, без реализации: в existing-branch оффере палитры проверять реальный каталог до открытия — переиспользовать `gitService.verifyWorktreeUsable` (как это уже делает `worktreeCreation.ts:115-119`) на пути `CommandCenterDialog.tsx:1049-1090`/`2050-2063`: при `{ok:false}` не вызывать `onCreateTaskInWorkspace` с несуществующим путём, а показать recoverable-ошибку по контракту WT-04 (путь + повторный запуск) с подсказкой о «Prune stale» / повторном создании worktree; автоматический prune не добавлять. Опционально помечать stale-записи в списке worktree (требует расширения контракта `listWorktrees` флагом prunable — отдельное изменение спеки `docs/git/worktree-operations.md`).

## Тест

- Путь: `packages/ui/test/commandCenterWorktreeFlow.test.ts`, describe `BUG-GWT-007 existing-branch offer vs stale registered worktree` (уровень UI-оркестрации; git RPC замокан, самодостаточный, без sleep).
- Содержание: `listWorktrees` возвращает stale-запись ветки `zcode/stale`, `verifyWorktreeUsable` → `{ok:false, reason:"missing-directory"}`; клик «Open worktree» не должен молча звать `onCreateTaskInWorkspace` с несуществующим путём (блокировка или видимая ошибка).
- Красный прогон без маркера (падает именно по багу, остальные 33 теста файла зелёные):

```
FAIL  unit packages/ui/test/commandCenterWorktreeFlow.test.ts > BUG-GWT-007 ... > BUG-GWT-007: opening a worktree whose registered directory is missing must be blocked or surface an error, not open silently
AssertionError: expected true to be false // Object.is equality
- Expected
+ Received
- false
+ true
 ❯ packages/ui/test/commandCenterWorktreeFlow.test.ts:732:48
Test Files  1 failed (1)
     Tests  1 failed | 33 passed (34)
```

- Помечен `it.fails("BUG-GWT-007: …")`; прогон с маркером: `1 passed (1)` файл, `33 passed | 1 expected fail (34)`. Когда баг починят, тест уйдёт в зелёный и `it.fails` станет красным — снять маркер.
