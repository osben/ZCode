# SEA Cross-Target Packaging

## Background

The default release form of ZCode remains the standard Node.js CLI package: `dist/zcode.cjs` plus
`bin.zcode`. SEA is an optional single-file distribution path that gives environments without a
preinstalled Node.js a standalone binary.

The SEA script originally copied only `process.execPath`, so on macOS arm64 it could only produce
`zcode-darwin-arm64`, which does not fit the Windows, macOS and Linux release goal.

## Goals

- Produce several SEA target artifacts from one host machine.
- The default target stays the current host, so the existing `npm run sea` behavior is not broken.
- Select targets explicitly through CLI parameters; add no environment variable.
- Download the target-platform Node binary from the official Node.js release; its version must equal the
  Node.js version running the script.
- Reuse the same bundled CommonJS entry, avoiding a business rebuild per platform.
- Release signing, notarization and certificate management are out of scope. The macOS ad-hoc signature
  during development is an executability repair after Mach-O injection, not a release signature.

## Non-goals

- No full release pipeline, upload, archive compression or package-manager publishing.
- No Windows Authenticode, macOS Developer ID, notarization or Linux package formats.
- No Alpine/musl as a first SEA target.
- No `ZCODE_` environment variable for target configuration.

## Target contract

First targets: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win-arm64`, `win-x64`.

Artifact names:

- Unix-like: `dist/zcode-<platform>-<arch>`
- Windows: `dist/zcode-windows-<arch>.exe`

User interface:

- `pnpm run build:sea`: resolves Turbo from the repository root dependencies and, through
  `--cwd apps/zcode-cli`, rebuilds the packages other than the CLI with `--force` inside the CLI
  workspace, then rebuilds the CLI bundle directly, and finally builds all first targets. The repository
  contains a nested pnpm workspace, so the package script must not resolve Turbo with
  `--workspace-root`, which would wrongly scope to the inner workspace lacking that binary. This flow
  avoids reusing stale package `dist` and keeps existing SEA artifacts out of the CLI build cache.
- Root `pnpm build:sea:all`: installs dependencies and forwards to the same all-target `build:sea`
  entry.
- `pnpm run sea -- <target args>`: only wraps the existing `dist/zcode.cjs` and runtime assets; it does
  not recompile the workspace.
- `node packages/cli/scripts/build-sea.mjs` (from `apps/zcode-cli`): builds the current host target.
- `node packages/cli/scripts/build-sea.mjs --target linux-x64 --target win-x64`: builds the given targets.
- `node packages/cli/scripts/build-sea.mjs --targets linux-x64,win-x64`: builds comma-separated targets.
- `node packages/cli/scripts/build-sea.mjs --all`: builds all first targets.
- `node packages/cli/scripts/build-sea.mjs --node-binary linux-x64=/abs/path/node`: uses a user-provided target Node
  binary and skips download resolution for that target.

Target parameters use the platform names of release naming; Windows input is `win-x64` / `win-arm64`.
Windows artifact file names use `windows`, aligned with the old GLM agent download contract; the
internal platform key and host checks still use the Node.js `process.platform` style `win32`.

## Target runtime assets

SEA can download and inject the official Node.js binary of another target on one host. `bfs` and `ugrep`
must first be built, verified and published to the unified dependency source by the producer of the
corresponding target platform. The `rg` of macOS x64/arm64, Linux x64/arm64 and Windows x64/arm64 all
use the original archives of Microsoft `ripgrep-prebuilt v14.1.1-1` with a pinned SHA-256, downloaded
from the `native-search-tools/ripgrep-v14.1.1-1` mirror directory of the same internal dependency
source. The selected macOS archive deployment target must not exceed the existing macOS 12.0 floor.
Linux `rg` must use a musl archive that introduces no glibc dependency. The `bfs` / `ugrep` producer
pins Node 26.11.1, glibc 2.28, GCC 12 and G++ 12 and verifies the final ELF for the GLIBC 2.28 ceiling,
version, features, architecture and dynamic dependencies. Both Windows architectures must reject
dynamic CRT, PCRE2 and compression-library dependencies that the build contract requires to be linked
statically. The SEA build reuses, per target, the same native-search release plan and downloader to
verify and prepare both kinds of prebuilt artifacts into
`packages/desktop/bundled-tools/<platform>-<arch>/`. SEA does not cross-compile during a foreign target
build, switch sources or silently omit tools.

The existing contract of public `build:sea` is always all-target; it must not degrade to host-only
because native search of some platform is not yet wired in. The build prepares and collects the runtime
assets of every target automatically. If a prebuilt archive is missing, a download fails or target
format/architecture verification fails, the build must stop before generating that target SEA; it must
not produce an official binary whose provider-visible embedded search is enabled while the execution
layer lacks the bundled tools.

The native-search release plans for x64/arm64 of macOS, Linux and Windows are all enabled. macOS/Linux
targets prepare `bfs`, `ugrep`, `rg`; Windows targets prepare `ugrep.exe`, `rg.exe`, and Windows `find`
keeps falling back to Git Bash/system. The final tool layout and the SEA manifest do not expose the
difference between producer and Microsoft sources; the SEA asset collector takes target tools only by
the unified release plan. Host-only development and E2E use `sea` or an explicit `--target`.

## Node binary source

Downloaded by default from `https://nodejs.org/dist/v<process.versions.node>/`:

