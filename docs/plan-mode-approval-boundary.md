# Plan Mode Approval Boundary

Plan mode's `ExitPlanMode` is the plan review boundary: after the model submits a plan, it must
wait for explicit user approval before exiting `plan` and continuing implementation.

## Semantics

- `EnterPlanMode` enters the read-only planning state without confirmation.
- `ExitPlanMode` always requires user confirmation in `plan` mode, including when plan was entered
  from `yolo`.
- Only after user approval does the runtime restore the pre-plan mode and allow later edits.
- On rejection without feedback, the current turn must end, the session stays in `plan` mode, and
  the user can keep typing revision notes.
- With feedback filled into the `ExitPlanMode` approval, the runtime stays in `plan` mode and
  persists the feedback as a real, ordinary `user` message; the `ExitPlanMode` tool result returns
  only a bridging note telling the model the user's feedback follows in the next user message. UI,
  resume and provider-visible history then treat the feedback as a new user query — not swallowed
  into a tool result, not shown as a turn-steer guidance message.

## MCP tool exception

Plan mode by default allows only read-only, non-destructive tool execution. MCP tools are
dynamically exposed by external servers; some do not declare `readOnlyHint` but are still needed
during planning to read external context, device state or remote material. So Plan mode uses a
separate permission boundary for MCP tools:

- MCP identity is recognized via the tool permission declaration
  `permission.permission === "mcp"`, never inferred from the `mcp__` name prefix.
- Project-level `deny` / `ask` rules still win and cannot be bypassed by the MCP exception.
- MCP tools explicitly declaring `destructiveHint: true` are still rejected in plan mode.
- MCP tools not explicitly destructive may execute in plan mode even without
  `readOnlyHint: true`.
- The exception skips only plan mode's readonly check — MCP tool registration, model-visible
  schema, output budget, timeout, cancellation, logging and the UI permission display protocol are
  unchanged.

## Interaction implementation

`ExitPlanMode` stays a model-called tool; the runtime still creates the approval boundary through
the permission broker. To let users type revision notes directly in the approval dialog, the
`ExitPlanMode` broker reuses `AskUserQuestion`'s `interaction/requestUserInput` channel instead of
the plain `interaction/requestPermission`.

- `approve` maps to permission `allow`.
- Closing the dialog maps to permission `deny` with no feedback, keeping the old
  stop-current-turn behavior.
- Custom input maps to permission `deny + reason` with `reasonSource: "plan_approval_feedback"`,
  expressing "plan needs revision". The runtime may interpret feedback only via this explicit
  source; deny+reason from hooks, project rules or other broker paths is never treated as
  feedback.
- On `reasonSource: "plan_approval_feedback"`, the runtime first injects the `ExitPlanMode` tool
  result to close the provider's tool-use protocol, then writes the custom input into real user
  message history via the active-turn pending input path carrying
  `source: "plan_approval_feedback"`. This order keeps provider-visible history as
  `assistant tool_use` → `tool_result` → `user feedback` while reusing `persistUserPrompt` so the
  next resume sees the feedback. UI renders default-source active-turn steers as guided/steer
  messages; plan-approval feedback must render as a plain user bubble.
- Plain `AskUserQuestion` does not follow this rule: its answers stay tool-call results; only
  `ExitPlanMode` approval feedback upgrades to a new user message.
- The projection layer maps `ExitPlanMode`'s pending permission to a pending elicitation and
  filters the corresponding `permission.requested` live event, so the UI never shows both a plain
  permission dialog and an input-capable dialog.

## Rationale

A rejected `ExitPlanMode` must not be fed back to the model as a plain tool failure: the model
would re-think and re-submit another plan within the same turn, showing the user a new confirmation
before they typed any feedback. A no-feedback rejection therefore carries turn control and the
runtime stops the turn right after recording it, preventing a self-loop during plan review. A
with-feedback rejection must not stop the turn, but also must not hide the user's words in a tool
result: the text is user-typed input, semantically the next query; a tool-result-only write would
produce no user bubble and break review-trail recovery on resume — hence the real user-message
persistence path.
