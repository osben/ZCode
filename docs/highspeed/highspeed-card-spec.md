# Highspeed Acceleration Card Spec

> Status: MVP in development (2026-08-20).
> Scope: send-time card draw, 1-second fallback, cooldown, pinned model, message marker, share, and an extensible global notice slot. The Highspeed composer has an activation animation; the share card stays static.

## 1. Product Semantics

- When the user clicks send, the client first tries to prepare a Highspeed card for the current Task.
- Input turns dispatched by a scheduled task / Automation never enter Highspeed admission: when the turn has an `automationId`, it neither calls draw nor reuses an existing card and sends on the ordinary inference path. Only this turn's attribution is checked; the Task's persisted `cronAutomationId` must not be used, otherwise later manual input in the same conversation would be misjudged as a scheduled task.
- The user may create a scheduled task through `CronCreate` during a Highspeed Turn. Creation must persist the session's resident `modelSelection`; the acceleration card Provider (`account:*-highspeed-card`) must never be written into an Automation. Later triggers use that original model on the ordinary inference path and neither fail nor get acceleration because creation happened during acceleration. Highspeed itself must not add `CronCreate` to the current user Turn's `toolDisallowlist`; conversely, the `automationId` of an actual Automation execution turn is the final gate: even if `modelExecution` is wrongly received, the CLI must ignore this single-turn execution material and keep hiding Automation write tools.
- If draw returns within 1 second and the card belongs to the current Task, this turn uses the card's bound provider/model and the Highspeed runtime endpoint.
- If draw has not returned after 1 second, the turn is sent normally; the request continues in the background, and if it hits later, the next send of the current Task uses the card automatically.
- `next_draw_at` is the server's cooldown authority; no repeated draw during cooldown.
- One card binds exactly one `task_id/provider/model`. When Task B observes Task A's card, it infers normally with no hint.
- While the card is valid and belongs to the current Task, the model selector is locked; it unlocks automatically after expiry.
- The user input of an accelerated Turn keeps the ordinary message style: no badge, background, border or other decoration.
- Accelerated output reuses the existing "worked {duration}" control; only the duration status text is shown in purple accent per Figma `6076:8300`; no separate output badge.

## 2. Backend Contract

### 2.1 Draw

```http
POST /api/v1/highspeed/draw
Authorization: Bearer <zcode JWT>
X-Bigmodel-Authorization: <business JWT of the current Coding Plan provider family>
Bigmodel-Target-Type: PERSONAL | TEAM
Bigmodel-Organization: <TEAM only>
Bigmodel-Project: <TEAM only>
Content-Type: application/json
```

```json
{
  "task_id": "task-abc123",
  "provider": "zai",
  "model": "glm-5"
}
```

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "card": {
      "card_id": "hsc_xxx",
      "task_id": "task-abc123",
      "provider": "zai",
      "model": "glm-5",
      "issued_at": 1786413600000,
      "expires_at": 1786414500000
    },
    "next_draw_at": 1786417200000
  }
}
```

On a miss, cooldown or no capacity, `data.card = null`, but `next_draw_at` is still returned. Draw reuses the existing Coding Plan dual-JWT contract: `X-Bigmodel-Authorization` carries the business JWT matching the current Z.ai/BigModel provider family directly, without `Bearer`; Team organization/project identity is passed only through the corresponding headers.

### 2.2 Accelerated inference

```http
POST /api/v1/highspeed/anthropic/v1/messages
Authorization: Bearer <zcode JWT>
X-Bigmodel-Authorization: Bearer <business JWT of the current Coding Plan provider family>
Bigmodel-Target-Type: PERSONAL | TEAM
Bigmodel-Organization: <TEAM only>
Bigmodel-Project: <TEAM only>
X-Highspeed-Card-ID: hsc_xxx
```

Accelerated inference goes through the same `/api/v1/highspeed/` gateway and auth middleware as draw, so it uses the **exact same Coding Plan dual-JWT contract** as §2.1 (the zcode JWT identifies the session identity, `X-Bigmodel-Authorization` carries the business JWT matching the current provider family, Team organization/project go through the corresponding headers), plus `X-Highspeed-Card-ID` identifying the card of this execution. Regression constraint: sending only `Authorization` + `X-Highspeed-Card-ID` once left the gateway unable to verify Coding Plan entitlement and returned `401 auth_failed`. The Coding Plan headers and the card ID must come from the same selected-connection resolution; no cross-Family splicing.

The body is Anthropic Messages, and `model` must equal the card's bound model. The client points this turn's Selection at the hidden built-in acceleration card Provider (`account:zai-highspeed-card` / `account:bigmodel-highspeed-card`; endpoint and model list come from the Built-in Provider Config), and the dynamic auth above ships through `modelExecution.requestAuth`; `modelExecution.selectionScope = "execution"` makes it apply to this turn only and never changes the session's resident `modelSelection`.

The acceleration endpoint's model capability facts also come only from the Built-in Provider Config and align item by item with the Coding Plan sites (mid-conversation system, provider-native WebSearch, image/video input). Acceleration changes speed only; the capability surface of one conversation must not jitter with whether this turn is accelerated.

Highspeed and Off-Peak Providers are derived execution entries of the current Coding Plan connection and own no separate entitlement. Their publication state must inherit the **final entitlement result** of the selected parent Provider after the same Account Provider resolution round: publish when the parent is explicitly available, take down when explicitly unavailable; when the parent query is `unknown`, first resolve the parent by the Account Provider last-known-good rule, then project the final result to the derived Provider. Never treat a raw `unknown` as no entitlement, otherwise the parent can still draw while the derived Provider is already removed from the Registry. Last-known-good is valid only within the same login account and the same Team `organization/project/product` identity; after the account or Team identity changes, both the parent and the derived entry must fail closed and never resurrect old entitlement.

```text
Raw Coding Plan query         Parent final result            Derived execution entry
available                 -> available                 -> available
unavailable               -> unavailable               -> unavailable
unknown + same-identity old entitlement -> last-known-good available -> available
unknown + identity changed -> fail-closed unavailable  -> unavailable
```

One Turn may produce multiple Messages requests because of tool calls. When any Highspeed request fails (card expiry `HTTP 400 / provider_code=3402`, auth failure, rate limit, 5xx, network error, timeout, stream interruption, i.e. **any failure**), the Agent must keep completed tool results and conversation context, switch the remaining model requests of that Turn back to the original session model from before the send, and must not surface the accelerated request failure as a whole-turn failure. On fallback a structured `TurnExecutionModelFallback` event is published and the Renderer notifies once: on card expiry "加速卡已到期，本轮后续内容将使用原模型继续生成" (the acceleration card has expired; the rest of this turn continues on the original model), for other failures "加速服务暂不可用，本轮后续内容将使用原模型继续生成" (the acceleration service is unavailable; the rest of this turn continues on the original model).

The fallback is expressed declaratively by `modelExecution.selectionFallback`: `{ providerId, rules: [{ reason, providerErrorCode? }], target? }`. Rules match in declaration order, the first hit decides the fallback reason, and an omitted `providerErrorCode` means any failure of that provider. The acceleration card declares two request-time rules: `3402 → highspeed_card_expired`, everything else `→ highspeed_request_failed`. Core falls back only when the failure comes from the provider the turn's execution Selection points at (no hard-coding by provider id prefix, model name or error text), and only once.

The same declaration also covers the model-creation phase before the request goes out. Only when the turn is an execution-scoped Selection, the Selection provider equals the declared provider, and the creation error is strictly `ProviderNotFound` or `ModelNotFound`, Core creates the fallback model in the same candidate order and continues the turn, publishing a `TurnExecutionModelFallback` with reason `highspeed_selection_unavailable`. Ordinary session Selections, other creation errors, and the fallback target's own creation failure must not be swallowed. When all candidates fail, the turn ends with the real creation error of the last ordinary model candidate, logs `warn`, and must not show the Highspeed Registry error to the user. After a successful creation-phase fallback, the turn's fallback declaration must be cleared so a later failure of the ordinary model cannot fall back twice.

Any creation-phase or request-phase failure attributed to Highspeed means the current card should no longer lock the Composer. After observing `TurnExecutionModelFallback`, the Renderer must call the Highspeed Service to invalidate the card by the `cardId` of the event's input. If the fallback target also cannot be created and no such event is produced, Core publishes `error.attribution.highspeedFallbackUnavailable=true` in that Turn's `TurnError` (both creation-phase and request-phase "nowhere to fall back" publish it), and V4 projects it to `control.lastError.attribution`. The Renderer invalidates the current card only when `highspeedCardId` equals the current card and this field is true, never inferred from error codes (for request-phase 3402/network failures the `code` is a provider error code, not a catalog error). Context overflow, user cancellation and local runtime failures do not take part in fallback and do not carry this field. The Service clears the card only when the current card ID matches, so an old event cannot clear a newly drawn card, and keeps the `nextDrawAt` cooldown fact so the next send does not immediately draw again and loop on failures. Model lock and acceleration visuals derive only from the Service's current card state, so after the matching card is invalidated the composer immediately leaves the Highspeed state and unlocks. A successful fallback shows no error Banner, only one notice that the turn switched back to the original model; if the ordinary model after fallback also fails the turn ends with its real error, but the Composer is already unlocked and the user can change models and continue.

Error-terminal card clearing must use the card attribution in the execution facts. `intent.highspeed.cardId` of a Highspeed command is the only card identity for the turn; when generating `TurnError` the CLI writes it into `error.attribution.highspeedCardId`, and V4 projects it to `control.lastError.attribution.highspeedCardId`. The Renderer invalidates the card only when this value equals the current card ID and `highspeedFallbackUnavailable` is true, and no longer looks up the input row through `rows.window`. On model creation failure, `TurnStarted` must be published and the accepted user input persisted before `TurnError`; the explicit error attribution still invalidates the exact card, and whether the history window contains the userInput is not a correlation basis. `inputId` remains the generic input anchor of TurnError but does not carry Highspeed card attribution. An old Agent without the `highspeedCardId` field can only clear the card conservatively by the `provider_not_found` / `model_not_found` catalog error codes with the card issue time as lower bound.

Destructive `editUserQuery` / `retryTurn` must complete one model admission check before the branch cut and workspace rewind; after the branch cut is committed it must not reject the same replacement input again using the mutable Provider Registry. If the Registry changes after the pre-check and before Core creates the model, Core may end the turn with a `model_creation` failure, but must first promote the replacement input to a recoverable authoritative user row. The final state can only be "new input + explicit error", never only a truncated history or a rewound workspace.

A creation-failure turn does not duplicate the persistence flow. Core only records the original creation error and then follows the same lifecycle as an ordinary turn: `TurnStarted`, the `UserPromptSubmit` hook, attachment parsing and user row persistence. The error terminal is written only by the same catch of the main lifecycle. After a model creation failure, Context must not be initialized and the `SessionStart` hook must not run: both depend on a usable model and sit before input persistence, so failing there would overwrite the original creation error and lose the accepted input again; `SessionStart` must also not be consumed by the failed turn and is left for the next Turn whose model can be created.

```text
Core model creation fails ──> record original error (no terminal) ──> skip Context init and SessionStart hook
  └─> TurnStarted ──> UserPromptSubmit hook ─┬─ blocked ──> completed(success, stopReason), input not persisted (ordinary-turn rule)
                                             └─ allowed ──> attachment parsing + user row persistence ──> throw original error
                                                                                       │
