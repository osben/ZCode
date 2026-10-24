# 05 — Phone logs in, then connects to the desktop directly from the QR code

**What to build:** The phone opens `/remote/v4?app_version&sid&mid&name`. Logged out it first enters the login
page; the OAuth callback returns directly to `/remote/v4` (the page recognizes `code`+`state`), the login state
is written to same-origin localStorage and the page redirects to the original URL. Logged in, it requests a
`role=terminal` token, connects `/api/v1/remote/ws2`, sends `auth_init(sid)` and after pairing enters the
existing bootstrap → workspace bridge → `rpc-frame` chain; the chat experience is unchanged. A mismatched
account shows "this device does not belong to the current account" with account switching; an invalid login
returns to the login page and back to the original place afterwards; `KICKED` has bounded retry. The phone then
has V2 only and the old `/web-remote` entry is removed.

**Blocked by:** 02 (real-device integration also needs 03 working)

**Status:** in-progress

**Parent:** [Web remote control on Relay V2: phone logs in, then connects to the desktop](./01-relay-v2-login-pairing.md)

## Acceptance criteria

- [x] Docs first: `relay-v2-pairing.md` gains the phone first-entry sequence (callback mode / login gate /
  direct connect with sid); `web-remote-login.md` is rewritten as the `/remote/v4` V2 login gate; the
  architecture doc's Web section is V2; a zh-CN/en-US copy table for the login gate, the no-`sid` placeholder
  page and the `device-not-owned` and `invalid-mobile-connection` failure pages is listed for confirmation.
- [x] Entry: `/remote/v4` with `code`+`state` enters OAuth callback mode (reusing the callback page and Web auth
  service); OAuth `redirect_uri` becomes `<origin>/remote/v4` with shared callback-address derivation updated;
  the `app_return_to` allow-list allows `/remote/v4` (trailing slash included) and existing share paths, query
  allows `app_version`, `sid`, `mid`, `name`; the dev-mode `return_to` forwarding stays.
- [x] Login gate: without a JWT render the existing login page (provider follows the build environment) with
  `appReturnTo` set to the full current URL; after the redirect following login, connecting continues
  automatically.
- [x] A new pre-connection orchestration module (injectable login state, device API, location/history/
  localStorage, transport factory): with `sid` → connect directly; without `sid` → this ticket renders a
  "scan the desktop QR code" placeholder (the device list comes in ticket 06).
- [x] New terminal transport V2 (sharing heartbeat/pair_status/bounded-retry helpers with the desktop):
  requests a `role=terminal` token with the localStorage JWT before connecting; URL
  `wss://<origin>/api/v1/remote/ws2?token=…&mid=…` (`mid` from the URL parameter); `auth_init` fields,
  `client_ts` seconds, 5 s heartbeat, 15 s watchdog, new token per reconnect and `KICKED` bounded retry match
  the desktop.
- [x] Error mapping: token 401 → clear local session, go to the login page with the full current URL as the
  return address; 5xx/network errors keep the existing 500 ms x 2^n backoff capped at 10 s; `AUTH_FAILED` after
  `auth_init` → new failure reason `device-not-owned`, whose failure page has "switch account" (log out, return
  to login keeping the return address) and "select another device" (hidden or disabled until 06); the failure
  page gains a secondary action slot for it (below the primary button, ghost style, per DESIGN.md);
  `WRONG_PARAM` → `invalid-mobile-connection`; `DEVICE_OFFLINE` and `INTERNAL` keep existing recoverable
  handling; a second `KICKED` → `session-conflict`.
- [x] Visual check: phone screenshot matrix (login gate, no-`sid` placeholder, `device-not-owned` failure page;
  narrow/wide x dark/light x zh-CN/en-US) via a new pending screenshot case modeled on
  `packages/web/test/e2e/manual-review/pending/remote-version.mjs`, never auto-promoted.
- [x] Delete the phone V1 terminal transport, browser HMAC proof computation, `/web-remote` route check,
  logged-in waiting page, old `remoteControlToken`/`relayOrigin` bootstrap and its `/api/remote-control/*`
  request code; old tests deleted or rewritten.
- [x] bootstrap-request/response, workspace-list, workspace-bridge-open/ready, `rpc-frame`/ack,
  `mobile-view-state-update`, the version-sync guard and the replayable recovery order are unchanged; existing
  regression tests all pass.
- [x] Tests (orchestration module + fake relay + fake fetch/location/storage): callback-mode detection and
  redirect, login gate, direct connect with sid, 401 back to login keeping the return address,
  `device-not-owned` actions; wire-level transport tests against the fake relay as on the desktop; shared/web
  URL parsing, allow-list and query pass-through tests.
- [ ] Test-environment acceptance: the branch keeps root `package.json` version `3.13.0` and overwrites the
  `3.13.0/` directory via the OSS test pipeline (first notify colleagues still on the 3.13.0 V1 desktop); a
  real phone completes "first scan with login → redirect → connect" and "logged-in direct connect", recorded in
  the `relay-v2-pairing.md` acceptance section.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests pass.

## Verification record (2026-09-19)

- Local implementation and review are complete; the ticket stays in-progress pending OSS/real-phone acceptance.
- Web test set 31 files / 296 tests passed; desktop/phone transport targeted regressions 48 tests passed; dev
  startup script regression passed. Regressions for suspended late open/ACK and the KICKED cross-generation
  waiting timer were reproduced first, then fixed.
- `pnpm typecheck`, `pnpm lint` (60 pre-existing warnings, 0 errors), `pnpm architecture:check --changed` pass.
- ML01-ML06 browser: 27 checks passed, 24 narrow/wide x theme x language screenshots in
  `.tmp/remote-login-v2-e2e/` (updated after rounded-corner and light-badge contrast tweaks, still pending).
  RV01-RV03 browser: 6 configuration groups passed, the pre-existing home-only dynamic subscription warning is
  kept as-is.
- Full `pnpm test:unit`: 17,988 passed, 12 skipped, 1 failed; the failure is the unchanged
  `packages/desktop/test/e2e/feedback/manual-review/pending/feedback-upload-privacy.test.ts:105` using
  `/private/tmp`, tripping the e2eRuntimePaths check. An unhandled error from an old home-only fixture missing
  `location.href` was fixed and confirmed gone by rerunning the whole Web set; unrelated cases were not re-run
  in full.
- Per root AGENTS.md (no auto-commit when required verification fails) the workspace is kept; the user's
  existing 02-04 changes are excluded from this ticket's commit.
- The OSS overwrite pipeline was not triggered, colleagues were not notified, and the real-phone OAuth paths
  were not run; the 3.13.0 V1 users must be coordinated and the test deployment done first, with manual results
  written into `relay-v2-pairing.md`.
