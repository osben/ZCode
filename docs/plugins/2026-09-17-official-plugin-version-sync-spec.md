# Official plugin version sync spec: node-repl-host / Browser Use 0.5.0 and Computer Use 0.6.0

> Date: 2026-09-17
> Status: implemented and verified
> Related change: Computer Use rebuilt on the node_repl SDK; the node_repl host was extracted from Browser
> Use into the standalone official plugin `@zcode/node-repl-host`.

This spec covers three packages because their version source-of-truth list changed structurally: of Browser
Use's original five sources, the fifth, `NODE_REPL_SERVER_VERSION`, moved out with the host and became
node-repl-host's own record. The earlier per-version series `docs/browser-use/*-browser-use-plugin-version-*-spec.md`
describes a single plugin and cannot express the ownership after the move.

## 1. Version decisions

| Package | Old | New | Rationale |
| --- | --- | --- | --- |
| `@zcode/browser-use-plugin` | 0.4.2 | 0.5.0 | The release unit changed: the node_repl MCP server is no longer carried by this plugin (`dist/mcp/server.js` left the seed list); only the skill, client runtime and docs remain. A composition change, not a fix, so minor. |
| `@zcode/node-repl-host` | 0.4.2 | 0.5.0 | The host contract changed: extracted from Browser Use as a standalone seed unit, tool surface adjusted with the Computer Use node_repl SDK rebuild. It inherited Browser Use's 0.4.2 on extraction and is lifted by the same minor step. |
| `zcode-cua` / `@zcode/zcode-cua-plugin` | 0.5.14 | 0.6.0 | The producer rebuild is breaking (`feat(cua)!`: tool surface, background input and observation surface), so a patch number cannot let downstream tell old and new producers apart. |

node-repl-host and Browser Use sharing the number is a coincidence of shared history, not coupling: each
bumps independently, and the comment on `NODE_REPL_SERVER_VERSION` records this.

## 2. Version sources

### 2.1 Browser Use (four, hand-maintained)

1. `apps/zcode-cli/packages/browser-use-plugin/package.json`;
2. `apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json`;
3. the `browser-use` entry in Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`;
4. the `browser-use` entry in SEA `officialSeaPlugins`.

The former fifth source `NODE_REPL_SERVER_VERSION` no longer belongs to this plugin.

### 2.2 node-repl-host (five plus one artifact, hand-maintained)

1. `apps/zcode-cli/packages/node-repl-host/package.json`;
2. `apps/zcode-cli/packages/node-repl-host/.zcode-plugin/plugin.json`;
3. the `node-repl-host` entry in Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`;
4. the `node-repl-host` entry in SEA `officialSeaPlugins`;
5. `NODE_REPL_SERVER_VERSION` in `src/tool-contract.ts`, i.e. MCP `serverInfo.version`.

`dist-types/tool-contract.d.ts` is a git-tracked declaration artifact and must be committed in sync with src.

node-repl-host is not user-facing: no skill, no marketplace listing, no icon. It must always ship embedded,
otherwise neither Browser Use nor Computer Use has a host to run on.

### 2.3 Computer Use (machine-derived, do not hand-edit)

The CUA version source of truth is `version` in the workspace package `packages/zcode-cua/package.json`
(since 2026-09 CUA lives in the monorepo; the git SHA pin, `bump-zcode-cua-producer.mjs` and `upstream.json`
were deleted, see `docs/cua/zcode-cua-monorepo-migration.md`). The records below are written back by
`check-version-coherence.mjs`; hand-editing any of them is flagged as drift by `--check`:

- producer `plugin/.zcode-plugin/plugin.json`;
- wrapper `package.json` and `.zcode-plugin/plugin.json`;
- the `computer-use` entry in Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`;
- every consumer's (desktop / services / node-repl-host / core / adapters / wrapper) dependency declaration
  on `@zcode/zcode-cua` must be `workspace:*`.

`dist/` is not in git: the version is injected into the bundle through the esbuild define
`__ZCODE_CUA_VERSION__`, so after changing the version rerun `pnpm build:cua` (root `prepare` and CI run it
after install), otherwise local dist keeps the old version.

## 3. Release and cache chain

```text
browser-use:     package / manifest / Bootstrap / SEA            = 0.5.0
node-repl-host:  package / manifest / Bootstrap / SEA / serverInfo = 0.5.0
computer-use:    workspace package -> wrapper / Bootstrap         = 0.6.0
                         |
                         v
 filesystem / SEA / Desktop / remote official assets
                         |
                         v
 seed temp -> atomic promote -> <plugin>/<version>
                         |
                         v
 the new runtime takes effect together with its version identity
```

Official cache directory names carry the version, so a bump seeds a new directory; old directories may stay
as history, but official discovery must point only to the new version.

## 4. Compatibility boundary

- No protocol change and no change to existing data shapes such as `ToolResultPayload`; only version identity and its sync points change.
- Historical version specs (`0.4.1`, `0.4.2`, ...) keep recording old facts and are not rewritten to the new version.
- The Browser Use SEA entry comment used to hardcode the then-current version; it is now version-neutral, removing one drift point (the document-skills entry comment in the same file was already neutral).

## 5. Mechanical drift checks

| Check | Coverage |
| --- | --- |
| `plugins.test.ts` "keeps every bundled plugin package, manifest, and seed version aligned" | Per official plugin, compares package / manifest / Bootstrap definition |
| `build-sea.test.mjs` "keeps SEA official plugin versions aligned with package and plugin manifests" | Per SEA entry, compares package / manifest / SEA list |
| `node-repl-host/test/mcp-server.test.ts` | Pins `serverInfo.version` == this package's `package.json.version` |
| `check-version-coherence.mjs --check` | Pins the whole CUA chain (workspace producer / producer manifest / wrapper / official definition / consumer `workspace:*`) |

## 6. Verification

Producer side: typecheck / lint / unit tests. Consumer side: `pnpm typecheck`, `pnpm lint`,
`pnpm architecture:check --changed`, affected unit tests and the CLI sub-workspace unit tests.
