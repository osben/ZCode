# CUA Producer 0.5.7 Integration and Consumer Convergence

- Date: 2026-08-19
- Status: implemented, awaiting manual review
- Producer candidate: `zcode-cua@52da434158df32f6d0825db6af1c3d263754c44c`
- Target branch: `feat/cua-merge-0817`

## Background

z-code had moved the source of truth of the Helper runtime to the pinned `@zcode/zcode-cua`, but the old
producer pin still forced the consumer to maintain three kinds of duplicate state:

1. a controller status/take/stop permission-service facade the renderer no longer calls;
2. always-true ghost cursor/PiP async getters, and `--permission-mode product` / `--backend broker` labels
   with no runtime consumer;
3. Helper app/display/executable names maintained by z-code itself.

Producer 0.5.7 removed these facades/pseudo-configs and converged the stable and dev Helper identities into
indivisible canonical constants. The consumer must migrate in the same batch; changing only the git pin would
produce a hybrid package of "old app directory and plist + new executable".

Pin evolution: `d55c5f3a` provided the producer surface convergence; `305df53f` merged stable screenshot
click, Zoom/ghost cursor and the HTTP request lifecycle; `d51e5365` wired the failed-start Helper identity
check/exit evidence into mandatory CI; `611304cc` fails closed on PID reuse during the exit wait and never
escalates SIGKILL to a new identity; the final `52da4341` converged the Skill guide on that baseline. The
consumer records only that immutable final revision.

## Architecture and release order

```text
zcode-cua MR (producer)
  ├─ ports: getStatus / restartHelper
  ├─ product host: ghost=true, PiP=true, background=false
  ├─ raw broker controller protocol + lease kept
  └─ canonical Helper identity
             │ pinned immutable commit SHA
             ▼
z-code MR (consumer)
  ├─ Local Host implements only getStatus / restartHelper
  ├─ plugin-host verifies only authority + exact socket + token
  ├─ build/package/desktop all consume the canonical Helper identity
  └─ wrapper / skill / lockfile synced with producer 0.5.7

Manual review order: merge the producer MR first, then the z-code MR; this task neither auto-merges nor tags.
```

## Contract

### Desktop installer runtime closure

- `@zcode/services` wires the producer broker into Desktop main, host and scheduler; the matching
  `@zcode/zcode-cua` JavaScript must be inlined by tsup and leave no bare package import in the final bundle.
- electron-builder keeps excluding `node_modules/@zcode/**`. To fix module resolution, the producer's source,
  sourcemaps, build directory or `ax_native.node` must not be copied wholesale into `app.asar`; native actions
  stay hosted only by the separate Helper.
- A unit test must mechanically check `noExternal` for the main, host and scheduler configs; release
  verification must actually build and launch the installer, and DMG/ZIP generation success is no substitute
  for startup success.

### Permission service and controller

- `ICuaPermissionService` keeps only `getStatus` and `restartHelper`.
- Delete the `getHelperStatus`, `takeController`, `stopController` routes and DTO re-exports in z-code that
  only implemented themselves and were referenced by tests.
- The raw broker's `controller_status` / `controller_takeover` / `controller_stop`, controller lease,
  admission, visual ownership and orphan reaper are all kept.
- Desktop continuous and web remote replayable both keep attaching to the same window-scoped Local Host; this
  change adds no runtime, session event, snapshot or remote state.

### Plugin authority

- Delete the permission-mode/backend argv injection and validation that has no runtime decision consumer; CLI
  bootstrap uniformly strips the old labels before the `--` terminator before calling the producer, so
  mixed-version configs do not pass retired argv further down. The producer injection re-export that services
  keeps only for tests does not carry this consumer canonicalization.
- This canonicalization is decoupled from broker credential injection: an explicit local-dev raw path without a
  socket and the non-macOS pass-through path must also clean the old labels, without injecting socket/token/
  authority or changing the fail-closed omit decision.
- Cleanup and canonical socket upsert treat only an adjacent token "not starting with `--`" as an independent
  value; in a malformed config where a flag is followed directly by another flag, the latter must not be
  swallowed and no old socket/value may be left as an orphan positional.
- Before import the official plugin must still prove all of: the official plugin id, the authority captured by
  the resolver, a broker socket exactly equal to the captured value, and a non-empty broker token.
