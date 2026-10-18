# BUG-GWT-006: commit-and-push в detached HEAD — пуш молча проваливается: ошибка пишется в уже закрытый commit-диалог, тоста нет

- Severity: S3 (push-сценарий сломан тихо; git-часть безопасна — пуш не выполняется; обход: повторить пуш из ветки через push-диалог, коммит уже создан)
- Кейсы: H5 (FAIL)
- Окружение: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build, sandbox HOME)

## Воспроизведение с нуля

1. Фикстура R5 `detached`: `"$QA_ROOT/bin/qa-run.sh" bash "$QA_ROOT/bin/make-fixtures.sh" R5` (HEAD~1, origin = `$QA_ROOT/remotes/detached.git`).
2. Сделать репозиторий dirty ДО открытия сессии: `"$QA_ROOT/bin/qa-run.sh" bash -c 'echo "h5-line for detached push test" >> $QA_ROOT/repos/detached/src/app.txt'`.
3. Открыть `$QA_ROOT/repos/detached` в QA-приложении, создать сессию (любое короткое сообщение, например «Reply with H5OK only.»).
4. В статус-панели нажать «Commit or push» → в диалоге (заголовок «Detached HEAD», +1 -0) ввести сообщение вручную → выбрать действие «Commit and push» (Enter или клик по cmdk-пункту).
5. Наблюдать: диалог закрывается сразу после выбора действия; на экране нет ни тоста, ни ошибки (`[data-sonner-toast]`=0, в DOM нет текста «Cannot push…»/«Push failed…»).
6. В логе хоста при этом 3 попытки из 3: `[rpc:call] git.push FAIL … "Cannot push while HEAD is detached."`; коммит при этом создан на detached HEAD (0442f11, e6a6d53, 2552722 в трёх попытках).

## Ожидание

- `QA-PROMPT.md` §6, H5: «Push в detached HEAD → понятная ошибка» — пользователь обязан увидеть результат действия: тост или открытый диалог с текстом ошибки (как в push-диалоге: `git.actionMenu.pushDialog.error.requestFailed`).
- Код-анализ H5 (сессия 1): единственный UI-путь, где detached-ошибка должна быть видна — commit-диалог после провала `pushAfterCommit`: `git.actionMenu.commitDialog.error.pushAfterCommitFailed` (`packages/ui/src/GitActionMenu.tsx`).
- `docs/git/requirements.md` §1.4 — поведение detached при push не специфицировано (отдельный SPEC-GAP-вопрос по UX чистого detached), но видимость ошибки пользовательского действия — базовое требование к любому git-действию из UI.

## Факт

- Коммит проходит на detached HEAD; `git.push` FAIL «Cannot push while HEAD is detached.» (3× в логах хоста, 00:12:27 / 00:14:33 / 00:16:51).
- `detached.git` не изменился (main/feature/a/release с прежними SHA) — git-часть корректна.
- Пользовательская обратная связь ОТСУТСТВУЕТ: диалог закрылся в момент выбора действия; тостов нет; DOM-текст «Cannot push…»/«Push failed…» не появляется (поллинг 1–9 с).
- После провала срабатывает `onRefreshGit()` (committed=true) — UI обновляется так, будто операция завершилась штатно.

## Доказательства

- Протокол кейса: `$QA_ROOT/cases/H5.md` (re-run session 2).
- Скриншоты: `$QA_ROOT/evidence/H5-1-detached-panel.png`, `H5-2-dialog.png`, `H5-3-after-failed-push.png` (пусто после провала).
- Прогоны теста: `$QA_ROOT/evidence/BUG-GWT-006-red-run.txt` (красный без маркера), `$QA_ROOT/evidence/BUG-GWT-006-green-run.txt` (`it.fails`, зелёный).

## Причина

