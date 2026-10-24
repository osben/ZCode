# ZCode Protocol: async model-backed control requests

## Background

The App talks to the `apps/zcode-cli` ZCode Protocol over child-process stdio. The protocol client
treats an ordinary request as a short communication request with a default 30 s timeout; the agent-side
NDJSON transport processes incoming messages serially. If a protocol handler waits synchronously for a
model request, later messages queue behind it and may even block the response of an agent -> app
reverse request.

`session/send` ACKs quickly while the real model turn runs in the background and pushes progress via
session events / `state.updated`. `session/compact` and `prompt/enhance` used to wait synchronously on
model requests and hit the same problems:

- After a model request exceeds the ordinary communication timeout, the host may judge the agent client stale and clean up the process.
- Protocol requests of other sessions in the same workspace are blocked by the serial queue.
- Responses to agent -> app reverse requests (provider runtime headers, permission, user input) can be blocked by a long handler.

## Goals

- The protocol ACK of a model-backed control request does not carry the model lifecycle.
- agent -> app response / error response is never blocked by any long handler.
- stop / cancel control messages can bypass long handlers.
- `session/compact` keeps session-turn semantics; its result continues through the compact timeline and snapshot.
- `prompt/enhance` keeps composer draft-tool semantics; its result goes through an independent job notification and is not written to the session timeline.
- Desktop keeps the direct continuous chain; mobile `/remote` keeps recovering state through the shared-host attachment and the replayable session/task boundary.

## Communication rules

### Transport bypass

The agent-side NDJSON transport must let these messages bypass the serial processing queue: response,
error response, `session/stop`, `prompt/enhance/cancel`. A response / error response is the completion
signal of an existing reverse request and cannot wait for the current request handler; stop / cancel
are control signals that must be able to interrupt background operations.

### `session/compact`

`session/compact` is a session-scoped model operation. Request handling only:

1. Validates the session, revision and active turn.
2. Handles a duplicate compact: if the current active turn is already a compact, return `already_running`.
3. Creates and registers an `AbortController`.
4. Starts the background `/compact` turn.
5. Returns the ACK snapshot quickly.

Terminal states (completed, failed, interrupted, skipped) keep being expressed by the existing compact
timeline event and snapshot. Callers must not treat the return value of `session/compact` as a
terminal result.

The App uses a compact-specific ACK timeout for `session/compact`, not the ordinary 30 s default,
because compact involves the model maintenance state, a large session snapshot and legacy/compatible
agents that may still have a minutes-long processing window; 30 s would misjudge a recoverable
compression as a stale agent. The long timeout protects only the ACK boundary and does not change that
the background compact terminal state is driven by timeline / snapshot.

The recommended result shape keeps the old fields and adds compact metadata:

```ts
{
  response: "",
  snapshot,
  compact: {
    state: "accepted" | "already_running",
    inputId?: string,
    operationId?: string
  }
}
```

`session/stop` still interrupts the background compact through `record.activeAbortController`.

### `prompt/enhance`

`prompt/enhance` is a workspace/session-associated utility model job, not a session turn. The protocol
splits into `prompt/enhance/start`, `prompt/enhance/cancel` and `prompt/enhance/result` (agent -> app
notification).

`start` returns quickly:

```ts
{
  requestId: string,
  accepted: true
}
```

When the background job finishes it sends a notification:

```ts
{
  requestId: string,
  status: "completed" | "failed" | "cancelled",
  enhanced?: string,
  errorMessage?: string
}
```

`prompt/enhance/start` params must carry `requestId` and support an optional `sessionId`. With a
`sessionId` the session's model config and provider runtime headers are used; only without a session
is a temporary app created per workspace, so several sessions of one workspace do not randomly reuse
the first active session's model state.

The UI's "cancel enhance" must call `prompt/enhance/cancel`, not merely invalidate the old result. The
UI still keeps requestId overwrite protection so that after cancel or further user edits an old result
cannot overwrite new input.

