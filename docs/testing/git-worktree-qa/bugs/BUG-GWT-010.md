# BUG-GWT-010: факт executionWorktree не персистится в tasks-index — после рестарта у сессий закрытых воркспейсов пропадает маркер worktree и классификация Environment=Worktree

- Status: FIXED (fix wave 2, 2026-10-18: unit + live confirmed in RT2; marker removed)

- Severity: S3 (данные классификации/маркера неверны до повторного открытия воркспейса; обход — открыть воркспейс; сессии, история и git не затронуты)
- Кейсы: F7, I1
- Окружение: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build)

## Воспроизведение с нуля

1. Фикстура R1 (`basic`) по QA-PROMPT §4; QA-приложение запущено по §2.7, проект `basic` открыт.
2. Создать worktree-сессию: Command Center → «New task in worktree» (или переключатель Worktree в композере) → отправить сообщение. Дождаться ready: в сайдбаре у сессии есть маркер worktree (svg aria `Worktree session · <dir>`); Settings → Sessions: Branch=`zcode/<name>`, Environment=Worktree.
3. Убедиться, что воркспейс воркtree'а (или родительский воркспейс, под которым листится сессия) после этого закрыт (вкладка закрыта; host этого воркспейса не запущен).
4. Полностью перезапустить QA-приложение (QA-PROMPT §9, затем §2.7).
5. После старта, не открывая этот воркспейс:
   - сайдбар (Group): у worktree-сессии нет маркера worktree;
   - Settings → Sessions: Branch=`—`, Environment=Local (фильтр Environment=Local теперь включает эту сессию, фильтр Worktree — не включает).
6. Открыть воркспейс ещё раз → host стартует, sessions-index холодно сеется из session-store (`execution_directory`) → маркер и Branch/Environment возвращаются.

Проверка персистентности в песочнице (можно, это QA-sandbox база):

```bash
sqlite3 "$QA_ROOT/home/.zcode/v2/tasks-index.sqlite" \
  "SELECT task_id, meta_json LIKE '%executionWorktree%' FROM tasks ORDER BY created_at"
# ни у одной worktree-сессии ключа executionWorktree в meta_json нет (0)
```

## Ожидание

- `specs/worktree-icon-visibility.md` Decisions 3-5: маркер сайдбара рендерится из факта сессии `task.executionWorktree` (healthy/missing — единственные состояния); факт принадлежит сессии, а не текущей живости host'а.
- `specs/manage-sessions-table.md` §3 (Environment-фильтр client-side по presence `executionWorktree`) и §4 cols 7-8 (Branch=`executionWorktree.branchName`, Environment=`Worktree` по presence): классификация обязана отражать факт сессии; после рестарта без открытия воркспейса она деградирует до Local/`—`.
- Контракт строки это предполагает: `WindowHostControllerTaskRow.meta.executionWorktree` (`packages/shared/src/zcode-protocol-v4/controller.ts:105`), а `ZCodeTaskMeta.executionWorktree` заявлен как «Mirrors the sessions-index sessionSummary field» (`packages/shared/src/zcode-task-types-core.ts:367-372`) — т.е. persisted-мета должна нести этот факт, как это делают соседние зеркала (`sideChatCount`, `cronAutomationId`).

## Факт

- F7: после рестарта (шаг F5) сессия кейса C9 (воркспейс `detached`, worktree `zcode-grumpy-cookie`, папка на диске есть, ветка @5632c228) потеряла маркер в сайдбаре; Settings→Sessions показал её Environment=Local, Branch=`—`. Восстановление доказано: `qa-open detached` → маркер и Branch=zcode/grumpy-cookie, Environment=Worktree вернулись.
- Sqlite-факт (F7): в `meta_json` НИ ОДНОЙ worktree-сессии нет ключа `executionWorktree` (проверена и строка C3) — факт не пишется вообще, а не «теряется при перезаписи».
- I1 (полный перезапуск): сразу после старта маркер «Worktree session» был только у сессии заново открытого воркспейса `detached`; после `qa-open basic` маркеры вернулись у всех 10 basic worktree-сессий. Потерь сессий нет (16/16), git не изменился — дефект чисто классификации отображения.
- Git до/после: не изменён кейсами (см. `cases/F7.md`, `cases/I1.md`). Ошибок в логах нет.

## Доказательства

- `$QA_ROOT/cases/F7.md` — дефект-наблюдение (root code-confirmed) + sqlite-проверка.
- `$QA_ROOT/cases/I1.md` — повторное подтверждение на полном перезапуске (не новая регрессия рестарта).
- Скриншоты: `$QA_ROOT/evidence/F7-1-sessions-settings.png`, `$QA_ROOT/evidence/F7-2-env-all-table.png` (включая восстановленную строку C9), `$QA_ROOT/evidence/I1-1-after-restart.png`.
- Красный тест: `packages/services/test/taskIndexWorktreeFact.test.ts` (вывод ниже).

## Причина

