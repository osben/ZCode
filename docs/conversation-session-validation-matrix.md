# Conversation Session Validation Matrix

Goal: turn conversation-area MVP cases into executable verification tasks. The case catalog describes what the product should do; this file describes how to prove it actually does.

Protocol sources:

- [conversation-protocol-declaration.md](./conversation-protocol-declaration.md)
- [conversation-session-case-catalog.md](./conversation-session-case-catalog.md)

## Verification principles

Every E2E case needs at least one user-visible assertion and one non-UI evidence layer. UI is the primary assertion because the product is defined by what the user experiences; logs, protocol, network, and files are supporting evidence for locating async, queue, persistence, and cross-session issues.

UI assertions must be deterministic and engineering-grade: locate elements via global `data-testid`, judge outcomes via DOM attributes, input values, normalized text, disabled state, and element counts. Screenshots and video are failure-review artifacts only, never an automated pass condition. Test id contract: [conversation-session-ui-testid-contract.md](./conversation-session-ui-testid-contract.md).

Default no-error-banner rule: unless the case's product expectation explicitly declares that an error banner should appear, any `ChatViewErrorBanner` / `ChatErrorBanner` during a positive or non-fault path fails the case. A typical counterexample is an error banner popping up during positive paths such as compact, goal, queue, fork, edit, or model switch; even if the other UI state eventually looks right, the case does not pass. Cases that may show an error banner must be explicitly marked fault, negative, error recovery, or provider/network failure in the catalog / coverage matrix / spec name or notes, with the expected error source, dismissibility, and the follow-up button/queue state.

| Evidence layer | What it proves                              | MVP collection method                                                                                                   |
| -------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| UI             | What the user actually sees and can operate | WDIO `data-testid` locators, DOM attributes, input values, normalized text, disabled state, counts                      |
| Runtime/Store  | Renderer-internal projection matches state  | Test-only state export: `sessionId`, `phase`, `queue.length`, `autoDrain`                                               |
| Protocol       | Real commands between app and agent         | Capture `session/send`, `session/compact`, `session/goal`, `session/stop`, `session/fork` req/res                       |
| Log            | Async flows hit the right branch            | UI logger, service logger, agent log, correlated by `caseId/runId/sessionId/inputId`                                    |
| Network/SSE    | Model streams, errors, compact retries      | Mock provider records requests, SSE events, event timing                                                                |
| Files          | History, settings, fork results on disk     | Export session snapshot, settings snapshot, relevant file tree at test end                                              |
| Artifact       | Post-failure review                         | One directory per case with screenshots, video, logs, protocol frames, network frames, snapshots; not part of pass/fail |

## Artifact layout

One directory per case, so evidence does not mix when multiple sessions run concurrently.

```text
artifacts/conversation-session/<caseId>/<runId>/
  screenshots/
    01-before.png
    02-after-action.png
    03-final.png
  video.mp4
  ui-log.ndjson
  service-log.ndjson
  agent-log.ndjson
  protocol-frames.ndjson
  network-events.ndjson
  session-snapshots/
    before.json
    after-action.json
    final.json
  files/
    workspace-tree-before.txt
    workspace-tree-after.txt
```

Screenshots and video are archived evidence, not assertion sources. Automated pass conditions must live in the deterministic layers (UI / Runtime / Protocol / Network / Files).

Every log line and frame must carry these correlation fields:

```text
caseId
runId
workspaceIdentity
workspacePath
sessionId
inputId
queryId
clientMode
```

Write an explicit `null` for a missing field instead of omitting it, so later joins stay mechanical.

## MVP case selection

The first batch is the 10 cases that best prove the loop. It does not cover environmental dimensions such as external faults, full disk, 429/503, or mobile replayable.

| MVP ID | Catalog ID  | Why first                                                                |
| ------ | ----------- | ------------------------------------------------------------------------ |
| MVP-01 | A01         | Minimal loop: first send, session creation, entering the detail page     |
| MVP-02 | A03         | Plain message enqueued while running — root of queue capability          |
| MVP-03 | A08         | `/compact` typed-queued while running — FIFO and no disguised plain send |
| MVP-04 | A07/H03/H04 | `/goal` queued while running — command vs plain prompt                   |
| MVP-05 | B02         | Queue survives stop and is not auto-consumed                             |
| MVP-06 | B06/B08     | Held queue after stop: more input appends; send-now consumes             |
| MVP-07 | D03         | Editing a historical user query preserves the queue                      |
| MVP-08 | E07/K08     | Forking a stable assistant does not copy the parent session queue        |
| MVP-09 | F03/F08     | Manual compact coexists with a held queue                                |
| MVP-10 | G01/G10     | After auto compact succeeds, pendingAction continues                     |

