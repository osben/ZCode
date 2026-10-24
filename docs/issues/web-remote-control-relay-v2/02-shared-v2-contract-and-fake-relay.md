# 02 — Relay V2 shared contract and fake relay test fixture

**What to build:** Without changing any existing V1 behavior (expand phase), give desktop and phone the shared
Relay V2 contract: V2 relay message types with runtime validation; HTTP contract types for device registration/
list/delete and the one-time token; QR URL build/parse without `hash`; V2 heartbeat constants; and an in-process
fake relay V2 shared by both ends' tests. Afterwards either end can write and run tests for the V2 handshake,
heartbeat, error codes and HTTP failures without live environments.

**Blocked by:** None.

**Status:** in-progress

**Parent:** [Web remote control on Relay V2: phone logs in, then connects to the desktop](./01-relay-v2-login-pairing.md)

## Acceptance criteria

- [x] Docs first: create the `docs/web-remote-control/relay-v2-pairing.md` skeleton with the V2 WebSocket
  message contract (`auth_init` without `role`, `pair_status_query` without `device_sid`, `client_ts` in Unix
  seconds), the HTTP contract (device register/list/delete, `role=device|terminal` one-time token) and the
  fake relay's capability boundary.
- [x] shared adds V2 inbound/outbound relay message types, HTTP request/response types and runtime parsers
  that reject illegal fields. V1 types and parsing stay untouched and existing shared tests pass.
- [x] The QR URL builder supports the V2 shape without `passHash`/`timestamp`; the parser accepts URLs with
  `sid`, `mid`, `name`, `app_version` all optional and no `hash`. V1 parsing with `hash` is unchanged.
- [x] Heartbeat constants gain a V2 group: base 5 s, jitter ±1 s, ACK deadline 15 s; V1 constants stay.
- [x] Fake relay V2 fixture: in-process HTTP handlers for device register/list/delete and token issuing plus
  a `/api/v1/remote/ws2?token=` WebSocket server. Tokens are one-time and bound to role and user; `auth_init`
  checks device ownership and answers `AUTH_FAILED` for another user's device; a new connection of the same
  role replaces the old one and sends it `KICKED`; `data` passes through between the paired sides with
  `client_ts` replaced by `server_ts`.
- [x] The fake relay can script `pair_status` of `auth_ack`/`pair_status_ack`, any error code
  (`AUTH_FAILED`/`WRONG_PARAM`/`KICKED`/`INTERNAL`/`DEVICE_OFFLINE`), server-initiated disconnects, and HTTP
  401/5xx/network errors; it records every received message and HTTP call for assertions. It serves both Node
  `ws` clients and browser-WebSocket-compatible clients.
- [x] The fake relay has its own tests proving the above matches the V2 doc. The fixture lives where desktop
  and phone tests can both import it; the location is decided at implementation and written into
  `relay-v2-pairing.md`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests pass.

## Comments

2026-09-19: Feature implementation is done; the verification gate still has baseline/environment blockers, so
the status stays `in-progress`; nothing committed.

- Contract basis and fixture API: [Relay V2 pairing contract](../../web-remote-control/relay-v2-pairing.md).
  Independent shared V2 message/HTTP parsing, explicit V2 QR parsing, V2 heartbeat constants and the shared
  fake relay are implemented; V1 default behavior is kept.
- `pnpm typecheck`, `pnpm lint` (0 errors, 60 pre-existing warnings) and `pnpm architecture:check --changed`
  pass; final shared package plus existing desktop/phone transport regressions: 133 files, 1,504 tests passed.
- Full `pnpm test:unit`: 1,914 files passed, 4 failed, 2 skipped; 17,943 tests passed. After targeted reruns the
  CUA staging, TTFT timeout and teardown errors no longer appeared; still failing are `e2eRuntimePaths.test.ts`
  (pre-existing `feedback-upload-privacy.test.ts:105` uses `/private/tmp`) and
  `storagePreparationProtocol.test.ts` (local dist of `@zcode/adapters/storage` lacks
  `SqliteSessionStore.openStartup` that exists in source). The related source is unchanged from the task
  baseline; no unrelated fixes were mixed in.
- Two-axis review: Standards no findings; Spec found a delete HTTP status/business-code difference, fixed and
  re-verified. The full gate did not pass; per root rules the changes are kept and not auto-committed.
