# Host RPC Log Levels

Owner: `packages/desktop/src/host/rpcLogLevel.ts` (`resolveRpcLogLevel`), called from `logRpc` in `packages/desktop/src/host/index.ts`.
Source of the messages: `packages/rpc/src/logging-middleware.ts` (`[rpc:call] <channel>.<command> OK|FAIL (<ms>)`, the error object is the trailing argument).

## Rule

Every RPC FAIL logs at `warn`, except the exemptions below. An exemption lowers one exact, expected failure to `info` (or `debug` for success polling). It must match the RPC name and a failure signal that the caller already treats as normal; a bare `FAIL` match or a wider path/code match is not allowed.

## Exemptions

| RPC (log prefix)                                 | Expected failure signal                               | Level | Why it is expected                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zcode-agent.backgroundBashOutputV4 OK`          | success                                               | debug | Polled about once per second for background shells.                                                                                                                 |
| `voice-dictation.getRuntimeState OK`             | success                                               | debug | Polled about once per second by the composer microphone dot.                                                                                                        |
| `zcode-session.getWorkspaceRuntimeIdentity FAIL` | `code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE`        | info  | Startup handshake before the provider registry syncs.                                                                                                               |
| `zcode-agent.subscribeSessionsIndexV4 FAIL`      | `code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE`       | info  | Renderer probes with `existing-only` before the runtime starts; it resubscribes on the `available` event.                                                           |
| `zcode-agent.conversationWorkflowRunsV4 FAIL`    | message contains `fault.workflowRuns.sessionNotFound` | info  | The workflow-run list is requested right after a session is created, before the host registers its record. The renderer retries (`useWorkflowRunJournalSummaries`). |

## Constraints

- Matching is on the RPC name in the log prefix plus the failure signal. The same signal from another RPC stays at `warn`.
- Errors cross the RPC boundary as messages; the `code` field is only present for the runtime codes above. Match on message text only for the `fault.*` signal.
- Adding an exemption requires a test in `packages/desktop/test/host-rpc-log-level.test.ts` covering the lowered case and at least one neighbouring case that stays at `warn`.