Main lifecycle catch (only error-terminal write point) <──────────────────────────────┘
  ├─ ordinary failure (including persistence failure) ──> TurnError(model_creation, original creation error); persistence error only logs warn
  ├─ user Stop ──> completed(cancelled), same as an ordinary turn
  └─ host fault (via abort signal) ──> TurnError(fault code), same as an ordinary turn
```

This turn never enters the model step, so guide is rejected (`turn_not_steerable`) and guide is re-routed to the ordinary queue. The turn also does not apply the submitted model selection, mode and plan, and does not count toward goal turns. `/compact` produces no user row: on creation failure it publishes `TurnError(model_creation)` directly without `TurnStarted`.

A new Agent publishes a three-state attribution on every `TurnError`: a string means the card used by the turn, `null` means the turn did not use Highspeed, and a missing field only means an old Agent. A catalog error of an ordinary queued turn is therefore `null` and must not clear an unrelated card held at the time; a lingering error attributed to an old card must not clear the current card either. For old-Agent compatibility: when the field is missing, keep the conservative card clearing by catalog error code with the card-issue-time lower bound; on that path an ordinary-turn catalog error may still clear a card by mistake, but only in the transition period of a new App connecting to an old Agent.

The fallback target resolves in order: **the declared `target` first, then the session's resident `modelSelection` copied before the turn was admitted**. `target` is the submission selection of the initiator at draw time (the Composer's current model and thinking tier), i.e. what would have been bound as the session selection had this turn not been accelerated; the acceleration card must fill it. The resident session selection is only a backstop: admitting the user message binds the ordinary submission selection, so normally they are the same. A candidate target must not be the turn's execution provider itself; a target not resolvable in the Registry skips to the next candidate. When neither resolves there is nowhere to fall back, the turn fails with the real error without burying the root cause, and Core must log a `warn` with the reason. Core stores the session candidate as the acceleration-card-specific `highspeedFallbackSelection` snapshot, and later user input updating the Session must not change the fallback target of the old turn. No overlay/model-restore interface is needed; the fallback request uses the user's own regular auth and no longer carries this execution's `requestAuth`.

Regression constraint (the fallback target must ship with the declaration): the fallback target once depended only on the runtime's resident session selection. After a desktop restart, if cold recovery fell in the window where the Provider Registry had just become ready but account entitlement was not yet resolved, the persisted session selection failed validation because the provider was not published and was not bound; if only accelerated turns were sent afterwards (execution scope binds no session selection), the runtime had no resident selection and on card expiry (3402) the degradation silently skipped, the whole turn failed as `highspeed card is invalid` and an error banner popped up. The initiator knows the original model at draw time, so it declares the target instead of betting on runtime state.

ACK admission constraint: the Highspeed execution Selection may be resolved late in Core to allow creation-phase fallback when the accelerated model is temporarily missing. Before accepting input, Bootstrap must confirm that at least one of the execution Selection or the declared `selectionFallback.target` exists in the current Worker Provider Registry. When the execution Selection is available, the input must not be rejected merely because the fallback target is missing; when neither is resolvable, it must be rejected before ACK with `modelUnavailable`, never accepted first and then only `TurnError(model_creation)` published. For such a Highspeed admission rejection the Renderer must invalidate the matching card, leave the acceleration state and unlock the model selector, and let the Composer restore body and attachments, without showing a Turn Error or a generic send-error Banner. ACK means the input was reliably accepted; the UI watchdog must not be used to recover an input that has not yet produced a `TurnStarted` / userInput projection.

`editUserQuery` / `retryTurn` persist the active branch cut, and `workspaceMode=rewind` also modifies workspace files first. They must run the same model admission check on the canonical intent and execution material about to be resent, before stopping the active turn, file rewind and branch cut. If admission fails, the active history and workspace must not change. The pre-check and the actual resend must reuse the same admission rule; ordinary send and edit-resend must not judge "usable model" separately. After a Highspeed `editUserQuery` is accepted, it follows the conversation protocol's accepted-input projection recovery: if the branch cut is already visible while the replacement user row is silent, only restore the same owned subscription, without replaying the command, fabricating a message, or restoring the old branch.

Fallback boundaries:

- **Accelerated request retries 0 times**: an execution-scope model handle carrying `selectionFallback` binds a `single-attempt` retry budget; the adapter layer no longer retries transient failures (429/5xx/network/timeout) with the default 10-step backoff, and the first failure goes to Core for fallback; otherwise users would wait minutes for the fallback when the acceleration endpoint is overloaded. The session model after fallback regains the default budget.
- **Declarative fallback takes precedence over same-model stream recovery**: on stream interruption with visible output already present, fall back to the original model and regenerate directly without first retrying on the accelerated model; if the failure hits the fallback declaration but no fallback target is resolvable, fail with the real error directly and likewise do not return to the accelerated model for stream recovery. `TurnExecutionModelFallback` must mark the abandoned text/reasoning stream `interrupted` and the unfinalized `inputStreaming` tool rows `cancelled`, so the original model's continued stream neither concatenates two model outputs nor marks abandoned output complete. A client-side tool that already formed a complete `tool_call` cannot only be `tool_abandoned` in memory: before switching models, scheduling must stop and the durable part must be closed; a completed result is committed as is, a running call prefers a committed explicit cancellation result, and if the state cannot be confirmed a synthetic interrupted result is committed, and the assistant tool call and tool result must enter live/cold provider-visible history in pairs. The fallback model may only continue from this stable anchor and must not blindly re-run tools, and no `pending`/`running` part may remain in persistence. Even if no fallback target is resolvable, settlement of accepted tools must complete first and then the turn terminates with the original provider error; "do not request the accelerated model again" must not skip tool closure, and `tool_abandoned` must not be published again after settlement to overwrite the terminal state.
- **A tool anchor resets the output continuation budget**: if a successful fallback actually committed one or more tool results, a new model execution boundary has been established, and like a normal tool response and same-model tool recovery it must zero `outputTokenContinuationCount`; a degradation that only abandons the text/reasoning tail without a complete tool call must not zero it, so text-only failures cannot bypass the continuation cap of the same output.
- **Failures that do not degrade**: user cancellation (the whole turn closes as cancelled), context overflow (handled by reactive compact; falling back to the same model with the same window would just overflow once more), and local runtime failures such as event persistence and projection. The catch-all "any failure" of the rule means only provider/network request failures explicitly attributed to the turn's execution provider; unattributed local exceptions must not be misjudged as acceleration endpoint faults.
- **Once per turn, card dropped on failure**: after fallback, all remaining requests of the turn use the session model; if the session model after fallback fails again, the turn ends with its real error. Once a creation or request failure is attributed to Highspeed, the current matching card is invalidated immediately with the cooldown kept, and the next turn must not reuse the same card; so even if the ordinary model also fails, the Composer has already left the Highspeed state and the user can pick another model to continue.
- **Cold recovery terminal**: the fallen-back accelerated attempt must be persisted as the unified stream-recovery discarded boundary, not an ordinary `completed` assistant. If the process exits before the fallback model produces a final assistant, cold recovery closes the Turn as interrupted; if a normally completed assistant follows, it recovers as success with no error Banner. The tool anchor still recovers in pairs as stated above.
- **Trace**: on fallback the CLI logs one `warn` with attribution (providerId, modelId, statusCode, providerErrorCode, reason), so a regression where auth failures are masked by degradation can still be found in logs.
- **Statistics unchanged**: a degraded Turn still counts `outputTokens/durationMs` as a whole Turn and takes part in sharing (§2.3). A Turn whose first accelerated request already failed has 0 accelerated output, but `highspeedMeta` was persisted with the input, so it still shows and counts as an accelerated turn; this is a known trade-off, and excluding it would need a separately defined statistics rule.

```text
execution Selection
        |
        +-- create ProviderNotFound / ModelNotFound
        |       +--> original session model created
        |       |       +--> emit selection_unavailable
        |       |       +--> invalidate matching card + unlock selector
        |       +--> no candidate created
        |               +--> fail with the ordinary model's real error
        |               +--> TurnError.attribution.highspeedFallbackUnavailable
        |               +--> invalidate matching card + unlock selector
        |
        +-- request failure --> preserve current Turn context/tools
                                +--> fallback target created
                                |       +--> notify Renderer once (card expired / request failed)
                                |       +--> invalidate matching card + unlock selector
                                |       +--> remaining requests use original session model
                                +--> no fallback target
                                        +--> fail with the original provider error (e.g. 3402)
                                        +--> TurnError.attribution.highspeedFallbackUnavailable
                                        +--> invalidate matching card + unlock selector
