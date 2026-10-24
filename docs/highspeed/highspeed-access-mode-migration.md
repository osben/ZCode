# Highspeed Migration to the Post-Provider-Refactor Model Contract

> Status: in progress (2026-09-14).
> Scope: move the single-turn inference routing of the Highspeed acceleration card from the retired `turnRuntimeModel` to `modelSelection` + `modelExecution{selectionScope:"execution"}`, and add the `zhipu-account` `highspeed` Access mode for accelerated requests.
> Related: [highspeed-card-spec.md](./highspeed-card-spec.md), `docs/working-memory/provider-refactor/steps/todo-142-start-offpeak-signing-exceptions.md`

## 1. Background and Problem

Highspeed predates the Provider refactor. It used `turnRuntimeModel` (`zcodeModelRuntimeConfigSchema`) to ship "which model this turn uses" and "which endpoint/credentials to call" as one bundle with the send:

```ts
// Retired contract: static facts and dynamic credentials mixed in one object
turnRuntimeModel: {
  revision: `highspeed-${cardId}`,
  model: { providerId: "highspeed", modelId: card.model },
  provider: {
    providerId: "highspeed",
    kind: "anthropic",
    baseURL: `${origin}/api/v1/highspeed/anthropic`,  // static fact
    apiKey: { source: "inline", value: jwt },          // dynamic credential
    headers: { Authorization: `Bearer ${jwt}`, "X-Highspeed-Card-ID": cardId },
    models: [{ modelId: card.model }],
  },
}
```

The Provider refactor deleted the `zcodeModelRuntimeConfigSchema` / `zcodeModelRefSchema` / `zcodeModelProviderInputSchema` family and replaced it with **static/dynamic separation**:

- Endpoint, API shape and model capabilities (**static facts**) come only from the ZCode Built-in Provider Config.
- Only the **per-execution dynamic auth material** (`apiKey` / `headers`) ships with the send.

The official build's request security-check exemption also moved from an "endpoint path allowlist" to the shared Adapter judging by Access mode. Todo142 forbids judging exceptions by Provider ID, model name, key content or endpoint path. The endpoint-path allowlist exemption Highspeed relied on was deleted with the refactor.

## 2. Migration Decision

Highspeed and Off-Peak are the **same class of problem**: single-turn, non-persistent, dynamic credentials, hidden Provider, shared `zcode.z.ai` gateway, exempt from the official build's request security check. Off-Peak is already migrated, so Highspeed reuses the same mechanism instead of building a parallel pipeline.

| Concern                             | Old Highspeed                          | After migration (aligned with Off-Peak)       |
| ----------------------------------- | -------------------------------------- | --------------------------------------------- |
| Endpoint / API shape                | `turnRuntimeModel.provider.baseURL`    | `api.baseUrl` of the Built-in Provider Config |
| Model                               | `turnRuntimeModel.model`               | `modelSelection{providerId, modelId}`         |
| Credentials                         | `provider.apiKey` + `provider.headers` | `modelExecution.requestAuth{apiKey, headers}` |
| Non-persistent semantics            | install turn overlay, restore at end   | `modelExecution.selectionScope = "execution"` |
| Security-check exemption (official) | endpoint path allowlist                | judged by `access.mode`                       |

`selectionScope: "execution"` is strictly stronger than the old overlay: it never writes the session's resident selection, so there is no install/restore pairing and no idempotent cleanup. The old `applyTurnRuntimeModelForPrompt` / `host.applyTurnRuntimeModel` / `host.clearTurnRuntimeModel` are retired.

## 3. Contract Changes

### 3.1 New Access mode

`zcodeProviderAccountAccessSchema.mode` gains `"highspeed"`:

```ts
mode: z.enum([
  "start-plan",
  "individual-coding-plan",
  "team-coding-plan",
  "off-peak",
  "highspeed",
]),
```

> Naming boundary: `highspeed` here means the **acceleration card** account access category. It has nothing to do with the model name `GLM-5.1-Highspeed` (an ordinary fast model variant) or the E2E fixture `e2e-glmhighspeed`; the literal overlap is coincidental.

### 3.2 New Built-in Providers (static facts)

`providerConfigRules.providerRules` in `config/provider/zcode-builtin.json` gains two hidden Providers, isomorphic to Off-Peak. Access `accountType` is a required enum, and the acceleration card draws on the current account's Coding Plan entitlement, so the Providers **must be split by account Family**; there is no silent cross-Family migration:

