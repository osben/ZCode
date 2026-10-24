# Feedback New API Migration Spec

## Background

The feedback service migrates from the old standalone feedback domain to new ZCode Server endpoints:

- Old: `https://feedback.example.invalid/v1/tickets`
- New production: `https://zcode.z.ai/api/v1/feedback/*`
- New test: `https://zcode.z.ai/api/v1/feedback/*`

The UI and RPC service interfaces are not extended; `IFeedbackService` keeps exposing the existing create, list, detail, comment, and attachment-upload capabilities. The migration stays inside the services layer: HTTP protocol, auth, field mapping, and the anonymous ticket cache.

The default feedback API base must follow the unified ZCode endpoint resolver:

- `ZCODE_ENV=production` or unset → default `https://zcode.z.ai/api/v1`.
- `ZCODE_ENV=test` → default `https://zcode.z.ai/api/v1`.
- Unified endpoint overrides `ZCODE_BASE_URL`, `ZCODE_TEST_BASE_URL`, `ZCODE_PRODUCTION_BASE_URL`, etc. keep working.
- `ZCODE_FEEDBACK_API_BASE` or an explicit `apiBaseUrl` is a manual override only, beating the environment defaults.

Feedback API HTTP egress must go through the services-layer unified `ApiClient`, never global `fetch` directly. The unified `ApiClient` owns ZCode Server endpoint rewriting, `x-request-id`, and the shared-parameter injection in `buildZCodeSourceHeaders()`; the feedback module only adds its own headers and request bodies on top. New shared ZCode Server parameters then need changes only in the unified API client/source headers, not per business module.

## New API contract

All feedback API responses share the envelope:

```json
{
  "code": 0,
  "msg": "ok",
  "data": {}
}
```

`code !== 0` or a non-2xx HTTP status is a failure; error messages prefer `msg`, then the response body.

Core endpoints:

- `POST /feedback/ticket`: create a ticket; JWT optional.
- `GET /feedback/ticket`: list the logged-in user's tickets; requires Bearer JWT.
- `GET /feedback/ticket/{ticket_id}`: ticket detail. Logged-in users use Bearer JWT; anonymous users must send `X-Device-Mid`.
- `POST /feedback/ticket/{ticket_id}/message`: append a message. Same auth split as detail.
- `POST /feedback/attachment/upload-credential`: get an OSS direct form-upload credential. Same auth split.

## Auth and anonymous identity

The service layer reuses the desktop host's unified telemetry `deviceMid` as the feedback anonymous `device_mid`:

- `deviceMid` is ensured synchronously by main via `telemetry-state.json` before window creation and injected into the host process.
- The feedback service no longer maintains a separate `zcodefeedbackclientid`, so one machine is not split into multiple devices across telemetry, ARMS, remote control, and feedback.
- The old `zcodefeedbackclientid` / `X-Feedback-Client-Id` survives only as deprecated data in local credentials — it takes no part in new-API requests or anonymous list isolation.

Header rules:

- Requests go through the unified `ApiClient`, automatically carrying ZCode Server shared parameters: `User-Agent`, `HTTP-Referer`, `X-ZCode-App-Version`, `X-Platform`, `X-Release-Channel`, `X-Client-Language`, `X-Client-Timezone`, `X-Os-Category`, `X-Os-Version`, `x-request-id`.
- With `zcodejwttoken` in local credentials, requests send `Authorization: Bearer <token>`.
- All feedback API requests send `X-Device-Mid: <telemetry deviceMid>` for anonymous ticket ownership and detail access.
- `POST /feedback/ticket` also sends `device_mid` in the body.
- The old `X-Feedback-Client-Id` and `X-Feedback-Account-Id` are no longer sent.

Anonymous users cannot call the server list endpoint. After an anonymous create succeeds, a minimal ticket cache in the feedback data directory backs the "My feedback" list. Logged-in lists come from the server's `GET /feedback/ticket`.

## Field mapping

For ticket creation, old UI inputs map to the new request:

- `title` → `title`
- `description` → `content.description`
- `type` → `content.function`
- `severity` → `content.severity`
- `contact` → `contact`
- `device` → `environment`

`environment` contains at least:

- `app_version`
- `platform`
- `release_channel`
- `os_category`
- `os_version`

`platform` uses the same system-architecture key as `GET /client/configs?platform=...` — e.g. `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`. `os_version` uses the short system release (`node:os.release()`), so macOS's full Darwin kernel string cannot exceed the backend's `feedback_tickets.os_version` length limit.

Extra device-snapshot fields are flattened into `environment` in snake_case instead of nesting under `device`. The UI detail view still maps `environment` back into `FeedbackDeviceInfo` so existing components keep working.

Status mapping:

- `submitted` → `已提交`
- `closed` → `已归档`
- unknown status → `已提交`

`已归档` is a services-layer internal value kept for compatibility with the existing `FeedbackTicketStatus`; the "My feedback" list and detail display it as 中文「已完成」/ English `Completed`, never exposing the compat name to users.

