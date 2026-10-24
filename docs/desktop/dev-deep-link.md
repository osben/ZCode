# Desktop Dev deep link

## Status

- Current-facts spec, dated 2026-09-09.
- Target scenario: run `pnpm dev:desktop:test` first, then click "去 ZCode 继续" (continue in ZCode) on the
  online test Share page.
- The online Share page and the `zcode://share/import` protocol are unchanged.

## Problem boundary

The online Share CTA can only produce a stable `zcode://share/import?code=...`. macOS protocol handling is
decided by LaunchServices, which cannot tell which terminal launched the project through pnpm.

`pnpm dev:desktop:test` currently launches `node_modules/electron/dist/Electron.app` directly. The `Info.plist`
of this raw Electron bundle has no `CFBundleURLTypes`; after system registration the handler is
`com.github.electron`, and a cold start or an external URL may show only Electron's default page.

## Approach

Only the macOS Dev launch script prepares a local `ZCode Dev.app` bundle:

1. Using the current checkout's Electron runtime as the source, prepare a copy under
   `.codex-runtime/desktop-dev/`.
2. Modify only the copy's `Info.plist`, writing:
   - `CFBundleIdentifier=dev.zcode.app.development`;
   - `CFBundleName/CFBundleDisplayName=ZCode Dev`;
   - the `zcode` scheme in `CFBundleURLTypes`.
3. Still launch the copy with the `packages/desktop` directory as Electron's dev entry, keeping Vite, HMR,
   `ELECTRON_RENDERER_URL`, `ZCODE_ENV` and the existing single-instance lock semantics.
4. The existing main process keeps calling `registerDeepLinkProtocol`; since the current process comes from the
   Dev bundle that declares `zcode`, LaunchServices registers the Dev bundle rather than raw Electron.
5. `open-url`, `second-instance`, ShareImport delivery and import persistence logic are unchanged.

## Event order

```text
pnpm dev:desktop:test
  -> dev.mjs waits for main/host/preload/Vite to be ready
  -> prepare ZCode Dev.app + Info.plist(zcode)
  -> launch Electron packages/desktop from Dev.app
  -> main registers the zcode default handler
  -> browser clicks zcode://share/import?code=...
  -> macOS open-url / second-instance
  -> existing Desktop ShareImport route
```

## Runtime boundary

- Only the unpackaged macOS Dev runtime changes; Windows/Linux keep the current launch path.
- `pnpm dev:desktop:test` keeps using the test environment endpoint; the production endpoint semantics of
  `pnpm dev:desktop` are unchanged.
- This fix guarantees the scenario "click the online page after Dev is already running". A macOS cold start
  when Dev is not running still needs a standalone packaged launcher, outside this minimal fix.
- `node_modules/electron` is not deleted or overwritten; the generated `.codex-runtime/` is only a rebuildable
  local artifact.

## Acceptance

1. The `pnpm dev:desktop:test` startup log records the Dev bundle path and a successful `zcode` registration.
2. The macOS LaunchServices `zcode` handler points to `dev.zcode.app.development`, not `com.github.electron`.
3. The online Share page still shows the original CTA and the original `zcode://share/import` href.
4. Clicking the CTA while Dev is running shows no Electron default page, and the existing Dev window receives
   `ShareImport`.
5. The Dev endpoint is `https://zcode.z.ai`, and the import request matches the page environment.
6. The existing deep-link parser/route unit tests still pass.
