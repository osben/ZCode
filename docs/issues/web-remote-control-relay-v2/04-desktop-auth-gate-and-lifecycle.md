# 04 — Desktop login gate and remote-control lifecycle linkage

**What to build:** A logged-out desktop user opening the remote dialog sees "login required" with a login entry
while main neither registers a device nor connects the relay; after login main is notified and, if a "last
enabled" target exists and the window workspace is synced, remote control resumes automatically; after logout
remote control stops immediately and stays at `auth-required`; at app start without a JWT, recovery stays at
`auth-required` waiting for login. Plus one desktop E2E.

**Blocked by:** 03

**Status:** in-progress

**Parent:** [Web remote control on Relay V2: phone logs in, then connects to the desktop](./01-relay-v2-login-pairing.md)

## Acceptance criteria

- [ ] Docs first: `relay-v2-pairing.md` gains the login/logout and remote-control lifecycle sequence diagram
      and `auth-required` semantics; the architecture doc's "enabled-state recovery after desktop app restart"
      section now requires waiting for a JWT; a zh-CN/en-US copy table for the `auth-required` state (title,
      description, login button) is listed for confirmation.
- [x] Remote-control status gains an `auth-required` presentation: the dialog shows the "login required" copy
      and a login entry (reusing the existing login trigger) without a QR code; zh-CN and en-US copy complete.
- [x] Visual check: dialog `auth-required` screenshots (dark/light x zh-CN/en-US), produced by this ticket's E2E.
- [x] A one-way renderer→main IPC login-state notification (login success / logout), sent by the renderer on
      OAuth session changes; strict types and runtime schema validation.
- [x] Main on "login success": if an enabled target exists and the window workspace is synced, retry
      restoring; on "logout": stop the current runtime, set `auth-required`, keep the enabled record. App-start
      recovery without a JWT stays at `auth-required` waiting for the notification and starts no extra host, remote
      session or Agent runtime.
- [x] Tests (manager public interface + fake login-state source): refuse to start without a JWT with no HTTP/WS
      calls; login notification triggers recovery; logout notification stops and keeps the enabled record;
      start-up recovery waits without a JWT. The IPC schema has rejection tests for illegal fields; the dialog's
      `auth-required` state has a render test.
- [ ] One desktop E2E: logged out, opening the remote dialog shows login required and main made no registration
      or relay connection; add, verify and promote per the E2E workflow skill.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and the new E2E pass.

## Implementation and verification

- Added the login lifecycle sequence, bilingual copy table, strict one-way IPC, manager login gate/recovery and
  the login entry. The remote workspace is now the single full-snapshot entry; regressions cover waiting for
  login, a target closed during disk reads, a remote placeholder missing its session, duplicate notifications
  and late async results.
- Pending desktop E2E passed 1/1 after a full build with 0 remote HTTP/WS calls; dark/light x zh/en
  screenshots are in `packages/desktop/.e2e-artifacts/desktop-e2e-20260919054022407-p76850-149c65ccfe5737d4/`.
  Human confirmation requested; not yet promoted.
- Repo unit tests: 17,958 passed, 1 failed, 12 skipped. The only failure is `e2eRuntimePaths.test.ts` detecting
  a `/tmp` literal in the pre-existing `feedback/manual-review/pending/feedback-upload-privacy.test.ts` (same
  as baseline and HEAD; fails alone). The ticket's final increment passed 10 files / 125 related tests.
- `pnpm typecheck`, `typecheck:e2e`, `pnpm lint` (60 pre-existing warnings, 0 errors),
  `pnpm architecture:check --changed` and diff whitespace checks pass; Standards/Spec re-reviews have 0 open
  findings.
- `e2e:fixture:check` currently supports only conversation-session/plugins and not the auth-config path; the
  no-model-request manifest was verified directly per this domain's contract.
- Existing 02/03 ticket changes untouched. Per project rules, with unit tests not fully green and manual
  promotion pending, no auto-commit. Phone and Windows/Linux untested.
