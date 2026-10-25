# Windows CUA product runtime spec

## Goal

Without depending on a local `zcode-cua` source directory and without controlling SSH/WSL/Docker/remote
workspaces, let a Windows x64/arm64 ZCode installer start the local Computer Use Helper on demand, reusing
the existing `@zcode/protocol`, the CUA broker, the official `zcode-cua` plugin and the desktop-local host
lifecycle.

Source development may still override product resources with `ZCODE_CUA_DEV_ROOT`; a product installer by
default reads only its own `resources/tools/cua-helper`, does not search adjacent directories, does not
download a Helper and does not fall back to the macOS implementation.

## Design conclusion

Windows reuses the boundary proven on macOS: the Agent connects only to the broker and the Helper holds the
automation capability independently. It does not copy macOS's separately published `.app`/SEA form (needed for
TCC authorization): Windows has no corresponding TCC principal requirement, so the Helper is started by the
Electron Node runtime inside the installer and the native `ax_native.node` ships as an installed resource.

`@zcode/zcode-cua` is the only package identity for Helper JavaScript, native source, addon and version
verification; no helper-runtime alias may be declared for the same Git commit. macOS/Windows CI must rebuild
the target-architecture addon from the canonical package and fail closed when `binding.gyp` or the
platform source is missing.

```text
Build time

pinned commit of @zcode/zcode-cua (or build-time explicit ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR)
  ├─ package.json:zcodeCuaRuntime.windows.entry
  ├─ package.json:zcodeCuaRuntime.windows.nativeAddon
  └─ externalized runtime deps express / sharp
                 |
                 v
prepare:windows-cua-helper
  ├─ verify package identity, target win32 arch and PE machine
  ├─ copy the minimal runtime files
  └─ generate runtime-manifest.json with SHA-256
                 |
                 v
bundled-tools/win32-{x64|arm64}/cua-helper
                 |
                 v
electron-builder extraResources + Windows signExts(.node/.dll)
  ├─ at copy time, sign .node/.dll in the final directory first
  ├─ afterPack checks win32/arch from the actual context equals the configured target
  ├─ refresh manifest.sha256 using only the final signed bytes
  └─ then strictly verify manifest / PE / hash / dependency closure / realpath containment
                 |
                 v
<install dir>/resources/tools/cua-helper
```

```text
Run time (desktop-local only)

official CUA plugin enabled
  -> host lazily resolves the Windows runtime
     -> if ZCODE_CUA_DEV_ROOT is non-empty: strictly use the explicit source root
     -> else: strictly use process.resourcesPath/tools/cua-helper
        -> verify manifest / win32 / arch / Electron version / file hashes
           -> Electron.exe + ELECTRON_RUN_AS_NODE=1 fork windows-helper.js
              -> Helper loads ax_native.node
                 -> named pipe broker ready + health PID re-check
                    -> Agent obtains socket/token/pluginAuthority
```

`desktop-attached-remote`, `standalone-server` and hosts with a remote workspace identity keep not creating a
default Helper. This adds no runtime, local host, SSH/WSL/Docker session, and does not change the mobile
`/remote` replayable, owner, queue, snapshot or workspace identity semantics.

## Release resource contract

The producer must expose a strict, versionable Windows runtime contract in `package.json`:

```json
{
  "zcodeCuaRuntime": {
    "schema": 1,
    "windows": {
      "entry": "dist/windows-helper.js",
      "nativeAddon": "build/Release/ax_native.node"
    }
  }
}
```

The contract object and the Windows sub-object allow no unknown fields; both artifacts must be canonical
`/`-separated relative paths, must differ, and must not contain backslashes, absolute paths, empty segments,
`.`, `..`, ADS colons or NUL. The consumer must not hard-code the producer version or artifact directory.

The product directory is fixed at `resources/tools/cua-helper` and contains at least:

- `runtime-manifest.json`
- `package.json` (declares `"type": "module"`; version equals the manifest `packageVersion`)
- the Helper file the contract `entry` points to
- the native module the contract `nativeAddon` points to
- `node_modules/express` and its runtime dependency closure
- `node_modules/sharp` and the target platform's `@img/*` prebuild packages

The `package.json` module declaration is mandatory (ZCT-2093176018262081536): the entry is ESM containing bare
`import`; if the runtime root has no nearest package.json, Node can rely only on detect-module syntax
probing, and any stray package.json with a `"type"` on the install drive chain disables the probe, making the
Helper fail with `SyntaxError` exit 1 and surface as `broker_unavailable`. Staging generates the file and the
afterPack verifier checks its presence, type and version consistency.

