# 02 — Connection Log and Error Contract

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:** none.

**Behavior to deliver:**

- **Clean, readable logs**: during a connection, the user sees only logs of this connection, already redacted.
- **Failure has a result**: refused, timed-out or host-not-found connections show a Chinese error within a reasonable time and never stay on "connecting".
- **Logs after failure**: after a failure, even if the wizard is closed, the device card in Settings can show the log of the device's most recent connection or update.

It corresponds to the "connection error classification" contract and the "connection log and operation log" section of the parent spec.

Scope:

- **Forwarding scope**: the connection progress context forwards only logs that the connection pipeline reports on purpose. Surrounding logs from other services in the same async context never enter the user-visible log, for example the complete settings content printed when the settings service writes config.
- **Redaction**: uniformly remove local absolute paths, tokens, credential references and device identifiers. Logs attached to feedback use the same filtered result.
- **Log level**: waiting for the user to confirm installation is recorded as info, not error.
- **Error code contract**: extend the error code set.
  - Cover: refused or unreachable, timeout, host not found, host key changed (when reliably identifiable), download failure, upload failure, preflight failure, install failure, insufficient remote space or permission, user cancel, unknown.
  - Shared types and runtime schema are updated together.
  - `AggregateError` takes the inner error code.
  - An empty or unrecognized message is classified as "unknown". A host response must not be dropped because of a schema validation failure.
- **Error copy transition**: new error codes first plug into the existing error copy mapping, in Chinese and English. The full classified display is taken over by [03](./03-presentation-model-states-and-glossary.md).
- **Recent operation log**: the service layer keeps the most recent connection or update operation log per device and adds a query interface. The log lives only in memory for this run, has a line limit, and is isolated between devices. The Settings device card provides a "查看最近日志" (view recent log) entry.

Acceptance criteria (all met):

- **Logs do not leak**: throughout the connection test container run, neither the user-visible log nor the feedback attachment contains settings content, local project paths, the connection profile or device identifiers. Needs main-process/host contract-layer tests; E2E asserts it too.
- **Waiting for confirmation is not shown as an error**: while waiting for install confirmation the log level is info and the UI does not show red error.
- **Refused connection no longer hangs**: connecting to an unused port shows "无法连接到主机" (cannot connect to host) within 5 seconds.
  - Contract-layer tests with `AggregateError` and empty-message failures assert a classified error code, a non-empty message, and that the host response passes schema validation.
- **Timeout and host not found**: each returns its own error code and Chinese copy; the UI falls back to generic copy for an unknown error code.
- **Both ends in sync**: shared types and runtime schema are extended together; App-side and host-side validation agree.
- **Logs after failure**: after the wizard is closed, the Settings device card still shows the device's most recent connection or update log; logs of several devices do not cross-talk. Needs service-layer tests and component tests.
- **Update fact documents**: the paragraphs on connection logs, error codes and operation logs in the remote main-chain fact documents are updated to the latest behavior.
- **Required checks**: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected SSH E2E all pass before the local commit.

## Verification Record (2026-09-27)

- Implemented and passed the dual-axis review (conventions/spec); the review findings (auto-reconnect closure retention, identity-generation log cross-talk) were fixed and regression-tested.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` pass; 15 related unit test files with 251 tests pass, covering concurrent/late output, the per-device 100-line cap, identity generation, Host schema and component reopen queries.
- Real SSH container verification: retry after a wrong password, first install, directory selection, full-run log filtering, and Chinese failure within 5 seconds on an unused port with prefilled feedback; the final round passed 2/2 (artifact `remote-log-contract-20260927-verified`). Dark/light themes and 1400/480px screenshots were checked; 480px is desktop responsive verification, not real-device mobile replayable. The new RDUX-LOG case stays pending and was not promoted manually.
- **Full verification limits**: the full `pnpm test:unit` run required by the implement skill had failures in unchanged modules and a hanging worker, and was stopped after more than 15 minutes. Run alone, `packages/services/test/repoSnapshotUploadTransport.test.ts:133` fails two cases with `ReferenceError: mode is not defined` (the same code is on the HEAD baseline); `autoUpdaterReadyState.test.ts` still does not exit for a long time in threads/forks alone. This ticket changes neither module; the user, aware of these limits, explicitly authorized the local commit.
- The global coverage audit's new pending fixture check passes; the overall audit fails on baseline D19/I74/I75 references and stale statistics and generated documents. The case fixture check and E2E type check for this ticket's new case pass.
