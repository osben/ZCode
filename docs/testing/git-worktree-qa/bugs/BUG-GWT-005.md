# BUG-GWT-005: после Retry в recovery подготовка зависает в ready — замороженное сообщение не допускается в сессию автоматически

- Status: FIXED (wave 3, 2026-10-18), verified live on a production QA build of the fix branch (RT4-C5): Retry → `git.createWorktree` +146 ms → `createSession{preparedSessionId}` +206 ms → `highspeed-card.prepareTurn` +556 ms → `sendText` +572 ms with no user action; recovery card and "Queued message" cleared; agent wrote `live6.txt` in the worktree of the same session.
- Previous status (wave 2): PARTIALLY FIXED — continuation moved to a store-level registry surviving view promotion; the remaining "runtime CommandInbox" localization turned out to be wrong (see Wave 3 below).

## Wave 3 (2026-10-18): real cause — stale Host seed rolls Retry back

**The CommandInbox localization was disproven.** Evidence from the RT3-C5 host log and code:

- The `sendConversationCommandV4` at Retry+0 ms is `updateWorktreePreparation{status:"preparing"}` from `SessionPane.handleWorktreePreparationRetry`, not an enqueued message. After `git.createWorktree`/`ensureWorktreeExclusion` the auto path made **no** Host call (no `createSession`, no `sendText`), so nothing ever reached the CommandInbox. "Queued message" is a renderer-only timeline label (`entry.queuedPromptPreview`). `prepareTurn` is a renderer highspeed side-call inside the send path, and `taskBus.leases` is an Electron-main metric, not CommandInbox state.
- Production renderer logging is a no-op, so the live path was traced with CDP conditional breakpoints in the minified bundle (`$QA_ROOT/evidence/RT4-C5-cdp-logpoints-before-fix.log`). Queued-send effect runs after Retry:
  1. `creating`, attempt B (retry) — continuation armed, rebinds to B;
  2. **`failed`, attempt A (the old attempt)** — continuation still armed;
  3. `creating`, attempt B — continuation **released**;
  4. `ready`, attempt B — nothing to dispatch.

Confirmed cause:

- `packages/ui/src/v4/ConversationWorktreeSetupSteps.tsx` (Host reconcile effect, deps include `entry`) re-runs when Retry's `startPipeline(creating, B)` changes the entry, but its `preparation` prop is still the stale Host seed `{failed, A}`: the Host accepted the retry before its snapshot reached the renderer.
- `packages/ui/src/v4/composer/composerWorktreePreparationRestore.ts` treated any `hostAttempt !== entryAttempt` as a "newer Host generation" and replaced the entry with `failed(A)`.
- `packages/ui/src/v4/ConversationComposer.tsx` queued-send effect: attempt mismatch + status `failed` → `detachQueued()` + `restore()` — the armed continuation is released permanently, so the later `ready(B)` admits nothing and the recovery record stays (MINOR-1).

Fix: attempt ids are opaque, so "newer" is decided by supersession. `retryComposerWorktreePipeline` records the replaced attempt in `entry.supersededAttemptIds`; restore ignores a Host seed carrying a superseded attempt; a genuinely newer Host attempt still replaces the entry and inherits the superseded set. Spec: `specs/composer-worktree-setup-steps.md` (supersession paragraph + event diagram, acceptance scenario 17).

Tests (`packages/ui/test/composerWorktreePipeline.test.ts`):

- `BUG-GWT-005: the stale Host failed seed for the retried attempt cannot roll back Retry and strand the frozen submission (RT4-C5 live path)` — mounted `ConversationComposer` + real `ConversationWorktreeSetupSteps`, real Retry button, stale `{failed, A}` seed, Host seed updated afterwards.
- `BUG-GWT-005: ignores a Host seed for an attempt the renderer already superseded, but still yields to a newer Host attempt` — restore-level rule.
- Red without the fix (source swapped to HEAD): mounted test `expected "vi.fn()" to be called 1 times, but got 0 times`; store trace `creating B → failed A → creating B (released) → failed B`, identical to the live CDP trace. Green with the fix: 41/41 in the file; 50 worktree/composer/command-center files, 467 tests green.

