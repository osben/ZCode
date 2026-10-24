# Provider business errors after cold hydration

Status: implemented.

## Problem

After a Start Plan turn failed with provider business code 3009 (`model concurrency limit exceeded`, HTTP 429) and the session was reopened, the chat showed the generic error banner with a feedback draft instead of the Start Plan concurrency-limit banner. The draft carried `TraceID: hydrate-trace`, which identifies nothing.

## Facts from the code

- The persisted assistant message keeps `error.name = "AiSdkModelAdapterError"`, `error.data.code = "model_rate_limited"` and `error.data.attribution.providerErrorCode = "3009"`.
- Cold hydration (`transcript-hydration.ts`, `collectTurnOutput`) rebuilds the failure as `TurnError` with `type = error.name`, no `code`, and the persisted attribution.
- The projection (`product-projection.ts`, TurnError) sets `lastError.code = error.code ?? error.type`, so the hydrated code is `AiSdkModelAdapterError`. It also copied `event.traceId`, which for every hydrated event is the shared `HYDRATION_TRACE_ID` sentinel.
- `useV4SessionQuotaBanner` passed only `lastError.code` to the business-code resolvers. `AiSdkModelAdapterError` is neither a business code nor a known wrapper code, so the concurrency banner did not take over the error.

## Product rules

1. The provider business code of a session error is `attribution.providerErrorCode` when present, otherwise `code`. This applies to the Start Plan quota (1005), concurrency (3008/3009/3010) and GLM plan-limit banners, live and hydrated alike.
2. A session error restored by cold hydration has no `traceId`. The feedback draft then omits the TraceID line rather than showing the sentinel. Live errors keep their real trace id.
3. The `HYDRATION_TRACE_ID` value on hydrated events is unchanged; it remains the replay sentinel used by the projection.

## Owners

- Business-code selection: `packages/ui/src/v4/useV4SessionQuotaBanner.ts` (single place that feeds the banner resolvers).
- `lastError.traceId`: the runtime projection (`product-projection.ts`).

## Acceptance

- Hydrating a persisted 3009 failure yields `lastError` with `attribution.providerErrorCode = "3009"` and no `traceId` (`apps/zcode-cli/packages/bootstrap/tests/transcript-hydration.test.ts`).
- On a Start Plan provider, an error with `code = "AiSdkModelAdapterError"` and `attribution.providerErrorCode = "3009"` is taken over by the `concurrent-limit` banner; on a non-Start Plan provider it is not (`packages/ui/test/useV4SessionQuotaBannerBusinessCode.test.ts`).
