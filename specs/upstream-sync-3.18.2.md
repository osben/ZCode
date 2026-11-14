# Upstream sync 3.18.2

Status: merged on branch `sync/upstream-3.18.2` (2026-11-14), PR open.

Upstream `fec975905` ("chore: sync ZCode source v3.18.2", pushed 2026-11-13) is merged into `fork`
with a real `git merge --no-ff`. The previous pin is `c5904686e` (v3.18.1), which is the merge-base.
The upstream commit touches 46 files (+1971/-171).

**The PR must be merged with "Create a merge commit".** A squash drops `fec975905` from the fork's
ancestry and `pnpm fmt:check` then fails (`specs/fork-format-scope.md`); see #380/#381 and #412.

`fork-upstream-base.json` is bumped to `fec975905a2abd4c07e35c40d51fa097a2258ec9` / `3.18.2`.
The migration-freeze baseline (`fork-upstream-migrations.json`) is regenerated for the same pin:
3.18.2 adds no migrations, so only `upstreamCommit` changes.

## Relation to the #438 reconstruction

`specs/upstream-backport-3.18.2.md` (#438, branch `feat/version-3-18-2-07d011`) reconstructed 3.18.2
from the shipped binary before the source was public. Upstream published the source on 2026-11-13, so
this sync takes upstream's files and drops the reconstruction (the 3.18.1 rule), and #438 is closed as
superseded. Two things are kept from it:

- the conflict resolutions below (its branch resolved the same fork/upstream overlap; the fork had not
  changed those files since the reconstruction's base `c12012582`, so its versions were current);
- the fork regression tests: `packages/shared/src/credential-security/systemCredentialCipher.test.ts`,
  `packages/services/test/accountProviderStartPlan.test.ts`,
  `packages/desktop/test/windowsAuthenticodeLiteral.test.ts`, plus their
  `scripts/fork-test-files.json` entries. They are written against the public cipher/provider APIs and
  pass against upstream's implementation.

`packages/shared/src/credential-security/copiedCredentialKeyShare.ts` from the reconstruction is NOT
kept: upstream implements the copied-credential key share inline in `systemCredentialCipher.ts`
(`shareKeyWithCopiedCredentials`), so the extracted helper has no caller.

## What 3.18.2 contains

1. Linux private-file key fallback for the system credential cipher (`enablePrivateFileKeyFallback`,
   writes `credential-secret`, `enc:v2:env:` when Secret Service is unavailable), plus
   `keyFingerprint` / `readOsKeyFingerprints` / `isOsSourcePinned` and
   `shareKeyWithCopiedCredentials`. Moving the data dir now registers the current key into the new
   root's `credentials.json` system entry (`updateDataBaseDir`, host→main IPC
   `credential-key-share-request/result`).
2. Start Plan readiness: `loadStartPlanMaterial` / `startPlanMaterialFromSnapshot`,
   `isStartPlanFamilyCurrent`, `resolveStartPlanFamilyFromOAuthProvider` (`zai_cn` login → BigModel
   family), `loadStartPlanZcodeJwt`.
3. `powershell-command.mjs`: the Authenticode query imports the Microsoft.PowerShell.Security module
   and writes JSON to a temp `signature.json`. Upstream's `powershell-command.test.ts` is taken
   (the 3.18.1 note to stop carrying the `$zcodeSignatureOutput` edit).

## Conflict resolutions

12 files conflicted.

| File                                                         | Resolution                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `README.en.md`                                               | Stays deleted (fork rule from 3.18.1).                                                                                |
| `README.md`                                                  | Fork README kept; `## Updates` gains the 3.18.0/3.18.1/3.18.2 lines in English.                                       |
| `docs/bash-background-parity.md`                             | Fork English; upstream's reworded global background-task switch line ported (env name dropped upstream).              |
| `docs/settings-storage-management.md`                        | Fork English table + upstream's credential-key row for `updateDataBaseDir()` and the plans-spec link.                 |
| `docs/zai-start-plan-provider.md`                            | Fork English + upstream's `zai_cn` → BigModel Start-family paragraph (its settings paragraph was already present).    |
| `packages/desktop/wdio.conf.ts`                              | Upstream `isNativeKeychainCredentialSpec` helper (covers the new auth-config credential specs); fork English comment. |
| `packages/desktop/scripts/powershell-command.mjs`            | #438 resolution (fork script + upstream Authenticode query), identical content.                                       |
| `packages/desktop/src/host/index.ts`                         | #438 resolution (fork host + upstream key-share IPC), identical content.                                              |
| `packages/services/.../accountProviderConnectionResolver.ts` | #438 resolution (fork resolver + upstream Start Plan material), identical content.                                    |
| `packages/services/src/setting/settingService.ts`            | #438 resolution (fork service + upstream key registration in `updateDataBaseDir`), identical content.                 |
| `packages/shared/src/channels.ts`                            | #438 resolution (fork channels + upstream `credential-key-share-request/result`), identical content.                  |
| `third-party/inventory.json`                                 | Fork side, then regenerated (`node scripts/licenses.mjs notices`); `THIRD-PARTY-NOTICES.md` updated.                  |

Everything else auto-merged; for files both sides had changed (e.g. `codingPlanProviderAvailability.ts`,
`oauthCredentialRepo.ts`, `desktopHostProcess.ts`, `main/index.ts`) the result is the mechanical
union of fork changes and upstream 3.18.2, which differs from #438 only where the reconstruction had
guessed structure that upstream implements differently.