```

### 2.3 Share

- The share card is generated by the client from persisted card-level Turn metrics; the backend share API is no longer called, and there is no dependency on `share_id`, `share_url` or a remote share response.
- Display values such as `token_usage`, `highspeed_tps` and `regular_tps` are still computed from card-level local aggregated facts; card-level healthy usage is still fetched through `/api/v1/highspeed/:card_id/healthy` to compute the highspeed TPS.
- Both copy-image and copy-text use client-generated content; the share notice stores only the latest local display snapshot and closes automatically by the existing 24-hour visibility rule.
- Before the Highspeed card reaches `expires_at`, only per-Turn metrics are accumulated; no share is called and no bottom-left share card is published. After the card expires and all Turns started by that card are complete, metrics are aggregated by `card_id`; only when the aggregated data is complete and the overall speedup ratio is strictly greater than `1.2x` is the bottom-left share card auto-published at most once within the current Renderer run. Below the bar (<= `1.2x`) or without trustworthy data, nothing is published (publish gate in §9 and `highspeedTurnStore.listHighspeedCardAutoShareCandidates`).
- After any Turn degrades on an accelerated request failure (card expiry or other failure, §2.2), it still counts `outputTokens/durationMs` as a whole Turn and takes part in the automatic or manual share of the card; share statistics do not distinguish output segments before and after degradation.
- After an automatic share fails, it must not retry immediately because of a snapshot, store version or React re-render, to avoid a request storm and 429; the manual share entry of historical Turns remains usable.
- The share button of a historical Turn always builds share content from the Highspeed completed-state metadata persisted in the transcript, not from Renderer memory records; after a successful copy it shares the success Toast "已复制分享内容" (share content copied) with the bottom-left share card, uploads or builds no remote share link, and does not switch the current bottom-left share card.

### 2.4 Failure diagnostic logs

- Draw, card-level healthy usage, and the ordinary TPS health check that Highspeed time-saved depends on must each log one `warn` on any network, HTTP, business-envelope or response-parse failure. A copy failure of client-generated share content must also log a corresponding UI warning; no non-existent share API request is logged.
- Logs contain at least the operation name, redacted URL, HTTP status/statusText, duration, error message, and the `x-request-id` / `x-trace-id` / `x-span-id` response headers; the response body keeps only a bounded error summary.
- Logs must not record `Authorization`, `X-Bigmodel-Authorization`, full request headers, JWTs, the full request body or streamed model output. Request context records only a non-sensitive summary useful for locating the problem.
- Highspeed inference continues through the Agent's model request error chain; Host does not log per streaming chunk, so failure diagnostics do not grow into high-frequency communication logs.

## 3. Send Sequence

```text
User        Renderer coordinator       Highspeed service/API       Session command
 | click send        |                          |                         |
 |------------------>| prepare(task, model)     |                         |
 |                   |------------------------->| draw / reuse card       |
 |                   |                          |                         |
 |                   |<--- card <= 1s ----------|                         |
 |                   | sendText(modelSelection + modelExecution, card metadata) |
 |                   |--------------------------------------------------->|
 |                   |                          |                         |
 |                   |---- OR timeout at 1s ----|                         |
 |                   | sendText(normal fallback)|                         |
 |                   |--------------------------------------------------->|
 |                   |                          | draw continues          |
 |                   |                          |-- result cached --------|
 | next click        | consume cached card      |                         |
