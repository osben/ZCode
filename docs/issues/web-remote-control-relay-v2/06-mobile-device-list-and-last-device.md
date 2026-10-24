# 06 — Phone device list and direct connect to the last device

**What to build:** When a logged-in phone opens `/remote/v4` without scanning (no `sid`): first auto-connect to
the most recently used desktop if it is online; otherwise show the account's device list with online devices
first sorted by name, offline devices greyed and unclickable, manual refresh and automatic refresh on return to
foreground; after selection the URL gets `sid`/`mid`/`name` written back and the connection starts, and a page
refresh restores it. The failure page's "select another device" entry works.

**Blocked by:** 05

**Status:** in-progress

**Parent:** [Web remote control on Relay V2: phone logs in, then connects to the desktop](./01-relay-v2-login-pairing.md)

## Acceptance criteria

- [x] Docs first: `relay-v2-pairing.md` gains the landing rule without `sid` (recent device → list), list
  sorting and refresh policy, and URL write-back rules, plus a text wireframe and copy table of the device list
  page (header and switch-account entry, list item layout, online marker, offline grey, empty state, refresh
  button position), **confirmed by the user before implementation**.
- [x] Without `sid`: read the recent device sid from localStorage and call the device list endpoint; if online
  connect directly, otherwise (offline or no record) render the device list page.
- [x] Device list page: fetch once on entry, manual refresh, refetch on `visibilitychange` back to foreground,
  no polling; online devices first sorted by `meta.name`, offline devices greyed, unclickable, showing the
  first 8 characters of `device_mid`; clear message for an empty list. The page is a standalone full-screen
  pre-connection page, same layout on narrow and wide screens, outside the `Root`/sidebar shell, reusing login
  page styles and the `zai-dark` default theme, with zh-CN/en-US copy.
- [x] After selection `history.replaceState` writes `sid`, `mid` (the list's `device_mid`), `name`, keeping the
  original `app_version`; the recent sid is written to localStorage; existing sid-keyed local state keeps
  working; a refresh restores via ticket 05's with-sid path.
- [x] The failure page's "select another device" action enters the list page; both actions of the
  `device-not-owned` page work.
- [x] Visual check: device list screenshot matrix (online/offline mix, empty list; narrow/wide x dark/light x
  zh-CN/en-US), reusing 05's pending screenshot case.
- [x] Tests (pre-connection orchestration + fake device API): recent device online/offline split, sorting rule,
  the three refresh triggers, URL write-back and localStorage write, empty list; list-page component render
  tests cover online/offline/empty.
- [ ] Test-environment real-device acceptance: open without a code and pick a device, refresh restore, account
  mismatch and account switching when logging in with another account; recorded in the `relay-v2-pairing.md`
  acceptance section.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests pass.

## Comments

- 2026-09-19: The user confirmed the wireframe, bilingual copy and behavior plan in
  [section 06 of the pairing spec](../../web-remote-control/relay-v2-pairing.md#手机设备列表与最近设备06);
  implemented and tested through the orchestration, fake device API and page-render seams.
- Local acceptance: Web 33 files / 312 tests, 41 browser checks and 6 version-recovery scenario groups passed;
  16 device-list screenshots in `.tmp/remote-login-v2-e2e/` with `device-matrix.html` / `device-matrix.png`
  overview and `index.html` raw matrix index. typecheck, lint (60 pre-existing warnings / 0 errors),
  architecture, desktop E2E typecheck and the Web V4 production build pass.
- Two-axis review: Standards findings (long-list scrolling, focus) and Spec findings (offline background and
  button corner radius) were fixed and re-verified; after adding the Web Tailwind scan declaration, browser
  computed styles confirmed the offline background takes effect.
- Real phone and test-environment OAuth/OSS acceptance is not done. Full unit tests: 18002 passed, 3 failed,
  12 skipped, plus 1 exit anomaly; process/desktop-transport/exit-anomaly tests pass when re-run in targeted
  form, but the pre-existing `feedback-upload-privacy.test.ts` path audit still fails. Per root AGENTS the
  status stays `in-progress`, changes are kept and not auto-committed; the implementation or tests of those
  pre-existing failures were not changed.
- 2026-09-22: The user confirmed offline devices show the device name remembered on this phone (no longer
  “未命名设备”, "unnamed device"); the spec's 06 section gains a "locally remembered device name" subsection;
  the former rule "do not cache historical online names" is reversed and the unit test now asserts the
  remembered name is kept (and the connection is not).
