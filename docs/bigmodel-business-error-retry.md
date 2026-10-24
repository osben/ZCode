# BigModel business error retry policy

## Background

BigModel / Z.AI compatible APIs wrap some recoverable failures in business error codes, sometimes inside an SSE error frame of an HTTP 200. The ZCode adapter normalizes such responses to `ProviderBusinessError` at the provider fetch boundary; the model runner classifies them into the unified retry budget.

The policy is deliberately conservative: no retry-directory refactor, no new protocol fields — BigModel business codes are added to the existing classification tables, reusing the existing failure events, retry events, and logs. If an SSE error chunk has no structured `code` field and only a BigModel-style message prefix like `[1302][...][request_id]`, the adapter extracts the four-digit business code before entering the same classification table.

Reference: [BigModel API error code FAQ](https://docs.bigmodel.cn/cn/faq/api-code)

## Implementation locations

- `apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts`
- `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`
- `apps/zcode-cli/packages/adapters/src/model/failure-inspection.ts`
- `apps/zcode-cli/packages/adapters/src/model/provider-finish-business-error.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-retry.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-status.ts`

The implementation keeps reusing the existing retry loop, stream retry boundaries, and log publishing paths. Business-code classification, error-object inspection, SSE error-chunk reconstruction, and delay computation stay in the files above, so provider special cases do not spread into the core runtime.

## BigModel business codes that retry

| Code   | Meaning                                                       | ZCode classification   | retry reason          |
| ------ | ------------------------------------------------------------- | ---------------------- | --------------------- |
| `1120` | temporary account access anomaly; docs suggest retrying later | `model_request_failed` | `server_error`        |
| `1230` | API call flow anomaly                                         | `model_request_failed` | `server_error`        |
| `1234` | network error                                                 | `model_request_failed` | `network_error`       |
| `1302` | excessive concurrency                                         | `model_rate_limited`   | `rate_limited`        |
| `1303` | call rate too high                                            | `model_rate_limited`   | `rate_limited`        |
| `1305` | platform traffic limit or overload                            | `model_rate_limited`   | `rate_limited`        |
| `1312` | model access overload                                         | `model_request_failed` | `provider_overloaded` |

These auto-retry only while no committed model events have been produced upstream. If a streaming request has already produced `text_delta`, `tool_call`, or `finish`, it is never auto-replayed, avoiding duplicate text or duplicate tool calls.

## Retry-After header

When the provider returns `retry-after-ms` or `retry-after`, the adapter prefers the provider-specified wait, capped at a sane 5 minutes. If the same response carries `x-should-retry: false` or `x-should-retry: 0`, the `retry-after`-driven wait is not used; only local retry judgment applies.

The response header must survive all three paths: a `ProviderBusinessError` thrown directly at the fetch layer, one reconstructed from an AI SDK error chunk / finish metadata, and one wrapped by `APICallError.cause`. Otherwise the adapter misjudges `retry-after` as missing and falls back to local exponential backoff.

## Streaming attempt cleanup boundary

Every failed attempt preparing the next physical request must first abort the current request and wait inside a bounded barrier for the iterator and the AI SDK tee retention branch to clean up. This applies both to `iterator.next()` throwing directly and to the adapter scheduling an internal retry after an AI SDK `type: "error"` chunk.

A cleanup failure or timeout must not overwrite the original provider error and must not block retry indefinitely; but the next `streamText()` must not start before cleanup completes or the bounded timeout hits.

## BigModel business codes that never retry

| Code   | Reason                                                              |
| ------ | ------------------------------------------------------------------- |
| `1113` | terminal business error from the provider; retrying changes nothing |
| `1304` | daily call limit; short-term retry changes nothing                  |
| `1308` | usage cap; must wait for reset                                      |
| `1309` | Coding Plan expired                                                 |
| `1310` | weekly/monthly quota cap; must wait for reset                       |
| `1311` | plan lacks model permission                                         |
| `1313` | fair usage restriction; retrying amplifies abnormal traffic         |

These stay non-retryable even when carried by HTTP 429: they are not transient concurrency or platform load issues — auto-retry wastes budget and can worsen provider-side throttling.

## Logging

No new log entry points; the model runner's structured status events are reused:

- `model_request_failed`: one failed attempt, logging `requestId`, `traceId`, `attempt`, `maxAttempts`, `reason`, `retryable`, `statusCode`, and a safe error message.
- `model_retry_scheduled`: next attempt preparation, logging `nextAttempt`, `delayMs`, `reason`, `statusCode`, etc.

Both events are logged at `warn` level by `runner-status.ts`. They are low-frequency lifecycle events, not per-chunk high-frequency logs.

## Test coverage

- `failure-classifier.test.ts`: BigModel transient codes classify as retryable.
- `failure-classifier.test.ts`: quota, plan, and long-term restriction codes stay non-retryable.
- `failure-classifier.test.ts`: `retry-after` survives error-chunk reconstruction and `APICallError.cause` wrapping.
- `runner-provider-business-network.test.ts`: an SSE `1305` business error publishes failure and retry-scheduling events when safe to replay, and the next request succeeds.
- `runner-provider-business-network.test.ts`: `retry-after` in an SSE error chunk decides the next physical request's wait.
- `runner-provider-business-network.test.ts`: after an SSE error chunk schedules a retry, the next physical request waits for the bounded cleanup of the previous abort, `iterator.return()`, and the tee retention branch.

## Future direction

If retry logic is further centralized later, provider business code mapping, HTTP status fallback, network inspection, and retry budget config can converge into `apps/zcode-cli/packages/adapters/src/model/retry/`. No directory-level move is done for now, to keep the change surface small.