```

Race rules:

1. The first send of a new Task first creates an empty session, obtains the real `sessionId/task_id`, then runs draw and submits the first turn with `sendText`; `createSession(firstInput)` must not be used to bypass Highspeed admission.
2. An existing unexpired card belonging to the current Task: no draw, accelerate directly.
3. An existing unexpired card belonging to another Task: no draw, no hint, ordinary send.
4. `now < next_draw_at`: no draw, ordinary send.
5. Only one in-flight draw per user; concurrent sends reuse that Promise.
6. The 1 second only limits how long the current send waits and does not cancel draw. But the draw/healthy **request itself must be bounded**: the transport aborts after `HIGHSPEED_REQUEST_TIMEOUT_MS` (default 20s, clearly greater than the 1s wait budget so a slow but legitimate draw can still land for the next turn) and rejects the Promise, with the deadline also covering response body reading; the reject triggers the `finally` release of the in-flight draw so the next send can draw again. A proxy/server that accepts the connection and never returns must not degrade "single in-flight" into a permanent circuit break recoverable only by restart.
7. The turn carries `automationId`: fall back directly before reading the card, cooldown, or starting draw; it must not change the current card, `next_draw_at` or in-flight draw state. The Task's `cronAutomationId` takes no part in the judgment.
8. While the current Task is running, new user input must still be admitted by the existing `queue` semantics and must not be rejected for carrying `modelSelection` / `modelExecution`. Running state is ultimately the Core `activeTurn`; even if the adapter controller or projection routing is not yet synced, as long as Core still has an active turn it must be queued, and routing to `startNow` is forbidden. The only meaning of `QueueItem.modelSelection` is the ordinary submission Selection from before the send; like mode and Plan it is persistable, cold-recoverable, and restored to the Composer when the edit is withdrawn; a single-turn execution Selection such as `account:*-highspeed-card` must never be written into it. `selectionFallback.target` may serve as the ordinary submission Selection only if its Provider Family is not Highspeed; all queue write paths must share the same ordinary Selection resolver. If the target was polluted into a Highspeed Provider by an old version or an abnormal payload, use the session's resident ordinary Selection instead, and never write the internal Provider into `QueueItem.modelSelection`. The queue may persist Highspeed card metadata without credentials; the accelerated `modelSelection` and `modelExecution` must be one execution bundle, resident in CLI process memory only by `sourceCommandId`, and frozen into the turn's execution context only when that input is promoted into a new Turn. Queue admission submits only the ordinary Selection and the card metadata and does not carry `modelExecution`. If the host does not provide the stash capability, fall back as a whole to the QueueItem's own ordinary Selection, with no half-way acceleration.
9. When a Highspeed queue item is promoted, `expiresAt` must be validated again. While the card is valid, automatic consumption prefers the execution bundle stashed in CLI memory; when the user clicks "send now", the Renderer must take the QueueItem's own ordinary Selection as the prepare input, re-prepare `modelSelection` + `modelExecution` from the same currently valid card and supplement them with `sendQueuedNow`, so missing temporary in-memory state does not wrongly degrade a valid card; supplemented material must be for the same card (`cardId`/`taskId` equal), and any cross-card material is ignored to avoid swapping credentials. The promotion boundary uses the accelerated Selection from the bundle, but `selectionFallback.target` must be fixed to the QueueItem's ordinary Selection. If the card has expired, or the execution bundle is still unavailable after re-prepare, only the Highspeed marker of this turn is removed and the QueueItem's persisted ordinary Selection is used directly; never look back at the Session Selection, which later input may have changed. Migration compatibility only applies to QueueItems of old versions that wrongly persisted `account:*-highspeed-card`, identified only by Provider Family and not by whether card metadata is present (a polluted resend of an old version may produce such an item without card metadata): on promotion, rewrite to the session's resident Selection; when the edit is withdrawn, do not restore that Selection and keep the current selection in the Composer; never expose the internal Provider to the error surface or Composer. In every case user input must not be lost or block the subsequent FIFO.
10. When the user edits the last real input and resends, it is handled as a new active send: before submitting `editUserQuery` the Renderer re-runs the current Task's Highspeed prepare and submits the card metadata and the single-turn `modelSelection` + `modelExecution` obtained this time together. The CLI accepts only a card of this session (`taskId` equals the current `sessionId`), not expired, whose `modelSelection` really points at the acceleration Provider; it must not reuse the old card credentials from the edited history turn; when the current card is invalid or prepare falls back, resend on the ordinary model and keep no old Highspeed marker.
11. Only Coding Plan users may call draw: before starting a new draw, confirm there is a usable Coding Plan connection (reusing the off-peak Coding Plan support judgment). A non-Coding-Plan user falls back to ordinary send directly, starts no draw, produces no warn noise, and must not change the current card, `next_draw_at` or in-flight draw state; an exception during the judgment is treated as unsupported to avoid hitting the draw API with invalid credentials. Reuse of an existing valid card (rule 2) is not subject to this gate.
12. Send closing does not wait for decorative data. After a hit, reading the ordinary Decode TPS (which only decides the time-saved display, not auth, model selection or inference correctness) waits at most `min(300ms, remaining of the 1s send budget)`: on timeout or failure this turn attaches no `regularTps`, shows no time-saved for the turn, and `sendText` is submitted immediately; the request itself is not cancelled and the Service layer continues and caches it for later turns. The total wait of `prepareHighspeedSendContext` must not exceed the 1s send budget, and the 15s timeout of the TPS query must never block the main business command submission. The 1s wait budget of Service-side `prepareTurn` starts from entering `prepareTurn`, and the same deadline uniformly covers the gate judgments before starting a new draw (rules 11/14), the draw wait, and the acceleration auth resolution after a hit or card reuse; no await may be timed separately outside the budget: if the gate judgment exceeds the budget this turn falls back `unavailable` to ordinary send and does not start draw; if the acceleration auth resolution exceeds the budget it falls back `draw-timeout` to ordinary send, the fallback result carries that card, and the card is kept for the next turn. Timed-out judgment and auth requests are not cancelled; after finishing, the underlying cache warms up the next turn; they do not change the card, `next_draw_at` or in-flight draw state.
13. retry, edit-resend and queue promotion share the same fallback resolver: on resend/promotion, if there is no valid Highspeed execution for this turn (no new card drawn, card expired, host cannot stash credentials) while the history/queue Selection points at `account:*-highspeed-card`, it must be explicitly rewritten to the pre-send resident session Selection; do not delete only `modelExecution` while keeping the accelerated Selection. An accelerated Selection is valid only paired with the same turn's requestAuth; keeping it alone would make Core fail with ModelRequestAuthMissing and be pinned into the new canonical intent, letting later ordinary sends keep carrying an unusable acceleration Provider. The rewrite applies only to this turn's intent and does not change the session's resident model.
14. A new draw is allowed only when the session model belongs to the selected Coding Plan Provider's model catalog: before starting a new draw the Service layer uses the model selection view (`ModelSelectionView.providers[].models`, sourced from the Built-in Provider Config) to confirm the current `providerId/model` combination really exists. A model not in the catalog (for example a model taken offline restored by the session, or a stale combination when the Registry is not ready), or a catalog judgment not completed within the send budget (for example Provider Runtime initialization blocking, see rule 12), falls back to ordinary send directly (reason `unavailable`), starts no draw, produces no warn noise, and must not change the current card, `next_draw_at` or in-flight draw state; an exception during the judgment is treated as not passed to avoid hitting the draw API with an invalid combination. Reuse of an existing valid card (rule 2) and an already in-flight draw are not subject to this gate. Mock scenarios pass to keep local verification semantics.
15. For a user-initiated submission (sendText, including new session and warm-up promotion) the model selection of Highspeed prepare comes from the same source as the submitted `modelSelection`: prefer `providerId/modelId/reasoningLevel` from the submitted selection, and for missing fields fall back field by field to session projection → draft → initial draft. The first send after switching models must do admission with the new selection: if the new provider/model does not satisfy the draw gate (rules 11/14), do not start draw and send ordinarily by the submitted selection; never keep using the session's old combination to draw and then overwrite the user's submitted selection with the card model. A history edit-resend without an ordinary submission selection prepares by the session's resident Selection; a manual queue promotion must explicitly pass the QueueItem's own ordinary Selection and never look back at the Session Selection that later admission may have rewritten.
16. If a draw failure is observed by this turn within the 1s send budget (HTTP 4xx/5xx, network error, non-zero business code etc.; on 2026-10-19 production this was a steady HTTP 400 `code=3001 parameter error`), this turn falls back to ordinary send immediately (reason `draw-failed`) and advances the Service's `nextDrawAt` to `now + 60s`: the cooldown semantics are the same as the `next_draw_at` returned by a successful draw (§1), and later sends during the cooldown must not start the same doomed draw and pay its whole latency again. The cooldown only advances and never retreats: take the larger of it and the existing `nextDrawAt`. A late background rejection that no turn observed (for example a 20s lifecycle abort after the budget, rule 6/CR-01) must not write the cooldown, and the next send may draw again; after the cooldown expires a normal draw resumes, and a successful draw's `next_draw_at` overrides the failure cooldown.

```text
running Highspeed turn
        |
        +-- next user prompt --> queue(card metadata + ordinary submission modelSelection)
        |                        + retainQueuedTurnExecution(
        |                            sourceCommandId,
        |                            highspeed modelSelection + modelExecution
        |                          )
        |                             |
        |                             +-- auto promote while valid --> freeze bundle into turn
        |                             |
        |                             +-- manual promote ----------> refresh from queued ordinary Selection
        |                             |
        |                             `-- expired/bundle missing --> use queued ordinary Selection
        |
        `-- edit queued prompt --> restore ordinary Selection to Composer
```

```text
edit accelerated user input
        |
        +-- prepare current task/card again
        |
        +-- valid card + runtime --> rewind + rerun with new Highspeed metadata
        |
        `-- unavailable ----------> rewind + rerun with ordinary session model
```

```text
send admission
  |-- automationId present --> normal send (no card reuse, no draw)
  `-- user turn -----------> existing Highspeed prepare/draw flow
```

## 4. Card State Machine

```text
                 draw miss / cooldown
        +--------------------------------+
        |                                v
  [idle] --draw--> [drawing] ---------> [cooldown]
                     | hit                  |
                     v                      | now >= next_draw_at
                  [active] -----------------+
                     |
                     | expires_at reached
                     v
                  [expired] ---> [idle/cooldown]

