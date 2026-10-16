# Desktop Packaging Parameters

`pnpm bundle:desktop` now accepts parameters for the target operating system and CPU architecture, allowing desktop packages to be built for different platforms.

## Desktop stdio Agent Bytecode Experiment

`pnpm dev:desktop:bytecode` reuses the complete regular Dev build, then precompiles
`apps/zcode-cli/packages/cli/dist/zcode.cjs` in the Node mode of the currently installed Electron,
generating a `zcode.bytecode.cjs` loader, `zcode.bytecode-<sha256>.jsc`, and
`zcode.bytecode-runtime-<sha256>.cjs` in the same directory. Regular `pnpm dev:desktop` continues to run JavaScript
for an A/B comparison using the same version and workload. To regenerate only the bytecode, run
`pnpm build:desktop-agent:bytecode` (first ensure the regular CLI bundle is up to date).

The desktop build script owns the build and bytecode formats; the existing Agent command resolver
still owns entry-point selection. The Dev launcher passes the option to the Host through
`ZCODE_DESKTOP_AGENT_BYTECODE=1`; it affects only the workspace CLI bundle inside Electron, not an explicitly specified Agent command, the native Agent under SSH/WSL,
or the production packaging flow. This variable is not a CLI product feature parameter. See the full contract in
[Agent Server spec](../../apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md)。

```text
Dev build → regular zcode.cjs → compile with matching Electron Node → bytecode + loader
Host command resolver → Electron Node loader → original app-server --stdio
                                         └→ original session/queue/stream owner
Host storage Worker → regular zcode.cjs --prepare-storage → original storage startup gate
```

Before executing the CLI, the loader must validate Electron/Node/V8, platform, architecture, the V8 cache identifier, and the bytecode digest.
A mismatch, missing artifact, or cache rejection must produce an error; it must not silently fall back to JavaScript. Precompilation must not execute the user's CLI. The loader
must not print diagnostics to stdout or change argv, cwd, module-relative paths, or the stdio lifecycle.
The storage preparation Worker keeps the JavaScript entry point to avoid snapshot incompatibility across Electron process types. The existing owner and recovery boundaries for desktop
continuous and mobile replayable remain unchanged.

This experiment uses equal-length ASCII spaces as padding and disables lazy compilation and bytecode flushing; V8 source references have not yet been removed.
It does not promise lower heap usage and is not a source-code encryption scheme. Regular JavaScript remains in the development directory for comparison and storage preparation.
Acceptance testing must cover CommonJS/dynamic import, argv/resource paths, `toString` on dynamically generated functions, error paths,
runtime mismatches/corruption, and a real stdio handshake and EOF. Record and compare the runtime, bundle digest, startup time,
`heapUsed` after GC, and RSS; the “Strings” category in a user screenshot cannot be treated as a direct measure of source-code usage.

## Default Behavior

With no parameters, the existing default remains: `mac` + `arm64`.

```bash
pnpm bundle:desktop
```

## Explicitly Specify the Target Platform

Named parameters:

```bash
pnpm bundle:desktop -- --os mac --arch x64
pnpm bundle:desktop -- --os win --arch x64
pnpm bundle:desktop -- --os linux --arch arm64
```

Positional parameters:

```bash
pnpm bundle:desktop -- win arm64
```

## Supported Values

- `os`: `mac` / `win` / `linux`
- `arch`: `x64` / `arm64`

Common aliases are also supported: `macos`, `darwin`, `windows`, `amd64`, and `aarch64`.

## CI / Script Scenarios

If passing CLI parameters is inconvenient, you can use environment variables instead:

```bash
ZCODE_TARGET_OS=linux ZCODE_TARGET_ARCH=x64 pnpm bundle:desktop

Production release packaging no longer injects a configurable generic update feed. The new client uses the server-side manifest provider at runtime; `electron-builder`'s generic `publish.url` is retained only as a local placeholder. The actual update-check endpoint is supplied by the default endpoint or overridden by `ZCODE_UPDATE_FEED_URL`.
```

## Dry Run

To confirm which target combination will run without executing it, run a dry run first:

```bash
pnpm bundle:desktop -- --os linux --arch x64 --dry-run
```

## Split Packaging into CI Stages

GitLab CI first runs resource preparation and the desktop build separately, then invokes the bundle command to produce the installer.
Use the following two parameters to skip the repeated steps:

```bash
pnpm bundle:desktop -- --os mac --arch arm64 --skip-prepare --skip-build
```

Equivalent environment variables:

```bash
ZCODE_SKIP_PREPARE=1 ZCODE_SKIP_BUILD=1 pnpm bundle:desktop
```

## Production Artifact Security Requirements

- `packages/desktop/scripts/run-production-build.mjs` must explicitly set
  `NODE_ENV=production`。
  `NODE_ENV=production` into `tsup` and `vite build`.
- Before a production build starts, clean `out/main`, `out/host`, `out/preload`, `out/renderer`, and the dev-ready
  markers, but preserve `out/metadata`. `tsup` does not automatically delete old chunks, so historical unminified artifacts could otherwise be
  included in the installer again by `electron-builder`'s `out/**/*`.
- In production, `packages/desktop/tsup.config.ts` must enable `minify` for the `main`, `host`, and `preload` Node artifacts,
  disable `sourcemap`, and set `legalComments: "none"` to avoid retaining source comments or
  `sourceMappingURL=*.map` references in the release package.
- `afterPack` in `packages/desktop/electron-builder.config.js` must continue to remove `*.map` files and
  JS/CSS `sourceMappingURL` comments from the final resources. `electron-builder`'s `files` pruning covers only the main package files;
  runtime dependency injection during afterPack, `app.asar.unpacked`, and `extraResources` could still bring in third-party
  sourcemap footers.
- `requiredRuntimeModules` in `packages/desktop/scripts/bundle.mjs` (mechanical artifact validation) must be a
  subset of `REQUIRED_ASAR_RUNTIME_MODULES` in `packages/desktop/electron-builder.config.js` (afterPack injection). Validation only checks whether a module is in app.asar; afterPack injection is what actually adds the dependency closure to the artifact.
  If validation is added without injection, no step is responsible for including the module's transitive dependencies, and packaging will fail at the end.
  Expand the injection list recursively through the `package.json` dependency closure. Modules already in the artifact are skipped, and duplicate entries do not change the artifact.
- Keep tsup sourcemaps in development to make local debugging of main/host/preload easier; do not generate or expose sourcemaps in production.
