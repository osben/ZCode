# Local Remote Asset Archive Design

Windows SSH users could fail in the default `local-download-upload` remote asset flow with `spawn C:\Windows\System32\tar.exe ENOENT`: after downloading a CDN component archive into the local `remote-assets-cache`, the desktop host tried to extract it by spawning the Windows system tar binary. The desktop client no longer depends on a local system `tar` for remote asset cache extraction or local upload archive creation.

Scope: desktop host local side of `local-download-upload` only. `remote-download` still uses the remote server's detected `tar`; uploaded directory archives are still extracted on the remote host with remote `tar`. SSH protocol, remote target types, web remote control delivery, and UI form behavior are unchanged.

Design — Node-based `.tar.gz` helper in `packages/server/src/remote`:

- `extractTarGzArchive(archivePath, targetDir)`
- `createTarGzArchive(archivePath, entries)`

Built on Node built-ins (`zlib`, `fs/promises`, `path`), supporting regular files, directories, and POSIX-style relative tar entry paths. The extractor rejects unsafe entries: absolute paths, `..` traversal, backslash paths, symlinks and special device entries, and paths resolving outside the target directory.

Integration:

- `packages/server/src/remote/remoteAssetCache.ts`: local `tar -xzf` extraction of downloaded CDN archives replaced by `extractTarGzArchive`.
- `packages/server/src/remote/remoteAssetInstaller.ts`: local `tar -czf` creation in `LocalUploadAssetInstaller.installDirectory()` replaced by `createTarGzArchive`.
- `packages/server/test/remoteDeploy.test.ts`: test CDN fixture archives built with `createTarGzArchive`, removing the local system tar dependency.

Compatibility: cache layout and deployment behavior unchanged — staging-directory extraction, `.ready` markers and atomic commit in existing callers, top-level source directory name preserved in upload archives, remote extraction command unchanged.

Tests: `ensureRemoteReleaseDirFromCdn()` downloads and extracts without spawning local `tar`; path-traversal entries rejected; local upload archive creation spawns no local `tar` and preserves the expected shape.

Limitation: the helper intentionally supports a small tar subset (remote asset build output is controlled by this project). Future assets needing symlinks or special entries require an explicit, tested extension — never silent acceptance.
