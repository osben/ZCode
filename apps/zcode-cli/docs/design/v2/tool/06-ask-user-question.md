# AskUserQuestion Tool

For TUI landing see [AskUserQuestion TUI plan](../tui-ask-user-question.md).

## Purpose

`AskUserQuestion` asks the user multiple-choice questions during execution, to clarify requirements, collect preferences or let the user make implementation decisions.

## Input contract

`AskUserQuestion` input is a strict object:

| Field         | Type                        | Required | Description                                          |
| ------------- | --------------------------- | -------- | ---------------------------------------------------- |
| `questions`   | `Question[]`                | yes      | 1 to 4 questions                                     |
| `answers`     | `Record<string,string>`     | no       | User answers filled back by the permission component |
| `annotations` | `Record<string,Annotation>` | no       | Extra notes from the user on a choice                |
| `metadata`    | object                      | no       | Tracks the source, not shown to the user             |

`Question`:

| Field         | Type               | Required | Description                                                    |
| ------------- | ------------------ | -------- | -------------------------------------------------------------- |
| `question`    | `string`           | yes      | Full question, clear and specific, ending with a question mark |
| `header`      | `string`           | yes      | Very short chip/tag, at most 12 characters                     |
| `options`     | `QuestionOption[]` | yes      | 2 to 4 options                                                 |
| `multiSelect` | `boolean`          | no       | Allow multiple selection, default `false`                      |

`QuestionOption`:

| Field         | Type     | Required | Description                                  |
| ------------- | -------- | -------- | -------------------------------------------- |
| `label`       | `string` | yes      | Display text of 1 to 5 words                 |
| `description` | `string` | yes      | Meaning or trade-off of the option           |
| `preview`     | `string` | no       | Preview shown when the option is focused     |

Uniqueness constraints on the input:

- `question` text must be unique.
- Option labels within one question must be unique.
- An `Other` option must not be provided; the UI provides it automatically.

## Output contract

Output:

| Field         | Type                    | Description                                                                   |
| ------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `questions`   | `Question[]`            | Questions actually asked                                                      |
| `answers`     | `Record<string,string>` | User answers; key is the question text, multi-select answers are comma-separated |
| `annotations` | optional record         | Option previews and user notes                                                |

The model-visible result becomes one explanatory sentence: the user has answered these questions and execution may continue based on the answers. Each answer is serialized as `"question"="answer"` and may carry preview and notes.

`answers` expresses the answers the user actually gave, not a required-form constraint:

- When all are answered it contains the keys of all questions.
- When partially answered it contains only answered questions; unanswered questions are not written as empty strings.
- When the user submits without answering any question it is the empty object `{}`, letting the model continue with the information it has.
- A completely missing `answers` field means the permission component has not finished the interaction, and the tool handler must not execute early.

## Behavior semantics

Core flow:

1. The model submits 1 to 4 questions and 2 to 4 options each.
2. The tool's own `checkPermissions` always returns ask, so the permission UI carries the interaction.
3. In the UI the user selects any number of answers, may skip some or all questions, and may type Other or notes.
4. The permission component fills `answers` and `annotations` back into the updated input.
5. The tool `call` only returns the questions and answers, with no external I/O.
6. The tool result enters model context and the agent continues.

The tool is declared as:

- `shouldDefer: true`
- `isReadOnly: true`
- `isConcurrencySafe: true`
- `requiresUserInteraction: true`

ZCode makes `requiresUserInteraction` a first-class capability of the scheduling layer: a non-interactive session, remote channel or background agent cannot block waiting for the TUI.

## Prompt constraints

ZCode gives `AskUserQuestion` full tool prompt semantics, not just a one-line short description. The provider-visible tool description is a short `description` plus `modelInstructions`, which after projection must express at least:

- This is a tool for asking the user questions during execution.
- It may be used to collect user preferences or requirements, clarify ambiguity, get implementation decisions, and offer direction choices.
- The user can always choose Other to type custom text.
- Use `multiSelect: true` for multi-select questions.
- Put the recommended option first and add `(Recommended)` after its label.
- In plan mode it may only be used to clarify requirements or choose between approaches before the plan is finalized; plan approval goes through the dedicated plan approval flow/tool, and `AskUserQuestion` must not be used to ask "is the plan OK to execute".

Model usage rules:

- Use it to collect preferences, clarify ambiguity, get implementation decisions or offer the user a direction.
- The user can always choose Other to type custom text.
- Put the recommended option first and add `(Recommended)` after its label.
- Set `multiSelect: true` for multi-select questions.
- In plan mode only use it to clarify requirements or choose approaches before the plan is finalized.
- Do not use it to ask whether the plan can be executed; plan approval goes through the dedicated plan approval tool.
- Do not refer to "this plan" while the user cannot yet see the plan.

ZCode keeps plan approval and clarification separate so AskUserQuestion is not abused as a generic confirmation button.

## Preview constraints

A preview supports markdown or HTML, depending on runtime configuration.

Markdown preview can be used for:

- ASCII sketches of UI mockups.
- Code snippets.
- Diagram changes.
- Configuration examples.

HTML preview can be used for:

- HTML mockups.
- Formatted code snippets.
- Visual comparisons or charts.

HTML preview validation:

- It must be a fragment: no `<html>`, `<body>` or `<!DOCTYPE>`.
- It must not contain `<script>` or `<style>`.
- It must contain an HTML tag.

A preview suits only single-select questions, not simple preference questions or multiSelect questions.

