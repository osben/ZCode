# BUG-GWT-002: Review pane / счётчик изменений не обновляются сами при внешнем изменении файлов (60-секундный самосбрасывающийся debounce)

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)

- Severity: S3 (обход есть — ручной Refresh; UX-деградация stale-статуса до минуты и дольше)
- Кейсы: A7 (основной; FAIL 0/2), B2 (echo: предупреждение о dirty появилось только после reload), F2 (echo: счётчик изменений stale до переоткрытия панели)
- Окружение: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build, sandbox HOME)

## Воспроизведение с нуля

1. Фикстура R1 `basic` (см. `$QA_ROOT/bin/make-fixtures.sh R1`; чистый `main`).
2. Открыть `$QA_ROOT/repos/basic` как проект в QA-приложении (`qa-run.sh "$ELECTRON_BIN" . --open-workspace=…`), Review pane открыт, статус чист («No changes are available»).
3. Снаружи дописать строку в tracked-файл:
   `"$QA_ROOT/bin/qa-run.sh" bash -c 'echo "probe line" >> /Users/<user>/.zcode-git-qa/<run>/repos/basic/src/app.txt'`
4. Наблюдать Review pane и хвост лога хоста (`$QA_ROOT/home/.zcode/v2/logs/<date>.log`, счётчик строк `git.refresh OK`).

## Ожидание

- Кейс A7: «изменение файла снаружи (qa-run.sh) → Review pane обновляется сам, без ручного refresh» (`$QA_ROOT/cases/A7.md`).
- Дизайн цепочки, задокументированный в самом коде: 150 ms debounce на watcher-е (`packages/services/src/fileWatcher/fileWatcherService.ts:10`) + 350 ms Git debounce на рендерере (историческая заметка в комментарии `packages/ui/src/hooks/useGitAutoRefresh.ts:13-14`). Ручной refresh отрабатывает за ~1-2 с — авто-refresh обязан укладываться в секунды.
- Примечание: `specs/review-reliability-fixes.md` тайминги авто-refresh не регулирует (у кейса A7 ссылка на неё условная); ожидание здесь — из определения кейса и собственного дизайна кода.

## Факт

- За 45 с (проба 1) + повторная дописка строки + 10 с контроля по логу (проба 2) панель НЕ обновилась ни разу: «No changes are available» при том, что git видит `1 .M src/app.txt`.
- Счётчик `git.refresh OK` в логе хоста за окно наблюдения 44 → 44: RPC не вызывался вовсе.
- При этом watcher зарегистрирован: `file-watcher.watch OK` ×2 в 19:07:56.986 (корень workspace recursive + `.git`), подписка `file-watcher.onDynamicChange` оформлена; ошибок/предупреждений `[GitAutoRefresh]` в логе нет.
- Ручной Refresh сразу показывает `src / app.txt +1−0` — данные и путь корректны, ломается только автоматический триггер.
- Echo-эффекты в B2 и F2 согласуются: stale-состояние живёт до reload/reopen, т.е. дольше любых наблюдаемых окон.

## Доказательства

- Протокол кейса и хронология: `$QA_ROOT/cases/A7.md` (A7-скриншотов нет — вердикт по опросу UI + счётчику лога; git ground truth внутри кейса).
- Лог хоста: `$QA_ROOT/home/.zcode/v2/logs/2026-10-17.log` — `file-watcher.watch OK` ×2 в 19:07:56.986; `git.refresh OK` в 19:07:56.982 (44-й) и далее только в моменты ручных/навигационных обновлений (19:08:11.002, 19:09:36.293, 19:09:53.149).
- B2: `$QA_ROOT/evidence/B2-1-dirty-cue.png` … `B2-3-dirty-cue.png`; F2: `$QA_ROOT/evidence/F2-1-changes.png` … `F2-3-after-commit.png`.
- Красный прогон теста — в разделе «Тест» ниже.

## Причина

