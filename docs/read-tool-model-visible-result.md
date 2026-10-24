# Read Tool model-visible result contract

## Background

The Read tool's provider-visible `tool_result` (including `is_error` and text content) is the model's only basis for understanding the read outcome. This document constrains the model-visible shape of Read for warnings, duplicate reads, preflight failures, image and plain-text reads. Structured output and internal error types are out of scope.

## Goals

- Read's model-visible warning / dedup / preflight error uses fixed, regression-testable copy and wrapping.
- Keep structured output and internal error types debuggable; converge only the model-visible text boundary.

## Design

- The `file_unchanged` model-visible content is fixed to:
  `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`
- Inline warnings in Read tool results use a single-line `<system-reminder>body</system-reminder>`. This is a Read-mapper-specific path and does not replace the global `wrapSystemReminderForSource(...)`.
- On a successful non-empty text read, the legacy malware reminder is not appended; only the conditionally generated freshness / truncation reminder and the line-numbered body are output.
- The provider-visible tool result of an image Read keeps only the image block. Resize dimension and coordinate data stays in the structured output; no extra text block is generated.
- When Read input semantic preflight fails, the handler catches the custom issue from `ReadInputSchema.parse(...)` and throws a recoverable `ToolExecutionFailed` whose message is `<tool_use_error>${issue.message}</tool_use_error>`.
- Non-Read or non-custom semantic validation errors keep going through the existing generic validation path; not every schema error may be wrapped as `<tool_use_error>`.

## Acceptance

- `read-tool-contract.test.ts` covers: successful text without the legacy security reminder, image results containing only the media block, dedup copy, the single-line Read warning wrapper, and `<tool_use_error>` for binary/device preflight.
