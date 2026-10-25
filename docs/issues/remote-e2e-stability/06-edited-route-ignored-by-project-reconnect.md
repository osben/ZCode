# After Changing the SSH Address, Sidebar In-Place Reconnect Still Used the Old Route

Status: done

## Expectation

The "device and connection management" requirement of the desktop SSH test guide: address and credential edits take effect on the next connection, and leaving credentials blank keeps the original credentials. The current connection can keep being used, and the next reconnect from the original project should use the saved Connection Profile.

## Reproduction and Evidence

- Business baseline `a13999a28927f629d0c64080a5096cf8b4f23bae`, server verified build.
- Case `conversation-session-ssh-remote-connection-management.test.ts`, edit scenario.
- `connection-management` in batches `r3-server-20261009183107835-42af65` and `r3-server-20261009221305938-a3e800` both failed the assertion on the actual connection count of the new route.
- Open A/B on the same device; in Settings change the route name, device name and SSH port to this case's forwarding proxy, leaving the password blank. The original project session kept its original value and the new proxy connection count was 0, as expected for "takes effect next time".
- After manually disconnecting the device, reconnect from the original project. The project got a session again, but the new proxy connection count was still 0.
- The settings write in the original Desktop log proves the Profile port was updated; the reconnect log still connected to the original port. Afterwards the old port was also registered as a second Profile. The failing assertion was not relaxed.

## Static Location in the Original Regression Round

`reconnectRemoteWorkspaceHistoryEntry` creates the reconnect target from `sessionEntry.target`. When `loadSourceServerProfileCredentials` reads the historical bound Profile it takes only the credentials and does not use the Profile's latest host/port/authentication method as the connection target. The historical Tab snapshot and the Profile can therefore form two different route facts.

Batch `r3-server-20261009223735233-3b63ee` explicitly waited for the old attachment to be released before re-running, and the new proxy connection count was still 0, ruling out the timing of asynchronous button completion. The business implementation was not changed in that task. Default route and device removal have separate scenarios, so the remaining management acceptance must not be skipped because of this failure.

## Root-Cause Fix (2026-10-10)

Fix start `1ed4575f887edcc73ee3924ffd6df85d2e60aafe`, whose related reconnect business code equals the original test baseline. A real module probe reproduced it: after the Profile updated its port, the original project reconnect still passed out the old port and produced a second Profile; connecting by Profile from Settings used the new port, and a password-only change was also readable by the original project reconnect.

The fix reads the complete SSH Profile by the original project's historical binding at the Renderer reconnect target resolution, keeping directory, Source identity, original route choice and Host lifecycle unchanged. The old session serves only as compatible input for histories without a Profile; when there is no new credential reference and the authentication configuration is the same, the old credential reference is kept, and a switched private key passphrase is not reused. Sibling reuse of the initiator's credentials and the same-device recovery order after a directory admission failure stay unchanged.

```text
Save:      Profile (authority of connection configuration) updated, the current online session is not restarted
Reconnect: project identity + path -> original bound Profile -> latest SSH target + credentials -> original Host connection entry
Success:   backfill new session / target, original workspace identity unchanged, no old route added
```

Verification results:

- 8 new reconnect behavior tests: 6 failed and 2 normal controls passed before the fix; all pass after. Covers manual/automatic recovery, new address/user, private key switching, old-credential compatibility, rejection when a new credential is missing, original bound route selection, and sibling credential reuse. The two old tests that only tested the credential helper were replaced by public reconnect behavior tests.
- `pnpm test:unit:affected --base 1ed4575f887edcc73ee3924ffd6df85d2e60aafe`: 371 Vitest files / 4378 cases and 28 Node audit cases pass; the root full unit suite was not run.
- Root type check, E2E type check, lint, architecture and fixture checks pass; lint keeps 81 pre-existing warnings. Changed-code format and diff checks pass. The existing table format and historical branch-name terminology warnings in the design spec match the baseline, and this change's clauses add no format or terminology problem.
- macOS Electron → independent Linux SSH container, `R3_CONNECTION_MANAGEMENT_CASE=edit`: `desktop-e2e-20261010-route-fix` **1/1 PASS**. The new port received 1 connection, authentication succeeded with the password left blank, A/B project identities were kept and B got a new session; still the original Profile, and the device's active Profile count is 1. The original assertion "new proxy actual connection count > 0" is kept, with added assertions for sibling recovery and no old route added.
- This run's `connection-management.json`, `test-results.ndjson`, run log and `build-source-evidence.json` are kept under `.e2e-artifacts`. The build status is `fresh-stable`, the source SHA-256 of the reconnect module was checked against the final working tree, and the result is in `route-fix-verification.json`.

This round re-ran only the edit variant of the full E2E; the default route / remove lifecycle variants keep their original passing records. Private key switching is covered by unit tests of the real reconnect function, with no separate real private-key SSH E2E; native Windows, a Linux desktop host and the whole mobile relay chain were not re-run. The WSL/Docker/Server reconnect paths, RPC, Host owner and the continuous/replayable boundary are unchanged; no manual promotion or CI admission was done.
