# macOS DMG signing and notarization

## Background

The macOS release DMG is the final distribution artifact that users download from a browser and hand straight to
Gatekeeper. 3.1.2 shipped a DMG that had passed `notarytool` and `stapler staple` but whose DMG itself had no
Developer ID signature; a download carrying a Chrome quarantine attribute was judged
`source=no usable signature` by `spctl -t open/install`, so some users failed to install.

## Goals

- `ZCode.app` keeps being signed by electron-builder with Developer ID Application.
- The final DMG must be separately `codesign`ed with the Developer ID before being submitted to Apple
  notarization.
- After DMG notarization and removal of `.unnotarized`, it must pass `codesign`, `stapler validate` and
  `spctl -t open`.
- The final `ZCode.app`, its bundled Helper and the user-level installed Helper must separately pass
  `codesign --verify --deep --strict` and `spctl -a -vv -t exec`; both Helpers must also pass the local
  `xcrun stapler validate`, confirming the staple still corresponds to the final bundle after signing was not
  overwritten again.
- A formal tag release must not upload `.unnotarized.dmg`; test, sandbox and MR pipelines may keep un-notarized
  artifacts for troubleshooting but they must not enter a formal release.

## CI flow

1. `build:macos:*` imports the Developer ID Application p12 into a temporary keychain.
2. `electron-builder` packages and signs `ZCode.app`, producing `ZCode-<version>-mac-<arch>.dmg`.
3. `ci-collect-artifacts` collects the DMG as `*.unnotarized.dmg`.
4. `scripts/notarize-macos.sh` runs DMG signing, notarization, staple, rename and acceptance on
   `*.unnotarized.dmg`.
5. In a strict release `scripts/notarize-macos.sh` also locates the packaged `ZCode.app` via
   `ZCODE_MACOS_RELEASE_APP_PATH` or `ZCODE_DESKTOP_DIST_DIR` and reuses `scripts/doctor-macos-release-app.sh` to
   accept the main app; with no app path it fails closed. The CUA/Helper release gate additionally sets
   `ZCODE_CUA_REQUIRE_HELPER=1` and explicitly accepts `Contents/Resources/cua-helper/ZCode Computer Use.app`
   inside the final app; missing means fail closed.
6. In a formal release `scripts/upload-oss.sh` accepts only `*.dmg` that completed the above flow.

### Temporary keychain search list constraint

Shell runners under the same macOS user share the user-level search list. Each job's keychain file is separate,
but reading, sanitizing and adding/removing list entries must happen inside the existing shared lock, and must
not overwrite the list with a snapshot taken at job start.

- The output of `security list-keychains -d user` is indented and wrapped in outer double quotes; first strip
  leading/trailing whitespace, then strip one outer layer of quotes, keeping spaces inside the path. Keep only
  existing absolute file paths, de-duplicate by full path and keep the original order.
- If the user's `login.keychain-db` file exists but is missing from the list, append it to the end, restoring a
  default entry polluted by an old script. This does not replace the certificate chain and private-key access
  permission checks.
- Adding must be idempotent; cleanup removes only the current job's path and keeps other jobs' valid entries;
  with no entries left an empty list is written explicitly. When reading the list fails, writing back is
  forbidden: release the lock and report failure, and never treat a read failure as an empty list.
- Regression tests run the real CI functions in Bash, with simulated commands providing the indented list and
  read/write failures, and must not access a real keychain. They cover pollution recovery, paths with spaces,
  de-duplication, interleaved add/remove and lock release; real runners still need verification of arm64/x64
  concurrent signing.

```text
acquire shared lock → read current list → parse and sanitize → add/remove own entry → write back → release lock
                         └ read failure → no write back → release lock and fail
```

This constraint protects only scripts that follow the same lock protocol. Scripts on old branches may still
overwrite the list; update the scripts or isolate runner users. Temporary keychains are not deleted by directory
age, to avoid deleting resources of jobs still building.

## Computer Use Helper: independent signing and architecture constraints

`ZCode Computer Use.app` ships with the main app and is copied to the user directory at runtime, but it is still
an independent TCC responsible principal (bundle id `dev.zcode.cua-helper`) and must be signed **separately**
from the main app to obtain its own Accessibility / Screen Recording entries in the system. Constraints:

- **The Helper ships with ZCode.app but runs as an independent bundle.** The source in the release package is
  fixed at `ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`; the product installer verifies it
  and copies it to `${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app`. Network download,
  `/Applications`, `~/Applications` or `ZCode.app/Contents/Library/Helpers` are not accepted as product
  fallbacks; a missing source must fail closed.
