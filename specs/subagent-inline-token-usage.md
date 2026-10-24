# Inline Subagent Token Usage

## Product rules

- Where a Desktop conversation telemetry attachment is available, a paired subagent row shows cumulative provider-reported input tokens, output tokens, and elapsed time inline with its type and task title.
- Input/output counts update after each completed model request from that child. They are exact provider usage values, not estimates and not token-by-token streaming counters.
- Omit token values until a provider usage report is available. The current `ZCodeUsage` report provides numeric input and output counts together; do not invent values when there is no report.
- Elapsed time uses the subagent row's `startedAt` and `endedAt`. While running, update once per second; when terminal, freeze at `endedAt`.
- Cold transcript hydration (`transcript-hydration.ts`, `synthesizeSubagentLifecycle`) stamps the synthesized `SubagentSpawned` / `SubagentStopped` events with the persisted Agent tool part's `time.start` / `time.end`, so a reloaded row keeps its real duration instead of the 1 ms gap between synthetic events (shown as "1s"). Event order still comes from `sequenceNumber`. The row's subagent type also falls back to the Agent tool input's `subagent_type` before the generic `subagent`.
- The values are renderer-only observation state. Do not add them to conversation rows, `SessionEvent`, the protocol, or persistence.
- Parent tool call identity is `toolCallId`; session identity is the parent `sessionId`, scoped by the existing remote-session and workspace-identity key. Never correlate concurrent child agents by spawn order or display name.

## State owner and event order

```text
child usage.delta (cumulative per completed model request)
  → ConversationTelemetrySupervisor matches childSessionId to parent toolCallId
  → messageTelemetry owns the cumulative display snapshot keyed by (telemetry attachment generation, parent sessionId, toolCallId)
  → ConversationAgentToolCallRow subscribes and renders input/output counts
```

- `messageTelemetry` owns the read-only UI projection and its subscriptions; the supervisor remains the sole writer from child facts. The subscription key combines the telemetry attachment generation and parent session ID, and the UI reads it from the matching scoped supervisor.
- Desktop foreground usage updates after each completed child model request. Background subagent usage is reported when the child reaches a terminal state. Web/mobile do not install this telemetry supervisor, so they omit token counts.
- Duplicate facts must not inflate usage; snapshots overwrite with the cumulative value already aggregated by the supervisor.
- Retain snapshots for completed rows for the lifetime of the in-memory conversation attachment; clear them when the attachment is discarded or the telemetry runtime is reset. No disk persistence or protocol change.

## Acceptance scenarios

1. A running foreground Agent row has no token counters before its first child usage report.
2. After each child model request completes, the matching Agent row updates its input and output counts without affecting other concurrent subagent rows.
3. The row's elapsed time increments while running and freezes at the terminal timestamp.
4. On task completion, failure, or cancellation, the last known token counts remain visible for the loaded conversation.
5. Missing provider usage fields remain hidden; no text-derived estimate is shown.
6. Replayed/duplicate usage facts do not double-count, and discarding the conversation telemetry attachment releases its snapshots and listeners.
7. After an app restart (cold hydration), a finished subagent row shows the duration between its Agent tool call's start and end and its real type (e.g. `Explore`), not "1s" and `subagent`.
