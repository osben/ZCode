# BUG-GWT-003: failed `git.createWorktree` логируется как «OK» и оставляет полу-ветку в git (нет отката `-b`-ветки при отказе создания)

- Severity: S3 (обход есть — Retry после восстановления прав доиспользует ту же ветку; мусор в git и ложная строка «OK» в логах сбивают диагностику и восстановление)
- Кейсы: C5 (основной, дефект 2), C8 (echo: тот же класс «OK при провале»)
- Окружение: macOS 27.2 (darwin, arm64), git 2.56.0, commit `bd6a05b3` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build, sandbox HOME)

## Воспроизведение с нуля

UI (как в кейсах):

1. Фикстура R1 `basic`; заранее `mkdir -p $QA_ROOT/repos/basic-worktrees && chmod 555 $QA_ROOT/repos/basic-worktrees` (проверено: `mkdir` внутри → Permission denied).
2. Открыть `$QA_ROOT/repos/basic`, композер → toggle Worktree ON → Send («Create file c5-marker.txt …»).
3. Наблюдать шаг failed + recovery; затем `git -C $QA_ROOT/repos/basic branch -vv` — осталась ветка `zcode/<auto>` без worktree; хвост лога хоста — `[rpc:call] git.createWorktree OK (64.2ms)`.
4. Вариант C8: фикстура R2 `empty` (unborn HEAD `main`), Worktree ON (поповер «Base branch main») → Send → мгновенный failed; в логе `[rpc:call] git.createWorktree OK (47.0ms)`; Retry — детерминированный отказ снова.

Unit-уровень (без UI; воспроизводит ядро бага реальным git):

```bash
T=$(mktemp -d)/repo && git -C $T init -q && git -C $T -c user.email=t@t -c user.name=t commit -q --allow-empty -m c1
P=$(mktemp -d) && chmod 555 $P
git -C $T worktree add -b zcode/x -- $P/x; echo "exit=$?"   # exit=128, Permission denied
git -C $T branch --list                                    # -> zcode/x  (полу-ветка!)
```

## Ожидание

- Кейс C5: «понятная ошибка + recovery; в git нет мусора — нет полу-веток» (`$QA_ROOT/cases/C5.md`; QA-PROMPT §C5), спека `specs/composer-worktree-setup-steps.md` §Preparation states (`failed`).
- Сервисный контракт: `createWorktree` сообщает об ошибке создания вызывающему слою, и неудачное создание не меняет множество веток репозитория (кто читает логи хоста — видит провал, а не «OK»).

## Факт

- C5 (EACCES): UI-провал пойман корректно (step failed + recovery), НО в git осталась ветка `zcode/dancing-walrus` @5371bb3 без записи worktree и без каталога; в логе при этом `[rpc:call] git.createWorktree OK (64.2ms)` (`…/logs/2026-10-17.log:19231`). Retry после `chmod 755` дошёл до ready, доиспользовав эту же мусорную ветку (второй ветки не появилось).
- C8 (unborn HEAD, base `main`): `[rpc:call] git.createWorktree OK (47.0ms)` (`…/logs/2026-10-17.log:23987`) при фактическом отказе `fatal: invalid reference: main`; git чист (нет коммитов → полу-ветка невозможна), Retry детерминированно падает снова.
- Unit-проверка на этом коммите (реальный git, temp-каталог): при read-only родителе `createWorktree` возвращает `{ ok: false, issues: [{ code: "unknown", detail: "…could not create leading directories…Permission denied" }] }` — ошибку вызывающему слою сервис ДАЁТ; но ветка `zcode/half-created` остаётся в репо (`git branch --list` ≠ пусто). При unborn HEAD + base `main` — `{ ok: false, issues: [{ code: "target-branch-not-found", detail: "fatal: invalid reference: main" }] }`.

Итого два независимых дефекта под одной оболочкой «OK при провале»:

1. полу-ветка-мусор после неудачного `worktree add -b` (ядро S3, воспроизводится на слое services);
2. строка «OK» в логе RPC при фактическом неуспехе (сбивает диагностику; именно она зафиксирована в кейсах как «git.createWorktree вернул OK»).

## Доказательства

- `$QA_ROOT/cases/C5.md` (ДЕФЕКТ 2: полу-ветка + «git.createWorktree OK (64.2ms)»), `$QA_ROOT/cases/C8.md` (то же для unborn).
- Лог хоста: `$QA_ROOT/home/.zcode/v2/logs/2026-10-17.log:19231` (`git.createWorktree OK (64.2ms)`, 21:52:21) и `:23987` (`git.createWorktree OK (47.0ms)`, 22:25:52).
- Скриншоты: `$QA_ROOT/evidence/C5-1-failed-rawkeys.png`, `$QA_ROOT/evidence/C8-1-failed-rawkeys.png`, `$QA_ROOT/evidence/C8-2-after-retry.png`.
- Красный прогон теста — в разделе «Тест» ниже.

