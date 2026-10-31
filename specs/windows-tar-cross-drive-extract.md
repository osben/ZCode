# Windows tar extraction across drives

## Background

`scripts/prebuilt-binary-extract.mjs` (`extractPrebuiltArchive`) unpacks `.tgz` archives with the
`tar` found on `PATH`. On GitHub Windows runners that is GNU tar from Git for Windows, which reads a
`-f` argument shaped like `host:path` as a remote archive. A drive-letter path (`D:/a/...`) therefore
fails with `Cannot connect to D: resolve failed`.

The helper avoided the colon by passing the archive path relative to the tar `cwd`. That only works
when both are on the same drive: `path.win32.relative()` does not throw across drives, it returns the
absolute target path, so the colon came back. Upstream 3.17.1 added the bundled npm stage
(`packages/desktop/scripts/bundled-npm-assets.mjs`), which extracts a cache archive on the checkout
drive (`D:`) with `cwd` set to a temporary directory on `C:`. Fork release run 41171314864 (Windows x64)
failed there; `downloadAndExtractPrebuiltBinary` has the same shape (temporary archive, repository
`cwd`).

## Rule

`resolveTarExtractInvocation({ archivePath, extractDir, cwd, platform })` is the single owner of the
tar command line:

- On `win32` the archive path is resolved against the caller's `cwd`; tar runs from that archive's
  directory and gets its bare file name, so no drive letter ever reaches `-f`. `extractDir` is
  resolved against the caller's `cwd` and
  passed to `-C` as an absolute forward-slash path (GNU tar does not treat `-C` as a remote spec, and
  MSYS accepts `C:/...`).
- On other platforms the invocation is unchanged: archive and `-C` paths as given, caller's `cwd`.

`extractPrebuiltArchive` resolves `archivePath` and `extractDir` against the caller's `cwd`
(default `process.cwd()`) once, before `mkdirSync`, so directory creation, PowerShell/`unzip` and tar
all target the same directory.

## Acceptance

- Win32, archive and `cwd` on different drives: no tar argument contains `<letter>:` before the
  archive name; tar `cwd` is the archive directory.
- Win32, relative `archivePath` or `extractDir`: both resolve against the caller's `cwd`.
- POSIX: arguments and `cwd` equal the previous behaviour.
- A relative `extractDir` with a `cwd` other than `process.cwd()` is created and extracted under that
  `cwd` (real tar), and nothing is created under `process.cwd()`.
- Regression test: `packages/desktop/test/prebuiltBinaryTarInvocation.test.ts` (fork manifest).
- The Windows x64 job of `fork-release.yml` passes `prepare:agent-bundle`.
