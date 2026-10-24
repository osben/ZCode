# Current Send Runtime Model Unavailable Handling

## Background

When the BigModel Team Plan project API key cannot be projected into a runtime key, the local model provider registry no longer contains `builtin:bigmodel-coding-plan`. A draft session may recover by creating a fallback session on another available provider, but the UI can still keep an older local `last selected model` value such as `custom:builtin%3Abigmodel-coding-plan:GLM-5.2`. If first send reuses that stale value, the service rejects the request with `ZCODE_RUNTIME_MODEL_UNAVAILABLE` before any model request is sent.

## Expected behavior

- Historical task restore errors that only say the old task model is unavailable stay hidden by the chat banner.
- Current draft/send failures with `ZCODE_RUNTIME_MODEL_UNAVAILABLE` are visible so the user can switch models or report the issue.
- Repeating the same send after a failure produces a fresh visible error; dismissing or retrying the previous banner must not suppress the next failure with the same message.
- If the unavailable runtime model is BigModel Team Plan Coding Plan, the error concisely asks the user to check whether the current account has been added to the project member list, not a generic model-unavailable message.
- Once provider snapshot hydration proves a local agent model preference points to a provider that no longer exists, prepare must not reapply that stale preference over the agent session settings.
- Desktop continuous and web remote replayable keep the same service guard; the behavior is limited to UI selection reconciliation and error presentation.

## Rules

- Model selection reconciliation uses the hydrated provider snapshot as the boundary. A custom local preference is reapplied only while providers are not hydrated yet, or when the referenced provider still exists in the snapshot; otherwise the agent-returned config options stay the source of truth.
- `ChatErrorBanner` suppresses `ZCODE_RUNTIME_MODEL_UNAVAILABLE` only for historical-task messages. Current session or current selection messages render like other actionable chat errors.
- Current first-send failures attach a local trace id when upstream provides none, keeping the visible error key distinct across repeated failures with the same code and message.
- BigModel Team Plan uses a dedicated error code only when the current BigModel family selected key is a `team-plan:*` connection and the selected runtime model cannot be projected from the current registry. A missing `builtin:bigmodel-coding-plan` provider alone does not classify as Team Plan, because personal BigModel Coding Plan reuses the same provider id. Product copy stays short and guides the user to check project membership.
- If a draft session was created with a fallback provider and a later send or set-model fails because that cached fallback runtime model has also disappeared from the registry, then when the request is trying to switch back to BigModel Team Plan the service classifies the visible error by the requested Team Plan model, not the stale fallback session model. This keeps the banner actionable for the membership problem the user can fix.
