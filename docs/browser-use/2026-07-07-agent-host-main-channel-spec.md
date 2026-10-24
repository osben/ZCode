# agent -> host -> main browser execution channel spec (T4)

> Status: implemented.
> Parent: `2026-07-07-browser-use-cdp-node-repl-spec.md`; depends on the T3 `BrowserControlPort` and the `interaction/browserExecute` protocol.
> Scope: the three-leg channel `BrowserControlPort.execute` (agent) -> ZCode Protocol -> host router -> parentPort -> main. Main-side CDP execution is T5; T4 returns a stub or passes through to an injectable main handler.

## 1. Three-leg path

```
agent: BrowserControlPort.execute(cmd)   [ProtocolBrowserControlBroker]
  -> context.requestClient("interaction/browserExecute", {requestId,sessionId,command}, resultSchema)
      | stdio JSON-RPC reverse request
host: zcodeAgentService client.onRequest case interactionBrowserExecute
  -> validate params -> browserControlMainBridge.execute({sessionId,command}) -> client.respondResult/respondError
  (pure RPC relay: no emitSessionEvent, no pending sessionEvent; unlike permission)
      | parentPort.postMessage(BrowserExecuteRequest{requestId,payload}) + pending map
main: desktopHostProcess child.on("message") case BrowserExecuteRequest
  -> browserCommandExecutor.execute(...)  [T5; T4 uses an injectable executor]
  -> child.postMessage(BrowserExecuteResult{requestId,ok,result|error})
      | host pending map resolve
```

## 2. Leg A: agent broker

- File: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/browser-control-broker.ts`. `createProtocolBrowserControlBroker(context)` returns a `BrowserControlPort` whose `execute({ sessionId, command })` calls `context.requestClient(zcodeProtocolMethods.interactionBrowserExecute, { requestId: randomUUID(), sessionId, command }, zcodeBrowserExecuteResultSchema)`.
- Injection: in `server-operations.ts`, the options object of `createWorkspaceZCodeApp(context, workspace, { ... })` gets `browserControlPort: createProtocolBrowserControlBroker(context)` next to `permissionBroker: createProtocolInteractionBroker(context)`; `createWorkspaceZCodeApp` already spreads `...options` into createApp (same as `providerRuntimeHeadersPort`).

## 3. Leg B: host router and host <-> main bridge

Host router (`packages/services/src/zcode-agent/zcodeAgentService.ts`, `onRequest`): a case for `zcodeProtocolMethods.interactionBrowserExecute` before the final `respondError(-32601)`:

- `zcodeBrowserExecuteParamsSchema.safeParse(request.params)`; on failure `respondError(-32602)`.
- Call the injected optional `browserControlMainBridge.execute({sessionId, command})`; success -> `client.respondResult(request.id, result)`; exception -> `client.respondError(request.id, {code:-32000,message})`.
- Never `emitSessionEvent`, never enter the pending sessionEvent map (pure RPC relay, different from the UI-blocking permission semantics).
- Bridge absent (non-desktop / remote control without main) -> structured `{ok:false, error:{code:"backend_unavailable"}}`, not a throw, so the model can read it.
- `browserControlMainBridge` is an optional dependency of `createZCodeAgentService` (`ZCodeAgentServiceDeps`), passed by the desktop host wiring.

Host <-> main bridge (`packages/desktop/src/host/browserControlMainBridge.ts`, or inside host/index.ts), modeled on `createFullFeedbackLogArchiveViaMain`:

- `pendingBrowserExecute = Map<requestId,{resolve,reject,timer}>`; `execute(payload)` posts `{type:HostResponseTypes.BrowserExecuteRequest, requestId, payload}` via `parentPort.postMessage` with a timeout (default 30 s; navigate/screenshot may be long).
- `requestId` is the correlation key of the pending Promise. If the Map already holds the ID, return `duplicate_request_id` immediately and never overwrite; this is not relaxed per session/scope because the result reply carries only the bare requestId.
- Timeout, send exception and result delivery may only compare-and-delete the `PendingEntry` they captured, never delete the same key unconditionally.
- Main replies `HostMessageTypes.BrowserExecuteResult{requestId, ok, result, error}`; host `parentPort.on("message")` dispatches resolve/reject (merged into the existing message dispatch in host/index.ts).
- `channels.ts`: `HostResponseTypes.BrowserExecuteRequest = "browser-execute-request"`, `HostMessageTypes.BrowserExecuteResult = "browser-execute-result"`.

## 4. Leg C: main receive (T4 placeholder, T5 executor)

`packages/desktop/src/main/desktopHostProcess.ts` `child.on("message")` handles `BrowserExecuteRequest`: T4 calls an injected `browserCommandExecutor?.execute(sessionId, command)`, and when absent returns `{ok:false,error:{code:"backend_unavailable",message:"browser executor not ready"}}`; then `child.postMessage({type:HostMessageTypes.BrowserExecuteResult, requestId, ...})`. T5 provides the real executor (WebContentsView + CDP).

## 5. Verification (T4 unit tests, logic layer, no Electron)

- Agent broker: fake `requestClient` records method+params and returns a preset result; `execute(cmd)` emits `interaction/browserExecute` with a requestId, passes command through and returns the result unchanged.
- Host router: fake client + fake bridge; browserExecute hits `bridge.execute` and calls `respondResult`; invalid params -> `respondError(-32602)`; absent bridge -> `backend_unavailable`.
- Host <-> main bridge: fake parentPort; `execute` resolves; timeout rejects / structured timeout; requestId correlation is correct (two concurrent calls do not cross); duplicate requestIds, same-scope and cross-scope, fail immediately without affecting the original entry.

## 6. Boundaries

- browser/execute does not change desktop-continuous / web-remote-replayable semantics: it is a one-shot agent -> app RPC outside stream/snapshot. Remote control without main gives `backend_unavailable`.
- Single source of truth: params/result are validated with the shared T3 zod schemas (host router side).
