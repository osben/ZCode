# Windows CUA Helper Two-Stage Readiness

## Objectives

Windows named pipes lack the atomic handoff semantics of `.pending -> final` that Unix sockets provide. During the Helper cold start, the Host therefore needs to obtain a transport tuple that has already completed authentication binding before the functional initialization is complete, so that the Agent can immediately start the `zcode-cua` MCP; while the functional layer is still initializing, tool calls are responded to by the broker with a retryable `broker_unavailable` to indicate warming-up.

## Status and Timeline

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

`transport_ready` only means that the named pipe has been bound and bearer-token authenticated by the current subprocess; it does not mean that UIA, screenshot, or input capabilities are ready; `ready` still means a complete health probe has succeeded. The old Helper only sending `ready` is treated by the Host as transport-ready as well, maintaining backward compatibility.

## Constraints

- The Host only accepts the exact child PID it forked and the pipe name it minted; it publishes the tuple to the Agent only after receiving `transport_ready`.
- Windows does not reuse old pipes, nor fabricate atomic switches by closing and re-binding; when the Helper fails or exits, the published tuple enters the existing recovery/recycle barrier.
- The Agent's MCP process remains alive; `broker_unavailable` is only used for warm-up retries on un-sent requests; action requests still obey delivery-state, and do not automatically replay potentially-sent side effects.
- Full `ready`/health failures still follow the existing cleanup paths; this scheme only eliminates stranded Agents caused by the 1-second window during normal cold startup.
