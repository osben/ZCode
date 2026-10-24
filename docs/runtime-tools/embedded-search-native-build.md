# Embedded Search Native Build Spec

## Goal

ZCode's Bash embedded-search branch ultimately needs to consume native search programs shipped with the
distribution, instead of depending on `find`, `grep`, `rg` preinstalled on the user's machine or forwarding
again to system commands through a Node subprocess.

This phase completes the macOS, Linux and Windows build and execution wiring: `bfs` and `ugrep` are built
from pinned-version sources, and `rg` on every target uses Microsoft `ripgrep-prebuilt v14.1.1-1`. macOS,
Linux and Windows x64 all provide an independent real Bash embedded-search E2E entry, but formal desktop
packaging does not run behavior E2E; Windows arm64 currently only keeps the existing x64-runner cross build
and runs PE static gates, and does not pose as target-architecture runtime E2E. Tool exposure and the
provider-visible prompt do not change with the execution backend switch.

Cross-platform target capability and current distribution enablement must be managed separately:

| Platform        | Target in-package tools                                           | Enabled in current distribution |
| --------------- | ----------------------------------------------------------------- | ------------------------------- |
| macOS arm64     | `bfs`, `ugrep`, `rg`                                              | yes                             |
| macOS x64       | `bfs`, `ugrep`, `rg`                                              | yes                             |
| Linux x64/arm64 | `bfs`, `ugrep`, `rg`                                              | yes                             |
| Windows x64     | `ugrep.exe`, `rg.exe`; `find` falls back to Git Bash/system       | yes                             |
| Windows arm64   | `ugrep.exe`, `rg.exe`; `find` falls back to Git Bash/system       | yes                             |

Windows has no native `bfs`: ZCode does not port Windows `bfs` itself and does not wrap the upstream Unix
`bfs` package as a fake native artifact.

Linux desktop/SEA and Linux remote share one native-search release plan: `bfs` keeps consuming `v4.1.1-2`,
`ugrep` consumes `v7.8.4-1` uniformly with the other platforms, and `rg` consumes Microsoft `v14.1.1-1`.
Darwin remote keeps deploying only the historical `rg 13.x` and cannot be rewritten implicitly by the Linux
release plan.

## User switch and Session lifecycle

The "General" settings page's terminal section provides the `nativeSearchEnhancementsEnabled` switch, on by
default. It controls only whether the Bash startup prelude maps `find` / `grep` to `bfs` / `ugrep`; it does
not control native artifact preparation, the `rg` fallback, Glob/Grep tool exposure or the provider-visible
tool matrix. When off, Bash naturally uses the current shell's system `find` / `grep`; Windows still has no
`bfs`.

The setting value is a startup preference of the root Session runtime, not turn metadata, and is not written
to Session history, queue, runtime snapshot or the shell init snapshot:

- A new root Session and a true cold resume read the current value once from the owning Host through `session/requestRuntimePreferences` when the runtime materializes.
- An active resume of an existing runtime does not re-read and keeps the current runtime's value.
- fork, selection side chat and subagent inherit the parent runtime's value and do not read the Host again.
- Toggling the switch does not hot-update a running or still-active Session; only a newly created or truly cold-resumed Session uses the new value.
- `rowsRange`, `plans`, `fileChanges`, `fileRewindPreview`, `attachmentBegin` and `subscribe` are only triggers of cold resume; all enter the same singleflight materialization and carry no setting field.

Setting authority and the remote chain are fixed as:

```text
Desktop-local SettingService
        ^
        | typed blocking runtime-preferences request
Desktop shared Host
        ^
        | service-scoped Agent RPC, correlated by requestId
desktop-attached remote Host
        ^
        | ZCode Protocol reverse request
Agent root runtime materialization
```

A local workspace and a standalone server read their own authoritative `SettingService` directly from the
Host they live on. A desktop-attached SSH/WSL/Docker workspace has the remote Host bridge the request to the
desktop shared Host and read the desktop's local settings; mobile `/remote` reuses the same shared-host
attachment and creates no independent runtime or settings copy. Relay and desktop main only pass through and
store no such business state.

`session/requestRuntimePreferences` uses a strict schema and distinguishes `runtime-materialization` from
`user-execution` by `scope`. This section consumes only the former's `nativeSearchEnhancementsEnabled`. Each
request waits at most 15 seconds; when the Host keeps the connection but does not respond, this runtime
materialization is blocked with a timeout error. For compatibility with old versions the default is enabled
when an old Host returns `-32601` or the Agent has not connected to the Host yet and returns `-32020`; an
invalid response, a settings resolver exception, a timeout and other transport errors must never silently
turn into enabled.

## Version baseline and security deviation

Version and build baseline of the embedded search tools:

- `bfs 4.1.1`.
- `bfs` uses these configure flags in order: `--enable-release --with-oniguruma --without-libselinux --without-libacl --without-liburing --without-libcap`, and supports the fixed leading args `-S dfs -regextype findutils-default`.
- The early baseline was `ugrep 7.5.0`; ZCode deliberately upgrades to `ugrep 7.8.4` to get the DFA state/edge and position-set complexity caps, so a malicious or accidental complex regex cannot exhaust memory at compile time. This is a security deviation and must not be described as keeping the early binary version.
- `ugrep --version` must expose `-z:zlib,bzip2,zstd,brotli,7z,tar/pax/cpio/zip`; macOS uses `-P:pcre2`, Linux and Windows use `-P:pcre2jit`.
- PCRE2 JIT is configured per platform branch: off on macOS, on on Linux and Windows. Both `win32-x64` / `win32-arm64` must include the Windows feature branch.
- `rg` on all desktop/SEA platforms is pinned to Microsoft `ripgrep-prebuilt v14.1.1-1`; the runtime version must be `ripgrep 14.1.1` and must expose `features:+pcre2` and PCRE2 10.43; JIT availability is still decided by the target platform's capability. Except for the Linux arm64 musl archive, which exposes no revision, all other targets must output the upstream revision `4649aa9700`. The archive content identity is guaranteed by the pinned SHA-256, and a binary must not be wrapped or modified to fill in a display string.
- The final artifact must not depend on dynamic libraries from Homebrew or the build directory. On macOS `bfs` may link only the system `libSystem`; `ugrep` only the system `libSystem` and `libc++`.
- The native search sidecar keeps each platform's existing packaging boundary: a macOS artifact's deployment target must not exceed Electron 41's macOS 12.0; the highest GLIBC symbol version of Linux `bfs` / `ugrep` is fixed at `GLIBC_2.28`, and the producer must actually run Node 26, glibc 2.28, GCC 12 and G++ 12; Windows x64/arm64 artifacts must not dynamically depend on the CRT, PCRE2 and compression libraries that the build contract requires to be statically linked.

The Linux compatibility gate checks the final ELF's `readelf --version-info` and compares all
`GLIBC_x.y[.z]` references numerically. `bfs` / `ugrep` must contain at least one parseable GLIBC reference
and the maximum must not exceed `2.28`; the Microsoft musl `rg` is allowed to have no GLIBC reference at all.
Checking only the build container's `getconf GNU_LIBC_VERSION` is not enough to prove final artifact
compatibility, and the artifact gate cannot be omitted.

## Prebuilt resource distribution

Ordinary desktop/SEA prepare and the local development flow do not compile native search tools on the spot
after a download failure. The self-produced `bfs` / `ugrep` archives and the original Microsoft
`ripgrep-prebuilt v14.1.1-1` archives are all downloaded from `${ZCODE_DEPS_BASE_URL}/native-search-tools`.
Before running prepare, platform packaging CI may run one deps ensure: it checks the runner-mapped shared deps
file system directly against the same `platform-arch` release plan; when a producer archive is missing, a
trusted pipeline builds, verifies and deterministically packages on the current target toolchain and publishes
to the shared deps via a temp file plus a same-directory rename. Every producer archive must have
`archiveSha256` configured in the release plan and be strictly validated before reuse, publish and download;
a missing or mismatched digest fails immediately and packaging cannot continue. ensure refuses to produce by
default; only a protected ref or a trusted entry that explicitly sets `ZCODE_NATIVE_SEARCH_ALLOW_PUBLISH=1`
enters the write branch; the in-repo macOS, Linux and Windows packaging templates are the authorized shared
deps write entries. Packaging jobs of the same `platform-arch` must be serialized across pipelines with a
GitLab `resource_group` so two producers never publish the same pinned version path at once; different
targets can still run in parallel. An existing version archive is never overwritten; if a manual call sees the
target already appeared, it may accept it only when the content digest is identical.

The above ensure is not a downloader fallback: a missing Microsoft `rg` must fail immediately and cannot
switch to self-production or repackaging; an HTTP timeout, non-200, a missing or mismatched SHA-256, an
extraction failure or a binary verification failure must also terminate the current build and cannot trigger a
producer. All formal archives of Microsoft `rg` and the self-produced `bfs` / `ugrep` must have a pinned
SHA-256 in the release plan and be verified before unpacking. For a producer resource not yet prepared and not
produced by trusted CI, the default URL must 404 and must not be filled in with another platform's artifact.
The intranet `rg` mirrors only the original bytes of the Microsoft release, without renaming or repackaging.

The downloader connects directly to the `${ZCODE_DEPS_BASE_URL}` intranet mirror by default. Only
`github.com` and its `githubusercontent.com` release redirect hosts may read the build environment's
`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`; other hosts do not implicitly go through a proxy. Every download
must fail explicitly when the connection is unresponsive for long, so a build machine that cannot reach GitHub
directly does not wait forever and the intranet dependency address cannot be hijacked by an external proxy.

New resources live uniformly under `${ZCODE_DEPS_BASE_URL}/native-search-tools`, versioned independently per tool:

```text
native-search-tools/
  bfs-v4.1.1-1/
    bfs-v4.1.1-1-aarch64-apple-darwin.tar.gz
    bfs-v4.1.1-1-x86_64-apple-darwin.tar.gz
  bfs-v4.1.1-2/
    bfs-v4.1.1-2-aarch64-unknown-linux-gnu.tar.gz
    bfs-v4.1.1-2-x86_64-unknown-linux-gnu.tar.gz
  ugrep-v7.8.4-1/
    ugrep-v7.8.4-1-aarch64-apple-darwin.tar.gz
    ugrep-v7.8.4-1-x86_64-apple-darwin.tar.gz
    ugrep-v7.8.4-1-aarch64-unknown-linux-gnu.tar.gz
    ugrep-v7.8.4-1-x86_64-unknown-linux-gnu.tar.gz
    ugrep-v7.8.4-1-x86_64-pc-windows-msvc.zip
    ugrep-v7.8.4-1-aarch64-pc-windows-msvc.zip
  ripgrep-v14.1.1-1/
    ripgrep-v14.1.1-1-aarch64-apple-darwin.tar.gz
    ripgrep-v14.1.1-1-x86_64-apple-darwin.tar.gz
    ripgrep-v14.1.1-1-aarch64-unknown-linux-musl.tar.gz
    ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz
    ripgrep-v14.1.1-1-aarch64-pc-windows-msvc.zip
    ripgrep-v14.1.1-1-x86_64-pc-windows-msvc.zip
```