| providerId                        | accountType | baseUrl                                         |
| --------------------------------- | ----------- | ----------------------------------------------- |
| `account:zai-highspeed-card`      | `zai`       | `https://zcode.z.ai/api/v1/highspeed/anthropic` |
| `account:bigmodel-highspeed-card` | `bigmodel`  | same as above                                   |

Both are `visibility: "hidden"`, `api.type: "anthropic-messages"`, with `builtinModelIds` equal to the same-Family Coding Plan Provider. The card echoes the model the user currently selected (`card.model` is the model submitted with the request); acceleration comes from changing the endpoint, not the model.

**Site capability rules must be added in step.** `modelConfigRules.providerSiteRules` match by `baseUrl`; without a rule the new endpoint silently falls back to the conservative defaults of `modelRules`. The acceleration endpoint must align item by item with the Coding Plan sites (`api.z.ai` / `open.bigmodel.cn` / `zcode-plan`), so two rules are added:

| Match                                               | Properties                                                               | Aligned with                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `https://zcode\.z\.ai/api/v1/highspeed/anthropic/?` | `inputFormat.supportsImage/supportsVideo = true`                         | same as `zcode-plan`                                                                |
| same + `apiTypeMatch: anthropic-messages`           | `supportsMidConversationSystem = true`, `supportsNativeWebSearch = true` | same as `zcode-plan`, **unlike `off-peak`** (Todo140 only disables off-peak search) |

Capability facts must stay stable within one conversation instead of jittering with whether this turn is accelerated:

- `supportsMidConversationSystem` decides whether system blocks may stay mid-conversation. If ordinary turns say `true` and accelerated turns `false` in one transcript, the same history is rewritten two ways. All Zhipu sites (including `off-peak`) are `true`, so there is no ambiguity.
- `supportsNativeWebSearch` decides whether `shouldExposeWebSearch` exposes WebSearch to the model (`apps/zcode-cli/packages/core/src/runtime/methods/config.ts`, which reads the **Active Model of this turn**). `false` would give accelerated turns one tool fewer, turning "only changes speed" into "also changes the tool set".
- `inputFormat` decides whether attachments can enter the turn. If ordinary turns support images and accelerated turns do not, already-written image input loses validity at send time.

**The pre-migration behavior differed**: `buildHighspeedTurnRuntimeModel` assembled `baseURL` itself and the config had no such site, so accelerated turns got the `modelRules` defaults (MCS, search, image all `false`). That was not a design conclusion, only a side effect of having no site rule. If the backend confirms the acceleration endpoint does not pass through native web search, change that single property to `false`; the rest of the migration is unaffected.

**The test-environment release bundle must be derived in step.** The production file `config/provider/zcode-builtin.json` is the only edit source; `config/provider/zcode-builtin.test.json` is mechanically derived by `pnpm provider:config:sync-test` (`ZCODE_ENV` selects which loads). The script rewrites `zhipu-account` `baseUrl` by an endpoint allowlist and copies site rules, so the new acceleration endpoint must also register its test twin endpoint, otherwise `pnpm provider:config:check-test` throws `Unknown account Provider endpoint` and the card gets no Provider in the test environment:

| Location                                                                                  | Content                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountEndpoints` in `scripts/sync-test-builtin-provider-config.mjs`                     | `https://zcode.z.ai/api/v1/highspeed/anthropic` → `https://zcode.z.ai/api/v1/highspeed/anthropic`                                                                                                                                     |
| `pairs` and count assertions in `scripts/test/sync-test-builtin-provider-config.test.mjs` | That test keeps its own endpoint table to verify the script allowlist was not changed wrongly; after adding built-in account Providers, update the `providerRules` count and derived site-rule copy count together (currently 10 / 9) |

### 3.3 Single-turn execution material

The `accelerated` branch of `HighspeedPrepareTurnResult` no longer returns `turnRuntimeModel`; it returns execution material that projects directly onto the protocol:

```ts
| {
    kind: "accelerated";
    card: HighspeedCardSnapshot;
    nextDrawAt: number;
    /** Mock keeps only the acceleration business semantics; omitting this field continues on the session's ordinary inference route. */
    execution?: {
      modelSelection: ModelSelection;
      requestAuth: { apiKey: string; headers: Record<string, string> };
    };
  }
```

Sending uses existing protocol fields; no new protocol field:

```ts
sendText({
  modelSelection: execution.modelSelection,
  modelExecution: {
    selectionScope: "execution",
    requestAuth: execution.requestAuth,
  },
  highspeedMeta, // card snapshot still enters message.data as an input fact, no credentials
});
```

`highspeedMeta` semantics are unchanged: it is a **projection card snapshot** without credentials or headers, and is persistable. Credentials live only in `modelExecution.requestAuth`, accepted only by idle `startNow`, and never enter the ordinary `CommandInbox`, so the queue persistence surface is unchanged. This matches the old rule "the queue persists only card metadata without credentials".

### 3.4 Security-check exemption

The official build's request security check judges the exemption by `access.mode`: `highspeed` is an exempt account mode like `start-plan` and `off-peak`. The endpoint path allowlist is not restored; Todo142 forbids path-based exceptions. The implementation exists only in the official build and is not expanded here.

### 3.5 Declarative single-turn fallback: `modelExecution.selectionFallback`

**This field is new in the staging contract in this migration** (`packages/shared/src/model-execution.ts`). The old implementation switched the rest of the requests back to the original model after card expiry through the overlay restore interface. Since `selectionScope: "execution"` never rewrites the Session Selection there is no "restore" step, so the initiator must **declare** which errors count as "this turn's execution credential is invalid":

```ts
selectionFallback: {
  providerId: string,
  // Matched in declaration order; the first hit decides the fallback reason; omitted providerErrorCode means any failure of that provider
  rules: Array<{
    reason: "highspeed_card_expired" | "highspeed_request_failed",
    providerErrorCode?: string,
  }>,
  // Fallback target: the selection submitted when the initiator drew the card (original session model + tier); the pre-admission Session candidate is kept as well.
  target?: ModelSelection,
}
```

The acceleration card declares `[{ reason: "highspeed_card_expired", providerErrorCode: "3402" }, { reason: "highspeed_request_failed" }]`: card expiry is reported with its own reason, and any other failure (auth, rate limit, 5xx, network, timeout, stream interruption) also falls back.

The send entry freezes the fallback target from the ordinary selection of that user message as `selectionFallback.target` and passes it explicitly. Before admitting the input, Core copies the ordinary Session Selection as a second candidate for when the declared target is missing or unresolvable. This is an acceleration-card-specific fallback snapshot: new inputs may update the Session, but error handling must not re-read the Session to change an old accelerated turn's fallback target. The fallback request no longer carries this execution's `requestDependencies`, i.e. it uses the user's regular auth.

The CLI only does pure matching (`turn-execution-fallback.ts`, called by `turn-model-step.ts`): when the providerId of this turn's execution Selection matches the declared value and the failure attribution does not point at another provider, the first matching rule in order falls back once. **No hard-coding by provider id prefix, model name or error text** (the same discipline as Todo142). The fallback reason comes from the matching rule; the CLI does not interpret error codes itself.

The fallback target is the declared `target` first, then the Session Selection pinned before admission. Admitting the user message binds the ordinary submitted selection to the Session; the acceleration endpoint never enters the Session; later messages cannot change the candidates already pinned for the current accelerated turn. On cold recovery the old session selection may not be bound yet, so the initiator must ship the selection at draw time as `target` in the declaration.

Boundaries to keep:

- **Fall back only once**: after fallback, `state.selectionFallback` is cleared; if the ordinary model fails again, the whole turn fails with the real error.
- **Fail when there is nowhere to fall back**: when the declared `target` and the resident session `modelSelection` are both missing or both unresolvable, the turn fails with the real error. The old `if (fallbackModel)` was always true and buried this branch under another error. Now candidates are tried in order; an unresolvable candidate (absent from the Registry) is skipped without interrupting; when all fail, log `warn` `model.execution_selection.fallback_unavailable` and return the original error.
- **Regression constraint (2026-10-09 log review)**: the fallback target once depended only on the runtime's resident session selection. After a desktop restart, cold recovery finished within 600ms after the Provider Registry became ready, while the account provider was still `entitled:false` with no published models, so validation of the persisted selection hit `provider-not-found` and did not bind; the next two turns were both accelerated, the runtime never had a resident selection, and on 3402 the degradation silently skipped and the whole turn failed. With `target` declared by the initiator this timing no longer matters.
- **Failures that do not degrade**: user cancellation and context overflow match no rule; overflow goes to reactive compact. Local runtime failures without provider/network attribution (event persistence, projection) must not be misjudged as acceleration request failures by a catch-all rule.
- **Fallback takes precedence over same-model stream recovery**: failure handling order is declarative fallback → stream recovery → Start Plan admission retry → overflow compact → whole-turn failure. If a failure hits the fallback declaration but no fallback target is resolvable, fail directly with the real error; do not continue stream recovery on the accelerated model. If fallback came after recovery, a stream interruption would first retry on the accelerated model until the budget is exhausted. When `TurnExecutionModelFallback` reaches projection it must first mark the abandoned text/reasoning stream `interrupted` and mark unfinalized `inputStreaming` tool rows `cancelled`; the original model's later output must open a new row, must not be concatenated with the accelerated output, and abandoned output must not be marked complete.
- **Execution handle with 0 retries**: an execution-scope model handle that carries `selectionFallback` and whose Selection points at the declared provider is bound to `ModelRetryBudget.SingleAttempt` (`createTurnModel(..., { retryBudget })`); the adapter layer reduces that request's `maxAttempts` to 1. The session model handle after fallback keeps the taskType default budget.

### 3.6 Protocol validation: `modelExecution` must not appear alone

`modelExecution` describes "how to call"; the Selection says "whom to call". With the two separated, the protocol layer must guarantee that no request carries credentials without a selection, otherwise execution would call the session default Provider with the acceleration card's credentials. In `packages/shared/src/zcode-protocol-v4/command.ts` each of three commands gets a superRefine:

| Command         | Before   | After                                            |
| --------------- | -------- | ------------------------------------------------ |
| `sendText`      | existing | kept                                             |
| `editUserQuery` | none     | **new** `modelExecution requires modelSelection` |
| `sendQueuedNow` | none     | **new** same                                     |

`editUserQuery` / `sendQueuedNow` are the only other entries from which Highspeed can restart an accelerated turn; before the migration they needed no validation because `turnRuntimeModel` carried its own model.

### 3.7 Access resolution: the acceleration card is not a standalone plan

`off-peak` and `highspeed` are not standalone plans but execution entries derived from a connected individual/team Coding Plan: request-time auth comes from a ticket and the card JWT respectively, and there is no plan key to validate. `accountProviderConnectionResolver.ts` extracts the three staging `mode === "off-peak"` literal checks into `isCodingPlanDerivedMode(mode)`, covering both derived modes:

1. The candidate set of the Coding Plan availability check (derived modes do not count as a configured plan).
2. Availability projection (a derived Provider's availability follows the current Coding Plan selection).
3. `resolveCurrentAccountAccess`: derived modes only require the current selection to be an individual/team Coding Plan, not a direct `selection.kind === mode` comparison.

So the acceleration card Provider's static `access.mode = "highspeed"` resolves to the user's **current** individual/team Coding Plan access fact and does not freeze the old entitlement after an account switch.

### 3.8 Time-saved statistics: `CodingPlanRegularTpsRequest.accountAccess`

`CodingPlanRegularTpsRequest` in `packages/shared/src/usage-stats.ts` changes from `organizationId` / `projectId` to a required `accountAccess`:

```ts
accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
```

Bug cause: the request used to carry only org/project, and request-time auth relied on the host guessing the account from the provider. After the Provider refactor, Coding Plan authorization is resolved uniformly through `accountAccess` (Team scope is included), and when it is missing `resolveAuthorization` always returns `null`, so "time saved" silently does not show. The cache key is now the whole access object instead of the org/project pair.

### 3.9 Event payload: `TurnExecutionModelFallbackPayload` field rename

`ModelRef` was deleted in the refactor, so the two fallback event fields are renamed (`contracts/src/events/session.events.ts`):

| Before                   | After                                |
| ------------------------ | ------------------------------------ |
| `fromModelRef: ModelRef` | `fromModelSelection: ModelSelection` |
| `toModelRef: ModelRef`   | `toModelSelection: ModelSelection`   |

This changes the **shape of a persisted event payload**, but the event is Highspeed-only and produced only on card expiry, so there is no cross-version compatibility surface: the pre-migration highspeed branch was never released.

### 3.10 Renderer send path

In `packages/ui/src/v4/SessionPane.tsx`, `dispatchCommand` inserts a 7th positional parameter `highspeedCard` after the 6th, `telemetrySeed`; staging's former 7th, `onEnvelopeCreated`, moves to 8th. All call sites were checked; none passes the callback as the card snapshot.

First send of a draft session can no longer reuse `createSession.firstInput`: the draw needs the real `sessionId` (for in-flight draw ownership and card reuse), so the first send uniformly goes through `createSession` + a separate `sendText`. **Cost: a first send without attachments also costs one more round trip.** This lets the draw and the send share one session identity and avoids a dangling state on the firstInput path where the card is drawn but the session id is unknown.

## 4. Sequence (after migration)

```text
Renderer                       Highspeed service            CLI admission            Adapter
   | prepare(task, model)              |                          |                     |
   |---------------------------------->| draw / reuse card        |                     |
   |                                   |                          |                     |
   |<-- accelerated{card, execution} --|                          |                     |
   |                                                              |                     |
   | sendText{modelSelection, modelExecution{execution, auth},     |                     |
   |          highspeedMeta}                                       |                     |
   |-------------------------------------------------------------->|                     |
   |                                          selectionScope=execution                   |
   |                                          => does not write the session resident selection |
   |                                          => no install/restore overlay needed       |
   |                                                              |                     |
   |                                          resolve provider by providerId             |
   |                                          (Built-in Config: baseUrl/api/models)      |
   |                                                              |-------------------->|
   |                                                              |  access.mode=highspeed
   |                                                              |  => exempt from official-build security check
   |                                                              |  => send the request directly with requestAuth
```

## 5. Unchanged Semantics

These existing rules are unaffected by the migration and must be kept:

- Automation dispatch turns (turns with an `automationId`) do not draw a card; even if execution material is received by mistake, the CLI must ignore it and keep hiding Automation write tools.
- 1-second fallback, `next_draw_at` cooldown authority, single in-flight draw, foreign cards silently sent as ordinary.
- When the card expires mid-Turn (`HTTP 400 / provider_code=3402`), context is kept, the remaining model requests switch back to the original session model from before the send, and the user is notified once. The original model must still be resolved from the currently valid workspace model catalog.
- Runtime state is ultimately the Core `activeTurn`; carrying execution material does not change `queue` admission semantics.
- A Mock draw still returns only the `accelerated` business state without `execution`; the message flow keeps using the session's ordinary provider/model and original inference interface.

## 6. Known Leftover Deviations

Found during this migration but **existing staging debt**, not fixed here and recorded so they are not mistaken for migration-introduced:

### 6.1 `v4-native-boundary` no-bridge ban is already red

`v4-native-boundary.test.ts` asserts that no file under `zcode-protocol-v4/` imports `zcode-protocol/`. Staging already has 3 violations (`session-flow.ts`, `goal-compact.ts`, `prompt-turn.ts`). This migration makes `fork-edit-retry.ts` and `queue.ts` also take `createModelExecutionContext` from `../../../zcode-protocol/model-execution.js`, adding 2 lines to the violation list.

The import style matches staging (`session-flow.ts` takes the same symbol from the same path); no separate shim is made for the acceleration path. The proper fix is to move `model-execution.ts` into the v4 tree and fix all 5 places at once, which is staging's M4 wrap-up work.

### 6.2 CLI test files do not take part in typecheck

The `include` of `apps/zcode-cli/packages/bootstrap/tsconfig.json` is only `src/**/*`, so test files are not in `tsc --noEmit`. The consequence has already happened: the Highspeed fixtures in `transcript-hydration.test.ts` kept the deleted `providerID` / `modelID` key names after the Provider refactor, so all selections silently became `undefined`, and the assertion "accelerated turns do not take part in the ordinary model switch baseline" falsely passed for a long time (0 markers vs 0 markers). It only became effective after the key names were fixed.

## 7. Verification

- `pnpm typecheck`, `pnpm lint`
- shared: `zcodeProtocolV4Command.test.ts`
- services: `highspeedCardService.test.ts`
- provider-node: `builtin-provider-build.test.ts` (including the `sync-test` contract: the production file and the derived test release bundle agree)
- ui: `highspeed/highspeedSend.test.ts`
- CLI bootstrap: `v4-native-commands.test.ts`, `v4-native-queue.test.ts`, `v4-native-fork-edit-retry.test.ts`, `automation-port.test.ts`, `transcript-hydration.test.ts`, `session-persistence.test.ts`
- e2e: `conversation-session-highspeed-card.test.ts`