- Severity: S3 (обход есть — ручной Restore → Send в той же сессии; но нарушен контракт спеки о допуске замороженной отправки после ready)
- Кейсы: C5 (основной, FAIL)
- Окружение: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (ветка `qa/git-worktree-20261017`), изолированный QA-инстанс (production build, sandbox HOME)

## Воспроизведение с нуля

1. Фикстура R1 `basic` (`"$QA_ROOT/bin/qa-run.sh" bash "$QA_ROOT/bin/make-fixtures.sh" R1`).
2. Заранее сломать создание: `mkdir -p $QA_ROOT/repos/basic-worktrees && chmod 555 $QA_ROOT/repos/basic-worktrees`.
3. Открыть `$QA_ROOT/repos/basic` в QA-приложении, в пустом состоянии включить Worktree, Send: «Create file c5-marker.txt with text C5. Reply with pwd.»
4. Дождаться сбоя (~4 с): шаг `data-worktree-setup-step="failed"` + recovery-карточка `data-testid="composer-worktree-recovery"` («Unsent message saved …»).
5. Вернуть права: `chmod 755 $QA_ROOT/repos/basic-worktrees`.
6. Нажать Retry (кнопка с ключом `worktreeSetup.retry`). Git-часть succeeds: worktree создан, второй ветки нет.
7. Наблюдать ≥40 с (поллинг `data-worktree-setup-steps` каждые 3 с): шаг навсегда `data-worktree-setup-step="ready"`; сессия не открывается, замороженное сообщение не принимается; клик по таску в сайдбаре тоже не активирует.
8. Обход: Restore на recovery-карточке → текст в редакторе → Send → та же prepared-сессия принимает сообщение, агент работает в worktree.

## Ожидание

- `specs/composer-worktree-setup-steps.md` §Contract: «After Git reports a ready path, activate the same session with the frozen submission. The Host validates and constructs the runtime with `executionWorktree` as its initial execution directory, then admits that submission exactly once» (то же в §Submission and editor behavior) и: «If activation fails before admission, the preparation entry stays `preparing` with its session identity, so the frozen submission remains recoverable and **one retry can admit it exactly once**».
- Кейс C5: «после возврата прав Retry создаёт worktree» и сообщение допускается; зависание ready без авто-активации контрактом не предусмотрено.

## Факт

- После Retry шаг зависал в `ready` ≥40 с (поллинг ×10: `steps=["ready"]`): сессия не открылась, замороженное сообщение не принято.
- В логах после `git.createWorktree OK` (72.0 ms) ни одного вызова активации/отправки (нет v4-команд допуска первого input).
- Открытие таска «Worktree zcode/dancing-walrus» из сайдбара не активирует сессию.
- Ручной путь работает: Restore → Send → та же сессия, агент создал `c5-marker.txt` (C5), pwd = worktree — данные и идентичность сессии целы, теряется только автоматический допуск.
- Git-состояние после Retry корректно: worktree создан (28 записей), ветка та же, новых orphan-веток от Retry нет (полу-ветка от первого сбоя — отдельный дефект кейса C5, не этот баг).

## Доказательства

- Протокол кейса: `$QA_ROOT/cases/C5.md`.
- Скриншоты: `$QA_ROOT/evidence/C5-2-retry-ready-stuck.png` (зависший ready), `C5-3-restored.png` (Restore), `C5-4-final.png` (ручная отправка сработала).
- Красный/зелёный прогон теста: `$QA_ROOT/evidence/BUG-GWT-005-red-run.txt`, `$QA_ROOT/evidence/BUG-GWT-005-green-run.txt` (и раздел «Тест» ниже).

## Причина