The upstream download address of the Microsoft prebuilt archives is
`https://github.com/microsoft/ripgrep-prebuilt/releases/download/v14.1.1-1/`. The target directory of the
intranet static server is fixed as:

```text
/Users/dev/shared/zcode/deps/native-search-tools/ripgrep-v14.1.1-1/
```

The corresponding default HTTP base URL is
`http://intranet.example.invalid:12345/zcode/deps/native-search-tools/ripgrep-v14.1.1-1/`. The archives to
mirror verbatim:

| Target        | Microsoft archive                                     | SHA-256                                                            |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| macOS arm64   | `ripgrep-v14.1.1-1-aarch64-apple-darwin.tar.gz`       | `84ff9b227b9aad651be0ac4cf7802a190015bfba3dfa6b015cc7aa89dd8c5c2b` |
| macOS x64     | `ripgrep-v14.1.1-1-x86_64-apple-darwin.tar.gz`        | `cfedd7993342bc5f90310ce73a00cbf5d3b5237654c9bfc18b383f0e829f3b11` |
| Linux arm64   | `ripgrep-v14.1.1-1-aarch64-unknown-linux-musl.tar.gz` | `98c0371366a9db920ed6c196083e8030511055e5f128b3bde2ca56bbddf85b9a` |
| Linux x64     | `ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz`  | `1154dd91f7b144cee490b91f1ab27ce04f8f01d8876cde2d9c0eff845c8ab012` |
| Windows x64   | `ripgrep-v14.1.1-1-x86_64-pc-windows-msvc.zip`        | `ede1d7f533f30d7e2870f77139d0fb9d7591daad5260b80d6a525e0bb5bd440e` |
| Windows arm64 | `ripgrep-v14.1.1-1-aarch64-pc-windows-msvc.zip`       | `88660d96f822d2e0329e254031068e82028f9c13efcec9b2d78c5a19d3f9ac47` |

Digests of the self-produced archives, pinned or pending producer backfill:

| Target        | Self-produced archive                             | SHA-256                                                            |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| macOS arm64   | `bfs-v4.1.1-1-aarch64-apple-darwin.tar.gz`        | `696f73eaff50d3c3de8a8ee36746a89693dd6ff0d010b05cd3b4b3eb2a369781` |
| macOS arm64   | `ugrep-v7.8.4-1-aarch64-apple-darwin.tar.gz`      | `01ea803e3fc3b94e796a9376e4d062a5490fe08e5760c6173e72b8f31546a4f3` |
| macOS x64     | `bfs-v4.1.1-1-x86_64-apple-darwin.tar.gz`         | `d993d72530749fa777339a7546f03338499abf235e2147d4adcd086641c6376f` |
| macOS x64     | `ugrep-v7.8.4-1-x86_64-apple-darwin.tar.gz`       | `6a2bedd9ccf53a2ac574d2fa498a36dcbe21e957b40442f9493180c6dad4dea9` |
| Linux arm64   | `bfs-v4.1.1-2-aarch64-unknown-linux-gnu.tar.gz`   | `dabdde935a02f89dd0c48c5cd0ec756a87d300fd5ace85a78e6a9eb51d771118` |
| Linux arm64   | `ugrep-v7.8.4-1-aarch64-unknown-linux-gnu.tar.gz` | `bf3b99c0af41f50c0ec3031b32ab8f67fa95b5581add18fad5163ece978d31ba` |
| Linux x64     | `bfs-v4.1.1-2-x86_64-unknown-linux-gnu.tar.gz`    | `9adf5759000021dd8fcd99670461cc43863f9172fb16f2f9a3e49c700311e7a0` |
| Linux x64     | `ugrep-v7.8.4-1-x86_64-unknown-linux-gnu.tar.gz`  | `13732f50fe63da07f3472f627f611b75359153163d07a0eb01e7c54125ae930e` |
| Windows arm64 | `ugrep-v7.8.4-1-aarch64-pc-windows-msvc.zip`      | `e9de73f1b542105203d586b19b4d57b8ecf2bf780f23e86c66a0fb7f56d51024` |
| Windows x64   | `ugrep-v7.8.4-1-x86_64-pc-windows-msvc.zip`       | `7bbd8e56540d2019a343688f1fc0ddb2ff5f0988090c577d2b9d6f4a8a86be21` |

The revision in `<tool>-v<version>-<revision>` increments only when the compile method or binary content
changes under the same upstream version, and does not follow the ZCode CLI version. The Linux artifact of
`bfs 4.1.1` keeps `-2` because the GLIBC build baseline changed; after the `ugrep` upstream version upgrade,
all platforms start from the new `v7.8.4-1` namespace and Linux does not inherit the old `v7.5.0-2` revision.
The historical remote `rg` resource is still consumed separately from `${ZCODE_DEPS_BASE_URL}/ripgrep-v13.0.0-10`;
this compatibility resource does not belong to the new desktop/SEA embedded-search release plan and cannot
serve as its version fallback.

The pinned archive digest confirms the identity of the downloaded content; the downloaded binary must still
pass the version, feature, architecture and dynamic-dependency checks, and Linux producer artifacts must also
pass the GLIBC 2.28 ceiling check. `.bundle-meta.json` records both the archive digest and the actual binary
digest: the former invalidates old caches after the digest changes, the latter is for local cache
consistency; the two cannot replace each other.

After a successful download or producer build, each tool directory gets a `.bundle-meta.json` corresponding to
the prebuilt release. A later prepare may skip only when the binary exists, its actual SHA-256 matches the
metadata, and the tool, version, release, target platform and file name in the metadata all match; on a Unix
host the target binary must also keep its executable permission, and if only the permission was lost it is
restored in place and reused without re-downloading. Leftovers such as historical rg 13 with no metadata, a
failed content check or mismatched metadata must be re-downloaded per the current release, and must not be
reused just because the fixed output path exists.

