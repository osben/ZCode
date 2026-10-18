# BUG-GWT-013: Чип назначения не появляется после программного открытия воркспейса (qa-open/--open-workspace) — потерянный первичный git-refresh не повторяется

- Severity: S4 (косметика/доступность фичи; восстановимо reload'ом рендерера или кликом по проекту; FLAKY-признак — гонка инициализации)
- Кейсы: A2, A4 (повторные наблюдения: B1-0, warn в H-блоке; см. progress.md 18:40, 19:44, 21:28)
- Окружение: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build)

## Воспроизведение с нуля

1. Фикстуры R2 (`empty`) и R5 (`detached`) по QA-PROMPT §4; QA-приложение запущено (QA-PROMPT §2.7), какой-нибудь воркспейс (R1) уже открыт и имеет чип «Choose where this task runs».
2. Открыть новый воркспейс вторым экземпляром (QA-PROMPT §3.6):

   ```bash
   source "$QA_ROOT/bin/qa-vars.sh"
   cd "$REPO/packages/desktop"
   "$QA_ROOT/bin/qa-run.sh" "$ELECTRON_BIN" . --open-workspace="$QA_ROOT/repos/empty"
   ```

3. В открытом воркспейсе проверить DOM: `document.querySelector('[aria-label="Choose where this task runs"]')` → `null` (сразу и через 2 минуты). При этом чип проекта в композере есть, композер активен.
4. `agent-browser reload` → чип появляется (для R2 текст «main», для R5 «Detached HEAD»).
5. Альтернативное восстановление без reload: клик по другому проекту в сайдбаре и обратно (смена workspacePath перезапускает refresh).

В логе в секунду открытия: `zcode-agent.subscribeSessionsIndexV4 FAIL … Error: ZCode Agent runtime is not running` (маркер гонки старта runtime; сама sessions-index подписка восстанавливается сама — `subscribeSessionsIndexV4 OK` через ~0.5 c).

## Ожидание

`specs/composer-branch-switcher-semantics.md` §4 (единый destination control) и §47 (empty repo: чип с base=HEAD): чип назначения присутствует в драфтовом композере любого project-воркспейса, являющегося git-репозиторием, без ручного reload — состояние чипа должно резолвиться из состояния воркспейса само.

## Факт

- R2 (18:38:14): чип отсутствовал >2 минут после qa-open (проверен дважды с интервалом; `evidence/A2-1-empty-repo.png`), появился только после reload. Контроль: R1, открытый тем же способом 4 минутами раньше, чип имел сразу.
- R5 (18:50:58): та же картина на обычном репо — не специфично для unborn HEAD (`cases/A4.md` шаг 2).
- Лог хоста в секунду открытия: `git.refresh OK` — 18:38:14.819 (39.6ms) и 18:50:58.242 (29.1ms); следующий `git.refresh` только после reload: 18:51:21.135. За весь прогон: 254× `git.refresh OK`, 0× FAIL; в рендерере нет ни одного warn `[useGitRepository] 读取 Git 仓库状态失败`.
- То есть: git-состояние на хосте получено успешно, рендерер результат не применил и не повторил запрос; git-данные не изменились (ground truth A2/A4 без изменений).

## Доказательства

- `$QA_ROOT/evidence/A2-1-empty-repo.png` — чип отсутствует (draft-состояние, чип проекта «empty» есть)
- `$QA_ROOT/evidence/B1-0-chip-missing.png` — то же на workspace `basic` (после рестарта приложения)
- `$QA_ROOT/evidence/A4-1-chip-detached.png` — чип после reload («Detached HEAD»)
- Лог: `$QA_ROOT/home/.zcode/v2/logs/2026-10-17.log` — строки 6777 (18:38:14.793 subscribeSessionsIndexV4 FAIL), 6792 (18:38:14.819 git.refresh OK), 6804 (18:38:15.334 subscribeSessionsIndexV4 OK), 7267 (18:50:58.242 git.refresh OK), 7426 (18:51:21.135 git.refresh OK после reload)
- Скриншоты не коммитить.

## Причина

