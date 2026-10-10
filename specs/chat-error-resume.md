# Кнопка Resume для ошибок чата

Статус: реализовано, ожидает ревью.

## Проблема

Иногда чат завершается ошибкой, и баннер говорит «что-то пошло не так». Чтобы продолжить, пользователь вручную пишет новое сообщение. Нужна кнопка Resume в баннере, которая одним нажатием отправляет в чат обычное сообщение `Continue from where you left off`.

## Факты из кода (на момент спеки)

- Баннер: `packages/ui/src/ChatErrorBanner.tsx`. Кнопка Retry уже есть (~309), но она вызывает `onRetry`, который в композере не передаётся. Существующий timeline Retry (`SessionPane.tsx` ~3085–3117, `retryTurn`) повторяет turn и не создаёт новое сообщение пользователя, поэтому Resume его не заменяет.
- Единственное место рендера баннера: `packages/ui/src/v4/ConversationComposer.tsx` (~2216–2223), видимость через `visibleError` (~1622).
- Путь отправки: `SessionPane.tsx` `handleSendText` (~2962) → `dispatchSendText` (~2921). Он же проверяет routing, модель и режим.
- Ошибка из runtime: `control.lastError` → `projectedComposerError` → `composerError` (`SessionPane.tsx` ~3937–3960). Закрытие баннера по `handleDismissComposerError` (~3964) записывает ключ в `dismissedErrorKeys`.
- Runtime сбрасывает transient `lastError` на следующем `TurnStarted` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` ~1647). Поэтому после успешного Resume баннер уходит сам.

## Продуктовые правила

1. Кнопка Resume показывается в баннере ошибки чата рядом с Retry, если передан обработчик и ошибка допускает повтор.
2. Нажатие отправляет текст `Continue from where you left off` как обычное сообщение пользователя. Используется тот же путь, что и отправка из композера: routing, очередь, модель и режим текущей сессии.
3. Текст сообщения не локализуется, потому что он уходит в диалог и модель. Локализуется только подпись кнопки (`chat.error.resume`).
4. Черновик в композере не меняется. Resume не читает и не очищает редактор.
5. Resume скрыт при:
   - `model_config_missing` (повтор не исправит отсутствие модели; сейчас так же скрыты Copy и Feedback);
   - `fault.runtime.hookBlocked` (хук заблокирует повтор).
6. Resume не использует `retryTurn` и не добавляет новый тип команды.
7. Если отправка вернула `blocked` или `confirmationRequired`, сообщение не уходит. Показывается toast, баннер остаётся.
8. Если отправка бросила исключение, `handleSendText` ставит `sendSubmissionError`. Resume не создаёт второй баннер и не повторяет отправку автоматически.
9. Успешный Resume не закрывает баннер вручную. Старую ошибку снимает runtime на `TurnStarted`.

## Источник состояния

- Ошибка turn: runtime (`control.lastError`).
- Ошибка отправки: `SessionPane` (`sendSubmissionError`).
- Resume не владеет состоянием. Он вызывает существующий `handleSendText`. Новых полей в store и протоколе нет.
- Busy-сессия: Resume ведёт себя как обычная отправка, routing решает существующая логика.

## Интерфейс

- `packages/ui/src/lib/chatErrorResume.ts` (новый, чистый модуль, только type-импорты):
  - `CHAT_ERROR_RESUME_MESSAGE = "Continue from where you left off"`;
  - `canResumeChatError(error: Pick<ZCodeUiError, "code" | "message">): boolean`;
  - `isModelConfigMissingError` переносится сюда из `ChatErrorBanner.tsx` и экспортируется, чтобы не дублировать список кодов.
- `ChatErrorBanner`: новый проп `onResume?: () => void`.
- `ConversationComposer`: новый проп `onResumeError?: () => void`, передаётся в `ChatErrorBanner` как `onResume` при `visibleError`.
- `SessionPane`: `handleResumeError` вызывает `handleSendText(CHAT_ERROR_RESUME_MESSAGE)` без черновика и передаётся в композер как `onResumeError`. Повторный клик, пока предыдущий Resume не завершился, игнорируется через ref.

## UI

- Кнопка: `Button variant="outline" size="sm"` из `packages/ui/src/components/ui/button.tsx`, без custom CSS (правило пользователя: только стандартные компоненты design system).
- Подпись: `chat.error.resume` в `en-US` и `zh-CN`.
- Порядок в баннере: Retry, Resume, Dismiss.

## Логирование

- `SessionPane` использует `logger` из `@/logger.js`. При исключении: `logger.warn("[v4-pane] Resume 发送失败", ...)`.
- Toast для `blocked` и `confirmationRequired` используется существующий `toast` из `@/components/ui/toast.js` с ключом `chat.error.resumeBlocked` (en и zh).

## Acceptance scenarios

1. Ошибка с обычным кодом: в баннере видна кнопка Resume. Клик добавляет в ленту сообщение `Continue from where you left off`, начинается новый turn, баннер исчезает.
2. Во время Resume черновик в композере не меняется.
3. `model_config_missing`: Resume не показан, Copy и Feedback без изменений.
4. `fault.runtime.hookBlocked`: Resume не показан.
5. Отправка вернула `blocked`: сообщение не уходит, появляется toast, баннер остаётся.
6. Отправка бросила исключение: ошибка отправки показывается через существующий механизм, второго баннера нет, пишется `warn`.
7. Подпись кнопки переведена на en и zh. Текст сообщения всегда английский.

## Валидация

- Unit (`node:test`): `canResumeChatError` для обычного кода, `model_config_missing` (все варианты кода), `fault.runtime.hookBlocked`; значение `CHAT_ERROR_RESUME_MESSAGE`.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.

## Вне скоупа

- Автоматический Resume без нажатия.
- Resume после перезапуска приложения.
- Изменение Retry (`retryTurn`).
- Resume для ошибок, которые не выводятся через `ChatErrorBanner`.
