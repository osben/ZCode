# Plan Mode Goal Command Guard

When Plan mode is active, submitting a goal control command from the composer is rejected at the
UI admission boundary with a toast prompting a mode switch. Surfaces: desktop composer, normal web
composer, mobile `/remote` composer. Related docs:
`docs/conversation-protocol-declaration.md`, `docs/conversation-product-state-space.md`,
`docs/v4-refactor/v4-goal-command-parity-plan.md`. Code owners: `packages/ui/src/v4/SessionPane.tsx`,
`packages/ui/src/v4/ConversationComposer.tsx`, `packages/ui/src/v4/slashCommands.ts`.

Out of scope: rewriting the CLI goal runtime, changing queue/goal persistence, changing the
desktop continuous or mobile replayable delivery protocol.

## Rules

- Guard triggers only on `config.mode=plan` (draft/prewarmed sessions and existing sessions
  included); build/edit/yolo keep their semantics.
- Rejected commands are the parser-recognized goal control commands: `/goal`, `/goal <content>`,
  `/goal replace/resume/...` and existing `/target`-equivalent entries. `/compact` and plain text
  are unaffected.
- Attachment/context handling follows the existing parser guard: `/goal` text with attachments or
  selected context is not a slash command and still goes through plain `sendText`.
- Side effects: only a toast plus a `blocked` return. Input, attachments and draft records are
  kept. Never dispatch `sendGoalCommand`/`resumeGoal`, never create a session, never write prompt
  history.
- One shared `SessionPane` admission guard for desktop continuous, normal web and web-remote
  replayable — no separate guard in relay/main/Host/CLI.

High-risk cross-products, all settled before UI admission: Plan × goal alias must not bypass; Plan
× draft promotion must not create an empty session; Plan × composer cleanup must not lose the
rejected input.

## Concept map and state owners

| Concept               | Why it matters                          | Source / owner                                                                 |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| collaboration mode    | decides the Plan guard                  | CLI projection `snapshot.config.mode`; mirrored by draft config in draft state |
| visible slash command | separates goal-control intent from text | `parseV4VisibleSlashCommand`                                                   |
| command dispatch      | entry to any goal/session side effect   | `SessionPane.dispatchSendTextAfterConfig`                                      |
| composer draft        | must survive rejection                  | `ConversationComposer` + Lexical editor/draft store                            |
| toast copy            | all-surface, bilingual                  | UI i18n + shared toast component                                               |

```text
composer submit
  -> parse visible slash command
  -> read effective collaboration mode
  -> mode=plan AND command=goal-control
       |-- yes -> toast -> return blocked -> keep editor/draft -> no V4 command
       `-- no  -> existing config barrier -> V4 command -> ACK/projection

desktop-continuous --------\
                             +-> shared SessionPane guard -> existing Host/CLI
web-remote-replayable -----/
```

## Cases

| Case ID | Setup                                            | Action                   | Assertions                                                                                                                 | Status   |
| ------- | ------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------- |
| PG01    | plan mode (snapshot or draft effective), `/goal` | Enter or click send      | correct toast; `sendGoalCommand`/`resumeGoal`/`createSession` none dispatched; editor not cleared; no prompt history write | covered  |
| PG02    | build/edit/yolo                                  | submit `/goal objective` | still dispatches `sendGoalCommand`                                                                                         | existing |
| PG05    | plan mode                                        | submit a goal alias      | identical to PG01 — aliases cannot bypass                                                                                  | covered  |

Pruned: ordinary text/`/compact` under plan (existing semantics), goal-looking text with
attachment/context (parser returns plain text), desktop/mobile terminal-state duplication (shared
UI admission; delivery profile does not change the guard), full alias permutations (parser
equivalence — one alias representative), queue/running/completed permutations (the guard runs
before dispatch, so runtime phase cannot change the outcome).

Coverage matrices record PG01 and the Plan × goal composer guard row; the old claim that `/goal`
could update the target after EnterPlanMode was removed.

## E2E handoff notes

- Provider fixture: not needed — the product contract is zero provider requests; any later E2E
  manifest uses `providerRequestPolicy: none`. No file-system fixture; not in the Docker preset.
- Review focus: draft/prewarm must not be promoted; the mobile shell must reuse the shared
  `SessionPane`.