The new API has no old type/module/assignee/event semantics. The services layer keeps UI-type compatibility:

- Create responses use this submission's `type`, `module`, `severity`.
- Server lists without a type default to `bug`.
- Detail messages map to `comments`, with display-only system events generated.

## Attachment upload

The new API drops the old `attachments:init`, chunk PUT, `attachments:complete` protocol. The services layer uses OSS direct form upload:

1. Call `POST /feedback/attachment/upload-credential` with `ticket_id`, optional `message_id`, `file_name`, and `size`.
2. Build the `multipart/form-data` form from the returned OSS `host`, `path`, policy, signature, and callback info.
3. Put the file field last and report upload progress to the UI.
4. After OSS returns 2xx, build a `FeedbackAttachment` from the current file info.

Upload cancellation still aborts the OSS request via `AbortController` and throws `FeedbackUploadCanceledError`.

The feedback form's default diagnostic-log upload still uses the full archive flow, but archive content covers only the logs and light config needed for feedback triage. The client-side precheck cap for log attachments is 1GB; to keep high-frequency protocol streams or plugin caches from bloating archives, the full archive excludes:

- `dev`
- `sessions`
- `session-bindings`
- `checkpoints`
- `repo-snapshots`
- `repo-wiki`

`repo-snapshots` / `repo-wiki` are historical data directories of the retired Repo snapshot upload and Repo Wiki features: upgraded user data roots may still carry them (snapshot encrypted bundles can reach GBs; wiki bodies contain repo paths and references), so the retired features' archive privacy boundary must keep applying.

## Network errors and retry boundaries

Feedback API calls go through Node.js `fetch` / Undici. Network errors must be normalized in the services' unified API network-error classifier; feedback, model connectivity, and other callers must not maintain diverging error-code lists.

Only connection-phase errors that prove the request never reached the backend may auto-retry:

- `UND_ERR_CONNECT_TIMEOUT`
- `UND_ERR_CONNECT_ERROR`
- `ENOTFOUND`
- `ETIMEDOUT` with explicit `connection attempts timed out` or `connect ETIMEDOUT` connection evidence
- `ENETUNREACH`
- `EHOSTUNREACH`
- `ECONNREFUSED`
- `ECONNRESET` that clearly happened before TLS establishment

Ordinary socket drops after the request body was sent, user cancellation, business timeouts, and HTTP failures must not auto-retry as connection errors. Until the backend provides an idempotency-key contract, `POST /feedback/ticket` may retry only the "request never reached the backend" failures above, to avoid duplicate tickets when a response is lost.

After retries are exhausted, services logs keep the redacted target URL, error code, attempt count, and duration. The UI must branch on whether the ticket was already created:

- Failure before ticket creation: do not show raw runtime messages like `fetch failed`; prompt in the current language to check network, VPN, or proxy and retry. The draft, screenshots, and contact info must be preserved for resubmission in the same form.
- Ticket already created but later material (logs etc.) upload failed and entered the error state: never prompt a full-form resubmission. The background state must clearly say "ticket created, but follow-up material upload failed" and open the existing ticket on click, avoiding duplicates. Screenshots keep the existing per-attachment degradation: on failure, write a system comment and continue submitting — this error-routing fix must not turn them into a whole-form failure.

## Multi-surface impact

This migration changes only `packages/services`' feedback HTTP protocol and persistence cache. It does not change:

- the stdio protocol between app and agent.
- task stream, snapshot, queue, owner command.
- the desktop `desktop-continuous` and mobile remote `web-remote-replayable` boundaries.
- main process, relay, or remote host attachment logic.

Desktop local and remote windows both reach the new API through the same feedback service in the host process; Web/mobile remote paths gain no separate Agent runtime or business state.

## Verification

Must cover:

- Ticket creation calls `/feedback/ticket` with `device_mid`, `content`, `environment` in the body and Bearer JWT + `X-Device-Mid` headers.
- All feedback API requests go through the injected unified `ApiClient`, never global `fetch` directly.
- Anonymous create without JWT uses the host-injected telemetry `deviceMid` and generates/persists no separate feedback client ID.
- Anonymous list without JWT hits no server and returns the local anonymous cache keyed by telemetry `deviceMid`.
- JWT list calls the server and maps statuses.
- Attachments complete via upload credential + OSS direct form upload with progress and cancellation.
- Handshake-phase retryable failures still retry.
- Undici `UND_ERR_CONNECT_TIMEOUT` auto-retries successfully after a first failure and recovery.
- Undici connection errors stop retrying after three consecutive failures, logging attempt count and error code.
- After connection errors are exhausted, the feedback form shows the localized network hint, not raw `fetch failed`, and preserves description, screenshots, and contact for retry.
- When post-creation log upload fails with a network error, the UI shows the localized "ticket created" hint and the background entry opens the existing ticket instead of the submission form.
- Run `pnpm typecheck` and `pnpm lint` in full.