The producer remains available as an explicit manual flow: on the producer runner of the matching platform
run `pnpm run pack:native-search`, which by default builds from the locked sources, verifies and packages the
current host's `platform-arch` self-produced set, then generates under `dist/native-search-tools-deps/native-search-tools`
a file tree identical to the static directory above. Platform packaging CI reuses the same producer through
`pnpm run ci:ensure-native-search-deps`; it builds only when shared deps lacks the current target archive,
outputs to a job temp directory first, and then publishes the missing files. The subsequent formal prepare
must re-download the just-published archive from the intranet HTTP path, so the first producing pipeline also
covers the real distribution and unpacking path and cannot skip the download by reusing the producer's local
binary output directly.

All producers handle only `bfs` / `ugrep` and neither build nor repackage Microsoft `rg`. Linux must build
natively on the target architecture and macOS must build on macOS; Windows keeps the existing x64 MSVC runner
and generates the matching architecture's `ugrep.exe` via CMake `-A x64` / `-A ARM64`. Supported explicit
targets can be chosen with `pnpm run pack:native-search -- --platform <platform> --arch <arch>`. Before
release, prepare downloads Microsoft `rg` from the intranet mirror and runs a PE machine/import static check
on all Windows targets; full runtime E2E runs only when host/target architecture match. Ordinary
`prepare:native-search` only downloads and must not call a producer or write shared deps.

The source of `rg` is fixed per target with no runtime probing: macOS arm64/x64 use the Microsoft archives
that depend only on system libraries, with deployment targets 11.0/10.12 respectively; Linux arm64/x64 use
the Microsoft musl static archive with no glibc dynamic dependency; Windows x64/arm64 use the Microsoft MSVC
archive that passes the PE machine/import gate. The shell policy of `rg` differs from `find` / `grep`:
`find` / `grep` are unconditionally shadowed to `bfs` / `ugrep` in the embedded branch, while `rg` is
supplemented with the bundled native implementation only when the current shell finds no executable `rg`, and
must not override the user's existing system `rg`.

### Archive source: intranet mirror and in-repo archive

`scripts/prepare-native-search-tools.mjs` is the only entry shared by desktop `prepare:native-search`, SEA,
server-cli staging and remote asset preparation. The source is decided once by
`resolveNativeSearchArtifactSource(env)`; callers do not decide on their own:

| Condition                                                                                              | Source       | Behavior                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL` is set, or `resolveIntranetDepsBaseUrl(env)` can resolve an address | `intranet`   | Calls `downloadNativeSearchTools` as is: URL, proxy, SHA-256, bundle meta and cache-skip semantics unchanged; remote Linux/macOS still run the existing `download-native-search-tools.mjs` and the legacy rg13 `download-ripgrep.mjs` commands respectively |
| The intranet dependency source is unconfigured (resolution throws or is empty)                         | `repository` | First verify the SHA-256 of all archives of this plan in `apps/zcode-cli/dependencies/native-search`, then unpack one by one, run the target-architecture check and write bundle meta; no download, no fallback to the mirror            |

- This repo's `intranetDefaults.mjs` carries a default intranet address, so the default is always `intranet` and intranet builds and CI behave unchanged; the in-repo archive takes effect only in environments where the dependency source is truly unconfigured (such as an exported open-source tree).
- The in-repo archive and the intranet mirror have the same name and SHA-256; the release plan gives both `downloadUrl` (`intranet` only) and `archivePath`; the two sources cannot be mixed or serve as each other's failure fallback, and a validation failure on either path terminates immediately.
- Remote assets use `resolveRemoteNativeSearchPrebuiltPlan`: Linux shares one plan with desktop/SEA, macOS keeps rg13; the version and digest of legacy rg13 are still held solely by `native-search-tools-config.mjs`.
- Before returning, both sources write `THIRD-PARTY-NOTICES.txt` and `SOURCES.json` (`binary.origin` is `intranet-mirror` / `repository-archive` respectively) into every tool directory through `stageNativeSearchNotices`, refreshed on cache hits too; remote components finish writing before computing the content hash, so the component archive carries these materials.
- Unpacking, locating and archive authenticity checking have exactly one implementation, `prebuilt-binary-extract.mjs`, which the download path reuses; on Windows tar args uniformly use forward slashes and prefer an archive path relative to cwd, so GNU tar does not treat the drive letter as a remote host.
- Producer packaging (`pack:native-search` / `ci:ensure-native-search-deps`) still packs only binaries, staying byte-for-byte reproducible against the archives with pinned SHA-256.

## Sources and dependencies

The build entry must pin the source commit or release version and verify SHA-256 before unpacking. The three
platform builds share these version sources:

| Component | Pinned version                                     | Purpose                              |
| --------- | -------------------------------------------------- | ------------------------------------ |
| bfs       | 4.1.1 / `f220fb5afd8dd7f46b1d1a2ae9c36261eaccf3cd` | `find` backend                       |
| ugrep     | 7.8.4 / `550599a6434fc5315fb6ecd415a5d859e6d846a8` | `grep` backend                       |
| Oniguruma | 6.9.10                                             | bfs GNU find regex semantics         |
| PCRE2     | 10.43                                              | ugrep `-P`                           |
| zlib      | 1.3.1                                              | ugrep gzip/zip/archive support       |
| bzip2     | 1.0.8                                              | ugrep bzip2 support                  |
| zstd      | 1.5.6                                              | ugrep zstd support                   |
| Brotli    | 1.1.0                                              | ugrep Brotli support                 |

These dependencies take part only in the build and are statically linked into the target program; they are
not distributed separately as final runtime sidecars.

A GitHub commit archive carries no `.git`, so bfs 4.1.1's `build/version.sh` falls back to `4.1`. The
producer must pin the patch version through the build environment `VERSION=4.1.1` and must not pass
`./configure --version=4.1.1`, which pollutes the `CONFFLAGS` output of `bfs --version`.

TODO: after native build and E2E wiring is complete on all platforms, sync the locked source archives above to
ZCode's internal dependency source and add a dedicated mirror address resolution for the source downloader;
until the mirror artifacts are ready keep using the official URL with SHA-256 verification, and the source
file names must not be assumed to be resources under the existing `ZCODE_DEPS_BASE_URL`.

The observable baseline covers only the top-level `bfs` / `ugrep` versions, the Oniguruma switch, the `ugrep`
feature set, and ripgrep/PCRE2 capability. The Microsoft archive comes from the same ripgrep 14.1.1 upstream
version and does not require a byte-identical build identity; the current goal is the same version, feature
set, argument behavior and dynamic-dependency boundary. The transitive dependency versions in the table are
compatible versions pinned for reproducible builds.

## Build boundary

- The source manifest, SHA-256 verification, download/extract, CLI argument parsing, output plan and behavior E2E belong to the cross-platform shared layer.
- The version numbers of `bfs`, `ugrep`, `rg` may be declared only once in the shared manifest; each platform builder, the Microsoft archive mapping, the artifact verifier and each platform source plan must reuse that version source and keep no drifting version constants.
- The static dependencies and the `bfs` and `ugrep` builds of macOS/Linux belong to the Unix shared layer; platforms provide only the compiler toolchain, preprocessing flags and native dependency checks.
- Microsoft `rg` takes part in no producer and does not reuse ugrep's PCRE2 build. Linux keeps using the musl archive with pinned SHA-256.
- Windows `ugrep.exe` uses a separate MSVC/CMake builder and picks the target with `-A x64` / `-A ARM64`; the pinned ugrep source is BOM-less UTF-8, and MSVC must use `/utf-8` explicitly and cannot rely on the runner user's code page to interpret source. `rg.exe` comes directly from the pinned-SHA-256 Microsoft MSVC archive of the matching architecture. Both reuse the download plan and the PE static verifier; the x64 target keeps an independent behavior E2E and the arm64 target keeps the existing x64 Windows cross-build chain.
- Windows builds use the static MSVC runtime and statically link PCRE2, zlib, bzip2, zstd, Brotli and ugrep's bundled 7zip decoder. The final PE must reject `VCRUNTIME*.dll`, `MSVCP*.dll`, `ucrtbase.dll` and other dynamic CRTs, as well as the build dependencies above that should be statically linked.
- The Linux producer is allowed by actual toolchain capability, not by a specific image identity: before downloading sources the build script must check that the Node major is 26, the builder glibc is 2.28, and the GCC major of `CC` and the G++ major of `CXX` are both 12, and the final artifact then passes the GLIBC symbol gate. A macOS Apple Silicon runner may build the x64 sidecar with the system clang `-arch x86_64` and execute the configure probe through Rosetta; the independent E2E entry can likewise verify the x64 artifact through Rosetta but is not embedded in the formal packaging job. ugrep configure must explicitly use the `x86_64-apple-darwin` host so the arm64 runner identity is not written into the x64 artifact. x64 keeps enabling baseline SSE2 and disabling AVX2 through the upstream compiler probe. Other unverified Unix cross-compilation stays rejected.
- Linux seed/rebuild launches target-architecture containers with local Docker on the dev machine, `--platform linux/arm64` / `--platform linux/amd64` respectively, and uses the unified entry `pnpm pack:native-search -- --platform linux --arch <arm64|x64>` inside the container; the current reproducible baseline is Rocky Linux 8 glibc 2.28, Node 26.11.1 and GCC Toolset 12. macOS and Windows are still produced by their respective platform packaging machines. `ci:ensure-native-search-deps` reuses the same packaging implementation to produce when the current runner satisfies the Node 26 / glibc 2.28 / GCC 12 / G++ 12 gate, and needs no extra Dockerfile or platform-specific wrapper from the repository; the image name itself does not replace the runtime gate above and the pinned archive SHA-256.
- The deployment target of the self-produced macOS `bfs` / `ugrep` sidecars is fixed at `12.0`; Microsoft `rg`'s deployment target may be lower but must not exceed `12.0`. The build check must read both Mach-O `LC_BUILD_VERSION.minos` and the old-style `LC_VERSION_MIN_MACOSX.version`; no tool may raise Electron 41's minimum macOS version.
- macOS `bfs` must mask the standard `posix_spawn_file_actions_addfchdir()` added by the macOS 26 SDK so upstream keeps choosing `posix_spawn_file_actions_addfchdir_np()` available since macOS 10.15, and must inject `-Dfdclosedir=__bfs_poison_fdclosedir_macos_26_4`. Both prevent the new SDK's configure probe from making a deployment-target-12.0 artifact weakly import symbols that exist only in higher system versions.
- Linux `ugrep` must statically link the GCC/C++ runtime; the final dependency allowlist must not accept `libstdc++.so`, `libgcc_s.so`, `libc++.so` or `libc++abi.so`, so a regression in build arguments still passing the verifier does not bring GLIBCXX/CXXABI compatibility risk into the distribution.
- x64 `ugrep` uses a baseline CPU configuration with AVX2/AVX512 disabled; arm64 uses the target compiler's NEON path.
- macOS builds depend on Xcode Command Line Tools, system `make`, `curl` and `tar` and need no Cargo/Rust or Homebrew libraries. Linux builds depend on binutils, `make`, `curl`, `file` and `tar`, likewise without Cargo/Rust; `CC` / `CXX` may be overridden explicitly, but the script must probe the actual compiler version of each separately and both majors must be 12. The Windows producer builds only `ugrep.exe` and depends on VS 2022 Build Tools, CMake, `curl` and `tar`; the arm64 target additionally needs the matching MSVC ARM64 toolset.
- The default output locations follow the desktop runtime asset structure:
  - `packages/desktop/bundled-tools/darwin-<arch>/{bfs,ugrep,ripgrep}` prepared by the native search prebuilt download chain.
  - `packages/desktop/bundled-tools/linux-<arch>/{bfs,ugrep,ripgrep}` prepared by the native search prebuilt download chain.
  - `packages/desktop/bundled-tools/win32-<arch>/{ugrep,ripgrep}` prepared by the native search prebuilt download chain.
- The desktop host and the Linux remote server discover the enabled artifacts of each platform through the existing runtime tool resolver and project absolute paths as `ZCODE_BFS_BINARY`, `ZCODE_UGREP_BINARY`, `ZCODE_RG_BINARY`. Windows neither generates nor projects `ZCODE_BFS_BINARY`, and `find` keeps going to Git Bash/system; the directories of discovered tools are appended to the Agent runtime's `PATH`, keeping user-command priority.
- SEA still delivers a single executable per target and must not deliver `bfs`, `ugrep`, `rg` as same-directory sidecars. At build time the native tools enabled for the current target and the manifest are written into SEA assets; at runtime the first read of the asset extracts to `cache/runtime_tools` under `ZCODE_STORAGE_DIR` (default `~/.zcode`).
- `pnpm build:sea` keeps the existing all-target contract and passes `--all` explicitly. The producer of each target platform must first build, verify and publish the prebuilt archive; the SEA build then downloads, verifies and prepares `packages/desktop/bundled-tools/<platform>-<arch>` for each target by the same release plan before consuming it uniformly. A missing foreign-target tool must fail closed and the public command must not be degraded to host-only. The host E2E uses the lower-level `sea --target <host-target>` and does not change the release entry.
- The SEA runtime tool cache must be located by `<target>/<tool>/<tool-version>-<binary-sha256>` and must not include the CLI version. When several CLI versions carry exactly the same tool version and binary content they must reuse one cache; upgrading a single tool must not force other unchanged tools to be extracted again.
- SEA extraction must verify the SHA-256 in the manifest file by file, write to a sibling temp directory and replace atomically, and restore executable permission. Concurrent first starts must converge to the same cache directory; a completed cache whose marker, file size, actual SHA-256 and executable permission are all valid is reused directly.
- The SEA runtime tool manifest describes only the target platform, tool id, tool version, binary name, size and SHA-256. Neither the cache path nor the manifest may depend on the ZCode/CLI version; non-SEA desktop, source CLI and remote runtime keep their existing discovery chains.
- Windows x64/arm64 SEA bundle `ugrep 7.8.4` and `ripgrep 14.1.1`; `find` keeps falling back to Git Bash/system. Both architectures must pass the PE target format and static dependency checks; x64 additionally has an independent real runtime E2E; arm64 remains an explicit to-be-verified item until the equivalent E2E is completed on an available target machine, and one cannot claim target-architecture runtime verification just because SEA can extract arbitrary tools.
- The env accepted by the runtime tool resolver must run through the explicit binary path, the server runtime root and the PATH lookup, and must not read parameters in one place and implicitly read global `process.env` in another.
- The desktop local binary locating info and the deployment version of the remote resource package are two kinds of metadata. The Linux remote manifest explicitly reuses the same native-search release plan and publishes `bfs-v4.1.1-2`, `ugrep-v7.8.4-1` and Microsoft `ripgrep-v14.1.1-1`; Darwin remote keeps publishing the historical `ripgrep-v13.0.0-10`. The remote producer must pick these two dependency chains explicitly by target platform, the desktop release plan must not rewrite Darwin remote implicitly, and historical release assets must not be deleted.
- The Agent default embedded-search backend directly holds the paths of the three native programs `bfs` / `ugrep` / `rg`. The Bash prelude no longer starts a Node forwarding layer through `__internal-search`; when `bfs` / `ugrep` are not executable it falls back to system `find` / `grep` respectively; when the shell already has an executable `rg` it stays unchanged, and only when it is missing is a function that runs the bundled `rg` directly added.
- The `find` fixed args must be arranged as `-S dfs -regextype findutils-default "$@"`.
- The `grep` fixed args must be arranged as `-G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl "$@"`; default args first, user args after.
- `grep` bypasses `ugrep` and calls system `grep` directly when it meets `-*-filter*`, `-*-pager*`, `-*-view*`, `-*-format-open*`, `-*-config*`, `---*`, `-@*`, `-*-save-config*`, `-[Zz]*`, `-[!-]*[Zz]*`, `--null` or `--null-data`; the last four groups preserve GNU grep's null-data/short-option semantics, which differ from ugrep's compression options.
- To trigger ugrep decompression through the embedded `grep` use `--decompress`; `-z` / `-Z` and `--null` / `--null-data` are reserved for the system grep compatibility path.
- The `rg` fallback in Bash adds no default flags and hands only the user's `"$@"` to the bundled ripgrep as is; args such as `--no-config` used by internal file-search calls do not belong to the Bash shell function contract.
- E2E may write to a temp directory through `--output-dir` and must not pollute the formal runtime assets.
- Downloads, compilation and intermediate dependencies all live in a separate temp working directory, cleaned by default on success or failure. The dependency flags written into the binary metadata must use stable relative paths and must not record a random temp directory, otherwise the SHA-256 of the same target and tool version drifts; only an explicit debug argument may keep the working directory.
- Build artifacts are not committed to Git. Dev-mode `pre-dev` decides whether the local native-search sidecar is valid through the same version, feature, architecture and ABI verifier as the release build; when a file is missing or verification fails, the artifact is prepared again, and readiness is not decided only by path existence. The desktop packaging flow prepares artifacts at build time; the runtime of an installed app does no source download or on-the-spot compilation.
- Desktop prepare, missing-asset detection and `extraResources` must read the same `platform-arch` release plan. A new target can usually join the release-enabled set only after a real build and an independent E2E pass, and must not be enabled as a whole because another architecture of the same OS passes; every formal packaging of an enabled target does not rerun behavior E2E. Windows arm64 is the existing cross-release branch explicitly restored this round; its PE static gate must not be recorded as completed runtime E2E, and it still needs to be verified on a target machine later.
- A prebuilt artifact must first pass Mach-O / ELF / PE format and target-architecture static checks in a temporary unpack path before overwriting the formal path and writing bundle metadata. Bundle metadata only checks whether the local file changes afterwards and cannot treat the SHA-256 computed from the downloaded file itself as proof of source trust; a cache that already has metadata must also pass the target check again before it may skip the download.
- The release plan must explicitly distinguish native build output from the sidecar dynamically packaged by Electron; desktop/SEA callers must no longer assemble platform-specific legacy ripgrep download branches.
- The macOS arm64/x64 desktop distribution packages both carry the matching architecture's `bfs` / `ugrep` / `rg` sidecar through `extraResources` and uniformly reuse the bundled-tools signing and notarization chain. The two macOS packaging jobs run only the asset verifier, signing and notarization, and do not run a Bash toolcall E2E before signing. Third-party license notices remain part of the compliance checklist before formal release; temporary E2E artifacts do not enter the distribution.
- The prepare of every platform must download the pinned-SHA-256 Microsoft `rg 14.1.1` archive; a producer must not produce `rg`. Desktop prepare and missing-asset repair must not call the legacy `prepare:rg` download chain.
- Linux x64/arm64 CI jobs must each enter an execution environment matching the target architecture; it may be a native runner or a target-architecture environment explicitly selected by `docker --platform`. A runner tag or image name by itself is no basis for approval; the arch seen by the build process, the actual Node/glibc/CC/CXX gates and the final ELF architecture/ABI checks must all match.
- The formal `build:windows:x64` / `build:windows:arm64` keep reusing the existing `windows` runner; the current x64 runner cross-generates the arm64 Electron/NSIS and native-search artifacts. Both targets must read the PE header and import table directly to verify the machine and static runtime, but the packaging job does not run the full runtime E2E.

## Linux remote and WSL resource boundary

After the Linux x64/arm64 producer, shared archive and packaging consumption chain are verified, Linux remote
(WSL, Linux SSH, Linux Docker) and desktop/SEA share one native-search release plan:

```text
Linux x64/arm64 producer
        |
        v
