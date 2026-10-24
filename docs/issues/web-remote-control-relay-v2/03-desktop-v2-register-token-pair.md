# 03 — Desktop registers the device, requests tokens and pairs over V2

**What to build:** After a logged-in desktop user opens the remote dialog, desktop main lazily registers the
device with the zcode JWT and persists the identity, requests a one-time `role=device` token before every
connection, connects `/api/v1/remote/ws2`, completes `auth_init`/`auth_ack`, and the dialog shows the new QR
code `/remote/v4?app_version&sid&mid&name`. The 5 s heartbeat, 15 s ACK watchdog, `KICKED` bounded retry and
token-failure backoff all apply; the "refresh QR code" entry is removed. The desktop then has V2 only.
Demonstrable in the test environment: the desktop gets a QR code and waits for the phone; successful pairing
can be verified with the fake relay.

**Blocked by:** 02

**Status:** in-progress

**Parent:** [Web remote control on Relay V2: phone logs in, then connects to the desktop](./01-relay-v2-login-pairing.md)

## Acceptance criteria

- [x] Docs first: `relay-v2-pairing.md` gains the desktop device registration/token/handshake sequence diagram
  and transport state machine; the architecture doc's Transport and Desktop Main sections switch to V2 and link
  the new doc.
- [x] New desktop device transport (separate class; heartbeat scheduling, pair_status transitions and bounded
  retry extracted as helpers shared with the phone): requests a token via an injected token function before
  connecting; URL `wss://<endpoint origin>/api/v1/remote/ws2?token=…&mid=<deviceMid>`; no `X-Device-ID`;
  `auth_init` carries only `device_sid`, `meta`, `client_ts` (seconds); `pair_status_query` has no
  `device_sid`; heartbeat 5 s ±1 s, reconnect after 15 s without ACK; every reconnect requests a new token and
  never reuses the URL.
- [x] `KICKED`: first one reconnects with a new token after a random 2-5 s delay; a second within 60 s stops
  auto-reconnect, transport goes to `kicked`, external failure `session-conflict`.
- [x] Manager lazy registration: on first start while logged in call the device registration endpoint
  (`device_mid` reuses the desktop deviceMid, `meta.name` is the hostname) and persist
  `{deviceSid, userId, endpointOrigin}` to AppSettings, not credentials. When the user id or endpoint differs
  from the persisted record, or `auth_init` returns `AUTH_FAILED`, re-register and best-effort delete the old
  record; failure does not block.
- [x] On first entry to V2 delete the V1 leftover `deviceSid` setting and `passHash` credential; the desktop
  V1 transport, HMAC proof computation and passHash storage provider are deleted, with old tests deleted or
  rewritten.
- [x] Within this ticket, `startAuthorized` returns an explicit failure without JWT and neither registers nor
  connects (the dialog's "login required" state and login linkage follow in ticket 04).
- [x] Token endpoint 401 → new failure reason `auth-required`; runtime goes to `error`, stops auto-reconnect,
  triggers no global logout and keeps the enabled record. 5xx and network errors back off exponentially from
  1 s to 30 s with jitter, reset after `auth_ack`; other 4xx → `relay-unavailable`.
- [x] Desktop main calls the device and token endpoints with Node fetch and `Authorization: Bearer <jwt>`, not
  through the services process. Relay URL derivation becomes `/api/v1/remote/ws2`, the test endpoint mapping
  stays, and the `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` override takes a V2 address.
- [x] The QR and "copy link" URL is `/remote/v4?app_version=<ver>&sid=<device_sid>&mid=<mid>&name=<hostname>`
  with no `hash`/`t`. The dialog drops the "refresh QR code" button, the confirmation dialog and the
  `resetPairingAuthorized` IPC; the manager surface reachable by the renderer is only `authorizeStart`,
  `startAuthorized`, `stop`, `getStatus`. The one-time internal start ticket boundary is unchanged.
- [x] Visual check: dialog screenshots (dark/light x zh-CN/en-US) confirm the refresh entry is gone and the QR
  and copy-link layout did not regress.
- [x] Tests (seam: manager public interface + real transport + fake relay): lazy registration and persistence,
  re-registration with best-effort delete on user/endpoint change, `AUTH_FAILED` re-registration, token 401 →
  `auth-required` with enabled record kept, QR URL shape, external status of `KICKED` bounded retry.
- [x] Tests (seam: transport against fake relay, fake timers): `auth_init`/`pair_status_query` fields,
  `client_ts` seconds, heartbeat and jitter, 15 s watchdog, backoff sequence, a new token on every reconnect,
  `KICKED` counting window.
- [ ] Manual verification: desktop dev on the test endpoint; logged in, the dialog shows a QR code and logs show
  registration, token and `auth_ack` waiting.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests pass.

## Verification record (2026-09-19)

Implementation and two-axis review are complete; the ticket stays `in-progress` pending real integration on a
logged-in test endpoint and gate closure.

- TDD seam: manager public API + real transport + loopback fake relay; the transport fake clock covers
  handshake, second-level timestamps, 4-6 s heartbeat, 15 s watchdog, backoff, 401/4xx, KICKED window, two-end
  pairing and disconnects. Extra regressions: registration 5xx retry after `AUTH_FAILED`, and background
  recovery after the first 30 s wait timed out still saving the enable intent.
- Final targeted verification: 8 related test files, 132 tests passed (last manager boundary fix re-run: 2
  files, 65 tests); root `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, `git diff --check`
  pass (lint 60 pre-existing warnings, 0 errors). A separate main tsconfig check surfaces pre-existing rootDir/
  browser-type errors; new main files have no type errors and the old main config was not fixed here.
- Last regression: a workspace-close notification must not rewrite a token-401-terminated `error/auth-required`
  to running; covered and Spec-reviewed.
- Two-axis review: Standards no findings; Spec found background-recovery persistence and connection-success
  telemetry issues, both fixed and re-verified.
- Full `pnpm test:unit`: 1916 files passed, 1 failed, 2 skipped; 17937 tests passed, 1 failed, 12 skipped. The
  failure is the unchanged `packages/desktop/test/e2e/feedback/manual-review/pending/feedback-upload-privacy.test.ts:105`
  using `/private/tmp`, tripping `e2eRuntimePaths.test.ts`; it fails alone too and is unrelated.
- Standard `pnpm dev:desktop:test`: first run lacked the CUA native addon (built within installed deps); then
  CLI `node-repl-host` compilation failed for missing declarations such as `@zcode/core/browser-client` and
  `@zcode/contracts/tools/node-repl`; CLI untouched.
- `ZCODE_ENV=test pnpm --filter @zcode/desktop dev:runtime` builds and starts main/renderer but existing
  storage preparation reports `transport_closed`; starting remote control through real preload/main returns
  `auth-required` (no usable JWT), so there is no live registration/token/auth_ack waiting evidence.
- Visual: real Electron renderer + production dialog component with an explicitly marked waiting test state,
  desktop 1440x1040 and narrow 390x844, zh-CN/en-US, Zai Light/Zai Dark, 8 screenshots. QR visible, no refresh
  button, no horizontal overflow in the copy-link row; narrow screens keep the dialog's internal scroll. They do
  not replace logged-in live relay integration and do not claim the phone V2 chain is implemented.
- Screenshot/machine-check artifacts: local session output (`desktop-<locale>-<theme>.png`,
  `mobile-<locale>-<theme>.png`, `evidence.json`); the temporary renderer fixture was moved out of the source
  tree and the dev process stopped.
- Existing ticket-02 workspace changes are kept and not mixed into a commit. Full checks still fail and live
  integration is incomplete, so per root rules no auto-commit.
