# ACTUAL ISSUES — Git/Worktree QA (verified live 2026-10-18, build b60bdde3)

Единственный источник актуальных проблем для следующего цикла исправлений.

> **Статус после волны 3 (2026-10-18, ветка claude/git-worktree-qa-bugs-0c60cd):**
> OPEN-1 — FIXED (живьём на production-сборке ветки, RT4-C5, 2 прогона); OPEN-2 — not reproduced
> (5/5 New-task Send доставлены после фикса, оговорки ниже); MINOR-1 — FIXED вместе с OPEN-1; MINOR-2 — FIXED (причина Git в
> `{reason}`, подсказка про репозиторий без коммитов); MINOR-3 — deferred (подсистема восстановления
> сессии / выбора проекта, не worktree); MINOR-4 — deferred (продуктовое решение владельца);
> MINOR-5 — not reproduced (0 send-RPC во время ввода, включая `inserttext` с ожиданием 14 с). Детали — в пунктах ниже.
> Статус после трёх волн: 12 из 13 багов закрыты и подтверждены живьём
> (001–004, 006–013); проверка — marker-тесты + UI-ретесты RT3 (QA_ROOT/cases/RT3-\*.md).
> Ниже — ТОЛЬКО то, что воспроизводится сейчас.

---

## OPEN-1 (BUG-GWT-005, S3): после Retry очередь не дрейнит в ход — допуск сообщения не происходит

**Состояние (волна 3): FIXED.** Локализация «рантайм CommandInbox» опровергнута: после Retry
рендерер не отправлял ни `createSession`, ни `sendText` (RPC на Retry+0 мс — это
`updateWorktreePreparation{preparing}`). Настоящая причина (CDP-трасса): reconcile-эффект
`ConversationWorktreeSetupSteps` с устаревшим Host-сидом `{failed, A}` откатывал запись Retry
`creating(B)` → `failed(A)`, queued-send эффект отцеплял продолжение. Фикс — `supersededAttemptIds`
(restore игнорирует сид заменённой попытки). Живьём: Retry → createWorktree +146 мс →
createSession +206 мс → prepareTurn +556 мс → sendText +572 мс, файл создан в worktree, карточка
recovery снята. Подробно — `bugs/BUG-GWT-005.md` §Wave 3.

**Исходное описание (до волны 3):**
Fix 2f76fd5e сделал: Retry → сообщение ставится в очередь (`sendConversationCommandV4` +0 мс),
prepared-сессия открывается сама, worktree создаётся (+99 мс), continuation живёт
в store-level registry и переживает promotion. **Но за 120 с — 0 turn-активирующих RPC**
(`prepareTurn`/turn-start/activate), `taskBus.leases = 0` во всех снапшотах, файл не создаётся,
recovery-карточка и «Queued message» висят. Ручной Restore → Send → Confirm работает:
`prepareTurn` +456 мс, файл ≤10 с, та же сессия. 4-я живая улика (C5, RT-C5, RT2, RT3-C5).

- Спека: `specs/composer-worktree-setup-steps.md` §Contract retry-admission
  («ready-запись, которая ничего не допускает — нарушение контракта») + stuck-ready routing
  (обновлена волной-2).
- Локализация (сужена): рантайм **CommandInbox не берёт queued-сообщение в lease после
  готовности worktree**; рендерер-часть исправлена и покрыта регрессией
  (`packages/ui/test/composerWorktreePipeline.test.ts` + upstream
  `v4ConversationComposerWorktreeLateAck.test.ts`).
- Воспроизведение с нуля: R1 basic → `chmod 555 $QA_ROOT/repos/basic-worktrees` →
  worktree-on + отправить «Create file x.txt with text X» → failed → `chmod 755` → Retry →
  наблюдать 120 с (нет prepareTurn) → Restore → Send работает.
- Evidence: `QA_ROOT/cases/RT3-C5.md` (хронология RPC), скриншоты RT3-C5-0..3;
  git-мусора нет (rollback волны-1 работает).
- Направление фикса: рантайм — после перехода prepared-сессии в ready (worktree создан)
  CommandInbox должен взять замороженное queued-сообщение в lease и запустить ход
  ( тот же путь, что у ручного Send: `sendConversationCommandV4` → `prepareTurn`).

## OPEN-2 (наблюдение, класс 005-семейства, S4): редкая тихая потеря Send из «New task»

