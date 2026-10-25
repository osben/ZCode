# AskUserQuestion TUI Plan

## Background

The `AskUserQuestion` contract, core handler and permission-broker-based TUI interaction already exist. The current implementation can parse `AskUserQuestion` input and show the question in the TUI, with single-select, multi-select, automatic Other text, Esc reject, preview text display, preview annotation fill-back, a multi-question review tab and composer draft preservation, and lets the tool continue through `modifiedInput.answers`.

It is still not a complete recoverable user interaction subsystem:

- Interaction state is still bridged by `PermissionBrokerRequest` / the approval queue, and lacks a standalone user interaction pending state and session event projection.
- The pending prompt is mainly in-memory state; session recovery, SDK list/reply/reject and plugin API have no unified interface yet.
- The ZCode app-server already carries `AskUserQuestion` through the `zcode.dev/elicitation/create` extension, but the official ZCode app-server elicitation and a generic `UserInteractionPort` are still not converged.
- HTML preview already has fragment schema validation; the TUI shows only plain text and provides no sandbox or rich rendering.
- Multi-question navigation already supports `Tab`, `PageUp` / `PageDown`, left/right arrow keys and number shortcuts; `Shift+Tab` is not yet implemented as independent reverse navigation.

The goal of this plan is to upgrade the existing MVP into a recoverable, auditable, agent-friendly user clarification TUI, instead of continuing to stuff all capability into the generic permission dialog.

## Current implementation status (2026-05-08)

Landed capabilities:

- `packages/contracts/src/tools/ask-user-question.ts` provides the runtime schema, JSON Schema, answer schema, preview annotation schema, and markdown / HTML fragment preview validation.
- `packages/core/src/tool/handlers/ask-user-question.ts` registers the built-in tool, declares `requiresUserInteraction`, read-only, low risk, `userInteraction` side effect scope, and accepts only input whose answers are already filled in.
- `packages/tui/src/app-question-state.ts` / `packages/tui/src/app-model.ts` use a standalone `QuestionPromptState` for TUI-internal selection, Other buffer, review and annotation; it still resolves `modify` through the permission broker.
- `packages/tui/src/app-question-panel.tsx` renders the question panel, review tab, completed-state tab, plain-text preview and multi-select state.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` uses the `zcode.dev/elicitation/create` extension for the ZCode protocol client and converts the elicitation answer and annotation back to `modifiedInput`.

Covered tests:

- `packages/contracts/tests/ask-user-question.test.ts` covers single-select schema, duplicate question, duplicate label, forbidding the model to provide Other, answers required before execution, markdown preview, HTML preview fragment and unsafe HTML rejection.
- `packages/tui/tests/tui.unit.test.ts` covers single-question Other, composer draft preservation, preview annotation, multi-question review, multi-select Space, Other input and `Ctrl+U` clearing the Other buffer.
- `packages/bootstrap/tests/zcode-protocol.test.ts` covers ZCode app-server `AskUserQuestion` going through the ZCode elicitation extension and filling back multi-question answers.

## Design points

Tool and permission:

- `AskUserQuestion` is a special tool with `shouldDefer`, `isReadOnly`, `isConcurrencySafe` and `requiresUserInteraction`.
- The tool's own `checkPermissions` returns ask, but the UI semantics is answering a question, not approving a dangerous operation.
- When the user is not in the TUI under remote channel mode, the tool is disabled to avoid the session hanging with nobody to respond; the tool is exposed only in allowed collaboration modes and returns a clear unavailable message when unavailable.
- Plan approval and clarification are strictly separated; AskUserQuestion is not used to ask "execute the plan?".

Suspension and events:

- On asking, the session emits a request event and the active turn suspends waiting for the answer; the pending user input lives in the turn state, and no extra continuation starts before the user answers.
- A standalone service manages `ask/list/reply/reject`, and the pending request waits on a Deferred; asked/replied/rejected events synchronize the TUI, HTTP API and plugin API.
- The API exposes list/reply/reject, suiting takeover by SDK, remote UI, plugins and automation.

Interaction and output:

- The TUI displays the question prompt and permission prompt separately, and disables ordinary input when a permission exists.
- One question is shown at a time, Enter advances and the last submits; PageUp/PageDown supports multi-question navigation; multiple questions use tabs + a confirm review; a single-question single-select can answer directly and close.
- Single-select supports option `preview`; when a preview exists it switches to an option list + preview panel.
- "Other" is provided automatically by the client; the model must not add it itself.
- The output serializes the answer, the selected preview and the user's notes together to the model.

## Design goals

1. `AskUserQuestion` is a user clarification interaction, not an ordinary permission approval.
2. The pending prompt must be a session/turn state object carrying `traceId`, `turnId`, `toolCallId`, `requestId`.
3. TUI, SDK and remote channel use the same reply/reject/cancel semantics.
4. yolo/automatic permission modes cannot bypass user interaction; non-interactive entries must fail closed or disable the tool in the tool registry.
5. The TUI prioritizes low friction: single-question single-select answers fastest, multi-question/multi-select provide review.
6. preview and annotation are kept as contract capabilities; the MVP may first render text, with rich rendering later.
7. When AskUserQuestion appears it takes over the original composer/input area; the ordinary user input box is hidden or disabled, but the user's existing draft must be preserved and restored after the question is answered.

## Recommended architecture

Add or complete a `UserInteractionPort`, and do not let the TUI depend on a permission special case:

```ts
interface UserInteractionPrompt {
  requestId: string;
  sessionId: SessionId;
  turnId?: TurnId;
  traceId: TraceId;
  toolCallId: ToolCallId;
  toolName: "AskUserQuestion";
  input: AskUserQuestionInput;
  requestedAt: Date;
}

