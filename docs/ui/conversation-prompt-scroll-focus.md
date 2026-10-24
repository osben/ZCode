# Conversation Prompt Scroll Focus

## Feature Summary

| Field                 | Value                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Change                | When the user submits a new prompt while reading earlier content, only the immediate-send path runs the existing "scroll to bottom" action once                         |
| User-visible surfaces | V4 conversation composer, queue item "立即发送" (send now), desktop/Web/mobile shared UI                           |
| Existing docs         | `docs/conversation-session-case-catalog.md`、`docs/testing/conversation-session-e2e-coverage-matrix.md` |
| Existing code owners  | `ConversationTimeline` owns renderer-local scroll state; `SessionPane` orchestrates composer/queue commands          |
| Out of scope          | Permanent forced pinning, protocol/CLI queue changes, cross-renderer scroll position sync, edit/retry/automatic drain                      |

## Clarification Log

| Round | Question                                    | User answer                                  | Boundary fixed              | Follow-up needed |
| ----- | ------------------------------------------- | -------------------------------------------- | --------------------------- | ---------------- |
| 1     | Do plain send, enqueue and queue send-now all trigger? | Enqueueing a message does not trigger; clicking send-now on a queue item does | send-now and enqueue are decided separately | no               |

## Boundary Decisions

| Boundary | Decision                          | Includes                                         | Excludes / prunes                   | Source                               |
| -------- | --------------------------------- | ------------------------------------------------ | ----------------------------------- | ------------------------------------ |
| Trigger  | Reuse the existing instant "scroll to bottom" action | composer direct send accepted; queue item send-now click | enqueue only, automatic drain, edit, retry | user                                 |
| Lifetime | Restore `following=true` once       | This scroll to the bottom and the existing natural following afterwards                   | Permanent bottom lock; continuing to force-scroll after the user scrolls up        | user + existing scroll state machine |
| Failure  | A failed composer send does not change the reading position   | accepted/no-throw send                           | rejected/throw                      | existing ACK boundary                |
| Client   | shared renderer semantics              | desktop continuous, plain Web, mobile remote UI   | Cross-device scroll position sync                  | architecture invariant               |

## Domain Scope

| Domain                | Include?      | Why it can change behavior                                      | Primary sources                       |
| --------------------- | ------------- | --------------------------------------------------------------- | ------------------------------------- |
| Conversation/session  | yes           | `inputRouting.mode` distinguishes start-now from enqueue                   | conversation protocol declaration     |
| Renderer scroll state | yes           | `followingRef`, scroll memory and the bottom action determine the user's reading position | `ConversationTimeline.tsx`、SRM cases |
| Mobile replayable     | boundary only | Shared UI, but the recovery protocol must not own scroll state                             | message flow architecture             |
| Protocol/CLI          | no            | No new command/result or queue state                             | renderer-local invariant              |

## Concept Map And State Owners

```text
composer start-now --ACK accepted--\
                                  +--> SessionPane intent --> ConversationTimeline bottom action ref
queue send-now click -------------/
composer enqueue -----------------X

scrollToBottom(): following=true -> instant bottom -> existing content-follow behavior
user scrolls up: following=false -> hold reading position
```

| State / fact              | Authority                                                  | Evidence                             |
| ------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| start-now vs enqueue      | current V4 `snapshot.inputRouting.mode` + held disposition | focused policy unit test             |
| queue send-now click      | `ConversationQueuePanel` user action                       | SessionPane component test           |
| scroll position/following | `ConversationTimeline` component instance                  | timeline action-ref unit test         |
| conversation/queue truth  | CLI projection                                             | unchanged                            |

## Dimensions And Candidate Combinations

| Candidate ID | State                                                      | Event                                           | Expected effect                                | Status                                                      |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| PSF01        | existing session, user is above bottom, routing=`startNow` | composer send resolves accepted                 | instant bottom; `following=true`               | accepted                                                    |
| PSF02        | existing session, user is above bottom, routing=`enqueue`  | composer input is accepted into queue           | keep reading position; `following=false`       | accepted                                                    |
| PSF03        | queue visible, user is above bottom                        | click queue item send-now                       | immediately run the same bottom action         | accepted                                                    |
| PSF04        | direct composer send throws/rejects                        | send fails                                      | keep reading position and draft                | pruned from trigger by success guard                        |
| PSF05        | PSF01/PSF03 already moved to bottom                        | user scrolls up again                           | existing scroll handler sets `following=false` | accepted invariant                                          |
| PSF06        | automatic queue drain                                      | runtime consumes an item without send-now click | no new forced scroll intent                    | ignored; existing following state decides content anchoring |

## Pruning Decisions

| Decision ID | Pruned combinations                                         | Guard/invariant                                   | Product reason                                | Representative coverage      |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- | ---------------------------- |
| P1          | provider/model/goal/tool × prompt scroll                    | routing result is the only relevant UI dimension  | these axes do not change scroll intent        | PSF01/PSF02                  |
| P2          | desktop continuous × mobile replayable product-state matrix | scroll is renderer-local                          | delivery changes recovery, not this UI action | shared component unit        |
| P3          | edit/retry/automatic drain                                  | no composer-new-prompt or explicit send-now event | avoid unrelated jumps while reading history   | absence of trigger in wiring |

## Accepted Cases And Coverage

| Case ID | Setup                                                                 | Action                                          | Assertions                                                                                      | Evidence layers             | E2E status |
| ------- | --------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------- | ---------- |
| SRM05   | long session, user scrolled away from bottom, routing start-now       | submit composer prompt and receive accepted ACK | bottom action runs once, latest content visible, following restored; later user up-scroll holds | UI + command ACK            | planned    |
| SRM06   | long running session, user scrolled away from bottom, routing enqueue | submit composer prompt                          | queue gains item; scroll position/following unchanged                                           | UI + projection             | planned    |
| SRM07   | long session with visible queue, user scrolled away from bottom       | click a queue item “立即发送”                   | bottom action runs immediately; command still follows existing send-now lifecycle               | UI + command ACK/projection | planned    |

## E2E Handoff Notes

- Reuse the existing V4 long-conversation scroll fixture and queue fixture.
- Use controlled-stream only for SRM06; SRM05/SRM07 need no new provider contract beyond existing fixtures.
- Desktop continuous is the formal representative. Mobile replayable only needs a shared-component assertion unless a future remote-specific regression appears.
- Keep the implementation renderer-local; do not add protocol fields, snapshot state, relay state, or persistent scroll state.
