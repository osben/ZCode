# Subagent RespondToCoordinator

## Goal

After receiving a coordinator message from main via `SendMessage`, a normal subagent can deliver its reply to the parent runtime with `RespondToCoordinator` while continuing its own task.

## Product contract

- `SendMessage` stays main-only.
- `RespondToCoordinator` stays child-only; its provider input is only `summary` and `message`.
- Child session, agent identity, and parent route are bound by the runtime closure; the model cannot choose or override the target.
- The tool registers only when `taskType === "subagent_child"`, the coordinator port is configured, and the global `toolDisallowlist` does not disable it; usage guidance appears only in the actual tool description.
- Success means only that the response command entered the parent runtime command queue synchronously — not that the parent model has read, accepted, or replied.
- While the parent is active, the first model step does not read runtime commands; only when the current turn advances to a later model step does the active loop read one command snapshot of `priority <= next` before compact and request prepare, merging the snapshot's `task-notification` / `subagent-message` with the current tool result.
- The active loop does not rescan the queue before compact, MCP init, or the provider request, and does not keep consuming commands enqueued during snapshot processing. Replies missing this snapshot wait for a later model step; if the turn ends, the outer runtime command queue starts a model-only turn serially.
- Ordinary `prompt` and target continuation are not consumed by the active-loop snapshot; they stay in the outer queue.
- The parent provider-visible carrier is a user-like `<subagent-message>` persisted with source `subagent_message` and visibility `model-only`.
- The synthetic carrier is not shown as a top-level user message, does not feed the session title, and does not enter `ReadSessionContext`. The child tool lifecycle mirror stays available to compatible consumers and diagnostics, but the parent V4 ProductProjection does not materialize ordinary child tool mirrors as `ToolCallRow`; the dedicated `RespondToCoordinator` card shows only in the child session conversation, and the parent session keeps showing only the Agent/Task summary.
- The child's final assistant text still means the task's final result; `RespondToCoordinator` does not end the task.

## Persistence and visibility

- Only when the parent runtime drains the response command is the full `<subagent-message>` carrier written to parent model history and the session store, containing the schema-validated, XML-escaped `summary` and `message` with no extra semantic truncation. Active/idle delivery, session hydrate, and parent resume thus share one model context; enqueue success alone still does not mean persisted.
- The synthetic user message source `subagent_message` and the `SessionEventType.SubagentMessage` lifecycle/progress event are two structures. The latter is only a progress summary; the former is the complete model input of the coordinator response and must not be truncated into a summary based on historical progress-event constraints.
- `model-only` is a display and context-projection boundary, not a "not persisted" marker. User-visible message projection, session title, and `ReadSessionContext` must filter the carrier; exports, diagnostics, privacy review, and storage budgets reading the raw parent session store must treat it as possibly containing the full reply.
- Before compact, the carrier may enter parent provider history; after compact the original model-only message need not be kept verbatim in the compact tail, but its semantics may enter the compact summary. UI hiding must not be read as data deletion.
- The child's ordinary tool/model/turn transcript stays only in the child session; this channel persists only the single reply the child explicitly sent via `RespondToCoordinator`, never a copy of the full child transcript.

## Scheduling

`RespondToCoordinator` uses `concurrentSafe: true`. It can join the same parallel group as concurrent-safe tools like `Read`, `Glob`, `Grep`; `Bash`, `Write`, `Edit` keep following the existing scheduler safety rules. The model should emit the reply call first and continue with the next work tool call in the same assistant step.

The child's currently executing tool batch is not interrupted by coordinator input; steer drain appends a `Message from coordinator:` input after the batch ends and before the next child provider request. If the coordinator input arrives while the child's current model step closes normally as text-only, persist that assistant first, append the coordinator input with `user` role, and continue the same active turn with the next provider request; only terminal states that cannot continue the turn (stop/cancel/interrupted) or an existing FIFO barrier blocking safe inline fall back to the ordinary future queue.

## Permission

- The tool keeps `readOnly: false`, `destructive: false`, `sideEffectScope: "session"`.
- Plan mode admits this non-destructive, approval-free session-local control action via the explicit `allowedInPlanMode` capability.
- Global disallow, project deny, and project ask still take precedence over the Plan-mode capability.
- Never disguise a session mutation as read-only.

## Result semantics

- A success result uses queued copy and reminds the child to continue the current task unless the coordinator explicitly changed or ended the goal.
- Synchronous enqueue failure returns a failed result; the failure copy likewise reminds the child to continue.
- With no coordinator port the tool does not register; a forced call in that state returns a configuration error.
- The response command and the subsequent Agent completion notification both use `priority: "next"`. They may appear in the same or adjacent provider requests, but the response's first provider-visible position must precede the completion notification.

## Failure semantics

- Command enqueue is the only synchronous acknowledgement boundary.
- The child-dedicated card's summary body shows only the input `summary` and failure status; it does not copy `message`, `responseId`, `error`, or the raw result. A real tool execution failure's cause shows only through the `ToolLayout` generic failure-state tooltip on hover/copy; the business `status: "failed"` invents no error detail or expandable section.
- A parent persistence, provider-request, or process failure after enqueue never rewrites the already-completed child tool result.
- The active-loop snapshot is a best-effort turn boundary, not a delivery barrier for the provider request; a `subagent-message` arriving after the snapshot is not guaranteed to enter the current request and may be consumed by a later active request or the outer queue.
- P0 provides no durable retry, inbox/outbox, read receipt, or process-restart recovery.
- While a single long tool has not returned, the child model has no control and cannot call the reply tool immediately.

## Out of scope

- Full Agent Teams, teammate mailbox, team roster, or sibling routing.
- Full child-side `SendMessage`.
- `replyTo`, read receipts, or a durable mailbox.
- Interrupting a single executing tool.
- Changing the scheduler to force parallelism of unsafe tools with the reply tool.
- Restoring or adding ordinary child tool rows inside the parent Agent card.
- New app-to-agent RPC, or changes to desktop/mobile runtime ownership, workspace identity, remote session routing, and the client command queue.

## Verification

- Contracts: strict input/output schema, the 20,000-character cap, and routing-field rejection.
- Core: child-only tool surface, Plan-mode permission, active/idle/terminal-race command intake, max model concurrency 1, FIFO ordering, enqueue-failure continuation, and hydrate parity.
- Shared: protocol source, model-only visibility, source-only fallback, and title filtering.
- Session context: `subagent_message` does not enter local relevant snippets.
- E2E `BG25`: `SendMessage -> RespondToCoordinator + continued work -> parent model-only wake -> child completion`, also verifying child conversation observability, no ordinary child tool row materialized in the parent session, and no top-level synthetic user bubble.
- E2E `O19`: under a real schema validation error, coverage confirms the child card body shows only the input `summary` and “回复失败”, no provider wrapper or raw error body, and the card is not expandable. The WDIO assertion that hovering the failed state shows the generic tooltip with the corresponding `context.errorText` is not yet added; coverage stays `partial`.
