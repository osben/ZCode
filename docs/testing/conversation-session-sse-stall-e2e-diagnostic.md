# Conversation Session SSE Stall E2E Diagnostic

## Goal and boundary

Defines a set of Desktop real-chain diagnostic E2E cases that use a local replay provider to stop emitting events at different SSE semantic boundaries and observe idle timeout, automatic recovery, UI projection, network requests and tool side effects.

The run chain is not an adapter/core unit test but:

```text
Desktop renderer (desktop-continuous)
  -> window-scoped Local Host
    -> ZCode CLI runtime
      -> provider adapter
        -> local replay HTTP/SSE server

first request:  event...event...<cut point>........(silence > idle timeout)
                                                   |
                                                   v
                                      adapter/core recovery boundary
                                                   |
second request:                          provider request -> success SSE
                                                   |
                                                   v
                         runtime event -> Host -> renderer -> V4 timeline
```

This round verifies only the desktop local `desktop-continuous` main chain; it does not change the mobile `/remote` `web-remote-replayable` gap/snapshot recovery boundary and adds no relay/main business state. Remote workspace, queue/Stop races, restart recovery, retry exhaustion and side-effecting tools are not crossed with this diagnostic matrix.

## Why it is a diagnostic

The final product contract of the top-level `S02/S03/S06` is still `decision-needed`: e.g. whether a partial text should finally be kept, collapsed or marked as an error, whether retry exhaustion is failed or interrupted, and how buttons and the queue are handled, are undecided. So this spec sits in `manual-review/pending`:

- Hard assertions cover only invariants that are confirmed or required for safety.
- Undecided UI/terminal states are only sampled, so the current implementation is not mistaken for the product contract.
- The facts observed are filled back into the "Measured results" below for later product rulings.
- A pending diagnostic is not counted as top-level fault `covered`.

The confirmed `S02-R1` still holds: a retryable reasoning-only stream break or idle timeout should discard the incomplete reasoning tail and recover from a safe anchor with a new assistant identity, without changing the queue, Stop or delivery boundary.

## Cut-point matrix

| Case      | First SSE cutoff position                                                                              | Semantic boundary                                      | Hard assertions                                                                                                                                      | Diagnostic sampling                                                      |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| SSE-ST-01 | Only `message_start`                                                                                   | retry-safe prelude                                     | Finally succeeds; exactly 2 main requests; no tool call                                                                                              | `canStop/runtimeStatus/timeline` during the stall; row/timeline after closing |
| SSE-ST-02 | Inside the thinking block, a `thinking_delta` already received                                        | reasoning-only visible boundary                        | Finally succeeds; exactly 2 main requests; the incomplete reasoning does not enter the recovery request history; no tool call                         | Whether the thinking marker is visible in the running state and how it is projected after recovery |
| SSE-ST-03 | Inside the text block, a `text_delta` already received                                                 | user-visible text boundary                             | The partial marker once appeared in the live UI; the stall must exit within a bound; if recovery occurs it finally succeeds; no tool call            | Whether the partial is kept/collapsed/removed after recovery in the current behavior |
| SSE-ST-04 | Inside the tool block, `input_json_delta` is unclosed JSON                                             | tool not yet committed                                 | The stall must exit within a bound; that tool is not executed; if recovery occurs the request contains no incomplete tool call                       | Whether the unclosed tool block enters the UI/store                      |
| SSE-ST-05 | The tool block has `content_block_stop` but no `message_delta/message_stop`                            | committed tool block / uncommitted message boundary    | After `content_block_stop` the tool executes once; the recovery request carries the successful `tool_result`; the same toolCallId is not executed twice | UI/runtime projection of the complete tool block after recovery          |
| SSE-ST-06 | The first stream ended normally and the read-only `Read` already executed successfully; the next model continuation stops sending after `message_start` | post-tool continuation boundary | The tool executes once; the three main requests in order are tool call, stalled continuation, recovered continuation; the latter two both carry the same successful `tool_result` | loading/runtime projection of a stall after the tool completes           |

Every stalled response schedules a sentinel event later than the E2E idle timeout after the cutoff. The client should first cancel that attempt because of the idle timeout; the next fixture immediately returns a unique completion marker. The E2E worker shortens the model stream idle timeout to `1000ms` for this spec only, not in production configuration and not spread to other workers.

