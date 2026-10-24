# Plan Mode E2E Coverage Plan

## Scope

The end-to-end acceptance surface of Plan mode is the user operation chain in a desktop-local `desktop-continuous` session and the provider-visible request body; internal implementation structure is not an acceptance target. The current E2E uses a synthetic DeepSeek replay fixture to fix the model's tool calls, so whether the real model chooses a tool is not mixed into product-semantics assertions.

## Existing Coverage

- `conversation-session-tool-cross-product.test.ts` covers `EnterPlanMode` succeeding into a tool block, and the ordinary tool display boundary where `ExitPlanMode` fails fast outside plan mode.
- `conversation-session-plan-approval-feedback-user-message.test.ts` covers that after `ExitPlanMode` is rejected with user custom feedback, the feedback enters the next provider request as a real user message.
- `conversation-session-plan-file-compact-continuity.test.ts` covers that after `ExitPlanMode` approval the plan text is written to `.zcode/plans` and returns to provider-visible context through `plan_file_reference` after a manual `/compact`.

## Added Coverage

`conversation-session-plan-mode-capabilities.test.ts` adds two plan mode capability boundaries:

1. When `ExitPlanMode` is rejected by the user without feedback, the current turn must stop and must not send a provider request carrying an `ExitPlanMode` tool_result; later ordinary user input is still in plan mode and carries the plan mode active reminder in provider-visible context.
2. In plan mode, when one assistant reply calls a write tool first and then a read-only tool, the write tool must be rejected with `mode.plan.nonReadOnly` and not persisted, and the later read-only tool must still run and return its real tool_result to the model.

## Out Of Scope

- Snapshot/gap recovery of the mobile `web-remote-replayable` is not inferred from this group.
- The approval proxy when a sub-agent triggers `ExitPlanMode` internally is not inferred from this group; it belongs to the later subagent human-in-the-loop delegate combination.
- Whether a plan file save failure blocks exiting plan mode is covered by core unit tests; E2E covers only the normal file continuity after user approval.
