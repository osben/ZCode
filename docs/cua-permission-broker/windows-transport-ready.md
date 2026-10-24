# Windows CUA Helper Two-Stage Readiness

Windows named pipes lack the atomic `.pending -> final` handoff of Unix sockets. During Helper cold start the Host therefore needs a transport tuple that has completed authentication binding before functional initialization completes, so the Agent can start the `zcode-cua` MCP immediately; while the functional layer is still initializing, the broker answers tool calls with a retryable `broker_unavailable` meaning warming-up.

```text
Host                         Helper                         Agent / MCP
 |                            |                               |
 | fork(socket, token)       |                               |
 |--------------------------->| bind + authenticate           |
 |                            |-- transport_ready ----------->|
 |<---------------------------|                               |
 | publish socket/token       | load native + build backend  |
 |--------------------------->|                               |
 |                            |-- ready + broker_info ------->|
 |<---------------------------|                               |
 |                            |                               | tool call
 |                            |<------------------------------|
 |                            | warming_up => broker_unavailable
 |                            |------------------------------>|
```

`transport_ready` only means the named pipe is bound and bearer-token authenticated by the current subprocess, not that UIA, screenshot or input capabilities are ready; `ready` still means a complete health probe succeeded. An old Helper that sends only `ready` is treated by the Host as transport-ready too (backward compatible).

## Constraints

- The Host accepts only the exact child PID it forked and the pipe name it minted, and publishes the tuple to the Agent only after receiving `transport_ready`.
- Windows does not reuse old pipes nor fake atomic switches by closing and re-binding; when the Helper fails or exits, the published tuple enters the existing recovery/recycle barrier.
- The Agent's MCP process stays alive; `broker_unavailable` is used only for warm-up retries of unsent requests; action requests still obey delivery-state and never automatically replay potentially sent side effects.
- Full `ready`/health failures still follow the existing cleanup paths; this scheme only removes stranded Agents caused by the 1-second window during normal cold startup.
