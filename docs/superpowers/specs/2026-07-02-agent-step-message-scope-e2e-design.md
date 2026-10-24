# Agent Step Message Scope E2E Design

Status: fix implemented; this is a historical E2E design record. The original formal E2E moved to `manual-review/pending` with the V4 test migration; current automated coverage facts live in `docs/testing/conversation-session-e2e-coverage-matrix.md`.

Change: fix `message_completion` wrongly accumulating the whole session history, locked by a failure-reproducing E2E on message scope. No new UI behavior; verifies the `/report` `agent_trace` payload. Code owners: `packages/ui/src/lib/messageTelemetry.ts`, `packages/ui/src/hooks/useZCodeChat.ts`, `packages/ui/src/hooks/taskStreamEventHandlers.ts`. Out of scope: queue/stop, cross-session, mobile replayable recovery protocol, real telemetry server ingestion.

User rulings: (1) cover only the history-accumulation defect (A), not also unclosed active tool steps — verify only `agent_step_cnt` message scope; (2) reconcile from local observable evidence (no external telemetry server); (3) since the production renderer disables local logs, use Electron `net.fetch` mock call history as equivalent, stronger local evidence — reconcile the main process's actual HTTP transport inputs rather than re-enabling production logs.

Boundaries:

| Boundary | Decision | Includes | Excludes / prunes |
| --- | --- | --- | --- |
| Client chain | `desktop-continuous` | desktop renderer normal session stream | `web-remote-replayable`, snapshot/gap recovery |
| Session shape | two consecutive turns in one session | the second turn must see the first turn's history | cross-session, fork/edit/compact |
| Step shape | one plain generation step per turn | deterministic plain-text replay | reasoning, tool call, permission/elicitation |
| Reconciliation key | `talkId + messageId` | one completion and its per-step events | talkId-only aggregation |
| Evidence | Electron main-process telemetry fetch call arguments | final HTTP body `agent_step` / `message_completion` | external telemetry server persistence |

State owners: active prompt telemetry — UI `activePromptTelemetryByTask` (completion `messageId`); agent step lifecycle — UI `agentStepTelemetryByTask` (per `talkId + messageId` `agent_step` payloads); session message history — agent runtime/session + UI projection (turn 1 complete before turn 2 sends; same `talkId`); telemetry transport input — renderer `reportAppTelemetryEvent` → main `createDesktopTelemetryFetch(net)`; E2E observation — WDIO Electron service `browser.electron.mock("net", "fetch")` call history.

## Production fix design

`message_completion` and per-item `agent_step` share one active-prompt lifecycle:

1. `activatePromptTelemetry()` initializes the turn's step aggregation and `loop_index` from `1` when activating a user message.
2. Each step accumulates exactly once at `finalizeAgentStep()`; therefore `agent_step_cnt` equals the count of `agent_step` events actually reported for the current `message_id`.
3. A closed `tool_call` step also accumulates `tool_call_total`; failed/timed-out tools accumulate `tool_call_failed`, keeping the turn's first tool error for completion failure fallback.
4. `finalizePromptTelemetry()` reads only the active prompt's aggregates — it never scans the session's full `taskMessages`.
5. `FinalizePromptTelemetryInput.taskMessages` and two historical scan helpers are deleted; callers no longer read the message store for completion counts.

`PromptTelemetryState` holds this state; `AgentStepTelemetryState` still owns only the active step and `loop_index`. Counting happens at the single step-close exit, so completion aggregation and the actual per-step events stay same-source instead of inferring streaming lifecycle from final message projections.

Counting invariants:

- For any `talk_id + message_id`, `agent_step_cnt` equals the number of `agent_step` events produced.
- `loop_index` for one message increments consecutively from `1`; a newly activated prompt restarts at `1`.
- `tool_call_total` equals the terminal `step_type=tool_call` steps in the current message; `tool_call_failed` equals those with `status=fail/timeout`.
- No step or tool from a previous message may enter the next message's completion.

Compatibility: the fix changes only the UI telemetry aggregation source — stream, snapshot, queue, owner, relay, host, and protocol untouched. Desktop continuous and web remote replayable each aggregate by their own activated prompt; replayable recovery semantics do not leak into the desktop path. Out-of-order tool events keep the existing fallback-step and permission-wait attribution; counting happens only when that fallback step finally closes.

## Case selection

| ID | Setup | Event | Expected | Status | Reason |
| --- | --- | --- | --- | --- | --- |
| R01 | same desktop session, turn 1 complete | turn 2 plain-text completes | turn 2 `agent_step_cnt` = 1 | accepted | minimal stable production-defect reproduction |
| R02 | turn 2 includes tools | completion | full tool/reasoning/generation reconciliation | pruned | later step-type coverage, not the minimal A boundary |
| R03 | two different sessions, one turn each | both complete | independent per-session counts | pruned | never hits the history-accumulation condition |
| R04 | mobile replayable restores history then sends | turn 2 completes | recovery chain still counts per message | ignored | cross-client semantics planned separately |
| R05 | stop/error while running | completion closes | interrupted step reconciliation | ignored | fault/terminal lifecycle planned separately |

## Accepted case R01: same-session second-turn step isolation

Setup: `prepareConversationE2E()` starts an isolated desktop app; two prompts with stable `E2E_AGENT_STEP_MESSAGE_SCOPE_*` markers match the case-local fixture; each fixture turn returns one plain-text content block, deterministically one `generation` step per turn.

Action: send turn 1, wait `idle`; send turn 2, wait `idle`; before sending, mock Electron `net.fetch` with a success response, then parse the telemetry endpoint request body from mock call history.

Assertions: both completions share `talkId` with different `messageId`s; turn 2 has exactly one `agent_step` for that `talkId + messageId`, type `generation`, `loop_index=1`; turn 2's `message_completion.agent_step_cnt` must be `"1"` (under the defect it read `"2"` — the test failed with an explicit count mismatch).

Evidence layers: UI/session — both turns return to `idle`, turn 2 reuses turn 1's session; provider — both markers hit the case-local replay; telemetry/transport — per-`talk_id + message_id` reconciliation of per-step and completion in the final HTTP body.

## E2E handoff notes

- Spec: `packages/desktop/test/e2e/conversation-session/conversation-session-agent-step-message-scope.test.ts`; fixture `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-agent-step-message-scope.json`; timing `fast-text`; both marker requests classified `main`; synthetic (manifest must record `syntheticReason`); no file-system fixture.
- Promoted to formal case by manual review; post-fix status `covered`; GREEN artifact `desktop-e2e-20260703-090147-683`; Docker preset admission follows the separate admission process.
- Review risk: telemetry reporting is asynchronous — poll mock calls, never fixed sleeps; the mock replaces only Electron `net.fetch` (provider replay goes through the agent's own HTTP chain).
