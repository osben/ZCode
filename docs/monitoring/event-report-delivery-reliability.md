# `/event/report` Desktop Delivery Reliability

> Status: First-phase implementation spec.
>
> Goal: Align generated business events with business data as much as possible without blocking business or introducing persistent outbox.

## Scope

First phase only modifies the `/api/v1/event/report` delivery strategy of the common `TelemetryCore` in Desktop Main.
Renderer call sites, `IPlatformService`, IPC schema, event payload, ARMS, CLI OTLP telemetry and Web/mobile `web-remote-replayable` remain unchanged.

Business results, toast, navigation, login/logout and task execution must not wait for telemetry. Crash, force-kill, power-off, long-term offline,
event source not generated, and persistent re-delivery are not within the first-phase scope.

## Delivery Contract

### Request headers

Only App `/api/v1/event/report` reuses `buildZCodeSourceHeadersFromContext` complete public headers: User-Agent, HTTP-Referer, X-Title, X-ZCode-App-Version, X-Platform, X-Release-Channel, X-Client-Language, X-Client-Timezone, X-Os-Category, X-Os-Version, X-Device-Mid. Language, timezone and device ID are consistent with this event context; environment source is current endpoint, version/platform from App context. Missing or illegal values follow the normalization rules of the public function.

Credential service remains the unique owner of login identity; Main injects read-only Authorization loader, each send (including retry) reads `zcodejwttoken` from current active account. When account and event user_id match and token non-empty, sends `Authorization: Bearer <ZCode JWT>`; anonymous, logout, switch to other account, credential read failure do not carry this header. Prohibited OAuth token / API key substitution, prohibited caching JWT, writing JWT into event body or logs. After reading, re-check active account and user_id, discard cross-account async results.

Report request disables automatic redirect, to avoid server 3xx redirecting carried identity/device headers to other addresses; failure still uses bounded retry, not expanding destination.

```text
event context + persisted deviceMid → public parameters (no extra disk read)
each attempt → credential service read and re-check current account → optional Bearer JWT → HTTP POST
```

Reward page web requests do not inject these headers; Website reporting is not within this modification scope. Bridge login/theme/language sync, desktop continuous and mobile replayable boundaries unchanged.

Acceptance: Complete public headers consistent with payload; login/anonymous, logout and switch account, token rotation, retry re-read credentials, read exception anonymous downgrade; observe App reporting with headers on local Electron, simultaneously reward page initial/refresh requests no longer inject App-exclusive headers and Bridge available.

Not verified: real server signature, Windows/Linux real machines and production deployment.

One logical event constructs endpoint, complete request body and `event_id` only once; all attempts reuse same values:

```text
logical event (stable event_id + body)
  -> attempt 1
       +-- 2xx ----------------------> delivered
       +-- network/timeout/408/5xx --> wait 300ms -> attempt 2
       +-- 429 ----------------------> wait 1s ----> attempt 2
       `-- other 4xx ----------------> failed
```

- Each request 5 seconds timeout; at most send twice.
- 2xx treated as server received successfully, does not parse response body business code.
- After second failure, `TelemetryCore` keeps reject semantics; existing UI helper continues to swallow failure, business does not rollback.
- `TelemetryCore` records one final de-sensitized warn, only contains event name, event ID, attempt count, status classification and duration
  details; attempt-level details only for debug.
- Server deduplicates by `event_id`; acceptance requirement is zero business duplicate after deduplication, original request allows same `event_id`.

## Exit Drain

`TelemetryCore` tracks unsolved logical reports within Main process. At normal exit,
`flushPendingReports({ timeoutMs: 2000 })` enters `prepareAppQuit` barrier in parallel with Host、Cron and window settings cleanup.

Flush continuously waits for new in-flight during deadline period; returns early when collection is empty. After deadline, only records remaining count,
does not cancel business, does not change exit result, nor endlessly extend exit.

## Performance Boundaries

- Normal 2xx path only sends one request; public headers do not add disk IO, Authorization read and re-check through existing credential service async each attempt.
- Retry only occurs on recoverable failure, at most one extra request.
- 5 seconds timeout replaces infinite hang, making memory and connection consumption bounded in failure scenarios.
- Exit at most waits 2 seconds in parallel, does not serially expand existing exit budget.

## Verification & Acceptance

Unit tests cover network error then success, 408/429/5xx, permanent 4xx, request abort, stable request body/event ID, final warning,
dynamic drain and drain timeout. Desktop exit tests verify telemetry flush has paralleled into existing barrier.

After launch, only count Desktop clients containing the fix, continuously observe three complete natural days. Using successfully created deduplicated
`off_peak_task_id` as denominator, successfully matched telemetry deduplicated task count as numerator, grouped by business task creation date.
Goal is to improve from approximately 87.6% to at least 95%, with absolute improvement not less than 5 percentage points.

If target is not met, then design persistent outbox、startup recovery and long-term offline re-delivery separately.
