# Недостоверный merge-статус в списке разговоров и hover popup

Статус: Git-сервис и кэш сохраняются, но workspace-level наблюдение и его UI-проекция отключены: текущая ветка workspace не является достоверным статусом отдельной сессии или worktree. В строках и hover popup не показываются merge-индикаторы, пока не появится task-level источник статуса.

Обновление 2026-10-18: task-level статус PR (включая merged) согласован в `sidebar-pr-status.md`; workspace-проба остаётся выключенной.

Обновление 2026-10-16: hover popup показывает доступные task metadata и `changeSummary`; он не показывает ветку или состояние merge из workspace-пробы. Возобновление merge-индикации требует статуса, адресованного конкретной задаче и её execution worktree (`executionWorktree.branchName`), а не включения workspace-пробы.

## Текущая видимость в списках

- Не показывать `Merged` бейдж ни в grouped sidebar rows, ни в прямом/legacy `TaskListItem`, включая их drag-overlay варианты.
- Сохранить Git service и его кэш. Не передавать workspace-level merge-статус строкам и hover popup; popup продолжает показывать task status, workspace, модель/effort и task `changeSummary`.
- Не заменять бейдж другим критерием или состоянием до отдельного решения на основе исследования PR/worktree lifecycle.

## Уточнение по данным (выяснено при реализации)

Per-session веток в модели данных нет: ни в `ZCodeTaskMeta`, ни в session-событиях, ни в UI. Ветка есть только у workspace (`GitRepositorySummary.branchName`). Поэтому «ветка сессии» = текущая ветка workspace, в котором живёт сессия; наблюдение имеет гранулярность workspace + ветка (совпадает с ключом кэша ниже). Все строки одного workspace показывают один статус.

## Проблема

В сайдбаре (`packages/ui/src/workspace-grouped-tasks/task-row.tsx`) сессия показывает статус, diff `+N −M` и время, но не показывает, влита ли её ветка. Нужно быстро видеть завершённые сессии и по наведению получать полезную информацию.

## Факты из кода (на момент спеки)

- Строка: бейдж внимания `taskAttentionDisplay` (`task-row.tsx` ~115, ~193–200), блок метаданных справа (~393–395).
- Tooltip: `taskChangeParts` (`task-row.tsx` ~128) через `formatGroupedTaskHoverChangeParts` из `packages/ui/src/workspace-grouped-tasks/task-row-tooltip.ts`; сам tooltip в `task-row.tsx` ~470–500.
- Diff: `ZCodeTaskMeta.changeSummary` (`packages/shared/src/zcode-task-types-core.ts:342`), читается через `getTaskChangeSummary` (`packages/ui/src/lib/taskChangeSummary.ts:26`).
- Данных о PR нет. Полей PR нет в `ZCodeTaskMeta`, zod-схемах (`packages/shared/src/validation.ts`, `packages/shared/src/task-realtime-core.ts`), UI и i18n. GitHub-клиента для PR нет: в `apps/zcode-cli` только read-only allowlist `gh pr view|list|status` (`apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts:52–104`).
- Состояние «Missing worktree» с кнопкой Resume из скриншота в исходниках не найдено. Вне скоупа.

## Продуктовые правила

1. Строки разговоров не показывают бейдж `Merged`, даже если в store осталась workspace-level запись со state `merged`.
2. Hover popup не показывает workspace branch или merge state; он показывает доступные task metadata и `changeSummary`.
3. Статус merge не передаётся из store в grouped или legacy task row.
4. Merged не означает закрытую сессию: автоархивации нет.

## Источник состояния: локальный git

- Ветка сессии считается влитой, если её tip является предком default branch: `git merge-base --is-ancestor <headRef> <baseRef>` (exit 0). `baseRef` берётся из `origin/HEAD`; если его нет, статус `unknown`.
- **Известное ограничение:** squash и rebase merge не определяются, для таких сессий бейдж не показывается. Это принятое решение.
- Сеть не используется. Автоматического `git fetch` нет: актуальность default branch зависит от последнего fetch пользователя. Явный fetch вне скоупа.
- Вариант через `gh` (точнее, но нужны auth и сеть) в эту версию не входит.

**Owner состояния:** сервис в runtime (`packages/services` или CLI), вызывает `git` с cwd `workspacePath`. Не Main: Main не держит task/session-состояние (правила репозитория).

**Ключ:** `workspaceIdentity?.trim() || workspacePath` + branch. Для remote workspace передаются `workspaceIdentity` и `remoteSessionId`, не путь. `git` выполняется на хосте workspace, результат возвращается по протоколу.

**Кэш:** in-memory с TTL 60 секунд; сброс при смене branch или checkout. Попадание в кэш валидируется текущим HEAD: один дешёвый `git symbolic-ref --short HEAD` на попадание (внешний checkout, не замеченный инвалидацией, обнаруживается на следующей пробе; HEAD не читается — попадание принимается). In-flight проба не может репопулировать кэш после инвалидации: запись результата охраняется generation-счётчиком per workspace, который инкрементируется при сбросе. Обновление при открытии сайдбара, фокусе окна и по сигналу успешной git-мутации (`onRefreshGit` → счётчик в сторе → немедленная re-proба). Rate limit не актуален: это локальные вызовы git; каденцией владеет сервис — клиентского TTL-гейта в UI нет.