- Any missing or drifted socket/token/authority fails closed; the server name or old labels must not substitute.

### Helper identity and packaging

- The stable package is fixed to `ZCode Computer Use.app`, the dev package to `ZCode Computer Use Dev.app`;
  both executables are `ZCode Computer Use`.
- The dev package's directory name, `CFBundleDisplayName` and broker display policy use
  `ZCode Computer Use Dev`; this does not change `CFBundleExecutable`, which must keep using the producer's
  `HELPER_DISPLAY_NAME` (`ZCode Computer Use`) and must not be derived back from the dev app name.
- build, electron-builder, release zip, notarize, doctor, runtime resolver and CI use the same set of producer
  constants; executable JavaScript build/dev entries import the constants directly, and literals in shell/CI
  that cannot import modules are mechanically compared with `HELPER_APP_NAME` / `HELPER_DISPLAY_NAME` by unit
  tests, no longer relying on manual sync. z-code no longer copies the default display name.
- Helper CI must read the immutable producer SHA dynamically from the workspace catalog; the extraction command
  itself must be actually executed by a Node unit test against the original script text in CI, not just a
  string-presence check. Regexes in shell/YAML must not double-escape `/`, otherwise Node 24 ends the dual-arch
  Helper job with a syntax error after the native build completes.
- The feature graph must list Helper build/release as a shared service node of Computer Use and build-release
  engineering and record `ZCode Computer Use.app` / `ZCode Computer Use Dev.app` as the current contract; the
  old `cua-helper-build` seed must not keep describing the retired app name.
- `assembleHelperApp` no longer takes `displayName`; the bundle id decides the app directory, plist name and
  executable at once, with no partial override.
- 0.5.5 legacy: the old `ZCode CUA Helper.app` may remain in user directories; TCC still identifies it by the
  existing bundle id/signing identity. This batch performs no unproven directory deletion or process-name kill.
- Current ops, signing, notarization, install and troubleshooting runbooks must treat only
  `ZCode Computer Use.app` as the acceptance target; the old name may appear only in residue notes marked
  `0.5.5 legacy`, so `codesign` / `spctl` do not silently verify the old package.

### Pin and skill

- The workspace catalog keeps a single canonical `@zcode/zcode-cua` git pin.
- The wrapper package/plugin/bootstrap version, the producer commit of the final raster spec, the bundled skill
  and `upstream.json` must sync to the 0.5.7 candidate.
- The skill sync script accepts only one canonical pin and writes an explicit upstream ref; it must not require
  the deleted helper-runtime alias nor write a temporary local branch name into release metadata.

## Tests and gates

- Update/add contract tests first, then change the implementation.
- service: permission facade inventory, authorization status/restart, TOCTOU final attestation, Windows
  runtime and the UI "no automatic controller RPC" cases.
- The low-level contracts of AX read-only, the Electron backend and the Helper installer are owned solely by the
  producer; z-code deletes three drifted mirror tests and keeps only consumer boundary tests for product
  wiring, permission UI, Local Host and packaging.
- CLI/plugin: missing and drifted authority/socket/token fail closed; permission-mode/backend no longer appear.
- packaging: stable/dev app, plist, executable, zip allowlist, electron-builder resource paths, CI staging
  paths and producer provenance are consistent; the dev app's display name and executable must be verified
  separately to avoid mistaking `ZCode Computer Use Dev` for the executable.
- operations docs and feature graph: all executable paths, signing acceptance commands and the build contract
  point to the canonical app; the old name remains only in explicit `0.5.5 legacy` residue warnings. The
  2026-10-15 unit-test cleanup removed the doc-text matching guards; executable artifacts are still accepted
  by the actual Helper build/release, and text matching is not treated as behavior coverage.
- version/skill: version coherence, skill sync actually executed, single-pin assertion, frozen install.
- Required: `pnpm typecheck`, `pnpm lint`, related unit tests, `pnpm build:cua-helper`,
  `pnpm package:cua-helper:release:dry`. Items that platform hardware/CI cannot complete on the current macOS
  must be listed as pending in the MR, without restoring the removed duplicate state through compatibility
  fallbacks.

### Test ownership migration ledger

Deleting a consumer mirror test does not delete the regression gate. The table below takes the pinned producer
commit as the source of truth and lists the producer behavior tests and the cross-package smoke tests that stay
in z-code. The producer MR must first pass the full `pnpm test`, then the consumer MR passes the matching
smoke, Helper build/release and the full-repo unit run. Paths are relative to each repository root.

