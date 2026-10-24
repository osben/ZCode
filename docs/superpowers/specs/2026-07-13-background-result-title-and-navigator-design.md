# Background Result Title and Real-user Turn Navigator Design

## Goal

A standalone background Agent/Bash completion turn no longer uses the inaccurate "worked for N seconds" summary title; it shows the title fixed when the task started. That result is already a model summary and provides no expand/collapse. The Conversation Turn Navigator indexes only user-initiated `realUser` inputs — never system notifications the runtime persisted with `role=user`.

```text
background task terminal
  │ { backgroundSource, workId, title }
  ▼
synthetic provider context ──► idle runtime command ──► TurnStarted
                                                        │
                                                        ▼
                                           TurnHeaderRow.originMeta
                                                        │
                              ┌─────────────────────────┴──────────────────────┐
                              ▼                                                ▼
                    static title + full history                  navigator ignores turn

real user send ──► UserInputRow(origin=realUser) ──► navigator item
```

## Structured data boundary

- New unified background result metadata: `backgroundSource: "bash" | "subagent"`, `workId`, `title`.
- Subagent title uses the Agent's launch description; Bash title keeps the existing `description → command → toolName → workId` resolution.
- The metadata persists with the background notification's synthetic message and travels via runtime command, `TurnStarted`, cold hydration, and product projection to `TurnHeaderRow.originMeta`. Never parse notification text or reverse-look-up the task by completion time.
- Notifications merged inline within an active loop do not create an independent `backgroundResult` turn and get no title; only idle-wake standalone model-only turns use this presentation.
- Replayable snapshot/coalesce reuses the row metadata: no new relay/main business state, no change to desktop-continuous or mobile-replayable recovery boundaries.

## UI semantics

- The new branch requires `turnHeader.origin === "backgroundResult"` plus complete source, workId, and non-empty title.
- The branch shows the full title as low-emphasis text with natural wrapping; history rows render fully forever — no `Collapsible`, chevron, trigger button, local open state, or work duration.
- Normal assistant turns and legacy background turns without structured metadata keep the current rendering; no text guessing or migration of old history.
- A navigator item requires a visible `UserInputRow(origin="realUser")` in the turn. Assistant-only, background result, goal continuation, mailbox, and other synthetic `role=user` inputs are all excluded; guided/queue-drained inputs stay when projected as `realUser`.
- The rule lives in the shared renderer serving desktop and Web; mobile narrow screens show no rail, but restored rows keep the same metadata.

## Acceptance and pruning

- Accepted: Agent idle wake, Bash idle wake, live/cold parity, title preserved across refresh, navigator count and preview drawn only from real user turns.
- terminal success/failed/stopped share one presentation rule; E2E covers the success path, and status combinations are covered by focused tests.
- Pruned: active-loop title insertion, migration of metadata-less legacy sessions, notification text parsing, mobile rail interaction E2E, full terminal status permutations.
- Automation covers at least: protocol/runtime metadata conservation, cold hydration, projection, static rendering of both title kinds, normal-turn collapse regression, legacy fallback, and strict navigator filtering.