## Probe Matrix

### MVP-01 First send enters the detail page

Catalog: A01

| Layer         | Assertion                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | Send “这是个什么项目”; the session detail page opens; the user message is visible; composer clears; generating or prewarming state shows |
| Runtime/Store | A non-empty `sessionId` exists; `phase` is `prewarming` or `running`; queue=0                                                            |
| Protocol      | One session-creation and send for the first message; `content` equals “这是个什么项目”                                                   |
| Log           | workspace prepared, session created, first prompt accepted recorded                                                                      |
| Network/SSE   | Mock provider receives one model request and starts SSE output                                                                           |
| Files         | Session snapshot contains the first user message                                                                                         |
| Artifact      | Screenshots at before, after-send, first-token; failure review only                                                                      |

### MVP-02 Plain message enqueued while running

Catalog: A03

| Layer         | Assertion                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| UI            | While streaming, send “继续解释”; the queue panel shows 1 pending message; the assistant keeps streaming |
| Runtime/Store | `phase=running`; `queue.length=1`; item content is “继续解释”                                            |
| Protocol      | No second `session/send` for the same session fires immediately                                          |
| Log           | Enqueue branch logged; no queue drain started                                                            |
| Network/SSE   | Current model request continues; no second model request                                                 |
| Files         | Persisted history has no “继续解释” user turn unless the queue is later consumed                         |
| Artifact      | Queue panel screenshot, protocol frame excerpt; failure review only                                      |

### MVP-03 `/compact` queued while running

Catalog: A08

| Layer         | Assertion                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | While streaming, send `/compact`; a queued feedback appears; the queue gains a `/compact` maintenance item; no compact timeline marker yet     |
| Runtime/Store | `phase` stays `running`; a kind=`compact` item is appended; `activeTurnKind` unchanged                                                         |
| Protocol      | No new compact model request before current work finishes; compact runs only after queue promotion; `/compact` is never a plain `session/send` |
| Log           | compact admission/enqueue logged; typed promotion logged after the ready boundary                                                              |
| Network/SSE   | Current model request continues; no compact model request before it finishes                                                                   |
| Files         | Session snapshot gains no `/compact` user message; summary/marker appear only after compact really runs                                        |
| Artifact      | Queue/toast screenshots, protocol FIFO order digest; pass verdict rests on queue item kind and request ordering                                |

### MVP-04 `/goal` queued while running

Catalog: A07, H03, H04

| Layer         | Assertion                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| UI            | While streaming, send `/goal 修完登录流程`; the queue gains a goal item; the current turn is not interrupted |
| Runtime/Store | New queue item preserves `/goal` semantics in kind or content; `phase=running`                               |
| Protocol      | No `session/goal` at send time; it appears only when the current turn finishes and the queue drains          |
| Log           | enqueue goal then drain goal; update semantics when a goal exists, set semantics otherwise                   |
| Network/SSE   | No new model request at enqueue; whether goal consumption triggers one depends on the goal result            |
| Files         | Session target unchanged before goal consumption; set or updated after                                       |
| Artifact      | Snapshots before/after enqueue and after consumption                                                         |

### MVP-05 Queue survives stop and is not auto-consumed

Catalog: B02

| Layer         | Assertion                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | With running and queue=1, click stop; the current turn shows a stopped/interrupted result; the queue still shows 1 item; no automatic next-turn loading |
| Runtime/Store | `phase=completed(interrupted)`; `queue.length=1`; `queue.autoDrain=false`                                                                               |
| Protocol      | `session/stop` appears; no `session/send` for the head item right after stop                                                                            |
| Log           | stop accepted; no queue drain started                                                                                                                   |
| Network/SSE   | Current SSE is aborted or ends; no new model request                                                                                                    |
| Files         | Session snapshot keeps the interrupted assistant state; queue snapshot keeps the item                                                                   |
| Artifact      | Screenshots before stop, after stop, after settling; failure review only                                                                                |

### MVP-06 Held queue: more input and send-now

Catalog: B06, B08