- Подтверждено (полная трассировка, файл:строка):
  1. Живой факт существует только в канале sessions-index: CLI публикует `executionWorktree` в summaries (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1285` — `resolveIndexMeta`; `sessions-index-projection.ts:119`); Desktop получает его через `WindowHostSessionsIndexObserver` → `sessionOverlay()` (`packages/services/src/window-controller/windowHostControllerService.ts:103`) → строка live-проекции (`packages/services/src/window-controller/windowHostControllerProjection.ts:174` — `executionWorktree` берётся ТОЛЬКО из `overlay`, никогда из `membership.meta`).
  2. `listTaskList` мержит факт только из live-проекции: `windowHostControllerService.ts:613-617` (search-путь, `projected.executionWorktree`) и `:669-672` (list-путь, `row.executionWorktree`); persisted-часть строки (`normalized`/`row.meta` из tasks-index) факт не поставляет. `refreshSource` `:452-453` прямо комментирует дизайн: «Live facts remain in Host memory only», overlay подставляется из `sourceLiveOverlays` (`:453`) — для воркспейса без запущенного host'а (закрытый воркспейс после рестарта) он пуст.
  3. Запись факта не происходит нигде: единственный writer `meta_json` — `TaskIndexRepo.syncTaskMeta` → `serializeMetaJson` (`packages/services/src/session/taskIndexRepo.ts:1626`, `:266-268`); все вызывающие строят meta без факта — `buildMetaFromSnapshot` (`packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts:1838-1888`, вызов `:1704`) и `zcodeTaskServiceAdapter.ts:1525`: `rg executionWorktree packages/services/src/session packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` — 0 вхождений. Источник снапшота физически не содержит поля: `zcodeSessionStateSnapshotSchema` (`packages/shared/src/zcode-protocol/index.ts:1362-1382`) и `ZCodeAgentCreateSessionParams` (`packages/services/src/zcode-agent/zcodeAgent.ts:223-239`) без `executionWorktree` — у desktop-стороны нет канала, по которому факт попал бы в persisted meta.
  4. Даже ручная запись не помогла бы чтению: `rowToMeta` парсит `meta_json` через `zcodeTaskMetaSchema` (`taskIndexRepo.ts:213`; `packages/shared/src/validation.ts:1703-1777`) — полей `executionWorktree`/`executionWorktreeMissing` в схеме нет, zod по умолчанию strip-ает неизвестные ключи. TS-интерфейс `ZCodeTaskMeta` поле объявляет (`zcode-task-types-core.ts:372`), но runtime-контракт персистентности не расширен.
- Гипотеза: — (причина подтверждена код-трассировкой до всех четырёх звеньев и красным тестом; слой будущего фикса — за владельцем).

## Предлагаемое исправление

Направление (без изменения протокола): сделать факт персистентным свойством tasks-index по образцу `cronAutomationId`/`offPeakTaskId` (meta_json — источник истины, preserve-on-absent при последующих runtime-синках):

1. `packages/shared/src/validation.ts`: добавить `executionWorktree` (reuse `zcodeExecutionWorktreeSchema`) и `executionWorktreeMissing` в `zcodeTaskMetaSchema`; `rowToMeta` уже вернёт их через spread `parsed.data`.
2. Писать факт на Host-границе в момент, когда он уже известен: при получении sessions-index summaries (там, где строится `sessionOverlay` / в syncer'е при `syncTaskMeta`) — т.е. каналом становится существующий v4 sessions-index, отдельного протокольного поля не требуется.
3. В мердже читать факт как fallback из persisted meta, когда overlay отсутствует: `windowHostControllerProjection.ts` `buildSourceRows` (spread из `membership.meta`) и/или `windowHostControllerService.ts:613-617,669-672`.

Слой: `packages/services` (+ shared validation). Тест ниже не привязан к способу — проверяет итоговый контракт холодного чтения.

## Тест

`packages/services/test/taskIndexWorktreeFact.test.ts` — services-уровень, без UI: реальный `TaskIndexRepo` во временной sqlite + `createWindowHostControllerRuntime`; live-фаза доставляет факт через sessions-index snapshot frame (единственный существующий сегодня канал), затем «рестарт»: свежий repo + свежий runtime без agent-сервиса (закрытый воркспейс), и холодный `listTaskList` обязан вернуть `executionWorktree`. Без sleep, самодостаточен, мокается только RPC-поверхность agent-сервиса.

`it.fails("BUG-GWT-010: cold listTaskList after a restart keeps the worktree session fact")`.

Красный прогон без маркера (`"$QA_ROOT/bin/real-run.sh" "$NODE_BIN" scripts/run-vitest.mjs run packages/services/test/taskIndexWorktreeFact.test.ts`):

```
 FAIL  unit packages/services/test/taskIndexWorktreeFact.test.ts > task index executionWorktree fact across restart (BUG-GWT-010) > cold listTaskList after a restart keeps the worktree session fact
AssertionError: expected undefined to deeply equal { …(2) }

- Expected:
{
  "branchName": "zcode/brave-otter",
  "path": "/work/demo-worktree/.worktrees/zcode-brave-otter",
}

+ Received:
undefined

 ❯ packages/services/test/taskIndexWorktreeFact.test.ts:188:46

 Test Files  1 failed (1)
      Tests  1 failed (1)
```

(падение ровно на холодном ассерте: live-фаза прошла — строка одна, факт из live-overlay присутствовал; подтверждает, что красный — это баг, а не setup)

С маркером `it.fails`: `Tests  1 expected fail (1)` — зелёный; станет красным, когда баг починят (тогда маркер снять).
