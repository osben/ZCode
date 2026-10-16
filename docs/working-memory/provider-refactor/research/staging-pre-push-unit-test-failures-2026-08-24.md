# staging Pre-push Unit Test Failure Report (2026-08-24)

> **Environment Review Note:** Successfully accessed internal asset services through a restricted SSH forward from a MacBook Pro, and executed full `pnpm bootstrap` using the repository-locked
> **Node v24.14.0 + pnpm 10.33.2**. install, Desktop
> `node-pty` rebuild, Agent/CUA bundles, native-search-tools downloads and verifications, workspace builds, and
> Desktop builds all succeeded, with bootstrap's final exit code being 0. Subsequently re-ran the following 7 files, and results remain
> **30 failures, 128 passing, 4 skipped**, with the failure set completely unchanged. Therefore missing installs, incomplete bootstraps,
> internal network download failures, and Node minor version differences have all been excluded.

## Summary

Verified the latest `origin/staging` on a Linux local environment using an independent detached worktree:

- staging SHA: `0e867f1323` (`Merge branch 'fix/tool-call-display-consistency' into 'staging'`);
- Targeted running 9 test files that errored in the pre-push full test suite;
- staging actual results: **30 failures**;
- Provider Refactor current branch results: **32 failures, 12,366 passing, 25 skipped**;
- Both share the exact same 30 Windows packaging, macOS notarization, and CUA failures;
- The 2 additional Settings source guard failures from the current branch have already been fixed by staging commit `4f0b024f73`;
- Therefore the pre-push failure body from the Provider Refactor is not introduced by this Provider overhaul; the latest staging also cannot pass that gate in the same environment.

## Environment

```text
OS: Linux
Initial verification Node: v24.19.0
Reviewed Node: v24.14.0 (repository-locked version)
pnpm: 10.33.2
Repository expected Node: 24.14.0
Vitest: 4.1.4
staging: 0e867f1323
```

Verifications use independent staging worktrees without modifying the Provider Refactor's current workspace. CUA catalog versions have no differences between staging and the current branch; Services CUA tests reuse the same installed catalog dependencies.

## staging's 30 Failures

### 1. Windows release packaging: 2 cases

Files:

- `packages/zcode-server-cli/test/releaseInstaller.test.ts`
- `packages/zcode-server-cli/test/packaging.test.ts`

Failing cases:

```text
release installer
  × installs a Windows zip and writes a launcher that is safe for quoted paths

stageRelease
  × stages a Windows target with a cmd launcher and zip archive
```

Representative errors:

```text
Error: spawn zip ENOENT
```

### 2. macOS notarization: 3 cases

Files: `packages/desktop/test/notarizeMacosScript.test.ts`

Failing cases:

```text
× Testing environment DMGs with TEST suffix should also enter the notarization flow
× retries transient notary upload failures before continuing
× formal releases missing post-installation app acceptance paths should not judge notarization as successful
```

Representative errors:

```text
scripts/notarize-macos.sh: line 92: integer expression expected
[notarize] dmg not found ... for arch=arm64
```

The script treats `stat` outputs as integers on Linux, subsequently misjudging test DMGs as non-existent.

### 3. Desktop CUA identity: 2 cases

Files: `packages/desktop/test/cuaHelperDevIdentity.test.ts`

Failing cases:

```text
× skips import entirely when the identity is already trusted and listed
× reuse-branch success returns without scope errors and reports persist state
```

Representative errors:

```text
expected security import calls to have length 0, but got 1
expected result.ok to be true, but got false
```

### 4. Desktop CUA System Settings watcher: 8 cases

Files: `packages/desktop/test/cuaSystemSettingsWindowWatcher.test.ts`

Failing cases:

```text
× parses a JSON line into the latest bounds
× reassembles bounds split across chunk boundaries
× keeps only the last line when several arrive in one chunk
× picks the largest layer-0 window so modal sheets do not hijack the anchor
× reports null once the settings window closes (empty array)
× fails open when the process exits or errors
× never spawns twice and kills the child on stop
× does not throw when the binary is missing (spawn throws synchronously)
```

Representative errors:

```text
expected watcher.latest() to equal window bounds, received null
expected spawnProcess to be called once, received 0 calls
expected error event not to throw, but Error: ENOENT was thrown
```

### 5. Services CUA Node Helper: 10 cases

Files: `packages/services/test/cuaPermissionBrokerNodeHelper.test.ts`

Failing cases:

```text
× does not expose missing or non-function raw-input/PiP exports from a legacy addon
× kills a timed-out capture, cleans its temp dir, and allows the next request
× serves observation/screen/clipboard methods behind the token over a real socket
× rejects an unauthenticated method call (helper requires the token)
× self-terminates (startup-claim watchdog) when no client claims it within the TTL
× does not report startup-timeout termination when an admitted action cannot drain safely
× freezes an unclaimed startup epoch before late authenticate + broker_info can pass health
× retries an explicit terminal stop after timeout until the admitted action drains
× terminal stop cancels a window-scoped native hold without waiting its 30s duration
× does not self-terminate once a client has authenticated (claimed)
```

Representative errors:

```text
preventActivation must stay fail-closed: expected function to be undefined
expected captureWindowPng(...) to return PNG bytes, received null
TypeError: native.probeAccessibility is not a function
```

### 6. Services CUA Helper Host: 5 cases

Files: `packages/services/test/cuaPermissionBrokerHelperHost.test.ts`

Failing cases:

```text
× permission refresh restarts processes but reuses socket/tokens, deletes markers only after successful verification
× marker complete retains handles after initial failures, retries only clean markers without restarting healthy H2
× external stops clean pending refresh markers after old transports confirm retirement
× H1s for permission refreshes prohibit SIGKILL and H2 launches when not responding to TERM, and keep markers
× H2 launches for permission refreshes fail closed after failures; next time can only be fresh and return reused=false
```

Common error patterns:

```text
CuaHelperError: Failed to verify the live ZCode Computer Use process identity
Caused by: ENOENT: no such file or directory,
rename '<socket>.pending' -> '<socket>'
```

## Provider Refactor Current Branch's Additional 2 Failures

Files:

- `packages/ui/test/settingsSubagentRowContent.test.ts`
- `packages/ui/test/settingsSkillScopeBadge.test.ts`

Failing cases:

```text
× uses the shared scoped resource-list structure
× does not repeat scope metadata beside the skill name in Plugin
```

These two cases already pass at `origin/staging@0e867f1323`. Corresponding staging fix commits:

```text
4f0b024f73 fix(ui): update source guard assertions to resolvePluginDisplayName
```

Therefore, after merging the latest staging, the count is expected to drop from 32 to 30, without making the pre-push gate fully green.

## Reproduction Commands

Full pre-push:

```bash
pnpm verify:pre-push
```

Only run 7 files still failing on staging:

```bash
pnpm exec vitest run \
  packages/zcode-server-cli/test/releaseInstaller.test.ts \
  packages/zcode-server-cli/test/packaging.test.ts \
  packages/desktop/test/notarizeMacosScript.test.ts \
  packages/desktop/test/cuaHelperDevIdentity.test.ts \
  packages/desktop/test/cuaSystemSettingsWindowWatcher.test.ts \
  packages/services/test/cuaPermissionBrokerNodeHelper.test.ts \
  packages/services/test/cuaPermissionBrokerHelperHost.test.ts
```

## Conclusions

The current Provider Refactor's targeted Provider, Adapter, Bootstrap, Services, Protocol, and UI regressions have all passed; what blocks force-with-lease pushes is the repository pre-push hard gate on full unit tests. The latest staging also reproduces 30 of these in the same environment,
so these cross-platform/CUA baseline tests need to be individually fixed or adjusted, and cannot be attributed to the Provider Refactor.

## Fix Designs

These 30 cases belong to cross-platform test gate defects; fixes do not change the product semantics of CUA, releases, or Providers:

- Windows ZIP archiving switches to in-repository asynchronous Node implementations, no longer requiring test machines or release builders to pre-install the `zip` command;
- The notarize script's mtime reads simultaneously compatible with BSD/macOS and GNU/Linux `stat`;
- macOS identity and System Settings watcher test platform seams must extend through to internal helpers;
- macOS Node Helper contract tests explicitly fix to `darwin`; cross-platform broker tests supplement current platform ABIs with fake natives;
- Helper Host state machine tests not starting real broker sockets explicitly disable transport rendezvous, avoiding temporary directory lengths deciding test branches;
- All fixes continue fail-closed, not hiding cross-platform failures by skipping entire test groups.

## Fix Results

On 2026-08-24, fixes were completed according to the above designs: the original 7 failing files received `158 passed / 4 skipped` on Linux,
with all 30 original failures completely eliminated. Meanwhile, Windows ZIP generation and safe decompression were unified to in-process asynchronous implementations, removing release builders' dependency on system `zip` and GNU tar reads of ZIP errors. The current branch's additional two UI source guard drifts synchronously adopt staging's existing fix `4f0b024f73`'s assertion results, without changing UI product implementations.