- **The Helper is an independent bundle but reuses ZCode's release identity.** The standalone Helper release
  chain must sign `dev.zcode.cua-helper` with `build/entitlements.helper.plist` + hardened runtime, with the
  same Developer ID Application team/identity as `ZCode.app` (no extra certificate or Apple account cost).
  `ZCode.app` and `ZCode Computer Use.app` in the same release payload must go through the same
  notarization/staple acceptance chain; after acceptance the Helper can be copied by the installer/script as an
  independent `.app` to `${ZCODE_HOME:-$HOME/.zcode}/computer-use/`. ZCode.app is responsible only for
  discovery, LaunchServices launch, the health check and injecting a random socket/token into the MCP child.
- **The Helper main executable must be a SEA Mach-O.** `scripts/build-cua-helper-app.mjs` uses Node SEA to inject
  the helper entry into a copied Node executable (replacing the old shell wrapper); it must already be a Mach-O
  before signing/notarization.
- **The plain-node ABI `ax_native.node` must be built first.** At runtime the SEA helper loads the pinned
  `@zcode/zcode-cua/build/Release/ax_native.node` with the embedded Node (not Electron), so it needs the
  **plain-node ABI** (node-gyp rebuild, not the Electron ABI of `@electron/rebuild`). `@zcode/zcode-cua` is in
  `allowBuilds` of `pnpm-workspace.yaml`; the standalone Helper build/acceptance must explicitly check that this
  unified addon exists and loads.
- **Cross-architecture (x64 packaged on an Apple Silicon runner).** On an Apple Silicon runner the packaging
  process's `process.execPath` is an arm64 Node; if the x64 job does not specify another Node, the SEA helper
  would be built as arm64. `assertHelperSeaBaseNodeArch` in `build-cua-helper-app.mjs` fails closed before SEA
  assembly and prompts: set `ZCODE_CUA_HELPER_NODE_PATH` for the x64 job to a SEA-capable Node compiled for the
  target architecture, and build the pinned producer's `build/Release/ax_native.node` for the target
  (`--arch=x64`). A native arm64 job needs no extra setting.

## Local Helper debugging without a Developer ID

A dev machine without a Developer ID / notarization credentials can still run the Helper-owned CUA chain with the
real ZCode App, but it must be explicitly marked local dev and must not serve as release evidence:

1. Build `ZCode Computer Use Dev.app` locally and install it to
   `${ZCODE_HOME:-$HOME/.zcode}/computer-use/dev/ZCode Computer Use Dev.app`.
2. Start the ZCode App from a terminal and set only in that process environment:
   `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`. The product Helper resolver is enabled by default in official
   releases and local/dist builds; only an explicit `ZCODE_CUA_PRODUCT_HELPER=0|false|off` turns it off. Desktop
   injects this deterministic local path into the utility host as the bundled source; when missing it fails
   directly and never falls back to network download.
3. ZCode.app still launches the external Helper through LaunchServices
   `open -n -g <Helper.app> --args --socket <path> --token-file <path> --launcher-pid <pid>`, so the macOS TCC
   principal is still the Helper itself. The product path **accepts only the one-time `--token-file` freshly
   signed by the launcher** (`helperMain` rejects a product broker without a token-file) and requires
   `--launcher-pid` for peer process-tree verification; `--token` is only an explicit local dev fallback and
   should not be the product acceptance path.

This mode relaxes only the Developer ID TeamIdentifier and Gatekeeper/notarization checks; bundle id, version,
architecture and Mach-O structure must still match. When missing or structurally mismatched it neither downloads
nor replaces the official Helper but fails closed. The TCC identity of an ad-hoc/unsigned Helper is unstable and
may need re-authorization after a rebuild; formal acceptance must still use a signed, notarized, stapled Helper.

## Acceptance commands

```bash
codesign --verify ZCode-<version>-mac-<arch>.dmg
xcrun stapler validate ZCode-<version>-mac-<arch>.dmg
spctl -a -t open --context context:primary-signature ZCode-<version>-mac-<arch>.dmg
```

After install, finally accept the main app and the external Computer Use Helper:

```bash
pnpm run doctor:macos-release -- "/Applications/ZCode.app"
ZCODE_CUA_REQUIRE_HELPER=1 pnpm run doctor:macos-release -- "/Applications/ZCode.app"
```

This command runs in order:

```bash
codesign --verify --deep --strict "/Applications/ZCode.app"
spctl -a -vv -t exec "/Applications/ZCode.app"
codesign --verify --deep --strict "$HOME/.zcode/computer-use/ZCode Computer Use.app"
spctl -a -vv -t exec "$HOME/.zcode/computer-use/ZCode Computer Use.app"
xcrun stapler validate "/Applications/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app"
xcrun stapler validate "$HOME/.zcode/computer-use/ZCode Computer Use.app"
```

0.5.5 legacy: after an upgrade the old `ZCode CUA Helper.app` directory may still exist, but it is not the
current installation's acceptance target; do not run `codesign` / `spctl` on the old path and treat the result as
release evidence for this version's Helper.

The script captures the output of the commands above on the success path and prints the raw diagnostics only on
failure, so the verbose internal attribute details of `codesign` / `spctl` do not pollute formal packaging logs.
