# ZCode Computer Use External Installation Closed Loop

## Background

The ZCode Computer Use Helper runs as an independent `.app` so it is an independent accountability process for macOS TCC. The distribution package carries the already-signed Helper within `ZCode.app/Contents/Resources/cua-helper/`; at runtime it is validated and copied to a stable user-level path, then launched via LaunchServices. It is not an Electron subprocess and does not use `Contents/Library/Helpers`.

Product installation location:

```text
${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app
```

Internal `ZCode Preview` and production share `ZCODE_HOME` tasks, configuration and credentials but use independent Helper version directories, so using CUA sequentially does not make two App versions overwrite each other or trigger downgrade protection:

```text
${ZCODE_HOME:-$HOME/.zcode}/computer-use/preview/ZCode Computer Use.app
```

This path is injected by the Desktop Host as `ZCODE_CUA_HELPER_INSTALL_VARIANT=preview`, changing only the CUA runtime component location, not the business data root. Both Helper bundles keep the signed identity `dev.zcode.cua-helper`, so the macOS Accessibility / Screen Recording authorization subject still shows the same `ZCode Computer Use`.

## Installation source

The official product has exactly one installation source: `Contents/Resources/cua-helper/ZCode Computer Use.app` within the current ZCode.app. When missing, invalid or unreadable, fail closed; product code does not attempt network downloads and has no download fallback. The build and signature gate must therefore ensure this arm64 Helper ships together with the main App.

The following overrides belong only to explicit local development mode and must not be production distribution configuration:

- `ZCODE_CUA_HELPER_DOWNLOAD_URL`: complete zip URL.
- `ZCODE_CUA_HELPER_DOWNLOAD_BASE_URL`: version directory base URL.
- `ZCODE_CUA_HELPER_VERSION`: expected Helper version for the local download package.
- `ZCODE_CUA_HELPER_TEAM_ID`: expected signing TeamIdentifier. When not configured it defaults to anchoring the ZCode official team `8A5X4JJ39T` (equivalent certificate pinning), not "any non-ad-hoc team"; the variable is for development or team switching overrides only.
- `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`: local development debugging only. It does not download and does not pass release signature/Gatekeeper validation; when the source is the bundled Helper explicitly provided by the current checkout, artifact contents are compared even if the version number is the same and atomically refreshed when changed. Silent reuse of the old Helper is prohibited.
- `ZCODE_CUA_PRODUCT_HELPER=0|false|off` (macOS/Windows): explicitly disables the default-enabled product Helper resolver; no host is created, no Helper started, no TCC prompt shown. When unset or explicitly `1|true|on`, desktop-local on-demand external Helper startup is enabled and the random socket/token is injected only into the trusted shared `node_repl` host.

## Verification

Before replacing an existing Helper the installer verifies in the staging directory. The product-embedded source is bound by build ID, signature, bundle id, architecture and Gatekeeper; it does not depend on the runtime version constant (historically misparsed as `0.0.0`); local downloads still check the version.

- `CFBundleIdentifier` in `Info.plist` is `dev.zcode.cua-helper`.
- For local downloads, `CFBundleShortVersionString` or `CFBundleVersion` equals the expected version.
- `Contents/MacOS/<CFBundleExecutable>` contains the current target architecture.
- `codesign --verify --deep --strict` passes.
- `codesign -dv --verbose=4` yields a non-ad-hoc `TeamIdentifier` equal to the expected team (default `8A5X4JJ39T`, overridable via `ZCODE_CUA_HELPER_TEAM_ID`). Under release verification an empty `expectedTeamIdentifier` is rejected (fail closed); packages without an anchored team are not accepted.
- `spctl -a -vv -t exec` passes (Gatekeeper/notarization result).

On verification failure the Helper is not started and no socket/token is injected into the shared `node_repl` host.

## Local dev mode

> The Helper and the model-side SDK/node_repl bridge are two independent assets. When the Helper shows ready but tools are still unavailable, also check the Dev build, plugin cache and session MCP registration chain in [`cua-dev-mcp-runtime-assets.md`](./cua-dev-mcp-runtime-assets.md).

`ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1` solves iterative testing when the development machine lacks a Developer ID signing identity. The product Helper resolver is enabled by default and needs no additional variable; only `ZCODE_CUA_PRODUCT_HELPER=0|false|off` disables it. This mode keeps bundle id, version, architecture and Mach-O structure verification but allows ad-hoc/unsigned signatures and skips Gatekeeper/notarization; after passing, the external Helper is still launched via LaunchServices at the product path and the random socket/token is injected into the trusted shared `node_repl` host.