## Evidence and judgement

Each case must collect at the same time:

| Layer         | Evidence                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| UI            | cutoff marker, `canStop`, timeline text, row count; the recovery-completion marker and idle state     |
| Network       | main request sequence, `fixtureId/status` and the message history of the recovery request             |
| Runtime/store | snapshots of `runtimeStatus/state/activeInputId` during the stall and after completion               |
| Tool          | the toolCallId count in DOM/store; the `tool_result` and `isError` the provider actually received    |

Failure criteria: no real recovery provider request was triggered, recovery cannot complete, the recovery request is polluted by an old partial, an uncommitted tool was executed, a committed tool was not executed, a successfully executed tool was executed again, or the tool result did not become the recovery anchor. How the current UI shows a discarded partial and whether it finally shows interrupted history is only recorded as a fact and does not fail the diagnostic.

Replay capture backfills `responseEvents` only when the response handler ends normally. The stalled attempts here are first aborted by the client idle watchdog, so that record in the capture stays `pending` with `responseEventCount=0`; this does not mean the cutoff event did not arrive. Whether the cutoff arrived is proven jointly by the fixtureId, the live UI cutoff marker, the runtime streaming state and the Agent streaming log, and the new provider request that follows proves the watchdog cancelled the old attempt and entered recovery.

## Fixture and spec

- provider fixture: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-sse-stall-diagnostic.json`
- case manifest: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-sse-stall-diagnostic.json`
- pending spec: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-sse-stall-diagnostic.test.ts`

Run command:

```bash
desktop_dir="$PWD/packages/desktop"
E2E_PROVIDER_REPLAY_FIXTURE_PATH="$desktop_dir/test/e2e/fixtures/upstream/common.json,$desktop_dir/test/e2e/fixtures/upstream/conversation-session/conversation-session-sse-stall-diagnostic.json" \
  pnpm --filter @zcode/desktop test:e2e:serial -- \
  --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-sse-stall-diagnostic.test.ts
```

## Measured results

A real WDIO run on macOS on 2026-08-27 passed 6/6. The test worker's base idle timeout was `1000ms` and each stalled fixture's sentinel event was at `5000ms`; all six cases entered recovery before the sentinel arrived and finally returned to idle. The observed time from the watchdog to the recovery request/terminal was about `0.9s~2.8s`; the spread includes the event cut point, runtime scheduling and retry backoff and must not be read as a production SLA.

| Case      | Facts measured on the current implementation                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSE-ST-01 | With only `message_start` received the UI stays streaming/Stoppable; after the idle timeout a 2nd model request is issued from the user's safe anchor and succeeds, finally returning to idle.                           |
| SSE-ST-02 | The thinking partial is visible in the live UI; the recovery request does not carry that incomplete reasoning, the partial is no longer shown after completion, and the 2nd model request succeeds.                       |
| SSE-ST-03 | The text partial is visible in the live UI; the current implementation still issues a 2nd model request automatically and it succeeds, and the partial is no longer shown after completion. This discarding behavior is still a product item awaiting a ruling. |
| SSE-ST-04 | The unclosed `input_json_delta` is not committed, `Read` is not executed, and the recovery request does not carry that tool call; the 2nd model request succeeds.                                                          |
| SSE-ST-05 | After the tool `content_block_stop` is received, even without `message_delta/message_stop`, `Read` still executes at once and succeeds; after the idle timeout the 2nd request carries the successful `tool_result` and it is not executed again. |
| SSE-ST-06 | The first model stream committed normally and `Read` executed successfully; after the 2nd continuation carrying the successful `tool_result` hung, only the model continuation was retried as the 3rd request and the tool was not executed again. |

At every cut point the stall snapshot is `canStop=true/state=streaming` and after completion `canStop=false/state=idle`. The Agent log of SSE-ST-05 further proves that `content_block_stop` is the actual tool-commit boundary: the same toolCallId appears only once as `tool.call.started/completed`, and the successful result then becomes the stream recovery anchor.

The production default base idle timeout is `600000ms`, the idle timeout of the first recovery request is `630000ms`, and it increases by `30000ms` each time afterwards. This E2E only shortens the base value of the current worker, verifying the state machine and the side-effect boundary, and does not mean production recovers after 1 second.