Implementation check (2026-05-08): `packages/contracts/src/tools/ask-user-question.ts` already runs preview validation inside `AskUserQuestionOptionSchema`. An ordinary markdown preview passes as is; when an HTML / doctype / comment shape is detected, the runtime schema requires it to be an HTML fragment, rejects `<!DOCTYPE>`, `<html>`, `<body>`, `<script>`, `<style>`, and rejects a preview that has only an HTML comment without a renderable tag. Covering tests are in `packages/contracts/tests/ask-user-question.test.ts`.

## Permission and session model

`AskUserQuestion` is essentially a user interaction tool, not a traditional permission request:

- Every question may be left unanswered. On desktop the option focus is only for keyboard navigation; an answer is written only on an explicit click, Space or Enter selection; clicking "Continue" or "Submit" directly skips the current question.
- The Bot single-select menu must provide a separate "Skip" action; skipping a middle question continues to the next one, skipping the last question submits the current partial answers, and skipping all submits `{ answers: {} }`.
- `checkPermissions` returns `ask` to reuse the permission request UI.
- When the user rejects, an explicit rejected projection must be produced.
- When remote channel mode is enabled and the user is not in the TUI, the tool is disabled, to prevent the session hanging with nobody to respond.

ZCode implements it as a `UserInteractionPort`:

- Supports three interaction carriers: TUI, SDK and remote channel.
- A pending prompt must be session state: recoverable, cancellable and auditable.
- Every question, option and answer must belong to the current `traceId` and `turnId`.
- A non-interactive environment must disable it directly or return a structured error, and must not wait forever.

## Validation and errors

Key failure paths:

- Number of questions is not 1 to 4.
- Number of options is not 2 to 4.
- Duplicate question.
- Duplicate option label.
- HTML preview contains a full document, script, style, or has no HTML tag.
- A non-interactive environment cannot show the question.
- User refuses to answer.
- The prompt is cancelled, or the pending prompt is not found when the session resumes.

These are distinguished as schema error, preview validation error, interaction unavailable, user rejected, prompt cancelled.

## ZCode design conclusions

`AskUserQuestion` is the "requirement clarification" interface of the NL-to-code process. It must not be just a permission dialog:

- The contract layer defines the `QuestionSet`, `QuestionOption`, `UserAnswer`, `QuestionAnnotation` schemas.
- The core layer creates a pending interaction event.
- UI/SDK/channel fill the answers back through an interaction adapter.
- Tool result serialization hands only an answer summary to the model.
- Plan approval, dangerous operation confirmation and ordinary preference choice need different capabilities and must not all be stuffed into one ask tool.

## Current implementation check (2026-05-08)

Landed MVP mainline:

- The contract layer exposes the `AskUserQuestion` runtime schema, JSON Schema, TypeScript types, answer validation and preview annotation schema.
- The core layer registers the `AskUserQuestion` built-in tool and projects `requiresUserInteraction`, read-only, low risk, `userInteraction` side effect scope, timeout, cancellation, result budget and runtime output schema onto the tool contract.
- The permission/runtime layer recognizes `requiresUserInteraction` and does not execute it as an ordinary auto-allow tool; answers are still filled back through the permission broker's `modify` result.
- The TUI layer supports single-select, multi-select, automatic Other custom text, reject, cancel, plain-text preview, preview annotation fill-back, a multi-question review tab and composer draft preservation.
- The ZCode app-server layer carries `AskUserQuestion` through the `zcode.dev/elicitation/create` extension and converts the elicitation response to `modifiedInput.answers` / `annotations`.
- The tool handler accepts only input whose permission component has already filled the `answers` field; a missing field returns a structured recoverable tool execution failure. `answers` may be complete, partial or empty, and unanswered questions do not fabricate preferences.

Architecture closure still open:

- A standalone `UserInteractionPort`, a `pendingUserInteractions` session projection and requested/answered/rejected/cancelled events have not landed.
- Continuing to answer a pending question after session resume, and SDK/HTTP/plugin list/reply/reject, proceed in later stages.
- The TUI shows markdown/html preview as plain text only; a full HTML sandbox, rich rendering, image paste, special plan interview buttons and analytics events are outside the current MVP.

## MVP scope

The first version lands the core interaction loop that is recoverable, auditable and not bypassable by automatic permission modes:

- The contract layer exposes the `AskUserQuestion` runtime schema, JSON Schema and TypeScript types.
- The core layer registers the `AskUserQuestion` built-in tool and projects it to the model.
- The permission/runtime layer recognizes `requiresUserInteraction`; even in `yolo` mode it must enter the interaction broker and cannot be auto-allowed.
- The TUI layer supports single-select, multi-select, automatic Other custom text, reject, cancel, text preview, preview annotation and multi-question review.
- The tool handler accepts only input whose permission component already filled `answers`; a missing field returns a structured failure. The user may submit complete, partial or empty answers, and the model handles unanswered questions with its best judgment.
- The markdown/html preview field is passed through as a contract field; the first TUI version shows the text preview with no rich rendering.

The first version does not implement image paste, special plan interview buttons, a full HTML preview sandbox or analytics events; these capabilities must extend step by step along the same `Question` / `Annotation` contract.

Minimum test set:

- Single-select, multi-select, Other.
- 1 to 4 question boundary.
- Option count boundary.
- Duplicate question and duplicate label.
- Markdown preview and HTML preview validation.
- User rejection.
- Partial and zero answers.
- Non-interactive session.
- Continuing to answer a pending question after session resume.