## App / Service responsibilities

- `ZCodeAgentService.enhancePrompt()` may keep exposing a Promise to the UI but internally wraps start, the result notification and cancel.
- The service holds the pending prompt enhance job; relay and desktop main only pass through and hold no business state.
- After returning the ACK, `ZCodeSessionService.compactSession()` and the task facade's `compactSession()` do not broadcast a terminal snapshot; the terminal state is driven by session event / snapshot sync.
- The mobile replayable path must not bypass the shared host, nor push prompt enhance job state down into relay/main.

## Verification checklist

- The `/compact` ACK uses the compact-specific long timeout; compression completion is delivered by timeline update.
- During `/compact`, other sessions of the same workspace can read/create/send.
- During `/compact`, `session/stop` can interrupt compression.
- The provider runtime headers response before the compact model request is not blocked by the queue.
- A prompt enhance longer than 30 s does not trigger stale-agent dispose.
- Prompt enhance cancel really aborts the agent-side model request, and an old result does not overwrite later user input.
- With several sessions in one workspace, prompt enhance uses the current session's model config.
- Mobile `/remote` compact state recovers through the replayable snapshot/timeline.

## Reverse-request session routing and termination guarantee (added 2026-09-09)

### Symptom

In the 2026-09-09 user log (`zcode-logs-20260909-035718`, build 3.11.2 / c4d5b5bc), all 8 subagents of
two dwf runs (`dwfrun-920daa62` with 5, `dwfrun-5e8d371f` with 3; provider
`builtin:bigmodel-start-plan`) each emitted one `model.request.started` and then nothing for 80 minutes
until the log export: no completion, no failure, and no `model.stream.stalled` (the 600 s stream idle
timer starts only on the first SSE event, and the request was never sent). The last CLI line of each
subagent was `zcode_protocol.session.require_missing`; the desktop side had 8 matching
`zcode-agent.respondProviderRuntimeHeaders FAIL ... Session is not active: sess_dwf-...`; all 38 same-kind
exchanges of the main session that day were OK.

### Root cause chain

```
actor runtime (before attempt 1)
  -> refreshBeforeModelRequest(sessionId = sess_dwf-...-actor_1_1)
  CLI protocol server -> interaction/requestProviderRuntimeHeaders -> desktop service -> security check -> UI
  UI headers -> desktop service -> updateRuntimeModelConfig(sess_dwf-...)
  desktop service -> requireSession -> sessionUnavailable   (throw happens BEFORE client.respond)
  respond is never sent -> actor waits forever: requestClient has no timeout and abort is the only other exit
  and the admission ticket is already held (admitAttempt runs before resolveModelForAttempt)
```

Two independent defects stacked:

1. **Wrong routing identity.** A child runtime has two identity axes but the code had only one:

   ```
   ledger identity sessionId               routing identity clientSessionId
   |- event persistence / transcript       |- interaction/requestPermission
   |- trace archive                        |- interaction/requestProviderRuntimeHeaders
   '- session store                        '- interaction/requestUserInput
      child runtime = itself                  child runtime = parent (recursively to root)
   ```

   `ProviderRuntimeHeadersPort.refreshBeforeModelRequest` used to take `sessionId` in its input and the
   core call site filled `runtime.sessionId`. Core's built-in subagent swapped it for the parent
   session via a private wrapper (`createSubagentProviderRuntimeHeadersPort`); the dwf actor and the
   legacy workflow child assembly put `appOptions.providerRuntimeHeadersPort` into runtime deps as is,
   so they sent the child's identity. The same drift happened to `permissionBroker`: core wrapped
   `createSubagentInteractionBroker`, the other two did not, so a dwf actor's permission /
   AskUserQuestion would take the same dead path. The existence of the private wrapper was itself the
   signal the interface was wrong: while the call site can choose the sessionId, the Nth child assembly
   point will get it wrong again.