## Причина

- Подтверждено (file:line, с проверкой на этой машине):
  1. Полу-ветка: `packages/services/src/git/repo/gitCliRepo.ts:1328-1347` — успех определяется по exit code дочернего процесса (`result.exitCode !== 0` → `ok:false`, строки 1352-1354). Команда — `git worktree add -b <branch> -- <path> [<base>]`; сам Git пишет `refs/heads/<branch>` ДО создания каталога worktree (проверено: exit 128 «could not create leading directories … Permission denied», ветка при этом существует). Сервис возвращает `ok:false`, но НЕ откатывает только что созданную ветку — полу-ветка остаётся в git (в C5 — `zcode/dancing-walrus`; Retry затем идёт по ветке `branchAlreadyExists`, `gitCliRepo.ts:1327,1332-1333`, и доиспользует мусорную ветку, маскируя мусор).
  2. Ложное «OK» в логе: `packages/rpc/src/logging-middleware.ts:41-48` — `LoggingServerChannel.call` пишет `[rpc:call] git.createWorktree OK (Xms)` для ЛЮБОГО вызова, завершившегося без throw; `createWorktree` сообщает об ошибках через разрешённый (resolved) объект результата `{ok:false, issues}` (`gitCliRepo.ts:1352-1354`), а не исключением. Desktop-host оборачивает сервер в `LoggingChannelServer` (`packages/desktop/src/host/index.ts:2100`), поэтому фактический провал логируется как OK — это и есть строки 19231/23987 из кейсов.
- Опровергнуто (часть исходной формулировки бага): на уровне РЕЗУЛЬТАТА `createWorktree` НЕ возвращает ok:true при EACCES/unborn — проверено unit-прогоном реального git на этом коммите (оба случая дают `ok:false` с issues), и UI-пайплайн корректно переводит `ok:false` в «failed» (`packages/ui/src/command-center/worktreeCreation.ts:99-104` → `packages/ui/src/v4/composer/composerWorktreePipeline.ts:167-170`). «Ложный успех» существует только в тексте лога RPC, не в потоке данных.
- Гипотеза (не проверено): при вызове БЕЗ baseBranch в пустом репо `git worktree add -b` выходит с кодом 0, создав orphan-worktree («No possible source branch, inferring '--orphan'»), — т.е. возможен и настоящий ok:true с бессмысленным (orphan) worktree; композер в C8 передавал base `main`, поэтому этот путь в кейсе не срабатывал.

## Предлагаемое исправление

- `gitCliRepo.createWorktree`: если `worktree add -b` завершился ненулевым кодом и ветка до вызова не существовала (`branchAlreadyExists === false`), откатить полу-ветку (например, `git update-ref -d refs/heads/<branch>` / `git branch -D` с защитой «не трогать существовавшую ранее ветку»). UI-слой не меняется.
- Отдельно (слои rpc/logging, необязательно для S3): в `LoggingServerChannel` различать «resolved» и «succeeded» для сервисов с объектом-результатом (логировать `ok:false`-payload как FAIL или добавлять флаг ok), чтобы расследование инцидентов не опиралось на ложное «OK».

## Тест

- `packages/services/test/gitCliRepo.test.ts`, `it.fails("BUG-GWT-003: failed worktree creation reports the error and leaves no half-created branch")` — реальный git во временном каталоге: read-only родитель (`chmod 0o555`), `createWorktree(…, "zcode/half-created", <ro>/zcode-half-created, "release")`; ассерты: `result.ok === false` (сервис обязан сообщать ошибку — сегодня выполняется) и `git branch --list zcode/half-created` пусто после провала (сегодня НЕ выполняется — остаётся полу-ветка).
- Красный прогон (без маркера):

```
FAIL  unit packages/services/test/gitCliRepo.test.ts > gitCliRepo worktree operations >
     BUG-GWT-003: failed worktree creation reports the error and leaves no half-created branch
AssertionError: expected 'zcode/half-created' to be '' // Object.is equality
- Expected
+ Received
+ zcode/half-created
 ❯ packages/services/test/gitCliRepo.test.ts:842:76
Test Files  1 failed (1)
     Tests  1 failed | 31 passed (32)
```

Красный именно по нужной причине: assert про `ok:false` прошёл (сервис ошибку возвращает), упал только assert «нет полу-ветки-мусора».

- Зелёный прогон (с `it.fails`): `Test Files 1 passed (1) — Tests 31 passed | 1 expected fail (32)` (real-run.sh, Node 26.11.1, git 2.56.0).
