# Status Panel Todo Focus Window Boundaries

Note: the click-to-expand fold rows below (TFW06, SP16) are superseded in part by
`2026-07-23-status-panel-todo-hover-preview-boundaries.md`, which turns the hidden groups into a hover preview.

## Feature Summary

| Field                 | Value                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Change                | Restore the originally designed compact Status Panel Todo window instead of a fixed first-4 list with a global expand      |
| User-visible surfaces | The "process" block of the V4 `ConversationStatusPanel`                                                                    |
| Existing docs         | `docs/ui/chat-summary-panel.md`, SP case catalog / coverage matrix                                                         |
| Existing code owners  | `ConversationStatusPanel.tsx` owns renderer-local display state; `conversationStatusPanelModel.ts` keeps the full snapshot |
| Out of scope          | CLI TodoWrite, session projection, persistence, desktop continuous / mobile replayable delivery protocols                  |

The simplified "first 4 + show more" implementation was judged a bug-candidate against the original design.

## Boundary Decisions

| Boundary          | Decision                                                               | Includes                                   | Excludes / prunes                                | Source                 |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ | ---------------------- |
| Compact threshold | Compact only when the Todo total is `> 6`                              | 0-6 items shown in full                    | A fixed 4-item window                            | `6f32518d4c` + user    |
| Focus point       | Prefer `inProgress`, else the first unfinished item, else the tail     | Focus item and following context           | Completed-first reordering                       | `5728558169` + user    |
| Default window    | Three consecutive items in original order; back-fill near the end      | At least 3 items when the total allows     | Always "current + next two" leaving a short tail | `da2360cfa0`           |
| Fold groups       | The groups before and after the window expand / collapse independently | In-place animation, count copy             | A single global "show more" switch               | `55f4f6c999` + user    |
| Snapshot update   | After an id / content / status change both groups return to collapsed  | Renderer-local reset                       | Writing session, store or protocol               | user + legacy behavior |
| Multi-platform    | Desktop and mobile Web share one renderer algorithm                    | Responsive shell keeps existing boundaries | replayable/continuous business cross product     | renderer invariant     |

## Domain Scope

| Domain                  | Include?            | Why it can change behavior                     | Primary sources                  |
| ----------------------- | ------------------- | ---------------------------------------------- | -------------------------------- |
| Conversation/session UI | yes                 | The Todo snapshot drives the visible window    | protocol declaration, SP catalog |
| UI shell / responsive   | yes                 | Long copy, fold rows, block scroll height      | `DESIGN.md`, chat summary spec   |
| Persistence / protocol  | no                  | No new authoritative state                     | renderer-local invariant         |
| Mobile replay recovery  | representative only | Same snapshot rebuilds the same default window | SP08 boundary                    |

## Concept Map And State Owners

```text
CLI TodoWrite snapshot
        |
        v
ConversationStatusPanelModel.displayItems  (full original order, authoritative UI input)
        |
        v
Todo focus partition                   (pure derivation)
  completed-prefix | focus-window | waiting-suffix
        |                 |
        +---- renderer-local open state ----+
                         |
                         v
              StatusSection scroll viewport
```

| State / fact                | Authority                           | Mirrors / caches                  | Evidence                                   |
| --------------------------- | ----------------------------------- | --------------------------------- | ------------------------------------------ |
| Todo content, order, status | V4 `PlanState.items` snapshot       | status panel model                | model unit test                            |
| Three-segment window bounds | pure partition helper               | none                              | focused unit test                          |
| Upper / lower fold switches | `PlanStatusItems` React local state | none                              | component interaction / runtime DOM        |
| delivery profile            | host attachment                     | renderer receives same projection | existing SP08; pruned from business matrix |

## Candidate Combinations And Pruning

| Candidate ID | State                                              | Event                             | Expected effect                                      | Status   |
| ------------ | -------------------------------------------------- | --------------------------------- | ---------------------------------------------------- | -------- |
| TFW01        | 0-6 Todo                                           | render                            | All shown in snapshot order, no group switch         | accepted |
| TFW02        | >6, inProgress in the middle                       | render                            | Focus three consecutive items, fold before and after | accepted |
| TFW03        | >6, inProgress at the end                          | render                            | Back-fill from the front, still three consecutive    | accepted |
| TFW04        | >6, no inProgress, has pending                     | render                            | Focus the first unfinished item                      | accepted |
| TFW05        | >6, all completed                                  | render                            | Focus the last 3; prefix is expandable               | accepted |
| TFW06        | compact state                                      | expand upper / lower group        | Each group changes independently; order unchanged    | accepted |
| TFW07        | any group expanded                                 | snapshot id/content/status update | Both groups collapse and the window is recomputed    | accepted |
| TFW08        | desktop / mobile, local / remote, provider / model | same snapshot                     | Same renderer result; no business full permutation   | pruned   |

Pruning rationale: the focus window consumes only `PlanState.items`; it sends no command and reads no
workspace, provider, delivery profile or persistence source. Desktop continuous vs mobile replayable only
affect how the snapshot arrives, not how it is derived. A pure helper plus the renderer component represent
the coverage; the mobile overlay stays with the dedicated SP08 work.

## Accepted Cases

| Case ID | Setup                                         | Action                                        | Assertions                                                           | Evidence layers         | E2E status |
| ------- | --------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- | ----------------------- | ---------- |
| SP14    | 6 or fewer Todo with mixed statuses           | expand process                                | All visible in original order, no fold-count rows                    | UI + model              | planned    |
| SP15    | 7+ items, current item first / middle / last  | expand process                                | Three-item window positioned correctly, tail back-filled             | UI + pure partition     | planned    |
| SP16    | Items exist before and after the focus window | click upper and lower fold rows independently | Each group expands / collapses, the other unchanged, order unchanged | UI + model              | planned    |
| SP17    | Any fold group expanded                       | Todo id/content/status updates                | Both groups collapse; window recomputed from the new snapshot        | UI + snapshot signature | planned    |

## E2E Handoff Notes

- Provider fixture: a later formal E2E can replay TodoWrite to produce 7 Todo items and update a middle status.
- File-system fixture: not needed.
- Timing: pure renderer interaction does not depend on slow SSE; the snapshot-update case uses two deterministic projections.
- Review risk: with two-line long copy the fold rows must stay visible, and the mobile overlay must not overflow horizontally.
- The current stage relies on focused component/model tests and desktop CDP runtime inspection; "planned" must not be reported as formal E2E covered.
