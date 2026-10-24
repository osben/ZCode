# `/event/report` Login Address & Error Body Privacy Boundary

## Objectives & trade-offs

Old implementation wrote complete OAuth authorizeUrl into `app_login_ck.login_url`, and allowed arbitrary events' `error_msg` original text into HTTP body; automated local regex would miss values after Bearer and unknown-format keys.
User confirmed first phase prioritizes privacy: do not encrypt-upload error original text, do not rely on regex guessing which segments are secrets.

- Retain `login_url` field name, only send lowercase hostname of HTTP(S) URL, remove userinfo、port、path、query and fragment. Invalid or non-HTTP(S) URL returns empty string; already normalized hostname can be repeatedly processed.
- **All events** `event_extra_detail.error_msg`: non-empty strings uniformly become `[redacted]`; empty strings remain empty, originally missing fields not added. Including current conversation/automation and future new events.
- Conversation events retain existing `error_type`; automation creation failure fills fixed `error_code`:
  `limit` / `timeout` / `network` / `auth` / `validation` / `unknown`, success is empty.
  Locally identify known error codes/patterns in this order; unknown or missing text classified as `unknown`, only provides coarse-grained attribution,
  does not return matching content, does not promise full diagnostic capability of restored original text. Status, duration and correlation ID unchanged.
- Processing only affects telemetry copies, does not change OAuth browser address, login state, tool results or business error display.
- UI before reporting and Core before serialization use the same pure function; function is idempotent, does not modify caller objects.
  agent_step/message_completion debug payload only records cleaned copies, changed to debug.
- Authentication request header Authorization still used for normal auth, not removed or copied into JSON; deletion of error body is separate matter.

## Chain & Compatibility

```text
OAuth original URL -> browser (original value)
           `-> login_url hostname -> UI sanitize -> IPC -> Core sanitize -> POST
Other UI events -> error_msg [redacted] -> same chain
Host/Main events ---------------------------------> Core sanitize -> POST
```

Shared implementation does not depend on Node, file system or platform API. Windows/macOS/Linux paths, arbitrary URLs,
Authorization values, keys (including multi-line PEM) all removed along with non-empty error body.
Desktop continuous and mobile web-remote-replayable subscription, queue, recovery, message attribution unchanged;
mobile still only forwards existing strict session_create. Theme, language and UI interaction unchanged.
This phase scope is `/event/report` login_url/error_msg; does not extend to ARMS, OTLP, compaction.reason,
template body, `event_text` or other business fields. Existing server-side historical data not repaired or cleared by this client.

## Acceptance

First run new test cases with old code to confirm failure, then verify: login complete URL only used for openExternal;
UI reporter/debug log and directly called Core final request body have no error original text; empty/missing/duplicate cleaning semantics stable;
future unknown events also cleaned; original object unchanged; network retry reuses cleaned body and event_id; normal Authorization
header maintained; verify actual received body with local controlled HTTP receiver does not contain synthetic sensitive markers.
Run related unit tests, pnpm typecheck, pnpm lint; uncovered real Electron/mobile/cross-OS real machine records in commit description.

## Verification limits

The new regression was first run against the old implementation and failed (original URL, original error body,
logs and final HTTP body); it passes now, including a real local HTTP receiver, retry body, normal auth header,
OAuth original address, parent/child agent, workflow, automation and the mobile `session_create` boundary. Windows/
Linux paths are covered as input cases only; no Windows/Linux real machine, real Electron login, mobile browser
E2E, real account or production network reporting was run. `architecture:check` passing does not prove all runtime
boundaries of the legacy/unmanaged shared/ui/services modules; the shared cleaning is an I/O-free pure function and
changes no business state owner.

## Field Table & Report Migration

- [Business monitoring agent_step / message_completion field table](business-monitoring.md): use `error_type` to aggregate failures, no longer cluster or search by `error_msg` original text.
- [Automation message telemetry field table](automation-message-telemetry.md): same error body privacy semantics.
- [Performance telemetry catalog](performance-telemetry-catalog.md): only constrains `/event/report` fields here, not extending to ARMS/OTLP.
- [Scheduled task management report](../ui/scheduled-tasks-main-view.md): `automation_create_result` original `error_code` was empty; this fills classification, report uses this field. Classification coverage needs separate `unknown` ratio check, cannot treat unknown classification as success.

Review fixes CR-01/CR-02: first sync above existing specs, then verify classification and privacy with actual reporter's failure/success reporting; failures lacking error info must still emit `unknown`, success must not carry stale error classification.
