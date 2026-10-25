# Todo 44: Repo Wiki Agent Runtime Headers and Cancellation Closeout

> Status: Completed
>
> Date: 2026-08-28
>
> Source: runtime investigation of Repo Wiki producing nothing for a long time on a MacBook Air

## 1. Symptom and conclusion

After starting Repo Wiki generation for several repositories, the UI stayed "running" with no Catalog, page draft or
final Wiki; the task could fail after nearly an hour with `Wiki model request timeout (900000ms)`. Not a database,
model speed or Wiki projection problem. Evidence: the same account's Team Plan ordinary chat, Session Title and Web
Search all received model SSE; the Repo Wiki Agent finished startup, Provider/Model Readiness and Active Model
creation; no Host Runtime Headers receive log for Repo Wiki requests; no model-service TCP connection from the Repo
Wiki Agent process; no SSE chunk, text delta or tool call; and `draft.json` is not written before Catalog succeeds.
Conclusion: the first Repo Wiki model request was stuck preparing execution-time access material for the account
Provider, before any HTTP was sent.

## 2. Normal model call chain

```text
Repo Wiki Service -- workspace/generateText --> Desktop Local Host / Services
 -- ZCode Protocol over stdio --> repo-wiki Agent Process
 -- Registry -> ModelFactory -> Active Model -> Adapter --> account Provider execution-time access material
 -- interaction/requestProviderRuntimeHeaders (reverse RPC) --> Host Account Credential Service
 -- Runtime Headers response --> Agent Adapter -- HTTP / SSE --> model service
```

API Key Providers get static access material from Personal Provider Config in the Agent; account Providers (Team,
Individual, Start Plan) get execution-time material from the Host account service. Host neither rebuilds the Model
nor forms a second Provider Config; it only answers the reverse Runtime Headers RPC the Agent sends before the formal
model request.

## 3. Confirmed root causes

1. **Repo Wiki Client had no Host Protocol Handlers.** A normal Agent Client runs `wireClient(client, workspace)`,
   which also registers Agent-to-Host reverse RPCs (including `interaction/requestProviderRuntimeHeaders`). Repo Wiki
   uses its own `repoWikiProcessManager` and `getRepoWikiClient()` only did `getClient` then `markReady`, never
   `wireClient`. The Agent's Runtime Headers request was parsed by Host's `ZCodeProtocolClient`, fired to
   `requestEmitter` with 0 listeners, and nobody responded, so the Agent Promise stayed pending.
   `docs/repo-wiki/repo-wiki-agent-lane.md` wrongly said "do not wire notification handlers (Wiki only needs
   request-response)", considering only Host-to-Agent request/response and missing Agent-to-Host reverse requests.
   Lane isolation should isolate process, queue and lifecycle, not cut off Host Protocol capability.
2. **Reverse Runtime Headers requests have no default timeout.** Agent `requestClient()` creates a timer only when
   `options.timeoutMs` is provided, and the Runtime Headers Port passes only the parent model request's
   `AbortSignal`. The Promise ends only on a Host response, the parent AbortSignal, or Protocol connection close.
   The Host-to-Agent Protocol Client's 3-minute default is a different layer; Repo Wiki overrides it to "Wiki
   Deadline + 30s cancel buffer".
3. **`workspace/cancelGenerateText` could not enter the running Agent.** Repo Wiki's single model Deadline is 900s;
   on expiry Host stops waiting locally and sends `workspace/cancelGenerateText` to trigger the AbortController the
   Agent saved for the operation. But the Agent NDJSON Transport processes requests serially and only
   `session/stop` could bypass the in-flight request, so cancel queued behind `generateText`, which waited on the
   AbortSignal, which waited on the cancel handler. Host's cancel RPC timed out after 5s but that best-effort
   timeout is exempt from process reclamation, so the Agent AbortController never fired and the old physical request
   lived on.
4. **Retries amplified one deterministic fault to about an hour.** Repo Wiki default `maxRetries = 3` (first request
   plus three retries) at 15 minutes each, with the old physical request never cancelled, so later cancel and
   generate requests stacked behind the first in-flight request while the Service layer repeatedly ended its local
   wait.

## 4. Decisions

- **Lane isolation does not change Host capability.** Chat Lane and Repo Wiki Lane both have an independent process
  and request queue plus complete Host Protocol Wiring. Every Client produced by `ZCodeAgentProcessManager` that is
  allowed to run a formal Model must install Host Protocol Handlers; Repo Wiki does not copy Account Auth, Runtime
  Headers or Provider resolution logic.
- **Cancel is control plane.** Like `session/stop`, `workspace/cancelGenerateText` must bypass the async wait of the
  ordinary request in front of it once that request has entered its handler and registered its AbortController. Cancel
  must not queue behind completion of the operation it cancels.
- **Parent cancellation is the main deadline boundary.** No arbitrary fixed Runtime Headers timeout to mask the
  problem; Runtime Headers keep inheriting the parent model request `AbortSignal`, provided parent cancellation
  really reaches the Agent. Any independent short deadline for automatic account Headers must be a separate contract
  distinguished by Account Access behavior, not added here.
