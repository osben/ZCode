# ZCode Preview RS: a second release app that runs the Rust agent

Status: implemented. Builds on `specs/fork-agent-runtime-selection.md` (phase 3: release builds ship `zcode-rs`).

## Problem

Release builds ship both agents, but the only way to run the Rust one is the `ZCODE_FORK_AGENT_RUNTIME` env or a hand-edited `agentRuntime` in the fork settings sidecar. There is no user-visible switch yet (phase 2). To use and compare the Rust agent day to day, the user wants a separately installed app, **ZCode Preview RS**, that runs Rust by default next to the regular **ZCode Preview**, which stays on Node.

## Product rules

1. **Two apps per release.** The fork release builds every platform twice:
   - **ZCode Preview** is unchanged (`dev.zcode.app.preview`). Its default runtime is `node`.
   - **ZCode Preview RS** (`dev.zcode.app.preview.rs`) has the default runtime `rust`.

   Both ship the same bundles and the same `zcode-rs` binary. They differ only in identity and the build default.

2. **Side by side.** RS has its own:
   - app id and product name;
   - Electron userData directory (`<appData>/ZCode Preview RS`) and therefore its own single-instance lock;
   - Windows AppUserModelId (its app id) and NSIS install (electron-builder derives the GUID from the app id);
   - Linux executable and package name (`zcode-preview-rs`);
   - Computer Use helper install subdirectory (`preview-rs`), so two apps on different versions never trip each other's helper downgrade protection.
3. **Same flavor.** RS keeps the product flavor `preview`. Every flavor check (menu, tray, updater, force update, dynamic workflow rollout) behaves exactly as in ZCode Preview.
4. **Shared user data.** RS does not rewrite `ZCODE_HOME` / `ZCODE_DATA_BASE_DIR`. Tasks, settings, credentials and both databases under `~/.zcode` are the same as for ZCode Preview. This is the same exposure upstream accepts for ZCode next to ZCode Preview.
5. **Runtime precedence**, highest first:
   1. `ZCODE_AGENT_SERVER_COMMAND` (unchanged, bypasses the feature);
   2. the `ZCODE_FORK_AGENT_RUNTIME` env;
   3. an explicitly stored `agentRuntime` in `~/.zcode/v2/fork-settings.json`;
   4. the build default: `rust` for RS, `node` otherwise.

   If `rust` is selected and the binary is missing, Main runs Node and logs `reason=binary_missing`, as before.

6. **One flag, strict parse.** `ZCODE_FORK_RS_IDENTITY` accepts only `1`, `0` or empty, like `ZCODE_PREVIEW_IDENTITY`. Any other value fails the build. `1` is valid only when the resolved identity is Preview (`ZCODE_PREVIEW_IDENTITY=1`, or `ZCODE_ENV=test`). A production-identity RS build fails, so an RS package can never replace a regular ZCode install.

### Consequences of running both apps

- **Shared runtime setting.** `fork-settings.json` is shared, so an explicit `agentRuntime` there (a hand edit today, the phase 2 switch later) applies to both apps. With `agentRuntime: "node"` stored, RS runs Node, and the log says `source=setting`. Phase 2 must decide whether the switch stays global or becomes per app before it ships.
- **`zcode://` deep links** go to whichever app registered the scheme last, so an OAuth callback can open the other app. Upstream has the same behaviour between ZCode and ZCode Preview.
- **macOS privacy permissions (TCC)** are keyed by bundle id. RS asks again for Accessibility, Screen Recording, Microphone and the rest.
- **Renderer local state** (pane sessions, open tabs, drafts in `localStorage`) lives in each app's userData and is not shared.
- **Concurrent writers.** Both apps' Hosts and agents write the same `~/.zcode` databases when both run. The agents already coordinate through SQLite locking; running both at once is supported, but not the recommended way to compare runtimes.

## Owners and data flow

```text
build env
  ZCODE_PREVIEW_IDENTITY=1, ZCODE_FORK_RS_IDENTITY=1
        |
        v
packages/desktop/scripts/fork-desktop-product-identity.mjs   (fork owner, wraps the upstream identity)
  resolveForkDesktopProductIdentity(env)
    -> { flavor: "preview", forkVariant: "rs", appId, productName, linux names,
         cuaHelperInstallVariant: "preview-rs", defaultAgentRuntime: "rust" }
        |
        +--> electron-builder.config.js : appId, productName, linux names, protocol display name
        +--> scripts/bundle.mjs         : <productName>.app path
        +--> tsup.config.ts             : define __ZCODE_FORK_PRODUCT_VARIANT__ = "rs"
                                             |
                                             v
               packages/desktop/src/main/desktopRuntimeEnv.ts (FORK_PRODUCT_VARIANT)
                 +--> desktopRuntimeEnv.ts : runtimeApplicationName -> userData, single-instance lock
                 |                           ZCODE_CUA_HELPER_INSTALL_VARIANT for the Host
                 +--> index.ts             : Windows AppUserModelId
                 +--> index.ts             : primeForkAgentRuntimeSelection({ buildDefault })
                                                  |
                                                  v
                         env > stored sidecar value (raw, readStoredForkSettings) > buildDefault
                                                  |
                                                  v
                         Host env ZCODE_FORK_AGENT_RUNTIME (unchanged path)
```

The stored value is read raw (`readStoredForkSettings`, exported from `@zcode/services/node`). The effective settings view materializes `agentRuntime: "node"`, which would hide the build default. As a side effect, a regular build with nothing stored now logs `source=default` instead of `source=setting`. The selected runtime does not change.

## Release

- `fork-release.yml`: both build jobs (macOS arm64, Windows x64) run a `variant` matrix (`preview`, `preview-rs`). RS sets `ZCODE_FORK_RS_IDENTITY=1`. Artifacts upload as `dist-<platform>-<variant>`, and the release job merges them.
- The package file names come from the product name (`ZCode Preview RS-<version>-...`), so they do not collide.
- The release notes name both apps for the macOS `xattr -cr` step.
- `fork-build.yml` only runs `pnpm build` and does not package, so it is unchanged.

## Acceptance

- Unit (fork manifest, `packages/desktop/test/forkDesktopProductIdentity.test.ts`):
  - RS identity with `ZCODE_PREVIEW_IDENTITY=1` and with `ZCODE_ENV=test`;
  - no RS flag returns the upstream identity with `forkVariant: null` and default `node`;
  - an RS flag on a production identity throws;
  - invalid spellings throw;
  - the packaged AUMID is the RS app id, and the dev AUMID is unchanged.
- Unit (`packages/desktop/test/forkAgentRuntimeSelection.test.ts`):
  - `buildDefault: "rust"` with nothing stored selects rust (`source=default`);
  - a stored `node` wins over the build default;
  - env wins over both;
  - a missing binary falls back to node.
- Build: `tsup` with `ZCODE_PREVIEW_IDENTITY=1 ZCODE_FORK_RS_IDENTITY=1` emits `__ZCODE_FORK_PRODUCT_VARIANT__ = "rs"` in the main bundle; without the flag it emits `""`.
- The upstream `desktopProductIdentity.test.ts` passes unedited.