- Подтверждено (код + лог):
  - Чип рендерится только при `shouldRenderComposerDestinationControl` → `gitState.workspaceKey === activeWorkspaceKey && gitState.summary.isGitAvailable && gitState.summary.isRepository` (`packages/ui/src/v4/composer/destinationControlVisibility.ts:10-20`; монтаж — `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1543-1546` и 1640-1655; состояние `gitState` — единственный владелец `useGitRepository`, `packages/ui/src/App.tsx:491-501`).
  - `useGitRepository` делает ровно ОДИН `gitService.refresh` на смену workspacePath (`packages/ui/src/hooks/useGitRepository.ts:465-475`); решение о повторе — `shouldRefreshLiveGitData` (`useGitRepository.ts:354-381`) — не учитывает ошибку/потерю результата: пока workspacePath/workspaceKey/refreshToken/includeExtendedData не изменились, повтор никогда не случится.
  - Результат запроса отбрасывается молча при `disposed || requestVersionRef.current !== requestVersion` (`useGitRepository.ts:499-503`); cleanup выставляет `disposed=true` (`useGitRepository.ts:550-552`); reject пишет error-state тоже без ретрая (`useGitRepository.ts:530-548`).
  - Auto-refresh не может спасти: файловые watcher-ы ставятся только если `gitSummary.isGitAvailable && gitSummary.isRepository` уже true (`packages/ui/src/hooks/useGitAutoRefresh.ts:59`) — замкнутый круг для «застрявшего» воркспейса.
  - Лог подтверждает: хост вернул успех в секунду открытия, рендерер не зафиксировал ни ошибки, ни повтора; восстановление пришло только от remount (reload) или смены workspacePath (клик по проекту) — оба перезапускают эффект с `shouldRefresh=true`.
- Гипотеза (не проверено до конца): какой именно триггер сбросил in-flight запрос в проде — в окне 25–40 мс после открытия идёт всплеск ре-рендеров/переподключений (deep-link → addTab + startDraftInWorkspace + setting.update, создание v4 workspace connection, старт CLI-runtime — в ту же секунду падает `subscribeSessionsIndexV4` с «ZCode Agent runtime is not running», `packages/ui/src/v4/agentSessionsIndexTransport.ts:121-126` c `runtimePolicy: "existing-only"`); вероятно, изменение identity одной из зависимостей эффекта (например, сервисного прокси) привело к cleanup при неизменных «логических» входах → результат отброшен, повтор не запланирован. Контраст: sessions-index-слой в той же гонке повторяет подписку и восстанавливается (OK через 504 мс), git-слой — нет.

## Предлагаемое исправление

Слой `packages/ui/src/hooks/useGitRepository.ts` (без изменений протокола): сделать потерю/сбой первичного refresh самоисцеляющейся — например, (а) учитывать в `shouldRefreshLiveGitData` незавершённость (`loading && !summary.isRepository`) или ошибку последнего запроса как основание для повора при следующей оценке эффекта/rpcReady-переходе, или (б) не отбрасывать результат in-flight запроса при identity-смене сервиса без смены workspaceKey. Не маскировать таймаутами.

## Тест

- `packages/ui/test/destinationChipOpenWorkspaceGitRefreshRetry.test.ts` — hook-уровень (детерминированный), прогон:
  `"$QA_ROOT/bin/real-run.sh" "$NODE_BIN" scripts/run-vitest.mjs run packages/ui/test/destinationChipOpenWorkspaceGitRefreshRetry.test.ts`
  - контрольный кейс (без сброса запроса) — PASS: харнесс валиден;
  - кейс бага: после смены workspacePath (open-workspace) in-flight `git.refresh`, сброшенный переподключением сервиса (identity-swap при неизменных логических входах), должен резолвиться без remount — чип (`shouldRenderComposerDestinationControl`) должен стать видимым.
- Красный прогон без маркера (падает именно assert бага, не setup):

```
FAIL  packages/ui/test/destinationChipOpenWorkspaceGitRefreshRetry.test.ts > BUG-GWT-013: re-issues the initial git refresh when the in-flight result is dropped, so the destination chip resolves without a reload
AssertionError: expected false to be true
  ❯ expect(result.current.summary.isRepository).toBe(true)
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

- С маркером `it.fails` (CI остаётся зелёным; станет красным, когда баг починят):

```
✓ packages/ui/test/destinationChipOpenWorkspaceGitRefreshRetry.test.ts (2 tests) 524ms
  ✓ BUG-GWT-013: re-issues the initial git refresh ... 512ms
 Test Files  1 passed (1)
      Tests  1 passed | 1 expected fail (2)
```
