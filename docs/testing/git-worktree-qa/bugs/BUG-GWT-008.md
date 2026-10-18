# BUG-GWT-008: `inside` worktree creation leaves `.worktrees/` untracked in the main checkout

- Severity: S3 (workaround exists: ignore the entry or add `.worktrees/` to exclude by hand; no data loss)
- Кейсы: D2
- Окружение: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build)

## Воспроизведение с нуля

1. Фикстура R1 (basic): репозиторий с коммитами на `main` (см. QA-PROMPT §4).
2. QA-приложение: Settings (Cmd+,) → Worktrees → локация «Inside repository».
3. Cmd+K → «New task in worktree» → проект `basic`, автоимя (например `hypersonic-avocado`), base = `main` → Start.
4. Сайдбар → основной checkout `basic` → Review pane.
5. Или без UI, один git (эквивалент того, что делает сервис):

```bash
cd <repo> && git worktree add -b zcode/brave-otter -- "<repo>/.worktrees/zcode-brave-otter" main
git -C <repo> status --porcelain   # → "?? .worktrees/"
```

## Ожидание

Worktree в режиме `inside` живёт внутри проекта (`<repoRoot>/.worktrees/<сегмент>`, `packages/ui/src/command-center/worktreeTaskFlow.ts` §computeWorktreeTargetPath, design doc `docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md` «Настройки Worktrees»). Каталог — служебный, создан самим приложением, поэтому основной checkout не должен показывать его как изменение: после создания `git status --porcelain` основного checkout остаётся чистым (`.worktrees/` исключён через `.git/info/exclude` или `.gitignore`).

## Факт

- `git worktree list` корректен: worktree в `<repo>/.worktrees/zcode-<name>`, ветка `zcode/<name>`, base-SHA = tip base — сам worktree работает.
- `git status --porcelain` основного checkout: `?? .worktrees/`.
- Review pane основного проекта показывает мусорную untracked-запись `.worktrees/zcode-hypersonic-avocado` («+0-0», диф недоступен — запись каталогная). Скриншот: `$QA_ROOT/evidence/D2-3-review-untracked.png`.
- Git после (кейс D2): worktree добавлен по правильному inside-пути, но статус основного checkout перестал быть чистым.
- Ошибок в логах приложения нет.

## Доказательства

- `$QA_ROOT/evidence/D2-3-review-untracked.png` — Review pane основного checkout R1 с untracked-записью.
- `$QA_ROOT/cases/D2.md` — полная запись кейса (PASS по основной проверке + дефект S3).
- Красный тест: `packages/services/test/gitService.test.ts` → «BUG-GWT-008: …» (вывод ниже).

## Причина

- Подтверждено: `packages/services/src/git/repo/gitCliRepo.ts:1266-1362` (`createWorktree`) выполняет только `git worktree add` (строки 1328-1347) и сразу возвращает успех (1356-1361); записи `.worktrees/` в `.git/info/exclude` или `.gitignore` нет нигде в цепочке: `rg "info/exclude" packages/services packages/desktop packages/ui` не находит ни одного упоминания (только нерелевантный файловый поиск `.zcodeignore`). Путь `inside` строится в `packages/ui/src/command-center/worktreeTaskFlow.ts:195-201`, вызов идёт через `packages/ui/src/command-center/worktreeCreation.ts:81` → `packages/services/src/git/gitService.ts:271-278` → `gitCliRepo.createWorktree`; ни один слой не трогает exclude. Воспроизведено чистым git: после `git worktree add <repo>/.worktrees/x` porcelain основного checkout содержит `?? .worktrees/`, а `.git/info/exclude` записи не имеет.
- Гипотеза: — (причина подтверждена на всех слоях цепочки).

## Предлагаемое исправление

В `createWorktree` (или в слое, который знает режим локации — там, где доступен признак inside) после успешного `git worktree add`, когда target path лежит внутри repoRoot, добавлять строку `.worktrees/` в `.git/info/exclude` репозитория (идемпотентно, не трогая пользовательский `.gitignore`; при отсутствии файла — создавать). Альтернатива по решению владельца: всегда добавлять `.worktrees/` в `.git/info/exclude` при первом inside-создании или фильтровать каталог на уровне статус-слоя — но exclude предпочтительнее: статус остаётся честным и для внешнего git.

## Тест

`packages/services/test/gitService.test.ts`, интеграционный (реальный git во временной папке, без моков):

`it.fails("BUG-GWT-008: inside worktree creation keeps .worktrees/ out of the main checkout status")` — создаёт worktree через `createGitService().createWorktree` с target `<repoRoot>/.worktrees/zcode-brave-otter`, проверяет, что worktree реально создан, и что `git status --porcelain` основного checkout пуст.

Красный прогон без маркера (`"$QA_ROOT/bin/real-run.sh" "$NODE_BIN" scripts/run-vitest.mjs run packages/services/test/gitService.test.ts`):

```
 ❯ fork-isolated packages/services/test/gitService.test.ts (20 tests | 1 failed) 1210ms
     × BUG-GWT-008: inside worktree creation keeps .worktrees/ out of the main checkout status 65ms

 FAIL  fork-isolated packages/services/test/gitService.test.ts > gitService > BUG-GWT-008: inside worktree creation keeps .worktrees/ out of the main checkout status
AssertionError: expected '?? .worktrees/' to be '' // Object.is equality

- Expected
+ Received

+ ?? .worktrees/

 ❯ packages/services/test/gitService.test.ts:975:57

 Test Files  1 failed (1)
      Tests  1 failed | 19 passed (20)
```

С маркером `it.fails`: `Tests  19 passed | 1 expected fail (20)` — зелёный; станет красным, когда баг починят (тогда маркер снять).
