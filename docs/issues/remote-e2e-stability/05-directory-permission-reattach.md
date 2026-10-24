# Directory Reattached as a Usable Remote Session after Its Permission Was Revoked

Status: done

## Expectation

The "single directory invalid" requirement of the desktop SSH guide: when a directory does not exist, becomes a file, or the current account has no access, only that project fails with a "directory unavailable" hint; the device and other projects remain recoverable. The directory is not recreated and history is not deleted automatically.

## Evidence at the Time

- Business baseline: `a13999a28927f629d0c64080a5096cf8b4f23bae`, server build, independent Linux SSH target.
- Case: `conversation-session-ssh-remote-directory-resilience.test.ts`, `R3_DIRECTORY_FAILURE_CASE=denied`.
- Batch: `r3-server-20261009170002590-cabde7`, task `directory-denied`.
- Steps: open A/B/C on the same device, save real A/B conversations; switch back to B, disconnect manually; change A's permission to `000`; reconnect B.
- Result: B/C recovered, A's `remoteSessionId` was still non-empty and the disconnected state was not kept as "directory unavailable". The original assertion failed when verifying A unavailable, and was not relaxed.
- Static basis: `prepareRemoteWorkspaceIdentity` only calls remote `FileService.stat` and checks that the type is directory. On Linux a successful stat of a directory itself does not prove the current account can traverse or read its content, so this check cannot cover a leaf directory whose permission was revoked.

## Runtime Identity Re-check (2026-10-10)

- Batch `r3-server-20261009221305938-a3e800`, task `directory-denied`.
- `directory-resilience.json` records the SSH user UID as 1000, and the Core `/proc/<pid>/status` real / effective / saved / filesystem UID are all 1000; running as non-root.
- The same SSH user gets `INACCESSIBLE` from `test -r` / `test -x` on A and `READ_DENIED` from `ls`.
- After reconnecting B, A's `remoteSessionId` was still non-empty, and a second independent target re-run gave the same behavior. B kept its original active path, and A was not isolated as directory unavailable. The actual denial and the session reattach are recorded in the artifact of the same case, ruling out a misjudgment due to test-account privileges.

## Root-Cause Fix (2026-10-10)

The sections above keep the evidence of the original regression batch. The fix is based on `5516284630ccff3552f37466266de270af661188`, whose related business code equals the original test baseline.

The Host's `prepareRemoteWorkspaceIdentity` now uses the existing remote `FileService.readdir` to read `directory/.`. Readable directory metadata does not mean accessible directory content; the trailing `/.` also requires the target directory to be traversable, so an empty directory with read-only permission `0400` is not let through by an ordinary `readdir(directory)`. The identity is bound only if the check succeeds, and the check path does not change the original project identity. The error keeps mapping to the original directory-unavailable error and fails only that project; no RPC is added, no Server update is required, and the directory need not be writable.

Regression covers manual/automatic recovery under real `000`, `0400`, `0100` permissions, isolation of other projects on the same device, retry after restoring permission, and a `0500` directory that can be read and traversed but not written. Before the fix 6 permission-recovery assertions failed; after the fix the targeted unit tests (32) pass, including protection for the real File RPC and late results after cancel.

Final verification:

- `pnpm test:unit:affected --base 5516284630ccff3552f37466266de270af661188`: 405 Vitest files, 4911 cases and 28 Node audit cases pass.
- Root type check, E2E type check, lint, architecture check, fixture check and changed-file format check pass; lint keeps 81 pre-existing warnings.
- macOS Electron → independent Linux SSH container, `R3_DIRECTORY_FAILURE_CASE=denied`: `desktop-e2e-20261010-directory-fix-denied-serial` passes 1/1. Non-root UID 1000 really cannot read/traverse A; A is kept and its session is empty, B/C get new sessions; the directory-unavailable hint, in-place retry after restoring permission, original-task continued chat and sentinel retention all pass. `directory-resilience.json`, screenshots, run log and source/build digests are kept under that run's `.e2e-artifacts`.
- The previous round `desktop-e2e-20261010-directory-fix-denied`, run in parallel with the affected unit tests, timed out waiting for Server ready at first install and had not entered the permission fault; the log also recorded a local `ps` start timeout. The failure evidence is kept; after the unit tests ended it was re-run alone with the same fix build, a new HOME and a new SSH target and passed, and the first round is neither recorded as a pass nor deleted.
- The first round's build is recorded as `fresh-stable`; the single re-run reused the build, with the raw record `unverified-reused-build`. It was additionally cross-checked that all 5286 artifact digests of the two rounds are identical and the source digests of the modules admitted in the first round match the current fix files; the result is saved as `source-reuse-verification.json` of the re-run artifact, and the original build status was not rewritten.

This round re-ran only the failing permission variant of the full E2E; delete / become-file are compared with the original full E2E record and this round's real file system / RPC unit tests. Native Windows, the whole mobile relay chain and a Linux desktop host were not re-verified; no manual promotion or CI admission was done.