Manifest schema version is `1` with fixed fields:

```json
{
  "schemaVersion": 1,
  "packageName": "@zcode/zcode-cua",
  "packageVersion": "0.5.2",
  "platform": "win32",
  "arch": "x64",
  "electronVersion": "41.0.3",
  "entry": "dist/windows-helper.js",
  "addon": "build/Release/ax_native.node",
  "sha256": {
    "entry": "<lowercase hex>",
    "addon": "<lowercase hex>"
  }
}
```

Paths and versions above are illustrative. Staging must write the current producer's contract paths verbatim
into `entry`/`addon` and the current package version verbatim into `packageVersion` for provenance; the
runtime requires only a non-empty string and does not compare it with a version constant in ZCode. The real
release version selection is still managed by the exact commit in the lockfile.

`arch` allows `x64` or `arm64`. Build time must check the `.node` PE machine: `0x8664` is x64, `0xaa64` is
arm64. A mismatched target fails the build immediately; installing a host x64 artifact into an arm64 package
is forbidden.

The release dependency must be pinned to an exact, remotely fetchable `zcode-cua` commit; floating branch
refs, adjacent-directory guessing or install-time compilation are not allowed. `ZCODE_CUA_DEV_ROOT` is only an
explicit local-development override.

## Runtime admission and failure semantics

1. When the platform is not `win32`, the Windows resolver returns the stable `unsupported-platform`.
2. A non-empty `ZCODE_CUA_DEV_ROOT` must be an absolute path and still goes through package/entry/addon
   verification; a misconfiguration fails closed without falling back to product resources.
3. Without a dev override an absolute `resourcesPath` must exist and the product root is fixed to
   `tools/cua-helper`.
4. Product mode must verify manifest schema, packageName, platform, arch, Electron version, entry/addon
   relative paths and SHA-256.
5. Diagnostics report only a stable reason and relative artifact, never unrelated environment variables,
   tokens or file contents.
6. The Helper still starts lazily; with the feature off or the official plugin disabled it does not start,
   probe or spawn a child process.
7. start/stop/restart/health, ready PID, health PID, named-pipe token and termination-blocking semantics
   follow the existing Windows Helper host; productization adds no second lifecycle.

Source admission and staging cannot check only lexical paths. The source root must be a non-link directory;
`package.json`, entry and addon must be non-link regular files and each `realpath` must be physically
contained in the source root's `realpath`. So even if an intermediate directory is replaced by a
junction/reparse point, no file outside the repo can enter the dev runtime or the installer.

## Signing and installation boundary

- Windows release builds are still signed uniformly by the repo's vsigntool hook.
- `electron-builder.win.signExts` must contain `.node` and `.dll`, so the CUA addon, the Sharp addon/libvips
  and other installer native deps enter the same signing moment.
- A local build without a certificate may produce an unsigned test package but cannot claim release-signing
  verification.
- electron-builder 26 signs `.node`/`.dll` through the Windows transformer while copying `extraResources`,
  and signing changes file bytes. `afterPack` must first verify the manifest's fixed fields, paths, PE
  architecture, dependency closure and physical containment, refresh only the SHA-256 of entry/addon in the
  final directory, then run one strict verification including hashes; it must not keep using the unsigned
  hashes from staging.
- Windows `afterPack` must take the actual os/arch from the electron-builder context and require it equal the
  configured target; a `--win` cross build or inconsistent environment variables must fail, never return
  skipped or accept under the wrong architecture.
- Update packages reuse the desktop app's existing update channel; the Helper has no independent
  download/update state.

```text
staging manifest (unsigned-bytes hash)
  -> extraResources copy
     -> Windows transformer signs .node/.dll
        -> afterPack verifies actual win32/arch
           -> verify fixed contract + PE + dependency closure + realpath containment
              -> refresh final-bytes hash
                 -> strict re-verification of the final manifest
                    -> later EXE/app.asar signing (no longer touches resources/tools/cua-helper)
```

## Acceptance

Automation covers at least:

- source override and packaged runtime resolution paths;
- a misconfigured source override does not fall back;
- any mismatch of manifest schema/platform/arch/Electron/hash fails closed;
- the Windows feature can still create a lazy product host without `ZCODE_CUA_DEV_ROOT`;
- non-desktop-local and remote workspace identity keep refusing creation;
- staging x64/arm64 PE machine verification;
- source/staging reject physical escape through symlink, junction/reparse point;
- electron-builder includes Helper resources, `.node`/`.dll` signing extensions, context target assertions,
  post-signing hash refresh and strict afterPack re-verification;
