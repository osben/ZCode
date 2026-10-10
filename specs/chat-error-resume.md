# Resume button for chat errors

Status: implemented, pending review.

## Problem

Sometimes a chat ends with an error, and the banner says something like "something went wrong". To continue, the user has to type a new message by hand. The error banner needs a Resume button that sends the ordinary message `Continue from where you left off` to the chat with one click.

## Facts from the code (at the time of the spec)

- Banner: `packages/ui/src/ChatErrorBanner.tsx`. A Retry button already exists (~309), but it calls `onRetry`, which the composer does not pass. The existing timeline Retry (`SessionPane.tsx` ~3085–3117, `retryTurn`) repeats the turn and does not create a new user message, so Resume does not replace it.
- The only place the banner is rendered is `packages/ui/src/v4/ConversationComposer.tsx` (~2216–2223). Visibility is controlled by `visibleError` (~1622).
- Send path: `SessionPane.tsx` `handleSendText` (~2962) → `dispatchSendText` (~2921). It also checks routing, model, and mode.
- Runtime error: `control.lastError` → `projectedComposerError` → `composerError` (`SessionPane.tsx` ~3937–3960). Dismissing the banner through `handleDismissComposerError` (~3964) records the key in `dismissedErrorKeys`.
- The runtime clears the transient `lastError` on the next `TurnStarted` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` ~1647). So after a successful Resume, the banner goes away by itself.

## Product rules

1. The Resume button appears in the chat error banner next to Retry when a handler is passed and the error allows a retry.
2. Clicking it sends the text `Continue from where you left off` as an ordinary user message. It uses the same path as sending from the composer: routing, queue, and the current session's model and mode.
3. The message text is not localized, because it goes into the conversation and to the model. Only the button label is localized (`chat.error.resume`).
4. The composer draft does not change. Resume does not read or clear the editor.
5. Resume is hidden for:
   - `model_config_missing` (resending cannot fix a missing model; Copy and Feedback are already hidden for this error);
   - `fault.runtime.hookBlocked` (the hook would block the resend).
6. Resume does not use `retryTurn` and does not add a new command type.
7. If the send returns `blocked` or `confirmationRequired`, the message is not sent. A toast is shown and the banner stays.
8. If the send throws, `handleSendText` sets `sendSubmissionError`. Resume does not create a second banner and does not retry automatically.
9. A successful Resume does not dismiss the banner manually. The runtime clears the old error on `TurnStarted`.

## Source of state

- Turn error: runtime (`control.lastError`).
- Send error: `SessionPane` (`sendSubmissionError`).
- Resume owns no state. It calls the existing `handleSendText`. No new fields in the store or the protocol.
- On a busy session, Resume behaves like a normal send, and the existing routing logic decides what happens.

## Interface

- `packages/ui/src/lib/chatErrorResume.ts` (new pure module, type-only imports):
  - `CHAT_ERROR_RESUME_MESSAGE = "Continue from where you left off"`;
  - `canResumeChatError(error: Pick<ZCodeUiError, "code" | "message">): boolean`;
  - `isModelConfigMissingError` moves here from `ChatErrorBanner.tsx` and is exported, so the list of codes is not duplicated.
- `ChatErrorBanner`: new prop `onResume?: () => void`.
- `ConversationComposer`: new prop `onResumeError?: () => void`, passed to `ChatErrorBanner` as `onResume` when `visibleError` is set.
- `SessionPane`: `handleResumeError` calls `handleSendText(CHAT_ERROR_RESUME_MESSAGE)` without touching the draft and is passed to the composer as `onResumeError`. A click made while the previous Resume is still in flight is ignored through a ref.

## UI

- Button: `Button variant="outline" size="sm"` from `packages/ui/src/components/ui/button.tsx`, no custom CSS (user rule: standard design-system components only).
- Label: `chat.error.resume` in `en-US` and `zh-CN`.
- Order in the banner: Retry, Resume, Dismiss.

## Logging

- `SessionPane` uses `logger` from `@/logger.js`. On an exception it logs `logger.warn("[v4-pane] Resume send failed", ...)`.
- For `blocked` and `confirmationRequired`, the existing `toast` from `@/components/ui/toast.js` is shown with the key `chat.error.resumeBlocked` (en and zh).

## Acceptance scenarios

1. Error with a regular code: the Resume button is visible in the banner. Clicking it adds the message `Continue from where you left off` to the timeline, a new turn starts, and the banner disappears.
2. During Resume, the composer draft does not change.
3. `model_config_missing`: Resume is not shown; Copy and Feedback are unchanged.
4. `fault.runtime.hookBlocked`: Resume is not shown.
5. The send returns `blocked`: the message is not sent, a toast appears, and the banner stays.
6. The send throws: the send error is shown through the existing mechanism, there is no second banner, and a `warn` is logged.
7. The button label is translated to en and zh. The message text is always English.

## Validation

- Unit (`node:test`): `canResumeChatError` for a regular code, for `model_config_missing` (all code variants), and for `fault.runtime.hookBlocked`; the value of `CHAT_ERROR_RESUME_MESSAGE`.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.

## Out of scope

- Automatic Resume without a click.
- Resume after the app restarts.
- Changes to Retry (`retryTurn`).
- Resume for errors that are not rendered through `ChatErrorBanner`.