| Layer         | Assertion                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI            | With `completed(interrupted), queue=1, autoDrain=false`, type “再补充”; the queue becomes 2; after clicking send-now on the second item, that item moves to the head and is consumed |
| Runtime/Store | More input only appends to the queue and does not change `autoDrain`; after send-now the target item becomes the active input                                                        |
| Protocol      | More input sends one `sendText`, projected by the CLI as a queue item; send-now sends `sendQueuedNow`; consumption must not re-admit the command                                     |
| Log           | append queue item; send now/promote queue item; queue drain started                                                                                                                  |
| Network/SSE   | A new model request appears only after send-now                                                                                                                                      |
| Files         | Before consumption, session history has no “再补充” user turn; after consumption it does                                                                                             |
| Artifact      | Queue-order screenshots, protocol frames; pass verdict rests on queue item id order                                                                                                  |

### MVP-06b Running guide-mode steering message retained

Catalog: M06a, M06b, M06c

| Layer         | Assertion                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | Initial settings are explicitly `zcodeInteractionBehavior=guide`; with `running, queue=0`, send more plain text; the steering message shows as a `turn-steer` queue item or projects as a user message; after a short wait it must not disappear from both places |
| Runtime/Store | Selected provider is `glm`; local queue=0 before send; the steer item carries `turnSteer.status=submitting/queued`; if the runtime terminal state arrives first, strip turnSteer back into the local queue instead of removing the message                        |
| Protocol      | Guide mode still sends `sendText`; the CLI projects it as guide input per `inputRouting`/follow-up mode, without creating a separate plain turn; when guide conditions are not met, the CLI queue owns it, no renderer-local queue fallback                       |
| Log           | agent-side steer queued / drained / rejected / fallback recorded; on out-of-order events, correlate back to the steer item via pendingInputId/messageId                                                                                                           |
| Network/SSE   | The steering message must not create its own plain model request; if drained, follow-up content joins the current turn; if fallen back, a later queue drain sends a plain request                                                                                 |
| Files         | After drain, session history contains a guided user turn; before drain, the queue snapshot keeps the steering text                                                                                                                                                |
| Artifact      | Settings snapshot, queue item `data-kind=turn-steer` / guided user message after send, queue/history after settling; pass verdict anchored on both marker and queue item id                                                                                       |

### MVP-06c Running-queue send-now follow-up matrix

Catalog: M07a–M07h

| Case | Assertion                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M07a | `running + queue text + send-now on head`: the head text becomes the next active input after stop; the message enters user history; no duplicate request                     |
| M07b | `running + queue text + send-now off-head`: the clicked item is promoted and consumed; untouched items keep relative order; no message lost                                  |
| M07c | `running + queued /goal + send-now`: the goal item is consumed with goal semantics and updates target; never sent as plain text or swallowed                                 |
| M07d | `send-now while the active turn is in a tool call / approval window`: tool/approval routing stays with the old turn; preemption only affects queue drain                     |
| M07e | `send-now when the stop terminal event is late`: the late terminal event can only close the old active input; it must not overwrite the new message, queue, or activeInputId |
| M07f | `send-now with missing activeInputId via desktop fallback`: fallback logs are visible; the clicked item still enters the next turn; never silently skipped                   |
| M07g | `send-now clicked twice quickly`: send-now is idempotent; the same item is not sent twice; untouched items are not deleted                                                   |
| M07h | `send-now after switching models while running`: old in-flight requests unchanged; the consumed queue item uses the latest session model/thought level                       |

### MVP-07 Edit user query preserves queue

Catalog: D03

| Layer         | Assertion                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| UI            | With `completed(interrupted), queue>0`, edit any historical user query and submit; the session reruns; the queue keeps its content |
| Runtime/Store | After edit, `phase=running`; queue content, order, and `autoDrain=false` preserved                                                 |
| Protocol      | rewind/edit requests and the follow-up send appear; no queue clear                                                                 |
| Log           | rewind accepted; queue preserved                                                                                                   |
| Network/SSE   | A new model request for the edit rerun appears                                                                                     |
| Files         | Snapshot active history switches to the new branch; queue snapshot unchanged                                                       |
| Artifact      | History screenshots before/after edit, queue snapshot diff; pass verdict rests on message id, queue item id, and snapshot diff     |

### MVP-08 Fork stable assistant without copying queue

Catalog: E07/K08