Unpacked macOS desktop with the unsigned-local mode explicitly enabled first uses the non-empty `ZCODE_CUA_BUNDLED_HELPER_APP_PATH` as the local bundled source; when unset, empty or whitespace only, it falls back to `${ZCODE_HOME:-$HOME/.zcode}/computer-use/dev/ZCode Computer Use Dev.app`. When the path is missing or verification fails, fail closed and never fall back to download. The officially packed desktop ignores the development override and always uses `ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`, so the shell cannot rewrite the production source.

The standard `pnpm dev:desktop` startup script must inject both the current checkout's bundled Helper path and `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`. Both are required: with the path alone the Host does not enter the local-development trust and same-version content refresh branch and may keep starting a Helper in `~/.zcode` whose version is the same but whose native ABI is stale.

```text
dev startup
  -> inject checkout Helper path + unsigned-local flag
  -> verify and compare installed Helper with checkout artifacts
  -> if content differs, atomic refresh
  -> LaunchServices starts Helper, waits for broker ready
```

This mode never downloads the Helper automatically, so it neither silently replaces missing local artifacts with remote signed ones nor overwrites signed artifacts with development ones. It only proves the local App/Helper/socket/token flow works; it cannot prove stable TCC identity or release deliverability.

When jointly verifying unreleased zcode-cua source, first run `pnpm build` in the producer repository, then pass the same absolute directory to both build chains:

```bash
ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR=/absolute/path/to/zcode-cua \
  pnpm build:cua-helper -- --version <version>
ZCODE_CUA_RUNTIME_PACKAGE_DIR=/absolute/path/to/zcode-cua \
  pnpm --filter @zcode/cli build
```

These variables override build inputs only for this invocation and do not modify the lockfile. When unset the repository-pinned dependencies are used. Do not override only the Helper while leaving the plugin with the old frontend inline, or cross-version behavior is misjudged as a Helper regression.

## Installation and atomic replacement

The product copies the Helper from inside the App to the staging directory at the same installation root; explicit local downloads first download and extract to staging. After verification both use the same promotion:

1. Rename the existing Helper to a backup in the same directory.
2. Rename the staging Helper to the final path.
3. On promotion failure, roll back from backup.
4. On success, delete the backup and temporary directories and write `.zcode-cua-helper-meta.json`.

This avoids cross-volume `rename` and ensures unverified Helpers are never placed in the product path.

## Hardened runtime entitlements (minimal set)

The Helper is an independent TCC authorization subject (Accessibility / Screen Recording / Input), not a regular Electron renderer, so entitlements are the minimal set. The approved set is exactly (`packages/desktop/build/entitlements.helper.plist`, asserted by the release gate in `packages/desktop/test/runtime-asset-scripts.test.ts`; any addition fails it):

- `com.apple.security.cs.allow-jit`: Node SEA-embedded V8 needs `MAP_JIT` under hardened runtime (W^X).
- `com.apple.security.cs.allow-unsigned-executable-memory`: V8 JIT still needs writable executable memory under some macOS/Node combinations; retained only when `allow-jit` alone is insufficient for SEA to JIT normally. Risk acceptance boundary: this entitlement weakens W^X protection, so it is paired with startup env sanitization (`sanitizeHelperLaunchEnv` strips `DYLD_*`/`LD_*`/`NODE_OPTIONS`; both LaunchServices paths share the mechanism) and removal of `allow-dyld-environment-variables`, ensuring no external injection channel can exploit it. Verification/convergence command (on the signed release Helper): `codesign -d --entitlements :- "ZCode Computer Use.app"`. If the SEA still JITs normally in a clean environment after removing this entitlement (startup + one broker request without crash) it should be removed (follow-up: verify on the release runner).

Removed: `com.apple.security.cs.disable-library-validation` (R14), because the Helper loads only `ax_macos.node` signed by the same Team as the package (default `8A5X4JJ39T`), so library validation need not be relaxed; `com.apple.security.cs.allow-dyld-environment-variables` (R10), to prevent `DYLD_*` injection into this high-privilege subject. The broader configuration of the main App (`entitlements.mac.plist`) must not be applied to the Helper.