bfs 4.1.1-2 / ugrep 7.8.4-1 immutable archives + Microsoft rg 14 musl archive
        |
        +-------------------------+
        |                         |
        v                         v
Linux desktop / SEA       Linux remote asset manifest
                                  |
                                  v
                         bfs / ugrep / ripgrep components
        |
        v
WSL / Linux SSH / Linux Docker
  -> find: bfs 4.1.1
  -> grep: ugrep 7.8.4
  -> rg: system rg first, bundled rg 14.1.1 when missing

Darwin remote asset manifest
        |
        v
legacy ripgrep 13 component
```

The remote resource id, the manifest mount allowlist, the deployment loop and the runtime descriptor must be
connected in the same change; the Bash prelude must not see a nonexistent path. This wiring reuses the
existing shared host and Agent runtime, creates no new WSL Agent runtime, does not change workspace identity
and does not touch the delivery boundary between desktop `desktop-continuous` and mobile
`web-remote-replayable`.

## E2E contract

The macOS/Linux/Windows x64 E2E is an independent verification entry that calls the real prepare from an empty
temp directory by default. The outer runner only builds the producer set per target, downloads Microsoft
`rg`, runs the version/feature/ABI checks and starts one real Bash toolcall E2E, and must not maintain another
set of duplicate fixtures and behavior assertions. Linux verification may first produce and verify the
self-produced `bfs` / `ugrep` in the producer of the matching architecture, then have prepare supply the
Microsoft musl `rg`, and finally hand the same set of formal artifacts to the E2E through `ZCODE_BFS_BINARY` /
`ZCODE_UGREP_BINARY` / `ZCODE_RG_BINARY`; the same tool must not be compiled twice across the two stages.
Windows uses the self-produced `ugrep` and Microsoft `rg` and lets `find` go to Git Bash/system. The
cross-target fixture and PE verifier of Windows arm64 prove only the compile, collection and static
dependency contract and do not pose as target-architecture runtime E2E. The toolcall E2E must build the
prerequisite packages from the root workspace by `@zcode/bootstrap`'s real dependencies and cannot depend on a
pre-existing `dist` in the workspace. The full chain must cover at least:

`pnpm test:sea-runtime-tools:e2e` is the host E2E of the SEA single-file delivery: it builds the SEA of the
current target, copies the artifact to an isolated directory without sidecars, verifies the first extraction,
the second reuse, version/SHA/executable permission, and then hands the extracted path to the same real Bash
toolcall E2E. This command must not leave runtime-tool caches or temp directories in the user's default
storage root and must not serve as a prerequisite of desktop Electron packaging.

The cross-target fixture in SEA unit tests only verifies the manifest and asset collection contract; it
cannot replace the real native build of each target platform, the host SEA E2E or the cross-platform artifact
aggregation gate. A package-script regression must prove that `build:sea` always passes `--all`; a target
added later but not yet complete may make the release build fail explicitly, but must not change the existing
command behavior.

Formal desktop packaging generates the `bundled-tools/<platform>-<arch>` artifacts only through
`prepare:desktop-runtime`, runs the mechanical checks of version, feature, architecture, ABI and signing,
and then enters Electron packaging; the packaging templates for macOS, Linux and Windows must not call
`pnpm test:native-search:e2e` or `pnpm test:sea-runtime-tools:e2e`. To verify behavior, an independent E2E
entry consumes, by absolute path, the artifacts generated by the same release plan.

1. macOS/Linux verify `bfs --version`, Windows verifies system `find --version`; all platforms verify the version and capability string of `ugrep --version`.
2. `file` plus platform inspection tools verify the target architecture and dynamic dependency boundary of the finally shipped `bfs`, `ugrep`, `rg`: macOS uses `otool -L` / `vtool -show-build`, Linux uses `readelf -d` to check dynamic dependencies and `readelf --version-info` to assert that the maximum GLIBC reference of `bfs` / `ugrep` does not exceed 2.28, and Windows reads the PE header / import table directly to verify the machine and reject the dynamic CRT and the PCRE2 and compression libraries that should be statically linked.
3. Directory, depth, type, name and regex queries of `bfs -S dfs -regextype findutils-default`.
4. Recursive search with `ugrep -G --ignore-files --hidden -I` plus the VCS exclusion args.
5. Hidden files searchable, ignore files and VCS directories excluded, binary files excluded by `-I`.
6. stdin-only search, the no-match exit code, the invalid-regex exit code, and a pipe closed early by `head`.
7. `-E`, `-F`, `-P` in user args can override the default `-G`, and PCRE2 plus gzip, bzip2, zstd, Brotli, zip/archive decompression search capability is verified.
8. The default backend resolves the three native programs from `ZCODE_BFS_BINARY` / `ZCODE_UGREP_BINARY` / `ZCODE_RG_BINARY` and enters `NodeExecutionAdapter` from the handler of the real Bash tool entry; the test cannot hand-build an `ExecutionRequest` to skip the toolcall boundary.
9. At least one full Bash toolcall must prove at once the actual hit of `bfs 4.1.1` (system find on Windows) / `ugrep 7.8.4` / `ripgrep 14.1.1`, and cover the full integration capability ZCode promises for embedded search: `bfs` directory, depth, type, name and GNU find regex; `ugrep` recursion, hidden/ignore/VCS/binary filtering, stdin, `-E` / `-F` / `-P`, system-grep bypass for special args, compressed files and archives, exit codes and early pipe close; `rg` file/glob, hidden, stdin, fixed string, PCRE2, exit codes and early pipe close.
10. An existing executable `rg` in the shell must not be overridden by the bundled `rg`; when the shell lacks `rg` it runs `ZCODE_RG_BINARY` directly and cannot fall back to Node, WASM or the internal CLI forwarding layer.
11. The toolcall E2E must explicitly close the execution adapter, delete the fixture/output temp directories and enable Vitest async-leak detection; after the build entry succeeds or fails, no build/E2E workdir, child process, timer or unfinished promise may remain.

The full integration capability here is bounded by the args ZCode actually injects and their behavior; it does
not require exhausting all independent args of the upstream `bfs`, `ugrep`, `rg` CLIs. `ugrep --version` must
still assert the full compiled feature set; behavior tests execute at least gzip, bzip2, zstd and Brotli
separately, with zip and tar representing the archive search path.

Upstream tests serve only as supplementary evidence when source versions are upgraded or the build chain is
adjusted; `ugrep make test` and the `bfs` unit tests can be run through explicit build args and are not a
mandatory gate of every release build. The formal packaging gate is based on the pinned source/archive SHA and
the version/feature/architecture/ABI verifier; the real ZCode Bash toolcall E2E on the target architecture is
independent verification evidence and is not repeated for every installer build. The current Windows arm64
cross build passes only the PE static check and is a release verification still to be done after the code is
committed, not completed E2E evidence. macOS's bundled Bash 3.2 does not support the `coproc` used by the bfs
integration test harness, so the repo E2E cannot depend on that harness and should directly cover the arg
combinations ZCode actually uses.

## Follow-up integration

macOS arm64/x64 are wired into the desktop local runtime assets and each provides an independent Bash toolcall
E2E for its architecture. Linux `bfs` / `ugrep` are built by a producer that passes the Node 26 / glibc 2.28 /
GCC 12 / G++ 12 gate, and `rg` on both architectures uses the Microsoft musl static archive; the combined
artifacts get version, feature, architecture, dynamic-dependency and GLIBC 2.28 ceiling checks at desktop/SEA
and Linux remote packaging, and the full Bash toolcall E2E runs independently. Windows x64/arm64 CI generates
`ugrep.exe` through the MSVC/CMake builder and downloads the matching architecture's `rg.exe` from the
Microsoft release; both targets must pass the PE static dependency check, the x64 Git Bash toolcall and SEA
E2E stay as independent verification, and arm64 keeps the existing cross-build release chain. Darwin remote
temporarily keeps the historical rg13 component, and any later migration must be done as a separate change.

Platforms that do not carry native artifacts keep falling back to system `find` / `grep` through the Bash
prelude and must not fall back to the Node forwarding layer. Later platform wiring must not change the
existing contract of the provider-visible embedded branch.
