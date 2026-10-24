# ZCT-2096089929570893824 Local Acceptance Record

> Historical source: staging `35ba050592` (2026-09-07). This keeps the original author's acceptance facts of that time; it is not the current acceptance of the Todo103 integrated version and does not widen the scope of this round's fixes.
> The bot re-connection and new evidence of this round are in section 20 of `../working-memory/provider-refactor/research/todo103-staging-integration-ledger.md`.

Date: 2026-09-07. Environment: macOS arm64, ZCode Dev with local production-environment config, Ryan Bob Feishu direct chat, BigModel Coding Plan / GLM-5.3-Flash. Operated through Computer Use; no test message was sent to a group chat.

## Fix scope

- `65ad97769b`: a deleted bot's active task is no longer reused.
- `3c53fe008f`: keeps the Feishu send error's business code and log ID, shows the delivery failure separately from connection status, and clears it after a successful send.
- `8e7fe75d0f`: the strict protocol schema accepts the optional `scheduled.assistantMessageId` that the CLI already emits.

Direct-chat sending keeps open_id and does not switch to chat_id on failure; group chats remain unsupported. Existing cards are updated through message_id.

## Live results

| Check                        | Result                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CUA60ROUND long task         | 60 serial tool calls, each waiting 20 s and computing a checksum; all 60 start and completion markers present                                                  |
| Long task actual duration    | Model trace 04:35:21.232Z to 05:02:31.568Z, 27 min 10 s; the model estimate on the card is not a timing basis                                                  |
| Long task Feishu final state | After unlock, Computer Use confirmed the round-60 result, CUA60ROUNDDONE and Completed all visible                                                             |
| Latest build regression      | Old process exited normally, dev build containing 8e7fe75d0f rebuilt and started; CUAFIX1405 six-round computation fully done, desktop shows Worked for 1m 14s |
| Protocol runtime             | CLI log confirms 6 scheduled events carrying assistantMessageId; the new process log has 0 invalid-session-event drop warnings                                 |
| Follow-up message            | Feishu and desktop both show CUAFIXFOLLOWUPOK, Completed on Feishu                                                                                             |
| Connection status            | Bots -> Ryan Bob shows Feishu WebSocket is running / Connected, no delivery error prompt                                                                       |

Long-task session: `sess_59ef620c-a6c3-4503-a777-ab8395e780aa`. Post-fix regression session: `sess_f5109c02-ffb1-41df-bf0f-b208f9e1c9ef`.

Local screenshots were in `/tmp/zct-closure-evidence/` (long-task final state, post-fix desktop/Feishu results, bot connection status) and the post-fix log at `/tmp/zct-closure-runtime-final.log`. These were temporary local evidence, not portable repo test fixtures.

## Automated evidence and boundaries

- Before the protocol fix, four new combinations failed on the unrecognized assistantMessageId; after the fix protocol/stdio tests pass 74 with 1 skipped by platform condition.
- Typecheck passes; lint has 0 errors and 43 pre-existing warnings.
- The existing BOT-E2E-DF-01 uses a synthetic Feishu business rejection to verify diagnostics, success clearing, open_id sending and that group chats create no task; it must not be read as a reproduction of a real tenant send rejection.
- `Sending messages to users is temporarily unavailable` from Feishu was not observed this time. The client fix and the local normal-path acceptance are done; this does not claim the Feishu-side rejection root cause is gone.
- Not published or merged; Windows/Linux, real mobile devices and the original user tenant are out of scope. Protocol tests cover field validation for both deliveryKind values and are not a full cross-client recovery test.