- macOS: `node-v<version>-darwin-<arch>.tar.gz`
- Linux: `node-v<version>-linux-<arch>.tar.xz`
- Windows: `win-<arch>/node.exe`

Downloaded files must be verified against the same-version `SHASUMS256.txt` sha256; on failure the build
aborts without injecting.

The cache location is `packages/cli/dist/sea-node-cache/v<version>/...`. The cache is a build artifact
and not committed.

## Node 26 SEA baseline

ZCode uses Node.js `26.11.1` as the development, build and release baseline of this repository. The CLI
SEA blob is produced by the current Node 26 runtime, and release artifacts must embed the same-version
Node 26 runtime. SEA is no longer required to stay on Node 24 for old-OS compatibility; dev machines, CI,
Docker and SEA release must use the same 26.x baseline.

The SEA build path is `node --experimental-sea-config <config>` producing a preparation blob, which is
injected with `postject` into the official Node.js binary of the target platform. The script must keep
downloading the same-version target binary from the official Node release, or accept a binary the user
provides with `--node-binary <target>=<path>`.

The SEA config must explicitly write:

- `main`: the bundled CLI entry, currently `dist/zcode.cjs`, resolved relative to the `packages/cli`
  execution directory.
- `output`: the preparation blob, currently `dist/zcode.sea.blob`.
- `disableExperimentalSEAWarning`: `true`.
- `assets`: OpenTUI runtime assets, bundled official plugin assets and the bundled skill pack.
  Official plugins are stored as raw files in the SEA blob and extracted on startup into
  `~/.zcode/cli/plugins/cache/zcode-plugins-official/<plugin>/<version>/`. They must not be imported
  into the ZCode main bundle. Seeded official plugin manifests are rewritten to use the hidden
  `__zcode-plugin-host` entrypoint so the cached MCP server runs on the SEA-embedded Node.js runtime.
  Third-party plugins are not rewritten automatically and keep their own declared command. The bundled
  skill pack (`packages/bundled-skills/skills/**`, collected by `scripts/sea-bundled-skill-assets.mjs`
  under the `zcode-bundled-skills/` prefix) is not a plugin: its manifest hash names the extraction
  directory `~/.zcode/cli/bundled-skills/<hash>/`, every required file must be present or the build
  aborts, and a runtime hash mismatch refuses the pack.
- `useCodeCache`: `false`.
- `useSnapshot`: `false`.

The SEA blob is produced by the Node.js running the script, and the target Node version must equal the
current Node version. Cross-platform builds must disable `useCodeCache` and `useSnapshot`, because V8
code cache and snapshot load only on the same platform and may crash at startup after cross-platform
injection.

The image processing adapter must avoid depending on platform-native `.node` addons by default. The SEA
runtime uses the pure-JS Jimp adapter for resize-to-fit of PNG/JPEG/GIF and similar formats; WebP is
passed through unchanged for now, and no sharp, NAPI addon or external `.wasm` resource is introduced in
the SEA package. If a WASM/native image processor is adopted later, first specify asset injection,
runtime location, temp-file policy and a cross-platform smoke test.

## Zod runtime version and dedupe

JS builds shared by the CLI, the desktop built-in Agent and SEA must use Zod v4 `4.6.5` uniformly, to
avoid the old version creating all method closures of every schema at startup. The exact version in
`packages/shared/package.json` is the source of truth of the build gate; other direct dependency
declarations and the root lockfile must match it. A global override that would rewrite the dual-major
peer range is not used. Zod v3 tool contracts and `zod-to-json-schema` keep their major; there is no
cross-major replacement.

Dedupe is done by the CLI esbuild entry: it first picks the package version and exports by the
consumer's original resolution rules, then merges different install directories of the same version into
one implementation. Subentries and the actual ESM/CommonJS target files are kept; a global `zod` alias
must not redirect v3 to v4. After the build the metafile is checked: if the same version appears with
several actual package roots, or v4 does not match the unified version, the build fails and lists the
source paths. The ordinary CLI, desktop-agent and SEA share this gate.

Acceptance: nested duplicate install dedupe, v3/v4 coexistence, unchanged import/require export
conditions, correct subentry resolution, and existing resolution regressions of shared/provider/CLI/MCP.
Memory verification compares after GC under the same runtime and the same module/startup scenario; a
module experiment cannot replace a full CLI snapshot, and bundle file size is not used directly as heap
or RSS.

## CLI version source