- Подтверждено:
  - `packages/ui/src/hooks/useGitAutoRefresh.ts:15` — `GIT_AUTO_REFRESH_DEBOUNCE_MS = 60_000`: автorefresh отложен на 60 c.
  - `packages/ui/src/hooks/useGitAutoRefresh.ts:110-121` — `scheduleRefresh` на КАЖДОМ событии делает `clearTimeout` + новый `setTimeout(60 000)`: refresh срабатывает только после 60 c полной тишины в файловой системе. Окно наблюдения A7 — 45+10 c < 60 c, вторая дописка (~T0+45 c) сбрасывала таймер заново → 0 вызовов `git.refresh`. При любой активности чаще раза в минуту refresh откладывается бесконечно (starvation) — включая batch-записи агента, ради которых задержка и вводилась.
  - Отягчающее (та же причина): cleanup эффекта `packages/ui/src/hooks/useGitAutoRefresh.ts:160-165` гасит незавершённый 60-секундный таймер при любом ре-ране эффекта/unmount (смена панели/вкладки/workspace) — в B2/F2 ожидание отменялось ещё и навигацией.
  - Остальная цепочка цела и подтверждена: host-watcher `fs.watch(recursive)` с debounce 150 ms (`packages/services/src/fileWatcher/fileWatcherService.ts:10,63-88`) регистрируется (лог `watch OK` ×2), событие подпиской `onDynamicChange` доставляется в `scheduleRefresh`, а `onRefreshGit` → `handleRefreshGit` (`packages/ui/src/App.tsx:475-481`) → `setGitRefreshVersion` → RPC `git.refresh` — ручной путь работает. Существующие тесты `packages/ui/test/gitAutoRefresh.test.ts` и `packages/ui/test/useGitAutoRefresh.test.ts` покрывают только выбор путей наблюдения, не задержку.
- Гипотеза: сквозная доставка конкретного fs-события по RPC в момент эха напрямую не трассировалась (QA-приложение остановлено); но подписка зарегистрирована, ошибок нет, и подтверждённой кодовой причины достаточно для всех наблюдаемых фактов (55 c < 60 c).

## Предлагаемое исправление

Слой рендерера, `packages/ui/src/hooks/useGitAutoRefresh.ts` (продуктовый код не менялся — по заданию):

- вернуть Git debounce в суб-секундный диапазон проекта (350 ms), либо, если нужна защита от batch-записей агента, заменить «trailing debounce с полным сбросом» на throttle/leading-edge (первое событие — refresh, далее cooldown), чтобы продолжительная активность не морила refresh голодом, а cleanup при переключении панели не отменял обновление навсегда;
- синхронно обновить комментарий/документацию о выбранной семантике; host-side 150 ms debounce не трогать.

## Тест

- Файл: `packages/ui/test/gitAutoRefreshExternalChange.test.ts` (новый; уровень — unit-тест хука `useGitAutoRefresh`; моки только RPC-границы `fileWatcherService`/`systemService`, git-логика авто-refresh реальная; `vi.useFakeTimers`, без sleep; самодостаточен, не зависит от `$QA_ROOT`). Существующее имя `gitAutoRefresh.test.ts` занято upstream-тестом выбора путей, поэтому файл назван `gitAutoRefreshExternalChange.test.ts`.
- Красный прогон без маркера (имя `it("refreshes Git shortly after an external change event reaches the renderer")`):

```
RUN  v4.1.7 /Users/osben/Dev/ZCode-qa-20261017
 unit  packages/ui/test/gitAutoRefreshExternalChange.test.ts (1 test | 1 failed) 8ms
    × refreshes Git shortly after an external change event reaches the renderer 7ms

 FAIL  unit  packages/ui/test/gitAutoRefreshExternalChange.test.ts > useGitAutoRefresh external file change > refreshes Git shortly after an external change event reaches the renderer
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 ❯ packages/ui/test/gitAutoRefreshExternalChange.test.ts:97:26
    95|     });
    96|
    97|     expect(onRefreshGit).toHaveBeenCalledTimes(1);
      |                          ^
    98|   });
    99| });

 Test Files  1 failed (1)
      Tests  1 failed (1)
```

(Предусловия в том же прогоне прошли: `watch` вызван с `{ path: "/repo", recursive: true }`, слушатель подписан — падение именно по assert'у бага, не по setup.)

- После маркировки `it.fails("BUG-GWT-002: refreshes Git shortly after an external change event reaches the renderer")`:

```
 ✓  unit  packages/ui/test/gitAutoRefreshExternalChange.test.ts (1 test) 9ms
 ✓  unit  packages/ui/test/gitAutoRefresh.test.ts (8 tests) 2ms
 ✓  unit  packages/ui/test/useGitAutoRefresh.test.ts (1 test) 7ms

 Test Files  3 passed (3)
      Tests  9 passed | 1 expected fail (10)
```

Тест станет красным, когда debounce вернут в суб-секундный/корректный режим — маркер можно будет снять.
