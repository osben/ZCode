# Browser Use Plugin 0.3.0 Version and Recording Asset Sync Spec

> Date: 2026-08-14
> Status: implemented and verified
> Related capabilities: `capability.browser-use-plugin-distribution`, `capability.browser-webview-video-recording`

## 1. Goal

After Browser Use gained the IAB WebView recording API, the official plugin release identity moved from
`0.2.1` to `0.3.0`. The recording protocol, Browser client, model docs and MCP serverInfo are one release
unit; package, manifest, official seed, SEA and MCP runtime must never expose different versions.

These five current-version sources must all be `0.3.0`:

1. `apps/zcode-cli/packages/browser-use-plugin/package.json`;
2. `apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json`;
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`;
4. SEA `officialSeaPlugins`;
5. MCP `NODE_REPL_SERVER_VERSION`.

The root app version, other private workspace package versions and the lockfile are outside this plugin
version boundary.

## 2. Release and cache chain

```text
package / manifest / Bootstrap / SEA / serverInfo = 0.3.0
                         |
                         v
 filesystem / SEA / Desktop / remote official assets
                         |
                         v
 seed temp -> atomic promote -> browser-use/0.3.0
                         |
                         v
 marketplace partition points only to 0.3.0
```

`0.2.1` may coexist with `0.3.0` as a stale cache, but discovery loads only the `0.3.0` that the
official partition points to, must produce no duplicate diagnostic and must not reuse an old seed
marker.

## 3. Recording document asset contract

`docs/documents.json` exposes `docs/recording.md` through the lookup name `recording`. So
`docs/recording.md` must be added to these completeness checks, not just rely on recursive directory
copy:

- Bootstrap `OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS`;
- SEA `browserUseRequiredRuntimePaths`;
- Desktop `prepare-agent-node-bundle.mjs`;
- remote `prepare-prebuilds.mjs`;
- Server `REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS`.

If the recording doc is missing, the filesystem seed, SEA build or remote asset-reuse check must fail;
it must never produce an incomplete official plugin where "the API is registered but the lookup doc does
not exist".

## 4. Cases

| Case ID | Setup | Action | Assertions | Evidence |
| --- | --- | --- | --- | --- |
| BUV-030 | five version sources | run the version alignment test | all exactly `0.3.0` | Bootstrap, SEA, MCP unit |
| BUV-031 | `0.2.1` and `0.3.0` caches coexist | discover plugins | only `0.3.0` loaded, no duplicate diagnostic | Adapter unit |
| BUV-032 | Browser Use source lacks `docs/recording.md` | filesystem/SEA seed | the completeness check rejects the incomplete asset | Bootstrap, SEA unit |
| BUV-033 | Desktop/remote runtime asset scripts | check the required-path contract | `docs/recording.md` exists on both local and remote chains | Desktop, Server unit |

## 5. Done criteria

- The five version sources and explicit version assertions are unified at `0.3.0`;
- the current-cache fixture uses `0.2.1` as stale and `0.3.0` as current;
- all five release-asset chains require `docs/recording.md`;
- targeted tests for Browser Use, Bootstrap, Adapter, SEA, Desktop and Server pass;
- `pnpm typecheck` and `pnpm lint` pass.

Verification result: Browser Use plugin 6 files / 32 tests, Bootstrap plugin distribution 2 files / 41
tests, Adapter stale/current cache 1 file / 66 tests, SEA Browser Use release/alignment 2 tests, Desktop +
Server runtime assets 2 files / 116 tests, `pnpm typecheck`, and `pnpm lint` (0 errors, existing warnings
unchanged) all passed.