- **Old physical requests end before a retry starts.** Before any Repo Wiki retry the previous attempt's Agent
  operation must have ended or been explicitly cancel-acknowledged; ending only the Services-local Promise while
  stacking underlying model requests is forbidden. Existing retry covers empty response, invalid JSON, truncated
  output and transient Provider errors; narrowing the retryable set (timeout, auth, config, Protocol errors) follows
  the existing error classification minimally, with no generic Retry Policy abstraction.

## 5. Acceptance

1. **Reverse Runtime Headers:** the Repo Wiki Lane test Client actively issues
   `interaction/requestProviderRuntimeHeaders` and asserts: the Repo Wiki Client has the Host Request Handler
   installed; Host answers with the formal Account Runtime Headers service; the Agent continues the model request
   only after the response; no Host Registry Snapshot, Repo Wiki-specific Provider Config or second auth
   implementation. `getRepoWikiClient()` runs idempotent `wireClient(client, params)` before `markReady` and return
   (keeping the single-install `wiredClients` semantics); the Lane still does not enter Chat's
   `activeClientsByWorkspaceKey` and keeps process isolation and terminal reclamation.
2. **Real Transport cancel** (real `ZCodeProtocolNdjsonConnection`): `generateText` handler started and suspended ->
   send `workspace/cancelGenerateText` -> cancel bypasses the in-flight request -> the operation's AbortSignal fires
   -> the Runtime Headers request rejects -> `generateText` ends and releases the queue. Cancel response is
   `cancelled: true`, the in-flight request ends and later ordinary requests still run. Transport
   `shouldBypassProcessingQueue()` treats `workspace/cancelGenerateText` in the same control-plane boundary as
   `session/stop`, still waiting until the preceding request has entered its handler so cancel cannot beat
   AbortController registration and become a no-op.
3. **Retry concurrency:** Deadline/Retry tests record physical attempt entry, exit and concurrency;
   `maxConcurrentPhysicalRequests === 1`; attempt N is aborted and released before attempt N+1 starts.
4. **Diagnostic trail** (low-frequency lifecycle logs, no Header or credential bodies; per-chunk SSE stays debug):
   Runtime Headers requested; applied / failed; HTTP request started; SSE first chunk received; attempt aborted /
   completed; retry scheduled.
5. **Runtime verification:** an API Key Provider and an Account Provider each get a local Repo Wiki vertical check;
   the Account Provider shows Runtime Headers applied, model-service TCP/HTTP and an SSE first chunk; after stop or
   Deadline no Agent operation lingers and the next generation can start immediately. If HTTP was actually sent and
   the model still fails, use `/v1/messages` network capture; empty captures must not replace root-cause validation
   of the pre-HTTP phase.

Completion: Repo Wiki Account Provider completes the Runtime Headers reverse RPC and sends real model HTTP; API Key
Provider does not regress; Catalog success writes `draft.json` and page generation and `wiki.json` flow resume;
`workspace/cancelGenerateText` runs during an in-flight `workspace/generateText` and fires the Agent AbortSignal;
Deadline, user stop and task terminal state leave no Repo Wiki physical request or Agent operation; max underlying
retry concurrency is 1; Lane docs, tests and implementation agree on "complete Host Protocol Wiring"; no second
Provider/Model/Account authority and no timeout extension or extra retries to mask the fault.

## 6. Not done

No raising of Repo Wiki's 15-minute Deadline; no more default retries; no Repo Wiki-specific Registry, Config, Model,
Headers DTO or Account Auth; Host does not rebuild the Active Model; no arbitrary fixed timeout for all
Agent-to-Host reverse RPCs; no large "handled" protocol rework for the Event Emitter; no change to ordinary Chat,
Desktop continuous or Mobile replayable Session/Task state boundaries.

## 7. Outcome (2026-08-28)

- The Repo Wiki independent Client reuses the formal `wireClient()` before Ready; Account Provider
  `interaction/requestProviderRuntimeHeaders` is answered by the Host account service.
- `workspace/cancelGenerateText` and `session/stop` share the Transport control-plane bypass but still wait for the
  preceding `workspace/generateText` to register its operation controller.
- Services Deadline and retry implementation unchanged: real NDJSON tests prove cancel releases the old request
  before later requests enter their handler and `maxConcurrentPhysicalRequests === 1`, so no new cancel
  acknowledgement queue or Retry Policy was needed.
- Low-frequency Runtime Headers requested / applied / failed lifecycle logs added (no Header or credential bodies).
- `repo-wiki-agent-lane.md` now states: Lane isolates process, queue and lifecycle, not Host Protocol capability.
- Verification: Repo Wiki Lane, Account Runtime Headers, Services Deadline/Retry directed tests passed; Bootstrap
  Transport whole file 13 passed, Server workspace cancellation directed tests passed; `@zcode/bootstrap`
  typecheck, root `pnpm typecheck`, root `pnpm lint`, changed-file lint and `git diff --check` passed; CLI-wide
  `format:check` still reports 296 pre-existing baseline files (changed CLI files were formatted individually).
