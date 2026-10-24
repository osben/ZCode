# Ripgrep Runtime

## Background

- When ZCode Agent runs shell in GUI desktop, SSH remote, WSL and Docker, it cannot reliably depend on whether the host machine has put `rg` into `PATH`.
- The same environments also hit the problem of GUI / non-login shells losing the `bun` and `nvm` paths.

## Approach

- `packages/shared/src/runtime-tool-runtime.ts` uniformly declares the built-in `bfs`, `ripgrep` and `ugrep` runtime tools.
- Local desktop/SEA and Linux remote pin `ripgrep` to Microsoft `ripgrep-prebuilt v14.1.1-1`; macOS arm64/x64, Linux arm64/x64 and Windows x64/arm64 all download Microsoft's original archive with a pinned SHA-256 from `${ZCODE_DEPS_BASE_URL}/native-search-tools/ripgrep-v14.1.1-1`, no longer built by the native-search producer. The chosen macOS archives have a deployment target no higher than 12.0, Linux uses a glibc-free musl static archive, and both Windows architectures reject a dynamic CRT and build dependencies that should be statically linked, so upgrading rg does not change ZCode's existing system distribution floor. The Darwin remote producer temporarily keeps the historical `v13.0.0-10` asset; the two share no version metadata, and desktop prepare no longer exposes the old version download entry.
- `packages/services/src/runtime-tools/runtimeCommandEnv.ts` at host / server startup:
  - tries to replay a `PATH` from the login shell;
  - then appends the built-in tool directory to `PATH`; `rg` keeps the priority of the user's existing command, while `find` / `grep` are used by the embedded-search prelude directly via the bundled absolute path;
  - also injects `ZCODE_BFS_BINARY`, `ZCODE_RG_BINARY`, `ZCODE_UGREP_BINARY`.
- The ZCode Agent child process keeps inheriting this environment through the clean runtime env; no entry needs separate handling.

## Resource layout

### Local desktop

```text
packages/desktop/bundled-tools/<platform>/ripgrep/rg(.exe)
resources/tools/ripgrep/rg(.exe)
```

### Remote

```text
mock-cdn/releases/<version>/tools/linux-<arch>/{bfs,ripgrep,ugrep}/<binary>
~/.zcode/server/tools/{bfs,ripgrep,ugrep}/<binary>
```

Linux remote (WSL, Linux SSH and Linux Docker) deploys `bfs 4.1.1-2`, `ugrep 7.8.4-1` and Microsoft
`ripgrep 14.1.1-1`. Darwin remote keeps deploying the historical `ripgrep 13.0.0-10` and does not migrate
with Linux remote; the rg13 assets published by older versions are also kept.

## Result

- When the local GUI starts, ZCode Agent/terminal can recover `bun` from the login shell.
- When the host already has `rg` the user's version keeps priority; without `rg`, ZCode Agent can run the bundled version directly both locally and on remote.
- desktop/SEA and Linux remote can use the bundled `bfs` / `ugrep`; when a tool is missing or not executable they still fall back to system `find` / `grep` respectively.
