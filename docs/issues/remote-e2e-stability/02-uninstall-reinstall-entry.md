# Missing Confirmation Entry for Identity Generation Change after Uninstall and Reinstall

Status: done

> Historical verification baseline: 2026-09-25. The entry fix documented here is still valuable, but its premise that "a data-preserving reinstall necessarily produces a new identity" was replaced by the user decision of 2026-10-10 in [Issue 08](08-reinstall-history-visible-in-new-device.md). Today a same-device reinstall keeps identity and history; only replacing the independent data environment exercises confirm/cancel/archive. The old batches below do not represent the new semantics passing.

## Evidence at the Time

Business baseline `54ece08f23f79ae54aea1f51e0d941497d627392`, server batch `r3-server-20260924033117390-ff1bf4`: `uninstall` once reported PASS, but its run facts (`packages/desktop/.e2e-artifacts/remote-stability-20260924/uninstall-full05.json`) record a different path:

1. First install through the official wizard, then uninstall through the CLI with two DELETEs; run files are removed while config and the user data sentinel are kept.
2. Connecting again prompts that identity generation change must be confirmed, matching the [Source installation identity boundary](../../architecture/r3-source-server-remote-architecture.md).
3. "重新安装并连接" (reinstall and connect) in Settings was clicked. After 30 seconds the directory panel was still shown, the original project button was disabled, and there was no error text.
4. The old test then deleted all connections, created a new SSH connection and got a new installationId before judging PASS.

Step 4 proves a fresh install works but not that the recovery entry of step 3 works. The old case therefore masked the entry problem.

## Test Correction

`conversation-session-r3-uninstall.test.ts` now waits for that entry to complete the install, select the original directory and restore the session directly. On failure it keeps the directory panel and installation facts and FAILs directly; it no longer deletes the device to change the path and report a pass.

Round 10 `r3-server-20260924063933344-38f7b4` waited at wizard step 1 until timeout while the remote already had a new installationId. Checking the code showed that Settings calls `onCreateConnection` without a Profile and only opens the wizard; what actually submits the connection is `onSelectProfile(preferred)` of the wizard device card. That round omitted selecting the saved route and its timeout cannot be directly characterized as a business defect; the action has been added. Round 11 `r3-server-20260924070140735-f6bd8f` run facts (`packages/desktop/.e2e-artifacts/remote-stability-20260924/uninstall-recheck11.json`) confirm the Settings entry and the saved route were both clicked, after which establishing the link again prompted "请在连接管理中确认身份换代" (confirm the identity generation change in connection management). The remote `current.json` and the new installationId existed, and config and the user data sentinel were kept; the failure point is restoring the connection, and it cannot be described as the install not running at all.

Supplementary batch `r3-server-20260924091134245-eb60d2`, after receiving the identity error again, actually closed the wizard and returned to connection management. Run facts (`packages/desktop/.e2e-artifacts/remote-stability-20260924/uninstall-coverage-next.json`) show the page still marked "远端已卸载" (remote uninstalled), the only visible actions being "重新安装并连接" and "移除全部连接", and no identity-generation-change confirmation entry. This agrees with the source, where the confirm button lives in the Profile route list, and when `installState === "uninstalled"` that list is hidden. The recovery flow requires confirming the identity but the designated page has no usable entry.

Acceptance keeps the allowlist, preservedPaths, new installationId and user-data reconciliation of [R3A-UPG-09](../../testing/r3-remote-automation-case-matrix.md), and verifies that the recovery action in Settings itself works.

## Root-Cause Fix and Verification (2026-09-25)

The user explicitly authorized fixing this problem.

The root cause is in [SourceServerManagementPanel](../../../packages/ui/src/settings/SourceServerManagementPanel.tsx): the confirm button existed only on route rows, an uninstalled Source hides the routes, and the preferred route is not among the collapsed other routes, so when the Host already reported `identity-change-pending` there was still no confirmation entry. The Host's identity protection and atomic replacement contract did not need to change.

Now the device card shows the confirm action of the route actually pending confirmation first, and several pending routes are directly visible. All entries reuse the original confirmation dialog and `management.confirmIdentityChange`; cancel does not rebind, a failure shows the error and keeps the entry, and a success consumes the snapshot returned by the Host. The security boundary is not bypassed by changing `installState`, deleting the old device, accepting the new identity automatically, or retrying.

```text
Before: new installationId → Host identity-change-pending → UI hides confirmation → cannot recover
Now:    new installationId → device-card confirmation → user accepts → Host atomic replacement → choose directory from the new device
```

The regression test first showed 5 failures on the original component with the existing 18 passing; after the fix, with multi-route coverage added, the related UI, Host directory, connection management and services total 125 passing. Cancel, disabled while requesting, no automatic retry on failure, preferred and non-preferred routes, and installed/uninstalled all have behavior assertions. Type check, E2E type check and the architecture check pass; lint has 0 errors.

The real test used a dedicated test server and an independent Linux SSH container, business baseline `54ece08f23f79ae54aea1f51e0d941497d627392` plus this fix. In valid batch `r3-server-20260925030830182-0375bb`, `uninstall`, `devicerow` and `uipairwise` all PASS; the SHA-256 of the full input manifest is `55c831c21489c120f7a3e82ba8346c389892bade3121890c39d2b8e69263d596`. `uninstall` verified that cancel does not change the original route; after confirmation the old route is archived and old history kept, there is a new installationId, a new session, config/user data kept, and the original directory is selectable from the saved new route. An undeleted device goes through the first-connection path separately.

The same input version passed once each in the fresh containers of `r3-server-20260925031220129-dab784` and `r3-server-20260925031504324-c14318`, for three complete PASS runs in total, taking about 203, 158 and 158 seconds respectively (the first concurrent with adjacent cases).

The first candidate batch `r3-server-20260925030033171-139169` went past the identity confirmation, but the menu DOM click newly added in E2E did not trigger the Radix menu and the overall FAIL was kept. After switching to the WebDriver click used by the existing SSH helper, the full batches above passed; no business fallback was added for that test action error.

Scope is the desktop connection management UI only; the `isDesktop` gate of `SettingsPage` keeps the mobile replayable path from using this panel. The protocol, identity persistence, Host/CLI and data migration rules are unchanged. Rollback only needs reverting this UI fix; no data format change needs migrating back, but the missing confirmation entry would return.
