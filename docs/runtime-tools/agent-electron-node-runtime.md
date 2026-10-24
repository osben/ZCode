# ZCode Agent runs on an existing Node + the compiled `zcode.cjs` (desktop & remote)

## Core idea

ZCode Agent used to embed a separate native binary `zcode-agent` per platform (SEA: official Node +
`zcode.cjs` + TUI resources + official plugins), about 180MB per platform, **carrying its own Node**.

But on both desktop and remote **a Node already exists** in the environment that runs the agent:

- **Desktop**: the Host runs in an Electron `utilityProcess`; `process.execPath` points to the Electron Helper, with built-in Node 24.x (Electron 41).
- **Remote SSH/WSL/Docker**: the Source Server archive ships the target Node and runs the Server CLI/Core and `zcode.cjs` with it.

So the agent need not carry another Node; it just runs the compiled `zcode.cjs` on the existing one.

Key precondition: **ZCode Agent has no native NAPI addon** - `ripgrep` is WASM/WASI and the other
dependencies (cheerio / iconv-lite / jimp / ai-sdk / mcp-sdk / zod, etc.) are pure JS. `zcode.cjs` is a
single esbuild bundle (everything inlined except `@zcode/tui`), identical across platforms; the `app-server`
command path never loads `@zcode/tui`, so remote needs only this one file with no node_modules, and desktop
does not bundle the TUI.

Benefit: ~180MB per platform becomes ~16MB; one JS artifact across platforms; one agent shape for desktop and remote.

## How it runs

**Desktop** (`zcodeAgentProcessManager.ts: resolveElectronRuntimeZCodeAgentCommand`, gated by `process.versions.electron`):

```
process.execPath  <Electron Helper>
  args: [resources/glm/zcode.cjs, app-server, --stdio]
  env:  { ELECTRON_RUN_AS_NODE: "1" }   // required, otherwise the child is treated as a Chromium child and hangs at GPU init
```

**Remote**: the full archive puts `zcode.cjs` in the immutable release's `runtime/`, and Server Core creates
the Workspace Agent per the release manifest; loose files and wrappers are no longer deployed to
`~/.zcode/server/agents/glm/`.

## Implementation

**Bundle target version** (`apps/zcode-cli/packages/cli/scripts/build.mjs`): the esbuild `target` drops from
`node26` to **`node22`**, the lowest Node version of the two runtimes (remote v22.16), so the same
`zcode.cjs` uses no syntax unsupported by either target runtime (desktop Node 24, remote Node 22).

**Desktop**

- `zcode-agent-runtime.ts`: the descriptor gains `nodeBundleEntryFile: "zcode.cjs"` + `resolveNodeBundleSegments()`.
- `providerRuntimeResolver.ts`: `findZCodeAgentRuntimeNodeBundle()` locates `resources/glm/zcode.cjs`.
- `zcodeAgentProcessManager.ts`: `resolveElectronRuntimeZCodeAgentCommand`, inserted between the monorepo dev path and the native-binary fallback.
- Packaging: `prepare:agent-bundle` (`prepare-agent-node-bundle.mjs`) builds the cli, stages `zcode.cjs` into `bundled-agents/<platform>/glm/` and deletes the old native `zcode-agent`; `prepare:runtime-assets` replaces `prepare:glm` in the local list; electron-builder copies the whole `resources/glm` directory.

**Remote**

- `pnpm --filter @zcode/server-cli exec tsx src/packaging/stageRemoteAssetsCli.ts` generates a full archive for the four platforms; `runtime/zcode.cjs` shares the same descriptor SHA identity as the Server CLI/Core.
- Desktop local download-upload and SSH remote direct download only change where the archive is obtained; both end in `zcode update --from-archive`.
- The legacy `prepare-prebuilds.mjs`, component manifest and loose-file deployment no longer enter development, CI or release.

## Verification

- `tsc -b packages/rpc packages/shared packages/services packages/server` passes; `oxlint` on changed files 0/0.
- cli rebuilt with `target node22` (dist/zcode.cjs 15.7MB).
- Smoke: `node dist/zcode.cjs app-server --stdio` starts normally on plain Node and keeps serving stdio (clean exit 0 on stdin EOF), proving the compiled artifact runs without SEA or Electron - the run shape of the remote wrapper.
- Pending: an end-to-end session verification of one real SSH remote deployment and one real desktop packaging (involves the web-remote-control deployment chain, which cannot connect to a real remote/CDN locally).

## Notes

`scripts/download-glm.mjs` (downloads the native binary) and the desktop `prepare:glm` script no longer enter
the default chain; they are kept as a manual fallback and not deleted.