| Layer         | Assertion                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | The fork point is an already-stable `completed(success)` assistant in the parent session; even with a held queue, forking enters or creates the fork session; the parent queue is kept; the new session queue is empty |
| Runtime/Store | Parent queue unchanged; the fork session has a new `sessionId`, `queue.length=0`                                                                                                                                       |
| Protocol      | `session/fork` appears targeting the assistant message; no queue-copying command                                                                                                                                       |
| Log           | fork accepted, logging parentSessionId, forkedSessionId, targetMessageId                                                                                                                                               |
| Files         | Fork session history contains only content before the fork point; no parent queued prompt                                                                                                                              |
| Artifact      | Parent queue screenshot, new-session empty-queue screenshot; failure review only                                                                                                                                       |

### MVP-09 Manual compact coexists with held queue

Catalog: F03, F08

| Layer         | Assertion                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | With `completed, queue>0, autoDrain=false`, run manual compact; a compact started timeline appears; on success the same timeline updates to success; the queue is kept and not auto-consumed |
| Runtime/Store | `origin=manual` while compacting; `phase=completed(success)` after; queue unchanged; `autoDrain=false`                                                                                       |
| Protocol      | One `session/compact`; no automatic `session/send` for queue items                                                                                                                           |
| Log           | manual compact started/completed; no queue drain started                                                                                                                                     |
| Network/SSE   | A compact model request appears; no queue-consumption model request                                                                                                                          |
| Files         | Session snapshot has a compact summary or marker; queue snapshot unchanged                                                                                                                   |
| Artifact      | Compact started/success timeline screenshots, queue-retained screenshot; pass verdict rests on the compact marker test id and queue item id                                                  |

### MVP-10 Auto compact success continues pendingAction

Catalog: G01, G10

| Layer         | Assertion                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | On a plain send, the system decides auto compact is needed; the auto compact timeline shows first; after compact succeeds, the user message appears and generation starts |
| Runtime/Store | After `compacting(origin=auto)`, back to `running` with the pendingAction; the pendingAction is neither lost nor duplicated                                               |
| Protocol      | Compact requests happen first; the pendingAction's `session/send` or `session/goal` happens only after success                                                            |
| Log           | auto compact attempt 1 success; continue pendingAction                                                                                                                    |
| Network/SSE   | Compact SSE ends first; the pendingAction model request then starts                                                                                                       |
| Files         | In the snapshot the compact marker precedes the pendingAction user turn; no duplicate user turn                                                                           |
| Artifact      | Timeline-order screenshots, protocol/network timeline; pass verdict rests on marker/message DOM order and the protocol/network timeline                                   |

## Required test capabilities

The minimal capabilities to run the MVP probes; not a full automation platform.

| Capability              | Purpose                                                  | MVP requirement                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stable UI selectors     | WDIO finds elements without text/CSS/screenshot guessing | Fill queue, message, compact marker, fork, edit, toast, model selector test ids per [conversation-session-ui-testid-contract.md](./conversation-session-ui-testid-contract.md) |
| Protocol capture        | Verify commands fired and their order                    | Each request/response written to `protocol-frames.ndjson`                                                                                                                      |
| Mock provider/SSE       | Control running, stop, compact, auto compact             | Support token delay, failure, three compact retries, recovery to success                                                                                                       |
| Session snapshot export | Verify history, queue, goal, model settings              | JSON export at case milestones                                                                                                                                                 |
| Log correlation         | Join UI, service, agent, protocol                        | All logs carry `caseId/runId/sessionId/inputId`                                                                                                                                |
| Artifact collector      | Post-failure review                                      | Collect screenshots, video, logs, protocol frames, network frames, snapshots at test end; screenshots do not participate in verdicts                                           |

## Execution order

1. First run MVP-01 to MVP-03 probes manually, proving UI + protocol + log + snapshot collection works.
2. Then wire queue, stop, edit, fork, compact cases.
3. Auto compact last — it needs mock provider support for threshold triggers, retries, and timeline ordering.
4. Once MVP is stable, map the remaining accepted catalog cases onto the same probe template in batches.

## Todo156 start follow-ups

The acceptance boundary uses the final decisions of [Todo156 SF-01–SF-19](working-memory/provider-refactor/steps/todo-156-start-plan-followup-final-decisions.md). `conversation-session-start-plan-independent` still needs manual-review cases for SF-01/02/08/10/13: Start ring under a paid connection, team dropdown selection, plan names, and the close/confirm/not-now actions on the first side-panel item with parameters — asserting real model requests and that the main input draft is unchanged. The remaining cache-state combinations are covered by `startPlanRecommendationFreshness`, `providerFamilyConnectionVisibility`, and status-card tests; desktop/mobile viewports and light/dark themes go through browser visual cases. This note is not a claim of CI promotion or full SF E2E coverage.
