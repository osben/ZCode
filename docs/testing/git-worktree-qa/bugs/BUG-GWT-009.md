# BUG-GWT-009: поповер композера не обновляет список веток после create-and-switch

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)

- Severity: S3 (обход есть: reload окна или смена воркспейса сбрасывают кэш; данные не теряются, но до этого список веток и отметка current врут)
- Кейсы: B4
- Окружение: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build)

## Воспроизведение с нуля

1. Фикстура R1 (basic): `main` с коммитами, ветки `feature/a`/`main`/`release` (QA-PROMPT §4).
2. QA-приложение: открыть проект `basic`, чип назначения (`aria-label="Choose where this task runs"`) → строка «Task branch» → встроенный список веток (`[main, feature/a, release]`, `main` помечен текущим).
3. Footer-действие «Create and switch to new branch…» → в диалоге ввести `qa/b4-valid` → «Create and switch».
4. Диалог закрывается, чип корректно показывает `qa/b4-valid` (живой git summary обновился через `onRefreshGit`).
5. Снова открыть чип → список веток (listOpen переживает закрытие поповера, открывается сразу).

Или без UI — минимальный git-эквивалент того, что делает RPC:

```bash
cd <repo> && git checkout -b qa/b4-valid
# git branch: qa/b4-valid существует и текущая; список UI при этом остаётся [feature/a, main, release]
```

## Ожидание

`specs/composer-branch-switcher-semantics.md` §4, Popover row 2: встроенный список веток наследует семантику базового свитчера — «"Create and switch to new branch…" (existing `GitBranchCreateDialog` + create-and-switch semantics, unchanged)» и «current check + dirty count»; §4 «Reuse»: веточную машинерию даёт `useGitBranchSwitcher`. У исходного статус-панельного `GitBranchSwitcher` после create-and-switch повторное открытие показывает новую текущую ветку (список перезапрашивается при каждом открытии, `useGitBranchSwitcher.ts:126-134`: «Fetch the branch list every time the dropdown opens so a successful switch does not reuse the snapshot from the previous opening»). Тот же результат обязана давать и встроенная копия списка в поповере композера: после успешного create-and-switch повторно открытый список содержит новую ветку, и именно она помечена текущей.

## Факт

- После create-and-switch `qa/b4-valid` (RPC `git.createBranchAndSwitch` ok, git-состояние корректно: ветка создана от tip main, HEAD переключён) повторное открытие списка показывает устаревший `[main, feature/a, release]`:
  - строки `qa/b4-valid` нет;
  - ни одна строка не помечена текущей (живой `currentBranchName` = `qa/b4-valid` не входит в кэшированный список, поэтому подсказка «Uncommitted changes: N files» не рисуется ни на одной строке).
- Чип при этом обновляется правильно — расхождение только во встроенном списке.
- Кэш живёт до reload окна или смены воркспейса (эффект сброса по `workspaceKey`).
- Git до/после: сам репозиторий корректен (см. кейс B4), дефект чисто UI-слоя. Ошибок в логах нет.

## Доказательства

- `$QA_ROOT/cases/B4.md` — дефект-наблюдение 2 (полная запись кейса; PASS по основной проверке создания ветки).
- `$QA_ROOT/evidence/B4-2-chip-updated.png` — чип корректно показывает `qa/b4-valid` (контраст: список при этом остаётся устаревшим).
- Красный тест: `packages/ui/test/composerDestinationControl.test.ts` → «BUG-GWT-009: …» (вывод ниже).

## Причина

