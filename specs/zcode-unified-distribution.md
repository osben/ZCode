# ZCode unified Node distribution

## Product rules

- The Node distribution is named `zcode`, with executable `bin/zcode.mjs` and installed command `zcode`.
- `zcode` starts the existing terminal UI. All arguments except a leading `--web` are forwarded unchanged to the existing CLI (including `tui`, prompt, login, resume and internal protocol commands).
- `zcode --web` starts the existing local HTTP/WebSocket server with bundled Web assets and Agent. Existing Web flags remain available: `--workspace`, `--host`, `--port`, `--open`, `--no-open`, `--token`, `--no-token`.
- Only a leading `--web` selects Web mode; a prompt value containing `--web` must remain CLI input. CLI parsing, locale, permissions and sessions keep their existing owner.
- `zcode --help` includes the Web invocation plus existing CLI help; `zcode --web --help` describes Web flags. `zcode --version` reports the distribution version.
- Web keeps localhost binding, automatic port selection and non-loopback token defaults. `--no-token` with a non-loopback `--host` is rejected before the server starts (see `docs/specs/web-server-bind-auth.md`). TUI inherits the real terminal in the same process; the launcher must not consume its stdin or print Web status.

## Ownership and boundaries

The release scripts own archive assembly and installation. They reuse the CLI's existing `collectSeaTuiAssets` build API for the TUI dependency closure, workspace export rewriting, dependency-version placement, native libraries and workers. This build API is not a new runtime service dependency. Root release scripts are outside the runtime module roots in `architecture-policy.yaml`; the referenced CLI module is legacy and has no module contract.

TUI assets are placed under `agent/node_modules`, preserving package-relative paths and keeping their dependency versions separate from server dependencies. The CLI's built `provider/` config and third-party notices accompany `agent/zcode.cjs`; its external Playwright runtime is also included. Assets for the existing six SEA targets are combined; duplicate paths must have identical hashes or packaging fails. Required missing assets fail the build, including with `--skip-build`.

The launcher imports the existing Agent CLI entry in the same process, setting `process.argv[1]` to that entry so self-spawned CLI workers continue to use the canonical Agent. It introduces no session state, persistence, queue, replay or lease owner. The existing Web server owns its Agent process; the launcher forwards shutdown and observes child exit/error.

```mermaid
sequenceDiagram
    participant User
    participant Launcher as zcode launcher
    participant CLI as Existing CLI / TUI
    participant Server as Existing Web server
    participant Agent as Agent app-server
    User->>Launcher: argv
    alt no leading --web
        Launcher->>CLI: import Agent entry with original arguments and terminal
        CLI->>CLI: existing runtime admission and persistence
    else leading --web
        Launcher->>Server: spawn with workspace, static root and Agent command
        Server->>Agent: existing app-server --stdio lifecycle
        User->>Launcher: shutdown
        Launcher->>Server: SIGTERM
    end
```

## Packaging and migration

- Build with `pnpm build:zcode`; output is `dist/zcode/releases/<version>/zcode-<version>.tar.gz`, plus checksum, `latest.json` and `install.sh`.
- Node remains required, at the version pinned in `mise.toml`. The archive includes TUI assets for macOS, Linux and Windows (arm64/x64); native functionality must be verified per platform rather than inferred from asset presence.
- Build download URL: `--base-url` overrides `ZCODE_DIST_BASE_URL`; environment overrides `.env.local`, which overrides `.env`. Missing URL fails before building. Installer `ZCODE_DIST_BASE_URL` overrides its embedded default.
- Installer `ZCODE_DIST_HOME` overrides `~/.zcode/runtime`; `ZCODE_DIST_BIN_DIR` overrides `~/.local/bin`. These release-only variables do not change CLI/session data directories. Installation writes the `zcode` launcher and preserves existing user data.
- `pnpm build:zcode` coexists with the existing `pnpm build:lite` (`scripts/build-zcode-lite.mjs`), which internal CI and release flows may still use; the two commands produce separate outputs (`dist/zcode` and `dist/zcode-lite`) and neither changes the other. Do not automatically delete old Lite installations. Retiring Lite requires confirming that no internal pipeline still depends on it.

## Acceptance and validation

1. Launcher process tests prove default CLI routing, unchanged CLI arguments, help/version, exit-code propagation and no Web startup in TUI mode.
2. Web process tests prove leading flag routing, workspace/static-root/Agent configuration, invalid arguments, help and shutdown behavior without requiring a model or network service.
3. Installer test uses a local fixture archive to prove the installed command is `zcode` and defaults to CLI while forwarding `--web`.
4. Build a real release, extract outside the repository, unset workspace module fallbacks, import its TUI/native runtime and interact with it through a pseudo-terminal. Verify first render and clean keyboard exit without sending a model prompt.
5. Start the same extracted release with `--web`; verify HTML, `/api/server-info`, workspace and WebSocket connection, then stop it.
6. Run root typecheck, lint and architecture checks. Report actual platform and any unexecuted cross-platform or model-call paths.

## Recorded validation

- `node --test scripts/zcode-distribution.test.mjs`: 5 process/installer tests passed.
- Smoke test (`node scripts/zcode-distribution-smoke.mjs dist/zcode/releases/<version>/zcode-<version>.tar.gz`),
  run on macOS arm64 outside the repository with an isolated data directory: native TUI import,
  initialized screen, keyboard exit, Web HTML, `/api/server-info`, workspace, WebSocket and
  shutdown; exit code 0, no model prompt sent. The TUI readiness check strips terminal control
  sequences because the renderer interleaves them between characters.
- Build caveats: `@zcode/shared` has no build script; its `dist/` only exists after root
  `pnpm typecheck` (`tsc -b` emit), so run typecheck before assembling with `--skip-build`. Running
  `pnpm typecheck` after the server build overwrites `packages/server/dist/entry-http.js` with the
  unbundled `tsc` output, so rebuild the server before assembling. The server HTTP bundle must keep
  `yauzl` external (an inlined `yauzl` crashes on load with `Dynamic require of "fs" is not
  supported`); it is declared by `@zcode/server`, and both this distribution and `build:lite` copy
  it.
- Root `pnpm typecheck`, `pnpm lint` and `pnpm architecture:check --changed` passed; lint retains
  existing repository warnings.
- Linux, Windows and macOS x64 assets are collected but their execution was not tested. WebSocket
  connectivity is checked; an authenticated model conversation and browser GUI E2E are outside this
  packaging smoke test.
- Third-party notice freshness check passed after regenerating the root package manifest hash; the
  repository still reports 14 pre-existing material-review items, so this is not a strict
  release-compliance approval.