2. **Reverse-request responses were not unconditional.** The desktop `respondProviderRuntimeHeaders`
   performs a side effect first (pushing the runtime model config to that session); when it threw,
   `pending.client.respond(...)` never ran. The 2026-08-16 web remote-control hang (headers request
   stuck in `pendingProviderRuntimeHeaders`) was another trigger of the same class of failure.

### Contracts

**Contract 1: client-facing ports bind the routing identity at construction; call sites pass no sessionId.**

- The runtime-side `ProviderRuntimeHeadersPort.refreshBeforeModelRequest` input has no `sessionId`.
- The workspace-level implementation is still session-parameterized, named `SessionRoutedProviderRuntimeHeadersPort`, and appears only in `ZCodeAppOptions` and the protocol assembly layer.
- The only bridge is `bindProviderRuntimeHeadersPort(port, clientSessionId)`, and binding happens only when create-app assembles the main runtime. By type, an unbound port cannot enter runtime deps, so call sites cannot choose wrong.

**Contract 2: a child runtime's outward ports are minted only by the parent runtime.**

- `AgentRuntime.createChildClientPorts(context)` is the single exit, internally using `deriveChildClientPorts`; `parentSessionId` is filled by the parent runtime itself, not the caller.
- The three child assembly points (core subagent, dwf actor `script-workflow-child-runtime.ts`, legacy `workflow-facade.ts`) all obtain `permissionBroker` and `providerRuntimeHeadersPort` through it and no longer take them from `appOptions` themselves.
- Any depth converges to the root session without extra rules: `providerRuntimeHeadersPort` is already bound with no session parameter, so passing it through is idempotent; `permissionBroker` rewrites `request.sessionId` at each layer, the outer layer (closer to the client) writing last, so the final value is the root; `origin` is the opposite and keeps the innermost existing value so the subagent attribution is not overwritten by outer layers.

**Contract 3: a reverse-request response is sent unconditionally.**

- A failure of the `respondProviderRuntimeHeaders` side effect (runtime model config push) must not swallow the response: on a side-effect exception first `respond({ headersApplied: false, errorMessage })`, then rethrow the original exception to the caller.
- On `headersApplied:false` the CLI throws `ProtocolRequestError(-32031)` through the existing path, so the attempt fails with the real cause instead of hanging forever.
- No requestClient timeout is added here: the official-build security-check interaction may legitimately wait minutes for the user, and a timeout would only replace one guess with another; the request is already cancelled with the run's abort signal, and once the response is guaranteed no second exit is needed.

### Verification checklist

| Assertion                                                                                                   | Coverage                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| dwf actor's headers refresh goes through the parent runtime's bound port, input has no `sessionId`          | `bootstrap/tests/script-workflow-child-runtime.test.ts` (real adapter attempt chain)                                 |
| The parent-minted permission broker carries the parent session identity + subagent origin                   | same                                                                                                                 |
| With two nesting levels `sessionId` converges to the root and `origin` keeps the innermost                  | `core/tests/child-client-ports.test.ts`                                                                              |
| core subagent routing is unchanged (covered by the unified derivation after the private wrapper is deleted) | `core/tests/subagent-explore.test.ts` (including the regression guard "port input must no longer contain sessionId") |
| When the desktop runtime model config push throws, the CLI still receives a response                        | `packages/services/test/zcodeAgentService.providerRegistry.test.ts`                                                  |
| An unbound `SessionRoutedProviderRuntimeHeadersPort` cannot enter runtime deps                              | `pnpm typecheck` (the two types are incompatible; all three child assemblies are inside src)                         |
| legacy workflow child and dwf actor take the same derivation                                                | same call point + types; the facade currently has no test assembly, so no separate case                              |

