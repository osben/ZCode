# Saved SSH connection loses its credential after a cold restart

Status: done

## Symptom

Business baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test build, batch
`r3-server-20261011104332183-3a0c00`, case `boundary` (failed after 90.1 s).

1. Create a connection through the real SSH wizard from Settings ("New connection"), install, and
   create projects A/B. The first-run persistence notice shows once; `remoteBoundaryOnboardingVersion=2`.
2. Fully exit the old process with the safe-restart helper, reusing userData. Projects restore from the
   snapshot.
3. Choosing a directory from the device entry fails with “没有可用的 SSH 密码或私钥凭据，请返回配置后补充”
   (no usable SSH password or private-key credential; go back to configuration and add one).

The preserved HOME still has one Source and one Connection Profile whose password credential reference is
present, but `credentials.json` has zero entries. Settings, projects and onboarding state are intact. The
log shows one `credential.delete` before the first post-restart directory operation. Batch
`r3-server-20261011105317614-4a6780` records passwordRefs=1 / presentRefs=1 before the restart and
passwordRefs=1 / presentRefs=0 after, so the credential was lost during restart recovery, not never saved.

The same baseline blocked `project-order` after cold start (batch `r3-server-20261011125749338-152f05`: both
project rows offline, passwordRefs=1, presentRefs=0) and `recov` (Main logged `credential.delete OK`, then a
manual project connect failed with `Connection Profile requires interactive credentials`).

## Root cause

Persisted remote history uses a route identity (`remote:ssh:...`) but its target references
`connection-profile:*:password`. On recovery to the canonical `remote:server:*` identity:

```text
old route history references a Profile secret
  → buildRemoteWorkspaceSessionMutation re-projects it to the server identity
  → the new snapshot correctly drops the credential ref the Renderer does not own
  → diff cleanup adds the old Profile ref to credentialKeysToDelete
  → Renderer calls credential.delete; the formal Profile keeps a dangling reference
```

A read-only probe against the real `buildRemoteWorkspaceSessionMutation` (old entry
`remote:ssh:127.0.0.1:2222:dev:/work`, ref `connection-profile:fixture-profile:password`, new server
identity for the same target) returned `deletesProfileOwnedCredential=true`, `saveCount=0`, `entryCount=1`.
`preservesRollbackCredential` protected only legacy `remote-workspace:remote:*` keys. The credential service
itself does read-modify-write under a file lock; no stale in-process cache was found.

## Fix

The `remoteWorkspaceHistory` cleanup collector treated "keys the snapshot references" as "keys history owns".
It now collects only `remote-workspace:` owned credentials. Profile passwords and key passphrases stay owned
by the Source Directory: successful re-projection, capacity trimming and explicit history removal must never
delete them. No retry, password re-write, credential copy or recovery-timing change was added; the legacy
rollback protection and history-owned credential cleanup are kept. The fix prevents future deletion;
credentials already deleted by older builds must be re-saved through the existing authentication entry.
Rollback touches only the cleanup helper and re-exposes the deletion risk.

Regression tests (real module): successful rekey, capacity trimming and explicit removal failed before the
fix (each returned Profile password and passphrase delete intents) and pass after; the failure-recovery
control stays green. The boundary E2E asserts credential-reference presence before and after restart and
requires the post-restart directory read to succeed, without logging key or passphrase content.

## Verification

- Typecheck, lint (207 pre-existing warnings, 0 errors), architecture (0 violations), format and diff checks pass.
- Affected tests: 397 Vitest files and 4 Node test files. Vitest 4465 passed; one inventory check exceeded
  30 s in the batch run and passed in a targeted rerun (11 tests, 1.47 s) with no timeout or expectation
  change. Node scripts 34 passed; Source Directory 41 passed.
- Intermediate batch `r3-server-20261012003650390-d1994e` (fix applied, stale acceptance): 1 PASS / 5 FAIL.
  The failures continued as [issue 15](15-cold-start-open-workspace-siblings.md).
- Final: after issue 15's stale cold-start assertions were corrected (F5 semantics), batch
  `r3-server-20261012012923737-60d156` passed boundary, mixed, coldreconnect, project-order and rdux14 with
  no further business-logic change; `recov` passed on the same fix build. boundary showed password refs 1 and
  present 1 before restart, after restart and at the end, and the post-restart directory read succeeded.

Evidence: `packages/desktop/.e2e-artifacts/r3-server-20261011104332183-3a0c00-boundary/` and
`packages/desktop/.e2e-artifacts/issue11-20261012/`.