**Контракт (локальный git):**

```ts
type MergeStatus = {
  state: "merged" | "not_merged" | "unknown";
  baseRef: string | null;
  headRef: string | null;
  lastCommitAt: string | null; // ISO, дата tip ветки
};
```

Фактическая интеграция (реализация): типы `GitBranchMergeStatus` в `packages/shared/src/git.ts` (конвенция файла — `| null` вместо optional); метод `IGitService.getBranchMergeStatus` в `packages/services/src/git/git.ts` — существующая сервисная поверхность UI↔host (та же, что `getBranchComparison`). Отдельная запись в `zcode-protocol/index.ts` не нужна: это наблюдение по запросу, а не событие сессии.

**Версии:** старый host без метода отклоняет вызов — hook ловит ошибку, запись workspace удаляется из стора (бейдж гарантированно скрыт, включая ранее показанный), повторная проба на следующем фокусе. Ошибка `git status` внутри пробы не бросается наружу: repo-слой возвращает `unknown` с `headRef: null` и одним `warn`.

**Граница:** состояние merge не идёт в `desktop-continuous` stream и не записывается в `SessionEvent`/journal. Это наблюдение, а не событие сессии (тот же принцип, что у `session-token-throughput.md`).

## UI

- Бейдж: `Badge` из `packages/ui/src/components/ui/badge.tsx`, размер `text-ui-xs` (`DESIGN.md:227`). Цвет: акцентный primary (решение пользователя). Не использовать `--color-success`: он закреплён за waiting-подтверждениями (`DESIGN.md:112, 130`).
- Popup: переиспользовать текущий Tooltip. Показывать task status, workspace, модель/effort и task `changeSummary`; workspace branch и merge status не показывать, так как они не принадлежат отдельной задаче. Текст `text-ui-sm` (`DESIGN.md:226`). Все размеры через `text-ui-*` (`DESIGN.md:11`), без `text-sm`/`text-xs` и произвольных `text-[13px]`.
- Второй popup не создаётся.
- Интерактивные overlay выше пассивных tooltip (`DESIGN.md:427`).
- Строки через intl: новые ключи в `en-US`, `zh-CN`, `uk-UA` (`packages/ui/src/i18n/locales/`, ключи `taskList.branchMerged*`).
- Git service и его кэш остаются (их использует `ComposerDestinationControl`). Workspace-level UI-проекция удалена 2026-10-23 (PR #325): `BranchMergeStatusProbes`, `useBranchMergeStatuses`, `branchMergeStatusStore` и `branchMergeStatusProbeRunner` больше не существуют; восстановление — `git show 8724e0c1:<path>`. Task-level индикация строится на отдельном task-level контракте, а не на возврате workspace probe.
- Внешние ссылки только через `IPlatformService` (`packages/shared/src/platform.ts`), не `window.zcode`.
- Вторая строка `packages/ui/src/TaskListItem.tsx`: бейдж добавлен в обе её цепочки статусов с тем же правилом приоритета (после pendingInteraction и внимания).

## Платформы (desktop, web и mobile remote)

- Desktop (`desktop-continuous`): статус вычисляется на Host workspace и приходит в сайдбар по realtime.
- Web (`packages/web`) и mobile remote (`web-remote-replayable`): используют тот же контракт `MergeStatus`. Мобильный клиент подключается к существующему Host attachment на desktop, поэтому отдельный Agent, Local Host или remote-сессия не создаются.
- Восстановление после reconnect: `MergeStatus` перезапрашивается из snapshot, а не хранится в очереди событий. Это отдельный путь от stream в `desktop-continuous`.
- Отдельная проверка для каждой платформы в валидации (см. ниже).

## Логирование

- Сервис: `createServiceLogger("branch-merge-status")`. `info` при смене состояния; `debug` для сырого вывода git; `warn` для ошибки git, кроме «ref не найден» (один раз, без спама на каждом refresh); `error` не использовать для штатного «не влито».
- UI: `packages/ui/src/logger.ts`.

## Acceptance scenarios

1. Даже если store содержит `merged`, grouped и legacy строки не показывают бейдж, а hover popup показывает task metadata без workspace branch и merge label.
2. `changeSummary` остаётся видимым в строке и hover popup.
3. Remote workspace продолжает показывать корректную remote-метку и task metadata.
4. Merge-индикация возобновляется только после отдельного task-level контракта и его regression coverage.

## Валидация

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Unit: Git service сохраняет тесты маппинга, TTL и workspace identity в `packages/services/test/branchMergeStatusService.test.ts`. UI проверяется rendered markup тестами task row и hover popup: бейдж, branch и merge label отсутствуют при workspace-level merged status, а task metadata и `changeSummary` остаются.

## Вне скоупа

- Состояние «Missing worktree» и кнопка Resume.
- Автоархивация merged-сессий.
- Создание PR из UI.
- Определение squash и rebase merge.
- Автоматический `git fetch` и сетевые вызовы.