> **Addendum 2026-09-11 (sync with staging: Contract 1's implementation form changed, Contract 2 unchanged)**
>
> The staging provider refactor (`docs/working-memory/provider-refactor/`) made core's
> `ProviderRuntimeHeadersPort.refreshBeforeModelRequest` input **carry `sessionId` again** (retries of
> the official-build security check also go through it), the main runtime filling `runtime.sessionId`.
> The form "bind at construction, no sessionId in input" no longer holds, and
> `bindProviderRuntimeHeadersPort` and `SessionRoutedProviderRuntimeHeadersPort` were deleted. The
> intent of Contract 1, that call sites cannot choose the wrong routing identity, is now delivered by
> Contract 2's derivation layer: `deriveChildClientPorts` also wraps `providerRuntimeHeadersPort` and
> rewrites the input `sessionId` to the parent session; with multiple nesting layers the outer layer
> writes last so the final value is the root session (same rule as `permissionBroker`). The three child
> assemblies (core subagent, dwf actor, legacy workflow child) still go only through
> `AgentRuntime.createChildClientPorts`. The two verification rows "input has no sessionId" now assert
> `routedSessionId === parent session` (`script-workflow-child-runtime.test.ts`,
> `subagent-explore.test.ts`). For the row "when the desktop runtime model config push throws, the CLI
> still receives a response": staging rewrote `respondProviderRuntimeHeaders` (account auth material
> resolution failure -> `headersApplied: false` + reason, still replying unconditionally); our case for
> the old `updateRuntimeModelConfig` side effect was removed with the old path, and Contract 3 is held
> by the new implementation.

**Contract 4: Browser Use is the only reverse request that carries the ledger identity upstream.**

For `interaction/browserList` / `interaction/browserExecute`, `sessionId` is not a routing identity but
the **tab ownership** of the desktop browser backend
(`docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`; the scope key contains
`sessionId`). The desktop service is a pure relay for these two methods and does not look up a task by
`sessionId`; what must be resolved from the session is only the workspace
(`workspaceKey` / `workspacePath` / `workspaceIdentity` / `remoteSessionId`) filled by the CLI-side
`buildBrowserRequestContext`, plus `clientMode`. So a dwf actor's browser request:

```
actor runtime (sess_dwf-...-actor_2_1)
  | mcp__node_repl__js  _meta.session_id = actor
  v
node_repl broker socket --> ProtocolBrowserControlBroker (one state per server context)
                              | sessions.get(actor) absent
                              | childSessionParents.get(actor) = parent session   <- registered by forChildSession
                              | requireSession(parent) -> workspace / clientMode
                              v
                  interaction/browserExecute { sessionId: actor, workspace...: the parent's }
                              v
                  desktop main: scope = (..., workspaceKey, sessionId=actor, clientMode)
```

- Registration can only come from a port derived by the parent runtime: the child port returned by `BrowserControlPort.forChildSession({childSessionId, parentSessionId})` revokes the registration after `closeSession` emits `{ method: "closeSession", closeTabs: true }`. An unregistered non-client session is always `Session is not active`; the parent is never guessed from the id shape.
- The dwf actor and the core `Agent` subagent get child ports. A dwf actor (`tabOwner: "child"`) closes the browser session on run dispose, including closing tabs; a core subagent uses `tabOwner: "parent"`, the sent `sessionId` is swapped for the parent session (sharing tabs with the current conversation so the panel expands accordingly), the child port's turnEnded / closeSession are not sent to the desktop and closeSession only revokes the registration (`docs/browser-use/2026-07-16-subagent-browser-unavailable-spec.md`). A legacy `Workflow` child has no closing chain and gets none. Details: "Subagent sessions" in `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`.
- Within the same server context `createProtocolBrowserControlBroker` is called twice (the process-level node_repl broker and each app's runtime port). Connection memory (which browsers `turnEnded` / `closeSession` must go to) and child-session registration must both be shared per context: node_repl traffic uses the process-level instance and the lifecycle uses the app instance; stored separately, the app instance never saw the connection and `turnEnded` / `closeSession` never reach the desktop.