1× за раунд: Send из New task empty-композера принят UI, редактор очищен, но
0 `sendConversationCommandV4` в логах, сессия не создана; после reload та же отправка
доходила. RT-C5-эпоха: воспроизводился 2/2 при живом stuck-ready пайплайне; на сборке
b60bdde3 — 1× без стойкой связи (вероятная связь с keep-warm dispose в тот же момент).
Сопровождается «черновиком-призраком» (отправленный текст возрождался в композере).
Проверить при фиксе OPEN-1 (возможно, тот же lease-путь).

**Волна 3: not reproduced.** На production-сборке с фиксом OPEN-1: 5 раз session-view → New task →
Send (3× `keyboard type`, 2× `keyboard inserttext`) — каждый раз send-RPC ушёл, сессия создана,
редактор пуст, черновика-призрака нет (`$QA_ROOT/evidence/RT4-OPEN2-newtask-3x.png`,
`RT4-final-refactor-newtask.png`). Оговорки: worktree-intent оставался включённым (каждая отправка
создавала worktree-сессию; вариант с выключенным intent автоматизацией не получен), и
stuck-ready пайплайна (исходного предусловия) не было — после фикса OPEN-1 он не возникает.
Если потеря повторится — локализовать как dispose-гонку рендерера.

## MINOR (наблюдения, S4, без блокировки)

1. **[FIXED, волна 3 — следствие OPEN-1]** **Recovery-карточка не исчезает после успешного Retry** (RT3-C5/RT3-B нюансы) —
   остаётся до ручного Restore, хотя сессия открыта и очередь стоит.
2. **[FIXED, волна 3]** Неклассифицированный отказ Git показывает строку Git
   («Could not create the worktree: could not create leading directories of '…': Permission denied»,
   живьём RT4-C5), `target-branch-not-found` подсказывает про репозиторий без коммитов
   (`worktreeCreation.ts`, тест `worktreeCreationFailureReason.test.ts`). Исходно:
   **{reason} в ошибках подготовки worktree — генерик** («Could not create the worktree»
   без permission/EACCES; «Base branch "main" was not found» без упоминания пустого репо)
   — волна-1 закрыла сырые ключи, полировка причины не сделана.
3. **[DEFERRED]** — подсистема восстановления сессии и выбора проекта (не worktree), нужна отдельная
   локализация; «basic» отсутствовал в пикере и на b60bdde3 при живом прогоне волны 3.
   **New task сбрасывает выбор проекта** (path-dependent: из session-view → «Select project»,
   чипа нет; из empty-state — выживает) + «basic» отсутствует в списке выбора воркспейса
   New task (только 6 недавних) — RT3-C7obs.
4. **[DEFERRED — продуктовое решение]** предупреждать ли перед коммитом в detached HEAD — вопрос
   владельцу. **Detached-коммит уходит вне веток без предупреждения** (H5-производный UX-вопрос;
   push при этом корректно отказывает с видимым тостом).
5. **[NOT REPRODUCED, волна 3]** 0 `sendConversationCommandV4` в окне ввода во всех прогонах:
   3× `keyboard type` и 2× `keyboard inserttext` (исходный метод, окно ожидания 14 с до Enter).
   Тайминг-аномалия: `sendConversationCommandV4` однажды пришёл в лог за ~14 с ДО клика
   Send (в момент inserttext) — дубля не было; понаблюдать при работе с OPEN-1.

## Закрыто этой волной (для справки, повторно подтверждено живьём на b60bdde3)

010 (маркер/классификация Worktree переживают рестарт с закрытым воркспейсом — RT3-F7),
011 (бейдж Conflicted — RT3-A8), 012 + «1 files» (formatPlural en/zh/uk, guard-диалог и
dirty-cue — RT3-B6/RT3-1files), 006 (видимый тост «Committed, but push failed: …» 2/2 —
RT3-H5), 013 (чип назначения ~100 мс после программного открытия — RT3-A2/A4).
Волна-1 (b67cc63f): 001, 002, 003, 004, 007, 008, 009.

## Проверки на этой сборке

typecheck PASS, lint PASS, architecture:check --changed PASS, oxfmt (наши файлы) clean,
все ранее-маркерные тест-файлы rc=0 (маркеры сняты волной-2), G1 start/end PASS,
0 [error] за раунд, изоляция не нарушена, порт 9339 свободен.