interface UserInteractionResult {
  decision: "answer" | "reject" | "cancel";
  answers?: Record<string, string>;
  annotations?: Record<string, AskUserQuestionAnnotation>;
  reason?: string;
  resolvedAt?: Date;
}
```

The first phase may keep bridging through `PermissionBroker`, ensuring compatibility with the existing executor:

1. `PermissionService` recognizes `requiresUserInteraction` and always enters the interaction path.
2. `UserInteractionBroker` publishes `user_interaction_requested` and waits for answer/reject/cancel.
3. The bridge layer converts the answer into `PermissionBrokerResult { decision: "modify", modifiedInput }`.
4. After the executor supports native user interaction, the permission bridge is removed.

Suggested new events:

- `user_interaction_requested`
- `user_interaction_answered`
- `user_interaction_rejected`
- `user_interaction_cancelled`

The projection stores `pendingUserInteractions`, for session resume, SDK list and TUI redraw.

## TUI interaction spec

### Panel layout

- The permission prompt and question prompt are rendered separately but share the action panel queue.
- The question prompt replaces the area of the ordinary bottom input box instead of being appended above it; ordinary composer behaviors such as prompt submit, slash command, history recall and attachment paste pause at that time.
- When both a permission and a question exist, the permission takes priority; the question stays pending.
- Single-question single-select: no review tab is shown, and selecting submits directly.
- Multi-question or multi-select: header tabs and a final Review/Submit tab are shown.
- Each tab shows its `header`; answered tabs use a completed marker, unanswered ones stay dim.

### Input focus model

AskUserQuestion has its own internal input box, mainly for Other or later notes. It shares the same stdin/key event pipeline as the ordinary composer, but with different semantics:

- The ordinary draft already in `screen.input` stays unchanged when entering the question prompt and takes no part in answering.
- While the question prompt is active, all printable characters go to the question panel by default; they are written to the internal buffer only in the Other/notes input state.
- `Enter` in the internal input state accepts the current Other/notes; it does not send an ordinary prompt.
- `Esc` in the internal input state first exits the internal input state; `Esc` on the main question panel rejects the whole question.
- After the question ends, the ordinary composer restores the original draft, cursor and attachment state, and the user can continue to type or send.
- If the turn is cancelled by `Ctrl-C`, the pending question and the internal input buffer are cleared, but the ordinary composer draft must not be cleared.

### Composer draft preservation

This is a hard constraint when AskUserQuestion replaces the input box:

- The replacement affects only the current rendering and input routing and does not modify the existing `screen.input`, `draftAttachments`, or ordinary composer state outside the selection/slash command draft.
- If the user had already typed content before AskUserQuestion triggered, for example `please keep this draft`, the ordinary input box must keep showing the same content after the question panel closes.
- The internal input buffer for Other/notes must not reuse `screen.input`, nor overwrite `screen.input` when the answer is submitted.
- Rejecting the question, answering the question, cancelling the turn, permission queue switching and TUI redraw must not clear the original draft.
- Only a user's active submit, clear or edit while the ordinary composer is active may change the original draft.

### Keyboard

- `Up/Down` or `k/j`: move options.
- Digits `1-5`: directly select the corresponding option or Other.
- Single-select: `Enter` selects the current item; with only one question it submits immediately, otherwise it goes to the next question.
- Multi-select: `Space` toggles the current item; `Enter` goes to the next question or Review; submit only after at least one answer.
- `Tab` / `Shift+Tab`: with multiple questions switch between question tabs and the Review tab.
- `PageUp/PageDown`: with multiple questions, previous/next question.
- `o` or `Enter` after selecting Other: enter custom input.
- In Other input: `Enter` accepts, `Esc` cancels input, `Ctrl+U` clears, `Backspace` deletes.
- Main panel `Esc`: reject this question and generate a user-visible declined result.
- `Ctrl-C`: cancel the current turn and clear the pending prompt through the abort signal.

### Other and annotations

- The UI always provides Other automatically; the schema keeps forbidding the model from adding an `Other` option explicitly.
- A single-select Other is submitted as the only answer of that question.
- A multi-select Other counts as one answer item and takes part in comma joining.
- When an option with `preview` is selected, `annotations[question].preview` is filled back.
- A notes input may be added later, filling back `annotations[question].notes`; not required in the first version.

### Preview

MVP:

- Both markdown/html previews are first shown as a plain-text box.
- For a single-select question where the current option has a `preview`, the plain-text preview of the current option is shown below the option list, and `annotations[question].preview` is filled back when that option is submitted.
- A multiSelect question does not show preview for now, and the schema/prompt keep advising against using preview with multiSelect.

Later:

- markdown uses the existing terminal markdown renderer.
- HTML preview must first go through fragment validation, then consider sandbox/fallback rendering.

## Non-interactive and remote behavior

- Entries with `--prompt`, background tasks, no TTY or no broker do not expose `AskUserQuestion` by default, or return `interaction_unavailable` when executed.
- If a remote channel cannot relay the question to the user, the tool should be disabled.
- SDK/HTTP/plugin entries should expose pending list/reply/reject instead of letting the host process parse the permission prompt.
- A subagent does not allow `AskUserQuestion` by default, unless a parent-mediated interaction design appears in future.

## Implementation phases

### Phase 0: Lock the current state

- Add a set of snapshot tests of the current MVP proving single-select, multi-select, Other and Esc reject work.
- State clearly that the existing `PermissionBroker` bridge is only a temporary path, and mark the migration target in the spec.

### Phase 1: Add the interaction contract

- Add user interaction request/result schema and event payloads in contracts.
- The session projection adds `pendingUserInteractions`.
- Core adds a user interaction broker, default deny/unavailable, supporting abort signal and timeout.
- The permission bridge stays compatible: answer -> `modify`, reject/cancel -> deny/error.

### Phase 2: Complete the TUI prompt

- Split `QuestionPromptState` out of the approval state into a standalone render model, or at least build a clear adapter.
- Add tab/review, multi-question jump, number shortcuts, `j/k`, `PageUp/PageDown`.
- Keep the existing single-question fast path so the most common scenario does not get heavier.
- The TUI action panel handles only the head-of-queue interaction, and ordinary input is disabled while pending.

### Phase 3: preview and annotation

- Render the text preview panel.
- Record the preview annotation when an option is selected.
- The tool result and transcript show an answer summary and do not flood the screen with large previews; model content is still serialized by budget.

### Phase 4: Recovery and external entries

- The session event log persists requested/answered/rejected/cancelled.
- After resume rebuild the pending prompt; an already cancelled prompt does not wait again.
- SDK/HTTP/plugin expose `listPendingUserInteractions`, `answerUserInteraction`, `rejectUserInteraction`.

### Phase 5: Clean up permission coupling

- The executor natively supports defer/wait/continue for `requiresUserInteraction` tools.
- `AskUserQuestion` no longer depends on a permission decision to express answer fill-back.
- The permission UI serves only permission, the question UI serves only clarification.

## Test plan

Minimum test set:

- contract: 1-4 questions, 2-4 options, duplicate question, duplicate label, forbidding Other.
- core: execution fails when the `answers` field is missing; explicit `answers: {}`, partial and full answers all execute successfully; reject/cancel does not execute the handler; yolo does not auto-allow.
- broker: answer/reject/cancel/timeout/abort all clear pending and keep trace information.
- TUI: single-select quick submit; every question can be skipped and the last question may submit with `answers: {}`; multi-select Space toggle; Other input/cancel/clear; multi-question tab/review; Esc reject; Ctrl-C cancel; after AskUserQuestion ends, the composer draft that existed before entering is restored.
- preview: after selecting an option with preview, the annotation is filled back; an over-long preview is truncated for display without losing the model budget rule.
- resume: after restoring a session the pending prompt can still be answered; an answered prompt is not shown again.
- non-interactive: with no TTY or no broker a structured unavailable is returned, without hanging.

## Priority suggestion

Do Phase 0-2 first to get a usable and testable TUI; then Phase 3 preview. Phase 4-5 are architecture closure strongly tied to the value of SDK/remote entries, and can be split into separate feature-level commits after the first version is usable.