active + task mismatch => foreign-active (silent fallback for the current Task)
```

## 5. Message Metadata and Statistics

The MVP adds no physical column to the session database. The user message's `metadata.highspeed` in `message.data` persists the card snapshot used by the turn, with a fixed structure:

```json
{
  "schemaVersion": 1,
  "cardId": "hsc_xxx",
  "taskId": "task-abc123",
  "provider": "zai",
  "model": "glm-5",
  "issuedAt": 1786413600000,
  "expiresAt": 1786414500000,
  "fallbackAt": 1786414500123,
  "fallbackReason": "highspeed_card_expired"
}
```

This metadata is written only by `sendText` that passed Highspeed admission, entering SQLite through `sendText.highspeedMeta -> TurnInputIntentMetadata.highspeed -> persistUserPrompt`; an old message without the field is treated as an ordinary message. The Renderer still records running statistics by `sessionId + sourceCommandId`:

- `fallbackAt` appears only when an accelerated request failure degraded within the Turn (`fallbackReason` records the reason too: `highspeed_card_expired` / `highspeed_request_failed` / `highspeed_selection_unavailable`; the Renderer picks the hint copy from it; it is written, persisted and recovered by the same event and rule as `fallbackAt`), so the desktop continuous and mobile replayable paths project the expiry hint consistently; it does not change the Turn's share eligibility or full statistics scope. It is an authoritative metadata field: when persisting the terminal duration the CLI writes the `fallbackAt` already produced in the live projection into the transcript; `HighspeedMetricsUpdated` and Renderer `setHighspeedMetrics` merge `highspeed` field by field, add-only and never delete; a terminal metrics update must not clear a `fallbackAt` already produced in the same Turn; cold hydration restores the field as is, and live and cold projections agree.
- `cardId`
- `taskId`
- `provider/model`
- `expiresAt`
- `startedAt`
- `outputTokens/durationMs` after completion

Completed-state statistics such as `outputTokens/durationMs` are still kept only in current Renderer memory with a bounded count; share statistics still join by `sourceCommandId`. The Highspeed display identity of a historical message must be projected by the CLI from the persisted `metadata.highspeed` onto the corresponding `UserInputRow.highspeed`; the Renderer must not rely only on the in-process `highspeedTurnStore` to decide the purple worked time. This way, after card expiry, page reload or session cold recovery, accelerated output keeps the purple "worked" marker; old messages without metadata are treated as ordinary. The Highspeed card snapshot follows the transcript for both desktop `continuous` and mobile `replayable`, with no separate recovery message, snapshot or second queue.

### 5.1 Resident Selection of derived sessions

The accelerated Selection recorded on a message is a `selectionScope=execution` single-turn execution fact, valid only paired with the same turn's requestAuth; accelerated turns never call `setSessionModelSelection`, so the parent session's resident Selection always equals the user's original model during acceleration.

Paths deriving a new session from history messages (stable fork `forkAssistant`, fork-before-edit, auxiliary conversation) must skip an accelerated Selection and fall back to the parent session's resident Selection before inheriting the fork point message's selection (the same rule as §3 rule 13):

```text
boundary message selection
  |-- account:*-highspeed-card --> skip ----> parent session resident selection
  `-- ordinary selection ------------------> inherit (fall back to the resident tier when reasoning tier is missing)
```

The child's `SESSION_ENTRY_MODEL_SELECTION` entry, the fork notice assistant's `providerId/modelId` and the host's `runtimeConfig.model` must come from the same result; the cold recovery projection (`sessionModelSelectionOfHydratedMessage`) already has the same filter, so live and cold derivation agree. If the parent session has no resident Selection either, leave it empty; never write the acceleration Provider into the child. Otherwise the user would see "the original model did not come over after forking an accelerated session" (the acceleration Provider is a hidden built-in item that does not exist in the model list), and the child's first send would fail with ModelRequestAuthMissing.

Recovery self-heals by the same rule: when `readSessionModelSelection` reads a resident entry pointing at an acceleration Provider it drops it directly, and the session returns to "unbound" instead of being filled with a default model (recovery is not execution start), so the user selects a model once again. This keeps sessions broken before the fix from projecting the hidden identity as the UI selected state and contextWindow.

The Renderer's workspace-level Composer Recent (first priority for the model seed of a new task draft) follows the same constraint: the `modelSelection` in the accelerated `sendText` payload has been overwritten by the execution material with the acceleration Provider, so after accepted, Recent must record the original selection frozen by the Composer before sending (passed explicitly by the caller; default falls back to the payload-derived value), and `captureComposerRecentSubmission` skips as a backstop any selection pointing at an acceleration Provider. The read side `readComposerRecent` drops `modelSelection` leaf-wise (keeping `mode`) when it finds a stored record pointing at an acceleration Provider, and the new draft falls back to the default selection; otherwise "new task" from an accelerated session would show an empty model selector (the hidden identity resolves to provider-not-found in the model view).

## 6. Global Notice Slot

```text
Domain Producer
  -> GlobalNoticeStore
  -> PresentationArbiter
  -> Desktop/Mobile Surface Adapter
  -> RendererRegistry(type + schemaVersion)
  -> constrained GlobalNoticeCard shell
```

Generic envelope:

- `noticeId`, `dedupeKey`
- `type`, `schemaVersion`
- `scope`, `priority`, `interruptPolicy`
- `createdAt`, `expiresAt`
- `payload`, `actions`
- `dismissPolicy`, `persistencePolicy`
- `source`, `revision`

Highspeed mapping:

```text
type = highspeed-share
scope = user
dedupeKey = highspeed-share:latest
persistencePolicy = latest-only
dismissPolicy = cooldown 24h
dismissKey = highspeed-share
priority = normal
```

Historical dev builds may have written `hsc_mock_*` or `mock.z.ai` share notices into the user-level persistent store. The production path must automatically discard such legacy mock notices when reading that store, and must not keep showing them after restart or open a mock share address. Real Highspeed share notices are unaffected.

Only the latest display snapshot is persisted: `cardId/shareId/shareUrl/shareExpiresAt/dismissedUntilMs`. No share history table, no session table change. After the user clicks X, it is not shown globally for 24 hours; if the user never clicks X, the share card must also disappear automatically 24 hours after publishing. The display deadline is the earlier of "share link expiry time" and "notice creation time + 24 hours"; with the page open continuously, visibility must be refreshed actively at that time, without relying on restart or other notice events. After expiry it does not pop up automatically and is shown again after the next accelerated completion. A manual historical share does not lift the silence and does not replace the bottom-left card.

Notice persistence is a display enhancement and best-effort: in-memory state is updated first, and a `localStorage` write failure (QuotaExceeded, storage disabled) only logs a controlled warn, subscribers still receive the update, and `publish`/`dismiss` must not throw: the caller claims the auto share before publishing, and a throw would leave an unretriable claim, so the user would not see the share card and could not recover within the current Renderer lifetime. When `localStorage` itself is inaccessible (private mode, sandbox) it falls back to in-memory storage and the notice remains usable within this session.

## 7. Mock Plan

Deterministic fixtures through dependency-injected transport/clock:

- `hit-fast`
- `miss`
- `hit-after-timeout`
- `existing-foreign-task-card`
- `expired-card`
- `share-success`
- `share-refresh`
- `share-expired`
- `hit-invalid-model` (creation-phase fallback special case)
- `hit-queue-edit` (Highspeed queue editing special case)

Mock replaces only the Highspeed draw/share transport; it does not change the session deliveryKind and does not start another Agent runtime/host. An ordinary Mock hit still returns the `accelerated` business state, to verify card consumption, model lock, message marker, statistics and share, but must not ship Highspeed `modelSelection` / `modelExecution`; the message flow keeps using the current session's ordinary provider/model and original inference interface, so a Mock card does not hit the real Highspeed inference endpoint and return no data. Only two special cases ship real Highspeed `modelSelection` / `modelExecution`: `hit-invalid-model`'s Selection points at a model outside the catalog to verify creation-phase declarative fallback; `hit-queue-edit` uses an in-catalog model and a controllable slow stream to verify that the queue persists only the ordinary Selection and the temporary Highspeed execution applies only at the promotion boundary. Neither exception changes the boundary of other Mocks. An ordinary Mock card has no execution bundle: input queued by sending again while the Task is running is treated at promotion as "bundle unavailable" by §3 rule 9, removing the Highspeed marker and using the QueueItem's ordinary Selection. So the message marker of ordinary Mock covers only directly started Turns.

To shorten the local manual verification cycle, the Mock time windows are fixed:

- A successful draw and a miss response: `next_draw_at = draw completion time + 2 minutes`.
- A hit card other than `expired-card`: `expires_at = draw completion time + 5 minutes`.
- `expired-card` keeps returning an expired time, unaffected by the 5-minute window.

```text
Mock draw/share  -> Highspeed card state, marker, statistics, share
Mock send        -> current session ordinary provider/model -> original inference interface
Real send        -> Highspeed modelSelection+Execution -> Highspeed inference interface
```

Desktop E2E injects scenarios per spec file before Electron starts (wdio `beforeSession` writes `ZCODE_HIGHSPEED_MOCK_SCENARIO`; mapping table in `test/e2e/helpers/highspeed-mock-env.ts`). The Mock scenario is fixed inside the Host process and draw has a 2-minute cooldown, so one spec file corresponds to one scenario and completes one draw; a new scenario needs a new spec file and a registered mapping, and an unregistered spec does not install Mock, so an ordinary conversation does not accidentally draw a card. The cases in the table share one preparation flow (Coding Plan credentials, Team scope, session model), and the `hit-fast` case is also the positive control of the eligibility chain. Model requests keep the HTTPS Endpoint built into Team Coding Plan, replayed by wdio's Coding Plan data-plane proxy: the official build's request security check is treated as unavailable degradation, and each turn takes the case-local fixture by the marker of the last user message. The Provider must not be rewritten into an HTTP Mock Endpoint: Team Coding Plan forces the official build's request security check and accepts only HTTPS, and after rewriting every turn would fail in the model creation phase:

| Case      | spec file                                                             | Scenario            | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HS-E2E-01 | `conversation-session-highspeed-card.test.ts`                         | `hit-fast`          | After a hit the composer enters Highspeed, the completed state carries the Highspeed marker, enters by `activation`; switching back to the Task presents by `restore` (§9.2)                                                                                                                                                                                                                                                          |
| HS-E2E-02 | `conversation-session-highspeed-card-draw-timeout.test.ts`            | `hit-after-timeout` | First-turn draw exceeds the 1s budget: this turn sends ordinarily without the Highspeed marker; the late card is kept and the next turn of the same Task accelerates directly with the marker (§1, §3 rule 6). The composer state during the first turn is not asserted: the pane of a draft first send may bind the session only after the late card lands, and presenting that card by `restore` through the snapshot is legitimate |
| HS-E2E-03 | `conversation-session-highspeed-card-draw-miss.test.ts`               | `miss`              | The missed first turn and the next turn in the cooldown both send ordinarily; the composer never enters Highspeed and there is no Highspeed marker (§3 rule 4)                                                                                                                                                                                                                                                                        |
| HS-E2E-04 | `conversation-session-highspeed-card-admission-retains-draft.test.ts` | `hit-invalid-model` | Send rejected before ACK because the accelerated model is unavailable; the input body is kept and restored; the matching card is invalidated, Highspeed exited and the model selector unlocked (§2.2)                                                                                                                                                                                                                                 |
| HS-E2E-05 | `conversation-session-highspeed-card-fallback-unlocks-model.test.ts`  | `hit-invalid-model` | After accelerated model creation fails, it falls back to the ordinary model and completes; the matching card is invalidated, Highspeed exited, the model selector unlocked, only one degradation Toast is shown and no error Banner (§2.2)                                                                                                                                                                                            |
| HS-E2E-06 | `conversation-session-highspeed-queue-edit.test.ts`                   | `hit-queue-edit`    | Sending again while Highspeed runs enqueues; withdrawing the edit restores the ordinary Coding Plan Selection and resending after a modification still enqueues; `account:*-highspeed-card` must not be exposed in the Composer, Session or error Banner (§3 rules 8/9/15)                                                                                                                                                            |

HS-E2E-04/05/06 currently live in `manual-review/pending/` and are not yet promoted into CI; promotion follows the `e2e-case-lifecycle` flow. Before promoting HS-E2E-06, the first-turn slow stream of `hit-queue-edit` must be wired to the real request chain: this scenario goes through the Highspeed execution Selection, so requests hit the Highspeed inference interface rather than the Team Coding Plan Endpoint; the existing data-plane proxy replays only the latter and does not support `chunks/offsetMs` chunked delay; without that replay the case cannot prove "enqueue during streaming → withdraw → resend".

## 8. Multi-End and Recovery Boundaries

- Desktop stays `desktop-continuous`; Highspeed is only a pre-send-admission coordinator and a single-turn `modelSelection` + `modelExecution`.
- Mobile Web still uses `web-remote-replayable` through shared-host attachment; no runtime is started in the Web shell.
- The global notice UI provides both a desktop sidebar surface and a narrow-screen surface; static placeholder in this phase.
- Tasks of remote workspaces still use the original chain's `workspaceIdentity/remoteSessionId`; Highspeed user-level state must not use `workspacePath` as an identity key.
- The entry mode of the Highspeed composer is Renderer-local display state: desktop `desktop-continuous` and mobile `web-remote-replayable` each play the activation animation only when a draw on their own send path newly hits; switching Task, reload recovery, or viewing a card drawn on the other end presents the stable state directly (see §9.2). The entry mode is not synced through session, protocol or remote control.
- The Renderer in-memory store hydrates from the transcript by `sourceCommandId` with **idempotent merge**: authoritative completed-state fields (`outputTokens/durationMs/duration split/highspeedTps/savedDurationMs`) override running temporary values, and a running row must not clear completed fields; repeated, late and partial metadata updates produce only the necessary single store notification, and a completely identical re-hydration does not notify. When the mobile Web/remote-control Renderer registers a running row first and the desktop later persists the completed state and projects it into the transcript, the re-hydration must absorb those fields so card-level TPS, time saved and auto-share candidates can settle, and the remote must not recompute on its own and disagree with the authoritative CLI metrics.

## 9. Bottom-Left Share Card Visual Contract

Figma node: `6430-11379` (redraft on 2026-08-31; the old draft `6012:18468` is obsolete). The Highspeed share card in the global notice surface follows this static visual:

- The card width fills the sidebar activity slot, with a fixed height of `96px`, aligned with the marketing Banner; the outer frame has no maximum width or extra padding. When the sidebar scales only the background crop adjusts, text and button sizes stay unchanged, and on narrow screens nothing overflows the sidebar.
- The card has `12px` rounded corners. The light theme uses a `#FAFAFA` base close to the marketing Banner and a theme light-gray stroke; the SVG keeps only a low-opacity Z watermark, with no silver-gray gradient or noise; the dark theme keeps the original composited SVG background.
- Top left is the `ZCodeWordmarkLogo` SVG wordmark, `52px` wide at 60% opacity; the model row is `34px` from the top; a separate middle row highlights the full model name `GLM-5.3-Highspeed` at `text-ui-lg` (default 16px), weight 600, with a 16px Zap lightning icon in the same theme purple before the name at 4px spacing; text uses a Highspeed purple horizontal gradient: light theme `#4830C8` → `#6041FF` → `#8955DB`, dark theme `#9B85FF` → `#B09AFF` → `#CEACFF`, spread over the text width; where text background clipping is unsupported, fall back to the theme text color. Below, the secondary copy "分享你的加速时刻" (English `Share your speedup`) at `text-ui-base` (default 14px). Bottom right keeps a `View` button at `text-ui-base` (default 14px), 24px high; the secondary copy reserves space for the button and ellipsizes on narrow screens.
- The bottom-right `View` button has an eye icon; click opens the share dialog (`HighspeedShareDialog`) showing acceleration statistics. The bottom-left share card is published only when the card-level aggregated data is complete and the overall speedup ratio is strictly greater than `1.2x`; no data or below the bar (<= `1.2x`) publishes no bottom-left card (the publish gate uses the same criterion as this button's gate, see `highspeedTurnStore.listHighspeedCardAutoShareCandidates`). So a published card always satisfies eligibility and the `View` button always renders. To guarantee this, the notice payload must carry metric facts of the **same precision** as the publish gate: `durationMs`, `savedDurationMs` (milliseconds, not rounded) and `tokenUsage`; the component still re-checks these millisecond fields with the same `isHighspeedShareEligible` as defense in depth, and no untrustworthy or below-the-bar data may enter the share dialog. **The card render side must not re-judge eligibility from display-precision fields (second-rounded values)**: the payload once carried only second-level fields `ceil(duration)` / `round(saved)`, and rebuilding the ratio from seconds on the render side systematically underestimated within the `(1.2, ~1.25]` boundary band (for example 6100ms/1225ms actually 7325/6100≈1.2008x → rebuilt 8/7≈1.14x), hiding `View` on published cards. Second-level display values can only be derived from the millisecond fields at render time; only legacy second-level payloads within <=24h may be read by `×1000` as a backstop. This intentionally differs from the group-tail footer (§9.3): when below the bar the footer is still shown with only the button hidden, whereas the bottom-left share card is not published at all. The share address, share id and the corresponding shareUrl copy chain were removed from Highspeed share (see `docs/highspeed-share-client-generated.md`).
- The top-right close button is `10px` from the top and right, always visible on desktop and touch; it shares the `ghost` / `icon-xs` round button and icon size with the marketing Banner, has no background by default, raises contrast on hover and keeps the keyboard focus ring. It continues to trigger the global notice 24-hour silence rule.
- This phase implements only static layout and basic usable states such as hover/focus, no animation.
- The card uses a light watermark SVG and a dark design base image under Light/Dark/Zai themes respectively; the outer layout still uses the existing sidebar surface.

```text
card expires_at reached -------+
                               +--> aggregate card metrics --> GlobalNoticeStore latest-only snapshot
all accelerated Turns complete +
                                                                          |
                                                                          +--> View opens HighspeedShareDialog (copy image / copy text)
                                                                          +--> Close starts 24h display cooldown
```

### 9.1 Accelerated output worked time

Figma node: `6076:8300`.

- Copy keeps reusing `chat.history.workedFor` / `chat.history.workingFor` and the existing duration formatting.
- The worked-time text of a Highspeed turn uses `text-ui-base`, `font-medium`, `leading-5` and the `icon/purple` (`#9E77ED`) semantic color.
- Ordinary turn worked-time style is unchanged; input messages show no Highspeed visual marker.
- Keep existing collapse, keyboard focus, arrow and responsive behavior; no second history component for Highspeed.

### 9.2 Highspeed composer

Figma node: `6076:8306`.

- The Highspeed result before sending is assembled uniformly by the UI-side send coordinator: one `prepareTurn` produces both the existing command payload override and the card snapshot needed by Renderer statistics, and the ordinary send path must not call or re-interpret the admission result separately. The coordinator does not carry final execution admission; the CLI still does authoritative validation of active turn, queue, automation, runtime model and card validity.
- Keep reusing the existing `ConversationComposer` / `ChatPromptEditor`; no new input, send or model state.
- While a Highspeed card is in effect, the composer uses a `16px` radius, a Highspeed purple stroke and a restrained purple outer glow; the background keeps the theme `input` surface, compatible with light, dark and mobile Web.
- While the Highspeed card is in effect, the context token usage ring in the composer toolbar is hidden; it returns with the ordinary composer state after card expiry or invalidation. This rule changes only display, does not clear usage data, and does not affect the context usage statistics chain of desktop and mobile Web.
- No extra `Fast` label, to avoid changing where the input text starts. The ordinary state keeps rendering the interactive `ModelConfigSelect`; after the Highspeed visual handoff completes it is replaced by an independent read-only model marker with no dropdown, switch shortcut or fake disabled interaction. The read-only marker uses `packages/ui/src/assets/highspeed/lightning.svg` as the lightning icon with purple accent, and its text shows the draw response `card.model` followed by `HighSpeed`; on model hover an internationalized Tooltip shows only "原模型：{model}" (original model: {model}), where `model` is the full model display name of the session / draft config before Highspeed took effect. Remaining time is a fixed-width `HH:MM:SS` control per Figma `6076:8334`, in the fixed order "model → countdown → Think"; the alarm-clock icon does not shake, the time text uses tabular digits and fixed width, renders a single crisp layer of text with no outer glow, so second updates do not cause layout jitter. When the composer is below the `xl` container breakpoint it collapses together with Think: the model keeps only the lightning icon, the countdown keeps only the clock icon and hides `HH:MM:SS`; hovering the clock shows the live remaining time, avoiding toolbar overlap.
- The ordinary composer style is unchanged; after Highspeed expires it returns to ordinary style automatically with the authoritative card state.
- When Highspeed expires or the card does not belong to the current Task, the model entry shows the session / draft config model again; this display switch must not write back to the session's resident model.
- After the card takes effect, after a `500ms` delay a one-time low-resolution purple pixel texture diffuses from the composer center outward; at the tail of the diffusion the model name flips up as a page turn, then a Canvas fade-out and particle fade-in complete the handoff. The stable state keeps showing purple particles, a `#6041FF` stroke and four layers of purple glow, without changing the composer height or business DOM order. Particle glow must be pre-rendered once on an offscreen Canvas and reused as a sprite; the stable state's per-frame drawing must not call `shadowBlur`, so software shadow rasterization does not occupy the Renderer main thread for long.
- The pixel diffusion base color is `--color-highspeed-composer-surface` (light `#FFFFFF`, dark `#151515`), purple is `--color-highspeed-accent`; in the light theme the diffusion must not show dark mosaic. Regression constraint: the production build compresses colors with Lightning CSS (for example `#ffffff` → `#fff`, possibly rewritten into a color name), so the Canvas must hand the token to the browser for normalization before parsing it and must not use a hand-written parser that only knows 6-digit hex; only when the token is missing or unparsable use the dark fallback color. For values the Canvas cannot parse (such as `var()`, which `CSS.supports` still accepts) it silently ignores the assignment and keeps the previous `fillStyle`, so whether parsing succeeded cannot be judged only by reading back after a single assignment, otherwise the default black or the previous token's color would be taken as the result.
- No stroke derived from `currentColor` may flash during the activation transition. Regression constraint: under Tailwind v4, when the input shell does not explicitly declare `border-color` it falls back to `currentColor` (near-white foreground in the dark theme); at activation `border-width` jumps from `0` to `1px` and `border-color` transitions from that near-white to `transparent`, flashing a white ring. The `border-color` of `.chat-composer-input-surface` must be anchored to `transparent` as the transition start, so the stroke stays transparent before and after activation and only fades smoothly from `transparent` into the purple stroke after entering stable.
- No square corners may flash at the moment of switching to Highspeed. Regression constraint: on activation the inner input shell switches from `rounded-2xl bg-input` to `!rounded-none !bg-transparent`, where `rounded-none` takes effect instantly while the base class `transition-colors` makes the background `bg-input → transparent` fade for about `150ms`; during that moment the inner shell is a square that still has a background color, its four corners poke out beyond the input shell radius to form a corner flash that disappears as the background fades. The Highspeed override classes of the inner shell must carry `!transition-none`, so the background switches instantly and no square corners show (under Highspeed the inner shell is always transparent and borderless, so no color transition is needed).
- The model page flip uses a `400ms cubic-bezier(0.55, 0, 0.45, 1)` vertical displacement, X-axis flip and opacity transition; after completing and resting `1500ms`, a purple horizontal sweep plays once. The countdown does only a slight upward fade-in once and takes no part in per-second update animation.
- The activation animation belongs only to a draw that newly hits on this end's send path: only when `prepareTurn` returns accelerated and that `cardId` has not been presented in the current SessionPane before does it play, once, the pixel diffusion, model page flip, sweep, countdown entry, and the stroke and glow gradient (entry mode `activation`). All other presentations are `restore` and show the stable state directly: the diffusion Canvas is not mounted, the model marker and countdown appear immediately and still, no sweep, stroke and glow have no transition, and particles are drawn directly from the loop steady state instead of emerging one by one from an empty field. `restore` covers these acceptance scenarios: switching back to a Highspeed Task; composer remount within the same Task (for example leaving share mode); Renderer reload restored through `getSnapshot`; reused already-presented cards such as consecutive sends with the same card or sending again after switching back; cards drawn on another end (such as mobile Web) or in the background and presented for the first time on this end through recovery. Regression constraint: the recovery chain and a draw hit share the same card snapshot render path, and the composer reuses one instance across Tasks; triggering the animation on "card appears" would remount the background layer from `diffusing` when switching back, and transitions on the existing input shell would re-trigger, replaying the animation. So SessionPane registers a one-shot activation request on the send path, the composer locks the entry mode by `cardId` and consumes it immediately, and later remounts do not replay. The send origin is frozen in the synchronous phase of the user-triggered send (before any async wait such as the config barrier, draft model readiness, Start plan recommendation, empty session creation), recording the Task or draft the pane was bound to at that time. When the prepare result returns, it is presented and the activation registered per the rule above only if the pane is currently showing the Task the card belongs to, or the send origin is a draft and the pane still stays on the same draft (the session built by the first send has not yet been bound back to the pane); otherwise the returned card is still used for this turn's send but is not presented in the current pane and registers no activation, and presents by `restore` through the snapshot when switching back to its Task. Acceptance scenarios: A sends and switches to B before the result returns: B's composer shows no A card and plays no activation; A → B → A with the result returning after returning to A is the first presentation on this end's send path and plays `activation`; if the result returns while still on B, switching back to A later presents by `restore`.
- Under `prefers-reduced-motion: reduce`, the pixel diffusion, page flip and sweep are skipped and the stable material is presented directly; particles stop at a static mid-stage. These states derive only from the current `HighspeedCardSnapshot` and the Renderer-local one-shot activation request, are not written into session, queue, protocol or share statistics, and do not change draw, send, fallback, expiry and share logic.

### 9.3 Accelerated output source footer

Figma node: `6012:18573`.

- One Highspeed card may cover several consecutive accelerated turns; these turns form an acceleration interval identified by `cardId`. Only after the card countdown ends and the current last turn's output reaches a terminal state is the footer "以上由 Highspeed 生成" (the above was generated by Highspeed) and a "分享" (share) button shown once. Terminal states include normal completion, user interruption and abnormal failure; the footer must not disappear because the last turn is not a success.
- The footer is judged by whether the whole card produced output: as long as any accelerated turn of the card produced assistant text, reasoning, tool/subagent output or persisted `outputTokens > 0`, the group tail shows at the terminal state; it is hidden only when all accelerated turns of the card have no output at all.
- When a new accelerated turn appears for the same card, the footer moves from the old group tail to the new group tail; different `cardId`s each keep one footer. Ordinary turns and group-tail turns still generating show none.
- The footer is not shown while the card countdown is still running; the expiry boundary is re-rendered by the conversation time clock without requiring the user to send another message. The expiry clock is based on renderer `setTimeout`; a window hidden/occluded freezes the page and stops timers, which is a platform limitation. Three complementary window-wake compensations exist, all listening to `visibilitychange` (becoming visible) and window `focus`, compensating immediately on return without depending on new messages or snapshot events, and not triggering when switching to hidden: first, the group-tail footer visibility clock (`liveNowMs`) of ConversationTimeline catches up to the current time when the window resumes, so the footer of an expired card appears immediately; second, SessionPane triggers the expiry aggregation chain once (card-level TPS sampling → completed-state persistence → share entry available), so completed-state data of the view/share button becomes available; third, SessionPane's acceleration-state clearing clock: while the expiry `setTimeout` of `activeHighspeedCard` is stalled, after waking, if the real clock says it has expired, clear the card immediately (composer acceleration visuals and model lock exit together), otherwise re-arm the timer by the remaining time; when the timer fires it also judges by the real clock, and if it fires early because of monotonic vs wall-clock skew (or NTP rollback) while the wall clock has not expired, re-arm by the remaining time and do not stop clearing. Regression constraint: the composer countdown is an interval reading `Date.now()` every second and self-heals on wake; without compensation for card clearing, a zombie card appears where "the countdown is at 00:00:00 but the composer acceleration state does not disappear" and only the next message's prepareTurn revives it. Every entry of the aggregation chain (healthy sampling, metrics persistence, auto share) has claim/idempotency protection, so repeated compensation has no side effects.
- The footer uses a faint separator line across the content width with the copy and button centered over the line; background, border, text and hover all use theme semantic tokens, compatible with light, dark and mobile Web.
- The copy uses `text-ui-base`; the button reuses the compact `Button` with an external-link icon and does not duplicate a new share interaction.
- The share button keeps calling the current Highspeed card's share logic. When the current Renderer has completed-state metrics, it aggregates by `cardId`; on cold recovery it likewise aggregates the persisted completed-state metadata of all turns of the card, not only the group-tail turn. When trustworthy metrics are missing or the overall speedup ratio is not greater than `1.2x`, the footer is still shown but the button is hidden, and untrustworthy statistics must not be constructed.
- The footer decorates only the assistant output interval of the whole card; user input keeps the ordinary message style.
- While accelerated output is still generating, all gradient-breathing copy reusing `animated-gradient-text` within that turn ("思考中…" thinking, running tools, retry, etc.) uses the `icon/purple` semantic color uniformly; ordinary turns and finished accelerated turns keep existing colors.

### 9.4 Accelerated output time saved

Figma node: `6079:8738`.

- A `HighSpeed` tag is shown to the right of "worked" of each Highspeed output; ordinary output shows none. "节省约 {duration}" (saves about {duration}) may be shown only after the turn's output reaches a terminal state and the completed-state meta is persisted; it must not be shown early while generating.
- The ordinary speed baseline must not use a fixed constant. Before sending an accelerated turn, a lightweight health method requests only the 7-day data of Coding Plan `/model-performance-day`, reads the latest valid positive `proMaxDecodeSpeed`, and writes that sampled value into the Highspeed message meta; quota, activity, usage detail or 30-day health data must not be fetched for TPS.
- The lightweight health method caches 5 minutes at the Service layer by provider, team context and time zone and merges concurrent requests of the same key; the Renderer no longer keeps a second TPS cache. On the send path this read may only wait best-effort `min(300ms, remaining of the 1s send budget)` (§3 rule 12): on timeout the turn writes no `regularTps` and shows no time saved, and the request is not cancelled and is cached by the Service for the next turn to hit directly.
- While the card is valid the CLI accumulates `outputTokens` in the owning `turnHeader`, and the Renderer reads that authoritative value and the actual working duration only when the Turn completes, and does not show time saved early. After the card expires, `/api/v1/highspeed/:card_id/healthy` is called once, and `highspeedTps = completion_tokens / duration_seconds` gives the card-level average highspeed speed; if the last turn is still generating at expiry, keep this sample first, and only when the sample has no valid positive number or the request fails does it re-query once after the last turn ends.
- The time saved of each completed Turn is computed first from the real duration split persisted by the CLI: `modelSpeedup = highspeedTps / regularTps`, `savedDurationMs = max(0, round(toolDurationMs + otherDurationMs + modelDurationMs × modelSpeedup − (modelDurationMs + toolDurationMs + otherDurationMs)))`. Meaning: tools and other waits do not shorten because the model speed changes; only the model inference interval is scaled back to the ordinary basis by the ratio. This basis needs both `modelDurationMs` and `toolDurationMs` valid; when `otherDurationMs` is absent it is derived as `max(0, durationMs − modelDurationMs − toolDurationMs)`.
- In a mixed Turn only the duration of model requests actually executed by the `highspeed` provider enters the Highspeed time-saved computation of `modelDurationMs`; ordinary-provider requests after card expiry, ordinary model retries and their waits must not count into Highspeed model duration. `durationMs` still means the actual working duration of the whole Turn, and tools and other waits keep the original basis.
- When a historical message lacks the real split, fall back to a 20/80 estimate: `highspeedShare = 0.2 + 0.8 / modelSpeedup` (assuming tools and other waits take 20% and model inference 80% on the ordinary basis), `savedDurationMs = max(0, round(durationMs / highspeedShare − durationMs))`. This estimate is only a backstop and the new chain must not depend on it.
- Turns of the same card share the card-level `highspeedTps`. `regularTps`, `outputTokens`, `durationMs`, the real `modelDurationMs/toolDurationMs/otherDurationMs` split, `highspeedTps` and `savedDurationMs` are persisted as optional completed-state facts of the same Highspeed meta; `savedDurationMs` must be computed and written in the same batch as the split fields, and persisting the split while still storing a 20/80 estimate is forbidden.
- `outputTokens` must come from the single-Turn accumulated value in the CLI authoritative `turnHeader` projection: each main-chain `ModelComplete` adds that output usage to the owning Turn, and subagents, sidecars and other Turns must not be mixed in. The Renderer must not derive single-Turn tokens by observing transient `running` states or subtracting session-level cumulative usage; the result must be the same when desktop continuous updates are merged or when mobile replayable's first recovery is already terminal.
- Fact fields (`outputTokens`, `durationMs`, real duration split) are authoritatively provided by the CLI `turnHeader`; `savedDurationMs` is computed once by the first Renderer to persist completion per the basis above, written into the transcript through the `setHighspeedMetrics` command, and the CLI persists it and publishes the dynamic event of the same user row. The display on desktop `desktop-continuous` and mobile `web-remote-replayable` consumes only the same projected fact and does not recompute independently; only when a historical message lacks the persisted field is it estimated as a backstop at aggregation.
- When card-level healthy fails or returns zero, re-query at most once after the last turn completes; if it still fails, the card-level TPS successfully sampled earlier for that card may be reused. With no valid positive number, or a historical message lacking completed-state fields, time saved is not shown, and a fixed TPS fallback is forbidden.
- The status row uses `icon/purple` text and a 32% faint separator; the left worked duration stays `text-ui-base`, and the right time saved and tag use `text-ui-sm`. The status row may wrap on narrow screens and must not clip core information.

### 9.5 Shared-slot priority with the claim-token marketing Banner

The bottom of the left sidebar keeps only **one activity display slot**, shared by the Highspeed share card (global notice `highspeed-share`) and the "领 token" (claim token) marketing Banner (`resource_position === "banner"`, action `claim_zcode_plan`). When both hit, they **collapse into the same position with the claim-token one covering on top**; only after the claim-token Banner disappears or is closed does the same position show the Highspeed share card.

- Priority is fixed: **claim-token Banner > Highspeed share card**. Their visibility is still owned by their own stores: the marketing Banner by `marketingTouchController`, the Highspeed share card by `browserGlobalNoticeStore`. The slot does only a read-only projection to pick one to render, copies no second state and adds no timer.
- Banner "visible" reuses the single marketing-side predicate `isMarketingBannerRenderable` (`banner && resource_position === "banner" && (image || bannerHero)`); while the claim is `pending` the Banner is still present, and Highspeed keeps yielding.
- When the Banner disappears (`closeBanner()` clears it / server withdraws / no placement after pending ends), `bannerVisible` becomes false and the Highspeed share card reappears in the **same slot**, provided it is still in the 24h visibility window of §6 and not in the dismiss cooldown.
- During yielding, Highspeed's 24h timer is **not paused**: its validity is far longer than the Banner's lifetime, and after the Banner closes `getVisible()` still filters expiry/cooldown by §6, introducing no race; expiry judgment and refresh follow §6 and the existing `GlobalNoticeSurface` logic.

```text
marketingTouchController.banner visible? ─┐
                                          ├─▶ SidebarBottomActivity (read-only arbitration)
browserGlobalNoticeStore.highspeed visible?┘        │
                                                    ├─ Banner visible → render claim-token Banner (covering on top)
                                                    └─ otherwise      → render Highspeed share card
                                                               (unified slot = footer banner slot)
```

## 10. Out of Scope for This Phase

- Moving particles, animations pending UI assets, and extra interaction beyond the final visual draft.
- Notice history list, unread counts, batch read, multi-card carousel, server-side generic Inbox.
- Share history table or session table fields.
