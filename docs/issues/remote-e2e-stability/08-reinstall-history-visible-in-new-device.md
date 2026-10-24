# A Data-Preserving Uninstall and Reinstall Should Keep the Original Device Identity and History

Status: done

## Original Test Expectation

The "remote machine reinstalled" requirement of the desktop SSH guide: after confirmation create a new device, archive the old connection and keep the old history, without mixing old history into the new device.

## Real Historical Reproduction

- Business baseline `a13999a28927f629d0c64080a5096cf8b4f23bae`.
- Case `conversation-session-r3-uninstall.test.ts`, batch `r3-server-20261010001224807-40c41f`, task `uninstall`.
- After the first install a real turn was completed in the original project, producing task `sess_3b24f10d-ee85-48b9-b8ab-803cfbbff229`.
- Original install identity `2a4c7471-3337-4631-a43c-6129aa1ed4b6`. After the real CLI uninstall and a reinstall, identity confirmation was needed; cancel kept the old record, and after confirmation the old Profile was archived and a new Profile created.
- The new identity was `c518b19a-5e27-4da8-b96a-3f57a0f5466b`. After actually selecting the new device and the same directory, the new device's project's visible task list contained the old task above, and the `not.toContain` assertion failed.
- `uninstall.json` stores the original task/identity, the confirmation result, the retained database rows and `newInstallationTaskIds`; history was not verified only by file sentinels or the old App cache.

## Data Model Boundary

The Server keeps the legacy canonical key for compatible fallback, and the database rows of that round still used the original SSH route key. `SourceServerWorkspaceAliasRepo` looks up an existing canonical by directory; the App's device identity change did not isolate the visibility of tasks already in that Server user directory. The original test treated a data-preserving uninstall and reinstall as an independent device, but the remote is still the same user data. User data cannot be deleted, and the existing storage format cannot be asserted through the install UUID.

## Confirmed Semantics and Fix Goal (2026-10-10)

The user confirmed: a data-preserving uninstall and reinstall must keep the original device identity, connection and project, with the original history visible and chat continuable. This version has not shipped, so no legacy compatibility for lost identity or duplicate devices is needed. Start of this round: `1229463da32f09989cc474e0a8641c7f5b183d40`.

The root cause is that the uninstall allowlist deleted `install.json`, so the reinstall generated a new UUID, and the App archived the original connection and created another device; history reading itself matched the data-preserving semantics. The fix keeps the existing identity marker at the Server uninstall boundary, reusing the current atomic creation, ownership validation and uninstall startup protection, without changing canonical history or the App's identity routing.

The original case now verifies same-device recovery; confirm / cancel / archive / history isolation use a truly independent data-environment variant. Spec: [R3 identity lifecycle](../../architecture/r3-source-server-remote-architecture.md#保留数据的卸载重装2026-10-10).

## Implementation and Verification

- The official uninstall keeps `install.json`, and the cleanup of other runtime assets and the `uninstalled.json` startup protection are unchanged. The App keeps using the existing connection/project recovery path with the same sourceServerId, and the history canonical key is unchanged.
- The identity-change prompt now speaks of a change of the connection target's identity; an ordinary install confirmation no longer says "new device"; Chinese and English are synced.
- CLI regression went red then green: the old implementation did not list `install.json` in `preservedPaths`, and the new one verifies the identity file is kept as is, re-initialization does not change the ID, and the uninstall marker stays until the install completes. 4 related files / 78 tests pass.
- Affected root tests (start `1229463da32f09989cc474e0a8641c7f5b183d40`): 631 Vitest files / 6272 tests and 28 Node audits pass; the final install-confirmation-copy-related 4 files / 15 tests pass; the full unit suite was not run.
- Type check, E2E type check, lint, architecture, fixture and the 105-item queue contract audit pass; lint keeps 81 pre-existing warnings. The terminology scan hit only existing branch names in the current spec, with no new hit.
- macOS Electron → independent Linux arm64 SSH container, `desktop-e2e-20261010-reinstall-fix-preserve-data-r2` **1/1 PASS**: official uninstall, clicking the install confirmation from the original project, real install, original source/Profile/project kept, the original task visible and actually continued; the connection session regenerated. `uninstall.json`, `preserved-history.png` and `build-source-evidence.json` keep the evidence; the build is `fresh-stable`, and the uninstall manifest of the actual Linux archive was checked to be the fixed content.
- The first data-preserving round verified that the real uninstall keeps identity, but the case called the error-page waiting helper without clicking the install confirmation of the original project's handoff page, failing on "install must be confirmed first". After adding the actual user install confirmation and waiting for the error page to exit, it was re-run without changing business logic or relaxing the identity/continued-chat assertions; the first round's failure artifact is kept.
- `desktop-e2e-20261010-reinstall-fix-replace-environment` **1/1 PASS**: after fully sealing the original `.zcode`, an empty data environment was installed at the same SSH entry; the new UUID triggered the confirmation, cancel kept the original Profile, confirmation archived the old connection and created an independent Profile. The original task can be reconciled in the sealed database, the new device's visible task list is empty, and the current session and body do not mix in the old task. `identity-confirmation.png`, `new-environment-empty.png`, `uninstall.json` and the `fresh-stable` build evidence are kept in the corresponding run directory.
- Both E2E rebuilt the Desktop and used the Server/Agent archive regenerated from this source; the final Server CLI runtime files and the corresponding files of the archive used by the E2E have identical SHA-256, saved as `final-runtime-check.json`. Temporary target containers were all cleaned up; screenshot checks found no occlusion or inconsistent status copy.

The two variants keep `manual-review/pending` with no manual promotion or CI admission. The original FAIL of the historical batch is kept, and its expectation "a data-preserving reinstall shows no old history" is replaced by the semantics the user confirmed this round. Native Windows/Linux desktop hosts, the WSL/Docker product connection modes and the whole mobile relay chain were not verified; this change does not alter the Host/protocol or the continuous/replayable boundary.
