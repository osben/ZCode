# 04 — Wizard P0 Fixes and Flow Controller Extraction

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:** none.

**Behavior to deliver:**

First fix the problems in the connection wizard that stall users:

- **Saved password missing**: the primary button becomes "补充密码" (add password); clicking returns to the form and focuses the password field.
- **Target device already online**: tell the user "已直接使用现有连接" (the existing connection was used directly), and do not save the credentials newly entered.
- **While connecting**: the primary button becomes "取消连接" (cancel connection) and is clickable.
- **WSL and Docker connections**: stage copy no longer uses SSH wording.
- **User-initiated cancel**: no longer shown as an error.

Then, with behavior unchanged, extract the wizard flow into a testable controller covering entry intent, wait points, collapse and close, and result destination. This makes the three-screen redo ([10](./10-three-screen-wizard-and-selection.md), [11](./11-connecting-and-directory-screens.md)) easier.

Scope:

- **Wizard P0 defects**:
  - Clicking "retry" with missing credentials fails repeatedly.
  - A target device that is already online is silently reused with no hint.
  - The primary button cannot be clicked while connecting.
  - WSL and Docker connections show SSH stage copy.
  - After the user cancels installation, the UI shows a red error panel.
- **Pre-refactor**:
  - Extract the flow controller with all observable behavior unchanged.
  - Existing wizard tests assert by intercepting child component props; the flows covered this time are rewritten as tests asserting behavior through the DOM and service ports.

Acceptance criteria (all met):

- **Missing credentials**: the primary button shows "补充密码"; clicking returns to the form and focuses the password field; no inevitably failing retry loop. Needs wizard tests and E2E.
- **Target device already online**: when manually creating a connection whose target is an already-online device, show "这台设备已通过 `<连接描述>` 连接，已直接使用现有连接" (this device is already connected through `<connection description>`, the existing connection was used directly) and do not save the credentials newly entered. Needs tests.
- **Connecting**: the primary button is "取消连接" and enabled; after success it advances to the next step automatically.
- **Stage copy**: SSH, WSL and Docker each have their own stage copy in Chinese and English.
- **User-initiated cancel**: after the user cancels installation or the connection, the UI shows "已取消" (cancelled), not an error panel.
- **Pre-refactor**: after the flow controller is extracted, the same behavior cases pass before and after the rewrite; new tests no longer intercept child component props.
- **Update spec**: write the "already-online reuse notice" into the UX spec; other defects are kept as regression tests.
- **Required checks**: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected SSH E2E all pass before the local commit.

Acceptance record (2026-09-27): `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` and `pnpm --filter @zcode/desktop typecheck:e2e` pass; full `pnpm test:unit --retry=1` ran 2,028 files and 18,628 tests passing (14 pre-existing skipped tests), and the last flow-closing change was additionally verified by the 34 wizard DOM cases. The three specs for SSH CONN-01/02, CONN-03 and CONN-06/07 ran and passed; the artifact is in the [SSH P0 plan](../../testing/ssh-remote-p0-e2e-plan.md#rdux-04-向导回归). The two-axis review (conventions/spec) has no unresolved item; the new E2E stays pending and has not been promoted manually.