| Deleted z-code mirror                         | Producer 0.5.7 behavior owner / executable tests                                                                                                                                                                                                       | Consumer boundary kept in z-code                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cuaPermissionBroker.axReadOnly.test.ts`      | `test/native/windows-app-ref-resolution.test.ts`, `test/broker/ax-action-dispatch-status.test.ts`, `test/broker/capture-app-incremental-contract.test.ts`, `test/request-access-read-only.test.ts`                                                      | `packages/services/test/cuaPermissionBrokerNodeHelper.test.ts` verifies the pinned Helper/Node seam; Windows product/runtime integration stays in the consumer                                                                                |
| `cuaPermissionBroker.electronBackend.test.ts` | `test/request-access-read-only.test.ts`, `test/electron-screenshot-display-provenance.test.ts`, `test/windows-capability-truthfulness.test.ts`, `test/open-application-identity-conjunction.test.ts`, `test/macos-background-application-open.test.ts` | `packages/services/test/cuaPermissionBrokerHelperHost.test.ts` and `cuaPermissionBrokerNodeHelper.test.ts` verify Local Host -> producer assembly and fail-closed startup                                                                     |
| `cuaPermissionBrokerHelperInstaller.test.ts`  | `test/broker/helper-install-variants.test.ts`, `test/broker/helperInstaller.production-source.test.ts`, `test/broker/helperInstaller.build-id-promotion.test.ts`, `test/standalone/helper-launch/{installer,downloader,signature-verifier}.test.ts`   | `packages/services/test/cuaPermissionBrokerHelperAppBundle.test.ts`, `cuaPermissionBrokerHelperReaper.test.ts`, `packages/desktop/test/{cuaHelperRuntimeProvenance,runtime-asset-scripts}.test.ts` verify app assembly, cleanup, packaging and pin provenance |
| `cuaControllerServiceRouting.test.ts`         | `test/broker/{controller-admission,controllerCoordinator,controllerLease}.test.ts` keep the Helper-internal arbitration; the retired desktop RPC facade is not restored                                                                                | UI negative tests keep the constraint on the removed settings surface; the 2026-10-15 cleanup removed the consumer source forbidden-word guard, which is no longer treated as RPC behavior coverage                                            |
| `cuaGhostCursorSettingsWiring.test.ts`        | `test/broker/product-host-launch-policy.test.ts` locks product ghost/PiP always on and background off                                                                                                                                                  | `cuaPermissionBrokerHelperHost.test.ts` verifies only the product host wiring and does not copy the producer policy implementation                                                                                                            |

This ledger allows deleting a mirror only while the owner tests still exist and the producer full gate passes;
if a producer path is renamed or the behavior moves, update this table and the matching producer tests first,
then adjust the consumer smoke.

## Implementation verification

- The test ownership ledger was run against the pinned producer commit: producer 18 files / 122 tests, consumer
  boundary 9 files / 261 tests, all passed.
- Under Node 24.14.0 root typecheck and the CLI 22-package typecheck pass.
- CUA/desktop targeted regression: 19 files / 423 tests passed; CLI authority, skill and config: 188 tests
  passed.
- Full-repo unit: 1307 files passed, 1 skipped; 11396 tests passed, 11 skipped.
- Under the official self-contained Node 24.14.0 `build:cua-helper` passes with output
  `ZCode Computer Use.app`; the release dry-run passes, with only a real signing identity missing in the
  current environment.
- Under the official self-contained Node 24.19.0 `build:cua-helper:dev` passes (after the local stable dev
  identity keychain access blocked, the script's supported explicit adhoc escape hatch was used); the actual
  bundle is `ZCode Computer Use Dev.app`, `CFBundleName` / `CFBundleDisplayName` are
  `ZCode Computer Use Dev`, and `CFBundleExecutable` and the only arm64 Mach-O file are both
  `ZCode Computer Use`. This verification covers only the dev bundle identity and does not replace the release
  signing gate.
- Root lint 0 errors (the repo has 37 existing warnings). Root `fmt:check` is still blocked by the existing
  Electron fiddle HTML and `gb2312.js`; this change's files pass formatting, and the upstream Skill is kept as
  the producer's original for byte-for-byte provenance.
