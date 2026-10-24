# BG26 429 Failure Projection Isolation Design

## Goal

Stabilize BG26's case-local synthetic `429` replay. It verifies that the original provider error reaches the
background subagent failed notification, the failure hover and snapshot restore. BG26 does not add or change
any product-side main-model retry, queue or stream-recovery semantics.

## Evidence and root cause

In the early failing run `desktop-e2e-20260721-110945-241`, child attempts 1-6 reached the replay server and
attempt 7 only logged `model.request.started` / `model.network.started`; the stall point drifted between runs.
Real E2E rejected three experiments: reordering product-side stream cleanup/abort, explicitly closing the 429
response connection, and setting only BG26 retry to 0 (the first physical request still never reached the
replay server). The failure is therefore not in projection, hover, snapshot restore or product error
conversion: BG26 as a projection case inherits both the product default retry and the process-level global
fetch channel, and after the parent request completes a child request on that shared test channel can stall
before the replay server. Lowering retry only narrows the case semantics and does not isolate the unstable
channel.

```text
old chain
  parent title / launch / ACK
    -> process-level global fetch channel
  child 429 (default retry also applies)
    -> some or the first attempt only logs network.started
    -X-> replay server
    -> child has no terminal failed
    -> parent notification never arrives

target chain
  BG26 worker
    -> retry = 0
    -> ZCODE_HTTP_PROXY = current replay server
    -> Node http + per-request ProxyAgent
    -> 1 real 429
    -> child terminal failed
    -> parent failed notification
    -> live hover
    -> snapshot restore after switching tasks
```

## Design

Case-local worker isolation; product network code is unchanged.

1. WDIO `beforeSession` detects BG26 from the current worker specs and sets `ZCODE_MODEL_RETRY_MAX_RETRIES=0`
   for that worker only.
2. After the replay server starts and gets its dynamic port, only the BG26 worker sets `ZCODE_HTTP_PROXY` to
   that server's base URL and clears an explicit `ZCODE_NO_PROXY`. `ProxyAgent` sends absolute-form HTTP URLs,
   which the replay server already supports.
3. Non-BG26 workers and capture mode restore the proxy/no-proxy configuration from before WDIO started, so
   other cases and developer environments are not affected.
4. The BG26 fixture keeps one real `429 AccountRateLimitExceeded`, the original provider message and
   `retry-after: 0`; the retry fixture outside this case's contract is removed.
5. Provider message, status code, child marker, notification matcher and UI/restore assertions are unchanged.

This matches the confirmed BG26 semantics in the conversation case catalog: `429` is only a representative
real failure and does not define main-model retry/queue semantics. Product default retry stays covered by the
adapters focused tests.

## Impact boundary

- Only test infrastructure, the BG26 fixture/manifest and targeted tests change.
- Unchanged: `apps/zcode-cli`, `packages/ui`, `product-projection.ts`, conversation projection, E2E timeouts.
- Desktop `continuous` and mobile `web-remote-replayable` runtime, snapshot and recovery boundaries are
  unchanged.

## Verification

- Worker isolation and replay server focused tests (`8 passed`); BG26 fixture contract (`5 fixtures`).
- Unmodified BG26 passed two consecutive rounds (`desktop-e2e-20260721-123822-673`,
  `desktop-e2e-20260721-124220-804`): 5 complete requests, a single child `429`, Agent log
  `attempt=1/maxAttempts=1/statusCode=429`, then `turn.failed`, `subagent.background.failed` and the parent
  notification request with the original provider message preserved.
