# Hide Runtime Model Unavailable Banner Design

Historical tasks can persist a model reference whose provider or model no longer exists. The service reports `ZCODE_RUNTIME_MODEL_UNAVAILABLE` and keeps the guard so desktop continuous sessions never silently resume with a different runtime model. The internal guard, logs, restore handling, and task state all stay; the guard is just not rendered as a user-visible chat error banner (message: `历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。`).

Design:

- `ChatErrorBanner` treats `ZCODE_RUNTIME_MODEL_UNAVAILABLE` as non-renderable and returns `null`. This presentation-layer boundary is preferred over clearing the task error in `useTaskRestore`, because restore and model-switch flows still use that code to identify and clear historical unavailable-model state after a successful model switch.
- No replacement UI, text, toast, inline hint, or toolbar warning is added.

Non-goals: the error code stays in service and protocol logic; model restore/fallback/setModel semantics unchanged; service-side unavailable-model protection tests stay.

Verification: `ChatErrorBanner` UI tests — rendering with `code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE"` must not include the historical-model message; a normal error still renders its message. No visual regression needed (one code path removes a banner, no layout added).

Compatibility: UI-only. Desktop, web remote, mobile remote, service process, relay, task snapshot, and stream recovery semantics are unchanged; both continuous and replayable paths still receive and persist the error code.