- Electron 41 loads the staged `ax_native.node` directly;
- start the Helper from the staged/packaged product root, complete ready/health, and after exit confirm the
  named pipe is not connectable and no Helper child process remains;
- Windows' existing 30-tool source/live smoke does not regress.

Repo-level gates stay `pnpm typecheck` and `pnpm lint`. Pre-existing `test:unit:affected` failures on the
branch unrelated to CUA must be listed separately and not disguised as CUA regressions.

## Local product acceptance record (2026-07-29)

Windows `--dir` acceptance must explicitly load the repo's non-default config file name; a bare
`electron-builder --win --x64 --dir` does not load `electron-builder.config.js` and wrongly reports the
desktop `package.json` as missing a version before `extraMetadata.version` is injected. The correct command:

```powershell
Remove-Item Env:ZCODE_CUA_DEV_ROOT -ErrorAction SilentlyContinue
$env:ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR='D:\path\to\zcode-cua'
$env:ZCODE_SKIP_REMOTE_ASSETS='1'
$env:ZCODE_TARGET_OS='win32'
$env:ZCODE_TARGET_ARCH='x64'
pnpm --filter @zcode/desktop build
pnpm --filter @zcode/desktop exec electron-builder `
  --config electron-builder.config.js --win --x64 --dir
Remove-Item Env:ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR
```

The local producer was selected through an explicit `ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR` for
`@zcode/zcode-cua` staging; the workspace/lockfile still keeps the remotely fetchable exact pinned dependency;
target win32/x64, addon PE machine `0x8664`. The resource directory is
`<workspace>\packages\desktop\dist\win-unpacked\resources`, the manifest
`resources\tools\cua-helper\runtime-manifest.json`. After a GitHub download interruption, the cached
`electron-v41.0.3-win32-x64.zip` verified against Electron's official `checksums.json` was reused (zip SHA-256
`93346b31dfcd779c4c4cdfdfb2e3f9642e7a9888e388a8971ff3e95dbf948887`).

The local command executor's 20-minute cap interrupted exactly while `rcedit` modified the branded
`ZCode Preview.exe`; the leftover exe still had Electron `41.0.3` version info and a hash different from the
cache's original `electron.exe`, so Windows Application Control refused to start it. That command has no
trustworthy final exit code and cannot be recorded as a successful branded unpacked build. Running the same
`verifyPackagedWindowsCuaHelper` as afterPack independently verified the manifest, entry/addon hash, PE,
express/Sharp dependency closure and physical containment in the final resources, returning `verified`.

To verify only packaged resources and the target ABI, the original Electron `41.0.3` x64 was extracted from
that exact zip (exe SHA-256 `c3ff0b19217c3f3521bd392899cffa65b0f0c0aae500ee0291e85490a52327d4`) and run
beside the unpacked Electron resources; it is Electron `41.0.3`, embedded Node `24.14.0`, N-API `10`. The
product integration test overrode only the resolver's `command` with that executable; root/entry/addon/
node_modules all came from the packaged resources. In the final dedicated gate record the owned Helper PID was
`39992`; ready, health and `broker_info` PIDs were identical, after `stop()` a new named-pipe connection was
refused within 500 ms, the exact PID exited, and the token appeared in neither argv nor captured logs.

Live smoke runs of the same packaged entry/addon/node_modules all exit `0`:

- pointer: move, zero wheel, position observe/restore, hold interrupt and Helper clean exit all pass;
- clipboard: text read, marker write/read-back, original-text restore re-check and Helper clean exit all pass;
- screen: display/window WGC, occlusion equivalence, `capture_app`, `state_image`, fixed minimized failure,
  cursor restore and Helper/fixture clean exit all pass;
- canonical tool surface: 30-tool coverage valid, 28 non-clipboard observation/display/pointer/keyboard/
  semantic/focus/runtime tools pass; the two clipboard tools are covered by the companion smoke.

This machine has no release certificate, so the above ABI/resources acceptance must not be extrapolated to
final branded/signed executable acceptance. CI/signing-machine builds must still run the full
`rcedit -> .node/.dll/exe signing -> afterPack` and re-run the branded exe lifecycle test; Windows Application
Control must not be turned off for local acceptance.

## Explicitly not done

- No control or addition of SSH, WSL, Docker, remote workspace or mobile `/remote` runtime.
- No standalone Windows Helper downloader, installer or auto-updater.
- No Windows administrator elevation; high-integrity targets keep failing closed.
- This phase does not promise exact HDR/ICC color management; WGC ordinary-desktop capture correctness follows
  the source-phase conclusion.