- Подтверждено: `packages/ui/src/v4/composer/ComposerDestinationControl.tsx` ведёт собственный кэш списка, отдельный от кэша хука:
  - `:114` — `branchesResult` (локальный state);
  - `:186-220` — эффект загрузки выходит сразу при `branchesResult !== null` (`:188`), т.е. fetch выполняется ровно один раз; `setBranchesResult(result)` вызывается только при этой начальной загрузке (`:194`);
  - единственный сброс кэша — эффект по смене воркспейса/цели сервисов (`:123-130`, `setBranchesResult(null)` на `:127`, депсы `[workspaceKey, workspacePath, resolution.remoteSessionId, baseServices.gitService]`);
  - `handleCreateBranchAndSwitch` (`:141-151`) после успешного `switcher.createBranchAndSwitch()` не инвалидирует `branchesResult` — кода, аналогичного рефрешу хука, в композере нет;
  - рендер идёт из кэша (`:315` `branchesResult?.branches`), а отметка current считается как `branch.name === currentBranchName` по живому git summary (`:447`): новой ветки в кэше нет → нет ни строки, ни отметки.
  - Патч кэша в `handleMutationResult` хука (`packages/ui/src/hooks/useGitBranchSwitcher.ts:255-268`) обновляет только ЕГО собственный `branchesResult` — это другой экземпляр state, композер из него список не рендерит. Именно поэтому статус-панельный `GitBranchSwitcher` корректен: у хука есть и патч после мутации, и сброс снапшота при смене HEAD (`useGitBranchSwitcher.ts:111-124`), и перезапрос при каждом открытии (`:126-154`), а у композера — ничего из этого.
- Гипотеза: — (причина подтверждена трассировкой кода и красным тестом; фиксированного воспроизведения в живом UI не снималось на скриншот — фиксируется тестом).

## Предлагаемое исправление

Слой renderer, `ComposerDestinationControl.tsx`: после успешного create-and-switch (в `handleCreateBranchAndSwitch`, `:141-151`) инвалидировать кэш списка — `setBranchesResult(null)` (+ сброс `branchListFailed`), чтобы эффект `:186-220` перезапросил список при следующем открытии поповера. Более общий вариант, закрывающий и внешние переключения: зеркалировать стратегию хука — сбрасывать `branchesResult`, когда `gitSummary.branchName`/`headRefType` меняются при закрытом поповере (аналог `useGitBranchSwitcher.ts:111-124`), не инициируя RPC из самого сброса. Реализация — по решению владельца; тест ниже не привязан к способу (проверяет итоговое состояние UI).

## Тест

`packages/ui/test/composerDestinationControl.test.ts`, renderer-уровень (jsdom, @testing-library/react; RPC-поверхность `gitService` замокана, без sleep, самодостаточен):

`it.fails("BUG-GWT-009: reopening the branch list after create-and-switch shows the new current branch")` — открывает поповер → список веток (`main` помечен current через dirty-hint) → footer «Create and switch…» → диалог → `qa/b4-valid` → сабмит; мок `createBranchAndSwitch` мутирует состояние репо и возвращает ok, `onRefreshGit` обновляет живой git summary (как родитель); повторное открытие поповера — список обязан содержать `qa/b4-valid` с подсказкой текущей ветки.

Красный прогон без маркера (`"$QA_ROOT/bin/real-run.sh" "$NODE_BIN" scripts/run-vitest.mjs run packages/ui/test/composerDestinationControl.test.ts`):

```
 FAIL  unit packages/ui/test/composerDestinationControl.test.ts > BUG-GWT-009: branch list refresh after create-and-switch > BUG-GWT-009: reopening the branch list after create-and-switch shows the new current branch
AssertionError: expected undefined to be truthy

- Expected:
true

+ Received:
undefined

 ❯ packages/ui/test/composerDestinationControl.test.ts:399:23

 Test Files  1 failed (1)
      Tests  1 failed | 10 passed (11)
```

(падение именно на ассерте отсутствующей строки `qa/b4-valid` в повторно открытом списке; предшествующие шаги — исходный список, RPC ×1, закрытие диалога — прошли)

С маркером `it.fails`: `Tests 10 passed | 1 expected fail (11)` — зелёный; станет красным, когда баг починят (тогда маркер снять).
