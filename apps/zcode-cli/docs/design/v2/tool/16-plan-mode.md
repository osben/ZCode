# EnterPlanMode / ExitPlanMode

## Goal

Provide plan mode provider tools so the model can actively request plan mode, submit a plan to the user after read-only exploration, and leave plan mode to start implementing after the user approves.

The ZCode first version does not introduce an integrated plan file, auto mode gate, teammate mailbox or dedicated plan model, which the current runtime does not have. The plan body is passed directly through `ExitPlanMode.plan`; if a plan artifact/file is introduced later, this spec must be extended separately.

## Tools

### EnterPlanMode

- Name: `EnterPlanMode`
- Input: empty object `{}`
- Output: `{ message, previousMode, mode: "plan" }`
- Capability: enter plan mode directly, for exploration and solution design before a complex implementation task starts.
- Permission: `EnterPlanMode` shows no user approval; a successful call switches to plan mode.
- Side effect: `sideEffectScope: "session"`, not read-only.
- Concurrency: unsafe, must be serial. A mode change cannot run in parallel with other session mutations.
- Failure:
  - Tool execution failure: return a tool error, mode unchanged.
  - Runtime has no session mode port injected: configuration error.

The model-visible description must cover:

- Non-trivial implementation tasks should proactively use this tool, to get the user's agreement on the solution direction first and avoid rework after writing code directly.
- Besides simple tasks, prefer plan mode in these scenarios: new feature implementation, several viable approaches, changing existing behavior or structure, architecture decisions, multi-file changes, unclear requirements, implementation clearly influenced by user preference.
- After entering, only read-only tools such as `Glob`, `Grep`, `Read` may be used to explore, identify existing patterns and architecture, and design the implementation plan.
- Use `AskUserQuestion` to clarify the approach; plan approval must use `ExitPlanMode`.
- Do not overuse for single-line/small obvious fixes, clear small functions, tasks where the user already gave detailed implementation steps, or pure research/exploration; for pure research/exploration hint at `Agent`, without binding a concrete agent type in that sentence.
- The model prompt must include positive and negative examples: authentication, database optimization, dark mode, a delete button, API error handling should enter plan mode; a README typo, a simple debug log, asking where the route file is should not.

### ExitPlanMode

- Name: `ExitPlanMode`
- Input:
  - `plan: string`: the plan body shown to the user for approval.
  - `allowedPrompts?: { tool: "Bash"; prompt: string }[]`: in the first version kept only in input/output and the UI/permission projection; it does not automatically write permission rules.
- Output: `{ plan, previousMode, mode, approved: true, allowedPrompts? }`
- Capability: in plan mode, submit the final plan and ask the user to agree to leave plan mode.
- Permission: user approval is required by default. After approval, restore the mode before entering plan mode; when none was recorded, restore `build`. If the mode before entering was `yolo` (bypass permissions), `ExitPlanMode` restores `yolo` directly without an approval prompt.
- Side effect: `sideEffectScope: "session"`, not read-only.
- Concurrency: unsafe, must be serial.
- Failure:
  - Not currently in plan mode: stable failure, no pointless approval prompt.
  - Empty `plan`: schema validation failure.
  - User rejects: return a permission denied tool error and stay in plan mode.

The model-visible description must cover:

- Call only in plan mode, once the implementation plan is complete and ready for user approval.
- The tool must receive the full plan through the `plan` parameter; the model must not assume a plan file exists, nor send empty input.
- The `plan` parameter is what the user sees at approval; it must be complete, explicit and executable.
- In normal mode calling this tool requests user approval; when plan mode was entered from `yolo`, this tool exits directly back to `yolo` without requesting approval.
- Only for implementation tasks that require writing code; do not call it for pure research, searching files, reading files or understanding the codebase.
- If the requirement or approach still has open questions, clarify with `AskUserQuestion` first.
- Do not use `AskUserQuestion` to ask "is the plan OK" or "continue?"; approval is the responsibility of this tool.
- After the tool result is approved, the model may start implementing and should update the todo first (if applicable).
- The model prompt must include positive and negative examples: understanding the vim mode implementation should not call it; implementing yank mode should call it after planning is done; for an authentication feature whose auth method is undecided, `AskUserQuestion` first, then `ExitPlanMode`.

### Plan file continuity after approval

The current transitional implementation keeps the provider-visible input shape `ExitPlanMode({ plan, allowedPrompts? })`. After approval, the runtime writes the raw string of the finally approved plan to `.zcode/plans/plan-${sanitizedSessionId}.md` under the workspace root; a write failure does not block the already approved exit from plan mode and only makes later compact continuity degrade to having no plan file reference.

This file is not a new provider-visible input and not a full plan-file schema; it is used only for compact/resume continuity. When compact succeeds and this plan file exists and is non-empty, the runtime persists a `plan_file_reference` model-only reminder into the post-compact history:

```text
A plan file exists from plan mode at: ${planFilePath}

Plan contents:

${planContent}

If this plan is relevant to the current work and not already complete, continue working on it.
```

So even if compact happens right after `ExitPlanMode`, the next provider context after recovery still carries the full approved plan.

The current transitional implementation adds no plan file retention cleanup. If expired `.md` files in the plans directory should be cleaned by retention days, it must be added as a separate retention cleanup change, not deleted on the fly during compact/session.

## Runtime and events

Tool handlers do not import bootstrap or UI state directly. Core injects mode operations through `SessionModePort`:

- `getMode()`
- `getPrePlanMode()`
- `enterPlanMode({ toolCallId, traceContext })`
- `exitPlanMode({ toolCallId, traceContext })`

The runtime implementation saves `prePlanMode`, updates `config.mode`, writes a `SessionModeChanged` event, and after exit sets a one-shot `plan_mode_exit` reminder. The event reducer must update `SessionProjection.mode` from this event, so snapshot, resume, debug and ZCode app-server see the same fact.

## UI / ZCode app-server

- The permission request still reuses the existing `PermissionRequested` / `PermissionResolved` protocol.
- The `plan` of `ExitPlanMode` stays in the tool input / result payload, and the existing plan mode tool panel can parse and show it.
- Desktop continuous and web remote replayable both consume only session events / snapshots; the relay and main do not store plan mode business state.

## Tests

- contracts: input/output schema success/failure, JSON Schema projection.
- core: the registry exposes both tools; metadata/permission do not pretend to be read-only.
- permission: `EnterPlanMode` is allowed directly; `ExitPlanMode` requests approval in a plan mode entered from non-yolo and is allowed directly in a plan mode entered from yolo; neither is wrongly blocked by the read-only prohibition.
- runtime: after a successful `EnterPlanMode` call mode=plan; after `ExitPlanMode` approval the previous mode is restored; after rejection the mode is unchanged.
- events: `SessionModeChanged` updates the projection, and the snapshot uses the projection mode.
- reminder: after exit the next turn injects `plan_mode_exit`, and only once.
