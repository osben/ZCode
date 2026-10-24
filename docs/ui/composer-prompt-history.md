# Composer Prompt History

## Feature/change summary

| Field                 | Value                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | When the composer submits text, only a consecutive history entry equal to the previous one is filtered; `Up/Down` keep reading history |
| User-visible surfaces | The V4 conversation composer shared by Desktop / Web                                                                                   |
| Existing docs         | `docs/v4-refactor/m5-composer-parity.md`, `docs/conversation-session-case-catalog.md`                                                  |
| Existing code owners  | `packages/ui/src/lib/promptHistory.ts`, `packages/ui/src/lib/promptHistoryStorage.ts`, `packages/ui/src/v4/ConversationComposer.tsx`   |
| Out of scope          | Global de-dup, old data migration, history capacity and workspace key changes, protocol/Agent/relay state                              |

## Clarification log

| Round | Question                                             | User answer                           | Boundary fixed                                                                                  | Follow-up needed |
| ----- | ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------- |
| 1     | Consecutive or global duplicates                     | Filter only consecutive ones          | `A,A` keeps one; `A,B,A` keeps all                                                              | no               |
| 1     | How to normalize before equality                     | Just trim leading/trailing whitespace | Compare only the complete text after `trim()`; inner whitespace, newlines and case still matter | no               |
| 1     | Whether to clean duplicates when reading old history | No cleanup needed                     | The read path does no de-dup migration; existing duplicates keep their order                    | no               |

## Boundary decisions

| Boundary            | Decision                                                                                            | Includes                                                                     | Excludes / prunes                                         | Source        |
| ------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------- |
| Write de-dup        | A new entry identical to the current last entry after `trim()` skips the append and the disk write  | Consecutive identical submits, differing only in leading/trailing whitespace | Non-consecutive duplicates                                | user          |
| Text equivalence    | Only trim leading/trailing whitespace                                                               | `" A "` equals `"A"`                                                         | Inner whitespace folding, case folding, Unicode rewriting | user          |
| Read compatibility  | No de-dup in the read path                                                                          | Old array order and duplicates                                               | Migration/full cleaning                                   | user          |
| Navigation takeover | Keep the status quo: `Up/Down` are taken over only for empty input or when already browsing history | Single-line/multi-line composer                                              | Overriding normal cursor-up for a non-empty draft         | existing code |
| Failure rollback    | Keep the status quo: a failed send adds no history                                                  | send reject/failure                                                          | Leaving the failed body in history                        | existing code |

## Domain scope and high-risk cross-products

| Domain                  | Include?       | Why it can change behavior                                                                    | Primary sources                                    |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Conversation composer   | yes            | Submit and `Up/Down` both happen in the shared Lexical composer                               | `ConversationComposer.tsx`, `LexicalChatInput.tsx` |
| Renderer persistence    | yes            | History is renderer `localStorage` state                                                      | `promptHistoryStorage.ts`                          |
| Desktop/Web client mode | representative | Both reuse the same UI logic; the feature does not enter the continuous/replayable data chain | `docs/architecture/message-flow.md`                |
| Agent/protocol/queue    | no             | Writing history does not change submitted commands, queue or projection                       | `docs/conversation-protocol-declaration.md`        |

High-risk combinations converge as follows: send success/failure affects whether new history is kept; consecutive/non-consecutive duplicates affect whether to append; duplicates in old storage affect only read results. `desktop-continuous` vs `web-remote-replayable`, session phase, provider, queue, theme and locale do not change the pure renderer de-dup result, so each keeps the shared implementation as representative with no full permutation.

## Concept map and state owners

```text
composer submit
  -> read per-workspace localStorage snapshot
  -> trim submitted text
  -> compare with last entry only
     |-- same      -> send command; history/storage unchanged
     `-- different -> append (max 30) -> persist -> send command
                                      `-> send failed: compare-and-rollback

empty composer / history-browsing state
  -> ArrowUp / ArrowDown
  -> PromptHistoryPlugin
  -> replace Lexical editor text
```

| State / fact             | Authority                                                     | Mirrors / caches                                 | Evidence                                    |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| Prompt history entries   | Browser `localStorage` for the current existing workspace key | `ConversationComposer.promptHistory` React state | stored JSON + composer `promptHistory` prop |
| Current navigation index | `PromptHistoryPlugin` ref                                     | none                                             | focused navigation unit behavior            |
| Submitted text           | Lexical/composer draft until command accepted                 | `textRef`                                        | `onSendText` call                           |

## Dimensions and candidate combinations

| Candidate ID | Stored history       | Submitted text / event                  | Expected guard/effect                                                        | Status   |
| ------------ | -------------------- | --------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| PH01         | `["A"]`              | send `" A "`                            | Equals the last entry after trim; no append, no disk write                   | accepted |
| PH02         | `["A", "B"]`         | send `"A"`                              | Compare only the last entry `B`; append to `["A","B","A"]`                   | accepted |
| PH03         | `["A B"]`            | send `"A  B"`                           | Inner whitespace differs; append normally                                    | accepted |
| PH04         | old data `["A","A"]` | read / mount                            | No read de-dup, still returns two entries                                    | accepted |
| PH05         | `["A"]`              | send `"A"` fails                        | Not written to history, no rollback write needed, original history unchanged | accepted |
| PH06         | `["A"]`              | non-empty multi-line draft presses `Up` | Existing guard keeps cursor navigation, history not entered                  | pruned   |

## Pruning decisions

| Decision ID | Pruned combinations                              | Guard/invariant                                       | Product reason                            | Representative coverage              |
| ----------- | ------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| PHD01       | provider/model/session phase x de-dup            | De-dup is a pure renderer function before the command | Does not affect the comparison result     | PH01-PH05                            |
| PHD02       | desktop continuous x mobile replayable           | History does not enter conversation delivery          | Both reuse the composer                   | PH01                                 |
| PHD03       | `Up/Down` history takeover for a non-empty draft | `currentIndex === null && text.length > 0`            | Does not break multi-line cursor movement | existing `PromptHistoryPlugin` guard |

Unresolved questions: none.

## Accepted cases and coverage handoff

| Case ID | Setup                                           | Action                                     | Assertions                                                                          | Evidence layers               | Status       |
| ------- | ----------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------- | ------------ |
| PH01    | Most recent history is `A`                      | Submit `" A "` with surrounding whitespace | The command is still sent; history still holds only `A`; no storage write is called | UI integration + localStorage | focused test |
| PH02    | History is `A,B`                                | Submit `A` again                           | History is `A,B,A`; reading upward keeps the non-consecutive duplicate              | pure function + localStorage  | focused test |
| PH03    | Most recent history is `A B`                    | Submit `A  B`                              | Both entries are kept                                                               | pure function                 | focused test |
| PH04    | localStorage already has consecutive duplicates | Read history                               | Returns the original duplicate order, no migration write                            | localStorage                  | focused test |
| PH05    | Most recent history is `A`                      | Submit `A` again and the send fails        | Original history unchanged and no compensating write                                | UI integration + localStorage | focused test |

Matrix backfill: `docs/conversation-session-case-catalog.md` gets a new `PH` group; `docs/testing/conversation-session-e2e-coverage-matrix.md` registers the focused UI/storage automation. The change sends no provider request and changes no protocol or visuals, so no replay fixture is needed; if WDIO is added later it can declare `providerRequestPolicy: "none"`.
