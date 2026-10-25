# Agent Query ID Design

`sessionId` identifies the session, `traceId` the technical observation chain, `inputId` UI stop/queue/finalization. `queryId` is the user-semantic attribution field: all model requests between one real user input being consumed and the next belong to the same query.

Semantics — one real user input creates one queryId:

```text
user message/query A
  -> model request 1, x-query-id=A
  -> tool calls
  -> tool results
  -> model request 2, x-query-id=A
  -> retry/recovery request, x-query-id=A
until next consumed user message/query B
```

Rules:

- Plain prompts, queued prompt drains, and turn steers all carry a queryId. Multiple model requests, tool-loop follow-ups, and stream retries within one user input reuse it.
- A steer is a new real user input — injected after a tool result and before the next model request, never modifying a running model request — and must have its own queryId. Consecutive steers are independent queries and never merge.
- The model adapter writes `x-query-id` into `generateText` / `streamText` request headers, read from the request traceContext/metadata.
- Auxiliary requests (title, compact, goal verifier) never fabricate a user query: they only inherit a queryId already on the traceContext and may be empty.
- Legacy calls without queryId fall back to `inputId` (`session/send` and `session/steer`: `queryId ?? inputId`; adapter writes `x-query-id` only when the status context has one).

Propagation:

- UI creates `inputId` and `queryId` together for normal input; renderer-local queued prompts and the web remote replayable host command queue persist the queryId and reuse it on drain/actual send.
- `session/send` and `session/steer` take an optional `queryId` (main-path callers must pass it); `executeTurn` writes it into the turn traceContext; `steerTurn` stores it on the pending input and switches the next model request's traceContext to it.

Non-goals: queryId does not replace `traceId`/`sessionId`/`inputId`; UI finalization, stop routing, and task owner command `inputId` semantics unchanged.

Edge cases: a drained steer's queryId cannot be retracted as "pending input withdrawal" (it is already in model requests); a steer still pending may later get a retraction protocol keyed by `pendingInputId/queryId`; no user message may be inserted between a tool call and its tool result.