- Подтверждено (слой рендерера; перманентная потеря continuation-а замороженной отправки на Retry):
  1. `packages/ui/src/v4/ConversationComposer.tsx:1380-1446` — queued-send effect: при переводе пайплайна в `failed` рендерер немедленно отцепляет единственное продолжение замороженной отправки: `detachQueued()` (`pendingWorktreeSendRef.current = null`, строки 1385-1388, вызов на 1444) + `queued.restore()` (1445). Dispatch-closure `runSend` (единственный путь активации) после этого не существует; замороженная отправка остаётся только пассивной recovery-записью.
  2. `packages/ui/src/v4/ConversationComposer.tsx:1381-1382, 1413-1428` — на `ready` эффект диспетчеризует ТОЛЬКО при живом `pendingWorktreeSendRef.current` (`if (!queued) return;`). После сбоя он null → готовый worktree не триггерит ничего; шаг навсегда остаётся ready.
  3. `packages/ui/src/v4/ConversationWorktreeSetupSteps.tsx:281-334` — обработчик кнопки Retry обрабатывает только `outcome === "failed"` (`onPreparationFailed`); исход `"ready"` не содержит ни одного шага активации/допуска (нет re-attach recovery-записи, нет dispatch).
  4. `packages/ui/src/v4/ConversationComposer.tsx:1401-1405` — даже оставшаяся подключённой отправка была бы отброшена: Retry выпускает НОВЫЙ attempt id (`packages/ui/src/v4/SessionPane.tsx:2278` — `crypto.randomUUID()` в `handleWorktreePreparationRetry` → `updateWorktreePreparation`), а `retryComposerWorktreePipeline` (`packages/ui/src/v4/composer/composerWorktreePipeline.ts:332`) вписывает его в `params`; guard `queued.attemptId !== worktreePipeline.params.attemptId` → detach + restore. Двойной guardrail, и ни один путь не перепривязывает замороженную отправку к повторной попытке.
  5. Клик по таску в сайдбаре не помогает: composer подготовленной сессии монтируется с пустым `pendingWorktreeSendRef`, автоматической отправки нет; работает только новый ручной Send (готовая ветка `ConversationComposer.tsx:2111-2124` использует ready-пайплайн) — это и есть наблюдаемый обход Restore → Send.
- Гипотеза: ничего дополнительного для объяснения не требуется; отсутствие вызовов активации в логах согласуется с тем, что рендерер никогда не диспетчеризует (Host-активация инициируется рендерером, отдельно она не запускается).

## Предлагаемое исправление

Слой рендерера (`packages/ui/src/v4/ConversationComposer.tsx`, `packages/ui/src/v4/ConversationWorktreeSetupSteps.tsx` / retry-путь; продуктовый код не менялся): после failed → Retry → ready перепустить замороженную отправку из session-scoped recovery-записи ровно один раз — например, Retry-поток перепривязывает recovery-submission (по prepared session + submission id) к новому attempt id, и queued-send эффект диспетчеризует её на ready с сохранением consume-exactly-once; либо готовый retry-результат в обработчике Retry триггерит активацию той же сессии с восстановленной отправкой. Идемпотентность Host по attempt id сохранить; дважды допускать первое сообщение нельзя.

## Тест

- Файл: `packages/ui/test/composerWorktreePipeline.test.ts`, добавлен один `it.fails("BUG-GWT-005: admits the frozen first submission exactly once after a retried creation turns ready", …)`. Уровень — mounted `ConversationComposer` + реальный pipeline/store/retry (`retryComposerWorktreePipeline`, `beginWorktreePipelineCreation`); git замокан только на RPC-границе `createWorktree` (первый вызов — EACCES-reject, Retry — success); без sleep (только `vi.waitFor`/`act`), самодостаточен, от `$QA_ROOT` не зависит. Сценарий: send → creating → failed (recovery-запись подтверждается) → Retry с новым attempt id → ready → ожидание `onSendText` вызван ровно 1 раз с `executionWorktree` и `preparedSessionId`.
- Красный прогон без маркера (имя `admits the frozen first submission exactly once after a retried creation turns ready`):

```
FAIL  unit packages/ui/test/composerWorktreePipeline.test.ts > BUG-GWT-005: frozen submission admission
  after failed creation → Retry → ready > admits the frozen first submission exactly once after a
  retried creation turns ready
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 ❯ packages/ui/test/composerWorktreePipeline.test.ts:1442:26
   1442|       expect(onSendText).toHaveBeenCalledTimes(1);
      |                          ^
 Test Files  1 failed (1)
      Tests  1 failed | 35 passed (36)
```

Падение именно по багу: до этого ассерта тест прошёл failed-состояние (recovery-запись есть, `onPrepareWorktreeSession` вызван) и ready после Retry (`retryOutcome === "ready"`, entry `{status:"ready", worktreePath, sessionId}`) — то есть ready достигнут, а допуск не произошёл.

- С маркером `it.fails` файл зелёный (3 прогона подряд): `Tests 35 passed | 1 expected fail (36)`.
