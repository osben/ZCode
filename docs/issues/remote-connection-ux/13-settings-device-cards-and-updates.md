# 13 — Settings Device Cards, Unfinished Connections and Update Notices

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:** [03 — Remote connection presentation model, 5 states and glossary](./03-presentation-model-states-and-glossary.md), [06 — Interaction prototype and review](./06-interaction-prototype-review.md)

**Behavior to deliver:**

- **Device card**:
  - Row 1: connection-method icon, device name, state, primary action, and "编辑" (edit) and "更多" (more). The primary action is decided by the presentation model.
  - Row 2: connection description. The connection-type color appears only here.
  - Row 3: at most 3 project names, click to open; the rest shows "+N".
  - The "更多" menu holds device info (version, hostname, system user, device ID), copy device ID and remove device.
- **Other connections**:
  - Mark which one is in use and which is default, and allow changing the default.
  - Action buttons are always visible and need no hover; they wrap on narrow screens.
  - Remove the double border of a card inside a card.
- **Unfinished connections**: a connection that never connected is no longer shown as a device card but goes into "未完成的连接" (unfinished connections) at the page bottom. This block is collapsed by default and supports retry, delete and one-click cleanup.
- **Update notices**:
  - An optional update shows no toast, only a small dot on "远程设备" in the Settings navigation and a neutral banner on the device card.
  - Deduplicated by "device + target version" and persisted. Reconnect, network jitter or an app restart do not prompt again.
  - "稍后" (later) is valid only for the current run.
  - When the user starts an update, the update stage and progress are shown. Success shows a toast; failure shows a toast with "查看详情" (view details).
  - Before a forced update, list the running tasks.
- **Migration report**: a truncated path shows the full content on hover.

It corresponds to the device card, other connections and unfinished connections parts of the "Settings: remote devices" section, and the "update notice" section of the parent spec. The update direction for an over-old local version belongs to [03](./03-presentation-model-states-and-glossary.md); operation safeguards and scope labels belong to [05](./05-settings-safeguards-edit-and-scope.md).

**Prototype review conclusion** ([06 review conclusion](./06-interaction-prototype-review.md#comments)): the UI follows the approved prototype; these points follow 06.

- Primary actions on device cards uniformly use outline buttons; urgency is carried by the status label and the in-card banner; only "新建连接" on the Settings page is a solid primary button.
- Required update: status label + warning-colored banner explaining version and impact + "更新远端" at the card's top right, with no button repeated in the banner. Optional update: neutral banner with "稍后 / 更新".
- Other connections: the card's second line marks "当前 · 默认"; the expanded area lists only the remaining connections, with "设为默认 / 删除" always visible.
- The device status label reads "state · reason phrase"; the connection description uses normal casing `Docker · …`.

Acceptance criteria (all met):

- The device card layout matches the prototype, with component tests and screenshots.
- After attempting a connection to an unused port, the failed attempt does not appear in the Settings device card list; it appears only in "未完成的连接". Covered by E2E.
- After simulated reconnect and restart, update-notice dedupe still holds; "稍后" is valid only for the current run; an optional update shows no toast. All covered by update notice tests.
- The forced-update confirmation lists the running tasks.
- Screenshots in light, dark and narrow-screen.
- UX spec updated and the E2E case catalog synced.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected E2E all pass before the local commit.

## Verification Record (2026-09-29)

- Start `1bc73f709887b4882978f55de3d9177d57a9192d`, clean working tree; not pushed. Device card, current/default connection, unfinished connections, update preference/feedback, running-task confirmation and path tooltip are implemented; opening a project reuses the connection intent with an explicit profile + directory and does not require an existing attachment.
- Findings of the two reviews (conventions and spec) were fixed: setting the current connection as default, unfinished-connection logs, project opening without an attachment / dual-intent override, and the details navigation of the update-failure toast after the panel unmounts. The re-check found nothing left.
- `pnpm typecheck`, `pnpm lint` (64 pre-existing warnings, 0 errors), `pnpm architecture:check --changed`, desktop E2E type check, fixture check and diff check pass.
- Affected tests: based on the start commit, including uncommitted and new-file previews, 559 test files. Automatic resolution reported incomplete for the existing `.mp3` and `.html?url` asset edges; both files exist, are unchanged, and were confirmed manually as static-asset leaves, so the explicit test list was run through `test:unit:affected --files-manifest` instead of falling back to the full suite. In that round 555 of 556 Vitest files passed, with 1 file's two old layout assertions failing; 17 tests of 3 Node files passed. The old assertions were updated to the three-row layout and project identity dedupe was added; the final 8 files / 130 affected regression tests of this change and the review fixes all pass. Full-suite verification is not claimed.
- Real macOS Electron → isolated Linux SSH container: the new RDUX-13 case passes, covering device info, click-project recovery after disconnect, unused-port failure going only to the default-collapsed block, and the device being kept after confirmed cleanup. Earlier first-install timeouts and test wait/selector problems were located and fixed; final passing run `desktop-e2e-20260928211106956-p24417-7952ff47932db52d`.
- The existing RDUX-05 settings safeguard case passes on the final product build, run `desktop-e2e-20260928210923472-p23086-df79c48fd72ebf81`; the new case in that combined run once failed on a missing test constant import, covered by the final standalone regression above.
- Screenshots: `packages/desktop/.e2e-artifacts/desktop-e2e-20260928211106956-p24417-7952ff47932db52d/device-cards-{light,dark}-{1440,900,480}.png`, theme and narrow layout checked; 480px is a desktop window, not a real phone. The mobile device management gate and continuous/replayable code are unchanged, and related existing unit tests passed within the affected list; there is no mobile real-device or Windows/WSL real-device verification. The new case stays pending and was not promoted manually.