- Подтверждено (слой рендерера; ошибка пуша теряется в закрытом диалоге):
  1. `packages/ui/src/GitActionMenu.tsx:1191-1193` — после успешного commit вызывается `await pushCurrentBranch({ showToast: false })`; в случае провала push управление уходит в catch.
  2. `packages/ui/src/GitActionMenu.tsx:1209-1230` — единственный способ показать ошибку в catch — `setCommitError(...pushAfterCommitFailed...)` (1217-1227); тоста в failure-ветке нет вообще. `commitError` рендерится ТОЛЬКО внутри `GitCommitDialog` (`GitActionMenu.tsx:543`, `{error ? <p…>`), т.е. видим только при `commitDialogOpen === true`.
  3. `packages/ui/src/GitActionMenu.tsx:1370-1374` — `onOpenChange(false)` диалога вызывает `closeCommitDialog()` (`GitActionMenu.tsx:906-914`), которая безусловно сбрасывает весь стейт диалога (`commitError`, `commitDialogState`), НЕ проверяя `mutationPending`. Диалог dismiss-ится в любой момент между выбором действия и завершением async-операции (в Electron — вплоть до закрытия сразу при выборе, что и наблюдалось).
  4. Итог: push-reject → catch → `setCommitError` в закрытый диалог → ошибка невидима; тоста нет → тихий провал пользовательского действия. Воспроизведено компонентным тестом на том же код-пути (dismiss через `onOpenChange(false)` во время pending-пуша): после reject — диалог закрыт, текста ошибки нет в DOM, `toast` не вызывался, `commit` вызван 1 раз.
- Гипотеза: точный триггер закрытия диалога именно в момент выбора cmdk-пункта в production (Radix pointer/focus-взаимодействие cmdk внутри модального Dialog в Electron) — в jsdom клик по пункту диалог не закрывает; для дефекта это не существенно: любой dismiss в pending-окне теряет ошибку, что и доказывает тест.

## Предлагаемое исправление

Слой рендерера (`packages/ui/src/GitActionMenu.tsx`; продуктовый код не менялся): сделать failure-ветку `handleCommitAction` видимой независимо от жизненного цикла диалога — показать toast с текстом `pushAfterCommitFailed` (как это уже делает push-диалог через `pushDialog.error.requestFailed`), и/или не разрешать dismiss диалога (не вызывать `closeCommitDialog` по `onOpenChange(false)`), пока `mutationPending === true`, оставляя inline-ошибку в диалоге. Оба варианта закрывают и общий случай «пользователь закрыл диалог во время пуша».

## Тест

- Файл: `packages/ui/test/gitActionMenuError.test.ts`, НОВЫЙ, один `it.fails("BUG-GWT-006: keeps a push-after-commit failure visible after the commit dialog closes", …)`. Уровень — смонтированный `GitActionMenu` (jsdom + @testing-library/react), git замокан на RPC-границе `gitService` (refresh/stagePaths/commit — resolve; push — контролируемый deferred-reject «Cannot push while HEAD is detached.»); без sleep (только `findBy*`/`waitFor`/microtask-flush), самодостаточен, от `$QA_ROOT` не зависит.
- Сценарий: detached+dirty → commit-диалог → сообщение → «Commit and push» → push pending → dismiss диалога (production-путь `onOpenChange(false)` → `closeCommitDialog`) → push reject → ассерт: ошибка видима (открытый/переоткрытый диалог с ошибкой ИЛИ failure-toast). Сейчас: false → красный.
- Красный прогон без маркера:

```
FAIL  unit packages/ui/test/gitActionMenuError.test.ts > GitActionMenu commit dialog error visibility
  > BUG-GWT-006: keeps a push-after-commit failure visible after the commit dialog closes
AssertionError: push-after-commit failure must stay visible after the commit dialog closes:
  expected false to be true // Object.is equality
  ❯ packages/ui/test/gitActionMenuError.test.ts:243:9
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

Падение именно по багу (не по setup): до ассерта тест прошёл открытие диалога, «Commit and push» (commit вызван 1 раз, push вызван 1 раз), dismiss и reject; крашится только проверка видимости ошибки.

- С маркером `it.fails` файл зелёный: `Tests 1 expected fail (1)`.
