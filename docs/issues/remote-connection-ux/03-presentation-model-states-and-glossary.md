# 03 — Remote Connection Presentation Model, 5 States and Glossary

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:** [02 — Connection log and error contract](./02-connection-log-and-error-contract.md). This ticket's error classification must cover every error code defined by 02.

**Behavior to deliver:**

- **Consistent everywhere**: the same device has exactly the same state color, copy and primary action in the sidebar, session header, detail card, Settings page, wizard and task rows.
- **Only 5 states**: 已连接 (connected), 连接中 (connecting), 未连接 (not connected), 需要处理 (needs action), 连接失败 (connection failed).
- **User-initiated disconnect is not a failure**: shown as neutral "未连接".
- **Needs-action has a next step**: these all show as "需要处理" with a matching action: needs update, needs install, needs new-device confirmation, needs password.
- **Too-old local app points to desktop**: when the local desktop version is too old, guide the user to update the desktop app.
- **No engineering terms** on the interface.

It corresponds to the "remote connection presentation model", "connection error classification", "terminology and copy" and "design system" sections of the parent spec.

Scope:

- **Presentation model**: a new UI-layer pure-function module with two entry points: state mapping and error classification. Inputs, outputs and decision rules follow the parent spec.
  - It replaces the three existing state mappings and the existing error copy mapping.
  - All consumer screens migrate onto the presentation model but keep their current layout; layout redo belongs to 10-13.
- **Design system**: add an "in progress" semantic color. "Connecting" no longer borrows the SSH type color or amber.
- **Defects fixed**:
  - Two spinners while connecting.
  - "自动恢复 n/3" (auto-recovery n/3) must be visible on screen, not only in an aria-label.
  - When the local app is too old the primary action is "更新桌面端" (update desktop app) and the "连接" (connect) button must not be wrongly hidden.
  - Devices that need install or update no longer show as "离线" (offline).
- **Terminology**:
  - Clean all remote-related Chinese and English copy according to the parent spec glossary.
  - Rename the Settings section to "远程设备" (remote devices).
  - Rewrite copy about "generation change", "canonical history" and the migration report in language users understand.
- **Cross-module spec cleanup**:
  - Write the state mapping table, glossary, error classification table and acceptance scenarios into the [remote device connection UX spec](../../architecture/remote-device-connection-ux-spec.md).
  - Mark superseded old spec paragraphs.
  - Update the index of the [remote main-chain reading entry](../../remote/README.md).
  - Update [DESIGN.md](../../../DESIGN.md) and the [token conventions](../../../DESIGN.md).
  - Register the follow-up topics in the parent spec's "out of scope" in [R3 open issues](../../architecture/r3-source-server-remote-open-issues.md).

Acceptance criteria (all met):

- **State mapping tests**: table-driven tests cover every input combination listed in the parent spec and assert visible state, short text, semantic color, icon and primary action.
- **Error classification tests** cover:
  - all error codes of 02 and the unknown fallback;
  - copy variants per connection method;
  - "改用远端下载" (use remote download instead) appears only for SSH with local download selected.
- **All screens read only the presentation model**: sidebar, session header, detail card, settings card, wizard, task rows and the Settings navigation status dot read state only from the presentation model; the old mappings are all deleted. Every screen has a component test asserting it renders the model output.
- **User-initiated disconnect**: after a user-initiated disconnect, the sidebar and Settings both show neutral "未连接". Covered by E2E.
- **Needs update**:
  - Shows "需要处理 · 需要更新".
  - When the local desktop app is too old the primary action is "更新桌面端".
  - A reproduction test is written before the fix.
- **Silent reconnect at startup**: each project row has a single spinner; auto-recovery progress is visible.
- **Design token**: the "in progress" semantic color is written into the design guidelines and token docs. The token compliance test of the remote UI is extended and passes.
- **Forbidden word scan**: a new test scans the remote-related Chinese and English language packs to confirm none of the forbidden words listed in the parent spec appear. All new and rewritten copy is complete in Chinese and English.
- **Spec and cases in sync**: the cross-module spec cleanup is complete and all links work; the case catalog is synced per the [E2E workflow](../../../.agents/skills/e2e-case-lifecycle/SKILL.md).
- **Required checks**: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected E2E all pass before the local commit.

## Verification Record (2026-09-27)

- Five states and error classification are unified in a UI pure-function presentation module; raw device text and project display errors are separate inputs, and repair actions are tied to the connection that actually produced the state. Sidebar, session header, detail card, settings card, wizard, task label and Settings navigation all read the model.
- The dual-axis review (conventions/spec) passed. The review findings (action dispatch, error connection selection, project recovery facts, localized error coverage) have regressions.
- `pnpm typecheck`, `pnpm lint` (pre-existing warnings only), `pnpm architecture:check --changed` and the desktop E2E type check pass. Final affected regression: 95 files, 755 tests passed, including existing mobile replayable / isolation / recovery unit tests; there was no real-device mobile verification.
- Three real SSH cases all pass: RDUX-STATE user-initiated disconnect, neutral color; SSH-P0-CONN-01/02 retry after wrong password and first install/directory selection; RDUX-LOG refused connection and log filtering. Artifact: `packages/desktop/.e2e-artifacts/rdux03-verified-final`. Chinese/English, light/dark and 1400/900px desktop screenshots were checked; the new cases stay pending and were not promoted manually.
- The case catalog, coverage matrix and remote-server execution queue were synced; the new fixture check passes. A race in the existing SSH test setup (the onboarding-page check ran before the first screen) and an old telemetry-test assertion after the 02 error code extension were fixed.
- **Full-suite limit**: the full unit run required by implement was executed with 18,586 passing; this ticket's old assertions and post-review changes were all verified by the final affected regression. The remaining baseline failure is two `ReferenceError: mode is not defined` cases at `packages/services/test/repoSnapshotUploadTransport.test.ts:133`, still failing when re-run alone; the file and the HEAD blob are both `8738440a41e8e19f98a31918a54b7cc61ee8ce6b`, and this ticket did not modify services. An upload-memory-threshold failure seen in the full run passed when re-run alone.
- The user, aware of these two baseline failures, explicitly authorized recording the exception and committing this ticket locally; the baseline failures are not fixed by this ticket.
