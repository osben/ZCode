# ZCode Computer Use External Installation Closed Loop

## Background

The ZCode Computer Use Helper must run as an independent `.app` to be an independent accountability process for macOS TCC. The distribution package carries the already-signed Helper within `ZCode.app/Contents/Resources/cua-helper/`; at runtime, it first validates and copies to a stable user-level path, then launches via LaunchServices. It is not an Electron subprocess and does not use `Contents/Library/Helpers`.

The product installation location is fixed:

```text
${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app
```

Internal `ZCode Preview` and production share `ZCODE_HOME` tasks, configuration, and credentials, but use independent Helper version directories to avoid two different App versions overwriting each other or triggering downgrade protection when using CUA sequentially:

```text
${ZCODE_HOME:-$HOME/.zcode}/computer-use/preview/ZCode Computer Use.app
```

This path is injected by the Desktop Host as `ZCODE_CUA_HELPER_INSTALL_VARIANT=preview`, changing only the CUA runtime component location
without changing the business data root. Both Helper bundles maintain the signed identity `dev.zcode.cua-helper`, so the macOS
Accessibility / Screen Recording authorization subject still shows the same `ZCode Computer Use`.

## Installation Source

The official product has exactly one installation source: the
`Contents/Resources/cua-helper/ZCode Computer Use.app` within the current ZCode.app. When missing, invalid, or unreadable, fail-closed directly; the product code does not attempt network downloads and has no download fallback. Therefore, the build and signature gate must ensure this arm64 Helper is delivered together with the main App.

The following coverage belongs only to explicit local development mode and must not be used as production distribution configuration:

- `ZCODE_CUA_HELPER_DOWNLOAD_URL`: complete zip URL.
- `ZCODE_CUA_HELPER_DOWNLOAD_BASE_URL`: version directory base URL.
- `ZCODE_CUA_HELPER_VERSION`: expected Helper version for the local download package.
- `ZCODE_CUA_HELPER_TEAM_ID`: expected signing TeamIdentifier. **When not configured, it defaults to anchoring the ZCode official team `8A5X4JJ39T` (equivalent certificate pinning), not "any non-ad-hoc team"; this variable is for development or team switching overrides only.**
- `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`: for本机 development debugging only. This mode does not download, nor pass through
  release signature/Gatekeeper validation; when the source is the bundled Helper explicitly provided by the current checkout, even if the version number is the same, the artifact contents must be compared and atomically refreshed when changed — silent reuse of the old Helper is prohibited.
- `ZCODE_CUA_PRODUCT_HELPER=0|false|off` (macOS/Windows): explicitly disables the default-enabled product Helper resolver;
  when disabled, no host is created, no Helper is started, no TCC prompt is shown. When unset or explicitly `1|true|on`, desktop-local
  on-demand external Helper startup, and the random socket/token is injected only to the trusted shared `node_repl` host.

## Verification

Before replacing an existing Helper, the installer must verify in the staging directory. The product-embedded source is bound by build ID, signature, bundle id,
architecture, and Gatekeeper; it does not depend on the runtime version constant that was historically incorrectly parsed as `0.0.0`; local downloads still check the version:

- The `CFBundleIdentifier` in `Info.plist` must be `dev.zcode.cua-helper`.
- For local downloads, `CFBundleShortVersionString` or `CFBundleVersion` must equal the expected version.
- `Contents/MacOS/<CFBundleExecutable>` must contain the current target architecture.
- `codesign --verify --deep --strict` must pass.
- `codesign -dv --verbose=4` must be able to read a non-ad-hoc `TeamIdentifier`, which must equal the expected team (default `8A5X4JJ39T`, overridable via `ZCODE_CUA_HELPER_TEAM_ID`). Under release verification, an empty `expectedTeamIdentifier` is directly rejected (fail-closed); packages without an anchored team are not accepted.
- `spctl -a -vv -t exec` must pass, to verify the Gatekeeper/notarization result.

On verification failure, the Helper must not start, nor inject socket/token to the shared `node_repl` host.

## Local Dev Mode

> The Helper and the model-side SDK/node_repl bridge are two independent assets. When the Helper shows ready but the tools are still unavailable, you also need to check
> the Dev build, plugin cache, and session MCP registration chain in [`cua-dev-mcp-runtime-assets.md`](./cua-dev-mcp-runtime-assets.md).

`ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1` is used to solve the iterative testing problem when the development machine lacks a Developer ID signing identity. The product Helper resolver is enabled by default and requires no additional variable; only `ZCODE_CUA_PRODUCT_HELPER=0|false|off` disables it. This mode preserves the bundle id, version, architecture, and Mach-O structure verification, but allows ad-hoc/unsigned signatures and skips Gatekeeper/notarization; after passing, the external Helper is still launched via LaunchServices at the product path, and the random socket/token is injected to the trusted shared `node_repl` host.

Unpacked macOS desktop, after explicitly enabling the above unsigned-local mode, first uses the non-empty
`ZCODE_CUA_BUNDLED_HELPER_APP_PATH` as the local bundled source; when unset, empty string, or whitespace only, it falls back to
`${ZCODE_HOME:-$HOME/.zcode}/computer-use/dev/ZCode Computer Use Dev.app`. When the path is missing or verification fails, fail-closed, never fall back to download. The officially packed desktop ignores the development override and always uses
`ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`, so the shell cannot rewrite the production source.

The standard `pnpm dev:desktop` startup script must inject both the current checkout's bundled Helper path and
`ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`. Both are required: with the path alone, the Host does not enter the local development
trust and same-version content refresh branch, which can continue to start a Helper in `~/.zcode` whose version number is the same but whose native ABI is expired.

```text
dev startup
  -> inject checkout Helper path + unsigned-local flag
  -> verify and compare installed Helper with checkout artifacts
  -> if content differs, atomic refresh
  -> LaunchServices starts Helper, waits for broker ready
```

This mode does not automatically download the Helper, avoiding silently replacing missing local artifacts with remote signed ones, or overwriting signed artifacts with development ones. It can only prove that the local App/Helper/socket/token flow works; it cannot prove stable TCC identity or release deliverability.

When jointly verifying unreleased zcode-cua source code, first run `pnpm build` in the producer repository, then pass the same absolute directory to both build chains:

```bash
ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR=/absolute/path/to/zcode-cua \
  pnpm build:cua-helper -- --version <version>
ZCODE_CUA_RUNTIME_PACKAGE_DIR=/absolute/path/to/zcode-cua \
  pnpm --filter @zcode/cli build
```

These two variables only override the build inputs for this invocation, without modifying the lockfile. When unset, the repository-fixed dependencies continue to be used; you cannot override only the Helper while leaving the plugin with the old frontend inline, otherwise cross-version behavior will be misjudged as a Helper regression.

## Installation and Atomic Replacement

The product copies the Helper from inside the App to the staging directory at the same installation root; explicit local downloads first download and extract to staging. Both use the same promotion after passing verification:

1. Rename the existing Helper to a backup in the same directory.
2. Rename the staging Helper to the final path.
3. On promotion failure, rollback from backup.
4. On success, delete the backup and temporary directories, and write `.zcode-cua-helper-meta.json`.

This flow avoids cross-volume `rename` and ensures that unverified Helpers are never placed in the product path.

## Hardened runtime entitlements (minimal set)

The Helper is an independent TCC authorization subject (Accessibility / Screen Recording / Input), not a regular Electron
renderer, so entitlements must be the minimal set. The approved set is **exactly** (`packages/desktop/build/entitlements.helper.plist`,
asserted by the release gate in `packages/desktop/test/runtime-asset-scripts.test.ts`; any addition will fail):

- `com.apple.security.cs.allow-jit` — Node SEA-embedded V8 needs `MAP_JIT` for JIT under hardened runtime (W^X).
- `com.apple.security.cs.allow-unsigned-executable-memory` — V8 JIT still requires writable executable memory under some macOS/Node combinations;
  retained only when `allow-jit` alone is insufficient for SEA to JIT normally. **Risk acceptance boundary**: this entitlement weakens W^X protection, so it is paired with
  "startup env sanitization (`sanitizeHelperLaunchEnv` strips `DYLD_*`/`LD_*`/`NODE_OPTIONS`, both LaunchServices paths share the mechanism)"
  - "removal of `allow-dyld-environment-variables`" together, ensuring no external injection channel can exploit it. **Verification/convergence command** (on the signed release
    Helper): `codesign -d --entitlements :- "ZCode Computer Use.app"`; if the SEA can still JIT normally after removing this entitlement in a clean environment (startup + executing one broker request without crashing), it should be further removed (follow-up: verify on the release runner).

**Removed**: `com.apple.security.cs.disable-library-validation` (R14) — the Helper only loads `ax_macos.node` signed by the same Team as the package
(default `8A5X4JJ39T`), library validation does not need to be relaxed; `com.apple.security.cs.allow-dyld-environment-variables`
(R10) — prevents `DYLD_*` injection to this high-privilege subject. The broader configuration of the main App (`entitlements.mac.plist`) **must not** be directly applied to the Helper.
