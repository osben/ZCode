# 01 · Quick start

## Build from source

Prepare Git, Node.js 26.11.1 and pnpm 12.14.0; the repository root [mise.toml](../../../../mise.toml) is authoritative. Run the following commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --version
node apps/zcode-cli/packages/cli/dist/zcode.cjs doctor --json
```

`@zcode/cli...` includes the CLI's workspace dependencies. The first install runs the repository's asset preparation steps and needs access to the package and asset download sources. Do not treat a directory whose install scripts were skipped as a complete distribution.

For a single-file executable, run this after the build:

```sh
pnpm --filter @zcode/cli sea --target linux-x64
```

Targets are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win-arm64`, `win-x64`. Artifacts are in `apps/zcode-cli/packages/cli/dist/`; Windows file names use `zcode-windows-<arch>.exe`. Cross-packaging is not the same as running on the target platform.

Below, `zcode` stands for the CLI command. With the plain Node bundle, replace it with `node /absolute/path/to/zcode.cjs` and keep the adjacent assets the build generated. The SEA embeds Node and does not depend on the system Node version; external programs started by MCP, Hooks or plugins must still be installed separately.

## Use the executable

On macOS/Linux, add the execute bit to a trusted artifact and run it by absolute path:

```sh
chmod +x /absolute/path/to/zcode-darwin-arm64
/absolute/path/to/zcode-darwin-arm64 doctor --json
```

Windows PowerShell example:

```powershell
& 'C:\tools\zcode-windows-x64.exe' doctor --json
```

Do not use an artifact for a different OS or CPU architecture. If macOS blocks an unsigned artifact, confirm its source first and then allow it in System Settings; do not bulk-remove security attributes from unknown files.

## Self-check and model setup

```sh
zcode --version
zcode --help
zcode doctor --json
zcode plugins list --json
zcode skills list --json
```

`doctor` checks the version, platform, CPU, Node, executable path and SEA state; it does not prove that model credentials, the network or tool calls work. The plugin list can be queried on its own and does not require a paid model request first.

In the current source, personal model settings are saved in `~/.zcode/v2/provider_config.json`; runtime and extension settings remain in `~/.zcode/cli/config.json`. Set up a personal provider as described in [Configuration](03-config.md), or run `zcode login` on a supported account path. On a remote terminal, `zcode login --no-browser` prints the login URL; the browser callback may still need to be on the same machine as the CLI.

## First non-interactive call

```sh
zcode --prompt "只用一句话回复 ready，不调用工具" --cwd /absolute/path/to/project --mode plan --json --no-color
```

(The sample prompt asks for a one-sentence reply "ready" without calling tools.) A successful plain prompt returns `sessionId`, `response` and related run information. Then verify the tools you need in a throwaway directory and check real file or command results. A model reply saying "success" does not mean a tool ran.

Automation tasks that run commands or modify files usually pass `--mode yolo` explicitly, with the task container or the operating system limiting accessible scope. `--prompt` also defaults to `yolo`. This is neither read-only mode nor a sandbox. Before batch execution, continue with [Tools](04-tools.md) and [Permissions](05-permissions.md).

## Isolated run environment

Concurrent tasks should use separate working directories, user directories and data base directories. In the child process environment set `HOME`, `USERPROFILE` and `ZCODE_DATA_BASE_DIR` together to a temporary directory for this run; do not modify the caller's global environment. This isolates credentials, personal model configuration, sessions, plugins and memory. `ZCODE_STORAGE_DIR` controls only some storage paths and alone does not amount to full isolation.

A copyable cross-platform child process example is in [Batch tasks](13-automation.md). Configuration files and keys must also be written into that isolated environment; do not rely on the development machine's existing login state.