The ordinary Node CLI bundle and the SEA binary must inject `__CLI_VERSION__` from the `version` of the
repository root `package.json`. `packages/cli/package.json` is workspace subpackage metadata only and
must not be the source of `zcode --version`, `zcode version`, `zcode doctor --json`, the ZCode app-server
initialization version field, the MCP client initialize `version`, or `session.version`.

If the build script fails to read the root `package.json`, or `version` is not a non-empty string, it
aborts the build and reports the root version metadata anomaly. In source test environments that did not
go through bundle injection, the runtime keeps a `0.0.0` fallback so `packages/cli/src/run.ts` can be
tested directly.

## Injection and signing contract

The injection tool is the `postject` already installed in the repo. The script must add parameters by
target binary format:

- Mach-O: add `--macho-segment-name NODE_SEA`
- ELF: no extra section parameter
- PE: no extra section parameter

Official macOS Node binaries are normally signed; when building a macOS target on a macOS host the
script must remove the signature first so injection works. Right after `postject` modifies the Mach-O it
must run `codesign --force --sign - <binary>` for an ad-hoc signature; otherwise other dev machines may
kill the process when loading executable pages because of an inconsistent signature state. This
signature is not bound to a Developer ID, is not notarized and does not represent a release signature.

The official Windows `node.exe` normally carries an Authenticode signature. When building a Windows
target the script must remove the original Authenticode signature before `postject` injection;
otherwise the Security Directory of the PE points to the pre-modification signature data and a later
official signing service may report `0x800700c1` or judge the artifact not a valid Win32 application.
The removal must run cross-platform and must not depend on the Windows-only `signtool`: parse the
`IMAGE_DIRECTORY_ENTRY_SECURITY` of the PE optional header (the `VirtualAddress` of this entry is a file
offset, not an RVA), zero that directory entry, and truncate the certificate table data when the table
is at the end of the file. An unsigned Windows binary is a no-op; if the directory points outside the
file range the build aborts and reports a PE signature directory anomaly. Official Authenticode signing
is still out of scope of this script and must happen after SEA injection.

## Verification contract

- After a host target build, run a `--version` smoke test.
- Foreign targets are not executed on the host; only check that the binary was generated and the
  injection flow finished.
- The OpenTUI SEA asset manifest must contain the complete runtime dependency closure of `@zcode/tui`,
  including the `package.json` and `dist` of workspace packages; see `tui-opentui-sea-packaging.md`.
- When a macOS host builds a macOS target, the ad-hoc signature finishes before the smoke test.
- Windows targets finish Authenticode removal before injection; official signing is handled by the
  release/signing pipeline after injection.
- CI can later use a matrix to run the smoke test of the matching artifact on each OS.

## Error behavior

- `dist/zcode.cjs` not found: suggest running `pnpm build` first.
- `postject` not found: suggest running `pnpm install` first.
- Unsupported target: list the supported targets.
- Target runtime tool missing: abort and suggest that the matching platform prepare and aggregate the
  runtime assets first.
- Download failure or checksum mismatch: abort and name the URL or file name.
- Missing `tar`, so macOS/Linux Node archives cannot be unpacked: abort and suggest
  `--node-binary <target>=<path>`.
- The target Node binary has no SEA fuse marker: abort and suggest an official Node with SEA support.
- Corrupt or out-of-range Windows PE signature directory: abort without injecting or producing a
  signable artifact.

## Test coverage

- Target parameter parsing: repeated target, CSV target, `--all` and illegal targets.
- Package scripts guarantee that `build:sea` always passes `--all` explicitly, and the root
  `build:sea:all` forwards to that existing entry.
- Mapping of target to release artifact, download URL and artifact name.
- postject parameters are generated per target platform.
- The host target smoke check matches only the current platform and arch.
- The macOS ad-hoc signature runs only when a macOS host builds a macOS target and uses
  `codesign --force --sign -`.
- Windows Authenticode removal covers PE32/PE32+, unsigned no-op, trailing certificate table truncation
  and out-of-range directory errors.
- The OpenTUI runtime asset manifest covers the workspace runtime closure of `@zcode/tui`,
  `@zcode/i18n`, `@zcode/contracts` and excludes workspace source files.
- CLI bundle version injection reads the repository root `package.json`; a different version in
  `packages/cli/package.json` does not change the build-time version of `zcode --version`.
- The `build:sea` workspace script must rebuild the workspaces other than the CLI through Turbo `--force`
  before `build-sea.mjs --all`, then rebuild the CLI directly through package-local `pnpm build`; the
  CLI must be excluded from the Turbo build to avoid writing the existing SEA artifacts of the same
  directory into the `dist/**` cache.
- The package script must resolve Turbo from the repository root while keeping the Turbo working
  directory at `apps/zcode-cli`; the dry-run regression test must prove the command is executable, the
  task set is non-empty and does not contain `@zcode/cli`.
