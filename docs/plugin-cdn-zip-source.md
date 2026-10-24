# CDN zip plugin source install design

## 1. Goals / non-goals

### Goals

- Marketplace plugin entries can point at CDN-hosted `.zip` plugin packages and reuse the existing install loop:
  `installMarketplacePlugin` -> `cacheMarketplacePlugin` -> `resolvePluginSourceRoot` -> copy to
  `~/.zcode/cli/plugins/cache/{marketplace}/{plugin}/{version}/` -> write `installed_plugins.json`.
- Plugin entries add an explicit artifact type on the existing `{ "source": "url" }`:
  `{ "source": "url", "type": "zip", ... }`. `{ "source": "url" }` without `type` keeps legacy git clone semantics; never infer zip from a URL suffix.
- After download, verification, and extraction the resolver still returns a plain directory tree. The final install artifact stays a directory containing `.zcode-plugin/plugin.json`, `.claude-plugin/plugin.json`, or `.codex-plugin/plugin.json`; zip archives are not kept long-term.
- The download path follows the existing marketplace/git network egress policy. Git subprocesses inject explicit network env (`ZCODE_HTTP_PROXY` etc.) via `buildMarketplaceGitEnv()` and `applyNetworkEgressEnv()`; zip downloads use the same egress semantics instead of bypassing proxy config.
- Claude Marketplace Git compatibility is preserved. Phase 1 did not change `github`, `git`, `url`, `git-subdir`; the follow-up [public GitHub no-Git install spec](./plugin-github-archive-source.md) routed anonymously readable GitHub HTTPS sources to the same safe ZIP materializer, while other sources still use system Git. `npm` / `pip` remain diagnose-only paths.

### Non-goals

- Phase 1 does not support marketplace-as-zip. A marketplace source `"url"` still means an HTTP fetch of `marketplace.json` — a different axis from the plugin entry source.
- No package-manager installation inside zips (`npm install` / `pip install`).
- No changes to plugin runtime, enable state, or MCP/hook security policy; no business state sinks into the Electron main process, relay, or web remote links.
- No auto-update daemon; only the pin-reading used by the existing overview/update detection was extended.
- No new cache layout; zip files are never a long-term cache key or install artifact.

## 2. Source schema

Plugin entry URL artifact type:

```json
{
  "name": "cdn-plugin",
  "version": "1.2.3",
  "description": "Install from CDN zip",
  "source": {
    "source": "url",
    "type": "zip",
    "url": "https://cdn.example.com/zcode/plugins/cdn-plugin-1.2.3.zip",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "path": "packages/cdn-plugin",
    "stripRoot": true
  }
}
```

Field semantics:

| Field       | Semantics                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`    | Fixed `"url"` — this is the plugin entry source, not the marketplace source.                                                                                                                            |
| `type`      | Required `"zip"` for zip artifacts. Missing or `"git"` keeps legacy git clone. Unknown values diagnose/error, never fall back.                                                                          |
| `url`       | Required; remote CDN must be `https://`. Local test/fixture use allows loopback HTTP (`localhost` / `127.0.0.1` / `::1`).                                                                               |
| `sha256`    | Required for zip sources, 64 lowercase hex. The digest is verified before extraction is allowed.                                                                                                        |
| `path`      | Optional plugin subdirectory inside the zip, matching git source `path` semantics: extract safely to a temp root, then `resolveInside(path)` within it.                                                 |
| `headers`   | Optional, plain string headers only; sensitive headers such as `Authorization` and `Cookie` are forbidden in marketplace JSON. Phase 1 targets public CDNs and writes no credentials into marketplaces. |
| `stripRoot` | Optional boolean. `true` strips the single safe top-level directory when all entries share one; recommended default `true`, with a defined priority versus `path`.                                      |

Why `{ "source": "url", "url": "https://...zip" }` without `type` is not accepted:

- A plugin entry `{source:"url"}` reaches `resolveGitPluginSource()` inside `resolvePluginSourceRoot()` and clones `source.url`.
- A marketplace source `{source:"url"}` in `loadMarketplaceFromSource()` fetches `source.url` and parses JSON. The two `"url"` meanings live at different layers; overloading them further would break Claude marketplace compatibility.
- So zip must be written explicitly as `{source:"url", type:"zip"}`. Type is never guessed from the `.zip` suffix, because CDN signed URLs and suffix-less artifact URLs are both common.

### Marketplace URL filename and JSON contract

- The marketplace URL's filename plays no part in type detection. `marketplace.json`, `index.json`, or an extension-less URL all download and parse through the existing marketplace URL fetch path.
- The response keeps the existing marketplace manifest format with a valid top-level `name` and `plugins`; extension fields like `description`, `owner`, `description_i18n` stay in the raw manifest under the existing lenient parsing rules.
- No `{ "marketplace": { "name": "..." }, "plugins": [...] }` envelope compatibility. CDN publishers must emit the existing format so clients never maintain two synonymous schemas.
- A plugin artifact's zip filename is likewise irrelevant; the client dispatches only on the entry's `{ "source": "url", "type": "zip" }` and verifies content with `sha256`.

The official CDN marketplace can be used directly:

```json
{
  "name": "zcode-plugins-official",
  "description": "Official ZCode plugins marketplace",
  "plugins": [
    {
      "name": "example-plugin",
      "version": "0.1.1",
      "source": {
        "source": "url",
        "type": "zip",
        "url": "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/example-plugin/0.1.1/plugin.zip",
        "sha256": "5e93c44a9a3c292d6c59688d76874d9035ff740486390612c5daf13566d4049b",
        "path": "example-plugin"
      }
    }
  ]
}
```

Entry URL: `https://cdn-zcode.z.ai/zcode/official-plugin/index.json`. Versions and digests in examples are publish-time snapshots; client smoke tests should read the live version from the overview instead of hardcoding.

## 3. Install pipeline

Facts of the current chain:

- `installMarketplacePlugin()` ensures the marketplace manifest, then resolves the dependency closure.
- Each entry reaches `cacheMarketplacePlugin()`, which calls `resolvePluginSourceRoot()` for `{ path, cleanup? }`, reads the plugin root's manifest version, computes the cache directory, `rm target` + `cp` from the source root, and writes the install record.
- `validateMarketplacePlugin()`, `describeMarketplacePlugin()`, and marketplace source validate also call `resolvePluginSourceRoot()`, so the zip resolver must honor the temp-directory + cleanup contract, not just serve installs.

Zip dispatch inside `resolvePluginSourceRoot()` for `sourceKind === "url"`:

- A missing, non-string, or empty `url` errors immediately; field errors on an explicit object source never fall through to the `localByName` fallback.
- `type` missing or `"git"`: existing `resolveGitPluginSource()`.
- `type === "zip"`: `resolveZipPluginSource({ url, sha256, path, headers, stripRoot, signal })`.
- Any other `type`: unsupported/invalid source error.

`resolveZipPluginSource()` steps:

1. Create a temp directory (`mkdtemp(join(tmpdir(), "zcode-plugin-zip-"))`).
2. Download to a temp file using the marketplace operation's AbortSignal, the `ZCODE_HTTP_PROXY` / `ZCODE_HTTPS_PROXY` / `ZCODE_NO_PROXY` / CA egress config, and an accumulated-bytes cap that aborts and removes the temp directory on overflow.
3. Compute SHA-256 of the download: with an entry `sha256`, digests must match exactly; if policy ever allows a missing `sha256`, the digest is still computed but used only for logs/diagnostics/update pin.
4. Safely extract to a temp extract root:
   - per-entry path checks rejecting absolute paths, `..`, backslashes, Windows drives, empty and NUL paths;
   - rejecting symlinks, devices, sockets, and other non-plain files/directories;
   - per-entry accounting of uncompressed bytes, file/directory counts, and single-file size, failing over the limits.
5. Locate the plugin root:
   - with `path`: `resolveInside(extractRoot, path)`, directory must exist;
   - else with `stripRoot === true` (or default single-root detection): the shared single top-level directory;
   - else `extractRoot`.
     The root then goes through `validatePluginRoot()` / `resolveInstalledPluginVersion()` and must contain a valid plugin manifest, except entries with `strict:false` following the existing synthetic manifest rules.
6. Return `{ path: pluginRoot, cleanup }`. Cleanup retries finitely; failure paths keep the original download/verify/extract error and attach the cleanup failure as an extra diagnostic.
7. `cacheMarketplacePlugin()` copies the plain directory to `~/.zcode/cli/plugins/cache/{marketplace}/{plugin}/{version}/` as today. Post-copy source cleanup is best-effort and must not block the install record or `saveInstalledPlugins()`, avoiding a cache/`installed_plugins.json` split. `ensureMarketplaceEntryManifest()`, the install-record `source` write-back, and `saveInstalledPlugins()` are unchanged; the record keeps the full zip source object so later `sha256` update-pin comparisons work.

## 4. Security requirements

### HTTPS

- Remote CDNs are `https://` only; `http://` is allowed only for loopback hosts (`localhost`, `127.0.0.1`, `::1`) in local fixtures and dev verification.
- URLs must parse with `new URL()`; `file://`, `data:`, `blob:`, `ftp:` are forbidden.
- The final URL after redirects must also be `https://`; redirect count is capped.

### Headers

- `headers` accepts plain string key/values only.
- Sensitive headers are rejected by default: `authorization`, `cookie`, `proxy-authorization`, `set-cookie`.
- Custom `headers` survive a redirect only when the target shares the origin of the current URL; a cross-origin redirect must drop all custom headers — do not rely on the sensitive-header denylist to prevent leakage.
- Phase 1 targets public CDNs. Private CDNs need a credential-store integration designed first; tokens never go into marketplace JSON.

### Network egress

- ZIP downloads use the adapters web-fetch egress semantics: explicit `ZCODE_HTTP_PROXY` / `ZCODE_NO_PROXY` first, falling back to the user `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` sealed inside `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`.
- Never use a default HTTP resolver that only knows explicit ZCode proxies — after the agent scrubs standard proxy variables, git sources would install while zip sources would attempt a direct connection.
- CA, timeout, download size limits, and the AbortSignal stay in the shared HTTP adapter, not re-implemented in the plugin layer.
- Git clone uses `execGitCommand()` with env from `buildMarketplaceGitEnv()` -> `sanitizeZCodeRuntimeEnv()` -> `applyNetworkEgressEnv()`. Zip download does not run a git subprocess and cannot inherit that env naturally; it goes through the shared egress helper / fetch dispatcher so HTTP zip downloads match the marketplace/git network policy. `@zcode/adapters` already depends on `proxy-agent` for building the Node fetch dispatcher.

### Integrity

- `sha256` is the security default and required: 64-hex, lowercased before comparison.
- A missing `sha256` blocks install; validate returns an explicit diagnostic saying the manifest must provide `sha256`.
- Verification happens before extraction. On digest mismatch: no extraction, no cache write, no install record.
- Download, verify, and extract failures clean the temp directory. Temp cleanup retries finitely; if it ultimately fails, the original business error stays primary, and a successful install is never rolled back or skipped because of cleanup.
- `yauzl` is declared as an explicit dependency of `@zcode/adapters` (the repo already uses it in desktop/services, but cross-package implicit use is not allowed).

### Zip slip / unsafe entries

- Entry path normalization follows the approach of `packages/services/src/skill-sync/skillSyncPath.ts`: reject absolute paths, `..`, backslashes, Windows drives, and empty segments, then re-check with `relative(targetRoot, targetPath)` that the target stays inside the extract root.
- Never trust the library's path string alone; do own containment before writing files.
- Directory and file entries are handled separately. Symlinks and special files are rejected; where the library cannot reliably expose external attrs, the conservative policy writes only plain file and directory entries and fails everything else.

### Size limits

Constants live in the adapters plugin zip helper:

```ts
const ZIP_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const ZIP_EXTRACT_MAX_BYTES = 250 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 20_000;
const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
```

Defaults are product-tunable, but all five must exist: compressed download cap, uncompressed cap, entry-count cap, single-file cap, temp-directory cleanup.

## 5. Update detection

Current facts:

- `apps/zcode-cli/packages/bootstrap/src/plugins.ts` builds `latestPinByPluginId` from `entry.version` and the source pin (`readPluginSourceSha()`, now `readPluginSourceIdentityPin()`).
- `comparePluginUpdate()` priority: latest version present -> semver/version compare; else latest sha present -> sha identity compare; else `none`.

Zip semantics:

- Version stays primary: an entry with `version` updates on the version axis.
- Without `version` but with zip `sha256`, the `sha256` is the content integrity pin and update identity.
- To avoid conflating git commit shas with zip sha256, the pin helper returns a kind:

```ts
readPluginSourcePin(source): { kind: "git-sha" | "zip-sha256"; value: string } | undefined
```

The shipped helper is `readPluginSourceIdentityPin()`; `readPluginSourceSha()` remains as a wrapper. Git sources return `sha` / `commit`; zip sources return `sha256`.

Install records: `cacheMarketplacePlugin()` writes `input.entry.source` verbatim into `InstalledPluginRecord.source`, so zip installs keep `source.sha256` for the next overview comparison. No new persisted field records the downloaded digest; an entry without `sha256` provides no update pin and relies on `version` only.

## 6. Test plan

### Unit: source parsing / validation

- Valid zip shape: `source:"url"`, `type:"zip"`, HTTPS or loopback HTTP url, valid sha256, optional `path`, optional `stripRoot`.
- Invalid: missing url; non-loopback `http://`; `file://`; sha256 not 64 hex; headers not an object; sensitive headers; `path` containing `..` / Windows drive / backslash.
- Marketplace-level validate returns `plugin_validation_deferred` for remote zip sources instead of batch-downloading.

### Unit: download / integrity

- sha256 match proceeds; mismatch errors, cleans the temp directory, writes no cache or installed record.
- Compressed-limit overflow aborts; AbortSignal mid-download cleans up.
- Cleanup failure: failure paths keep the original error plus a cleanup diagnostic; with the cache already copied, the installed record is still written.
- Proxy: with the user `HTTP_PROXY` only inside `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` and no `ZCODE_HTTP_PROXY`, the ZIP request still goes through the local proxy; tests never touch the public network.
- Redirects: reject non-HTTPS/non-loopback targets; cross-origin redirects drop custom `headers`; same-origin keeps ordinary headers.

### Unit: safe extract fixtures

- Normal zip with `.claude-plugin/plugin.json` at the root.
- Single top-level directory zip installs via default root detection/`stripRoot:true`.
- Subdirectory zip installs with `path`.
- Zip slip variants: `../escape.txt`, `/absolute.txt`, `C:\escape.txt`, `nested/../../escape.txt`, backslash paths.
- Special entries: symlink; device/socket/unknown type; mixed directory/file.
- Limits: entry count, extracted bytes, single file.

### Unit: install/cache behavior

- After installing a zip source the cache path is still `cache/{marketplace}/{plugin}/{version}/`.
- The install record `source` keeps `{source:"url", type:"zip", url, sha256, ...}`.
- Plugin manifest version still wins over the marketplace entry version.
- `describeMarketplacePlugin()` can temporarily download/extract/enumerate an uninstalled zip plugin and clean up; `validateMarketplacePlugin()` deep-scans the root.

### Unit: update detection

- Entry with `version` and `sha256`: version axis wins; sha256 change with same version -> `none`.
- Entry without `version`, installed/source sha256 differing from latest -> `update-available`.
- Latest with sha256, installed without -> `version-changed`.
- Neither version nor sha256 -> `none` or a warning, per the fixed product decision.
- Existing git `sha` / `commit` tests keep passing (Claude official git path intact).

### Desktop E2E: startup seed + service install + discover

- Pending manual-review spec: `packages/desktop/test/e2e/plugins/manual-review/pending/plugin-cdn-zip-marketplace-install.test.ts`.
- WDIO `beforeSession` starts a loopback zip fixture server before Electron launches and seeds the zip marketplace into `<E2E_HOME>/.zcode/cli/plugins/known_marketplaces.json` and `<E2E_HOME>/.zcode/cli/plugins/marketplaces/{marketplace}/marketplace.json`.
- The spec calls the real `zcodeAgentService.installPlugin()` via renderer `window.__testActions`, covering desktop renderer -> services -> agent protocol -> bootstrap -> adapters.
- Asserts: seeded marketplace and zip plugin visible in overview before install; `cache/{marketplace}/{plugin}/{version}` materialized after; `installed_plugins.json` keeps `{source:"url", type:"zip", url, sha256}`; `config.json#plugins.enabledPlugins[id] === true`; `listPlugins()` discovers command/skill components.

### Desktop E2E: official CDN smoke

- Pending manual-review spec: `packages/desktop/test/e2e/plugins/manual-review/pending/plugin-cdn-zip-official-cdn-smoke.test.ts`.
- Both cases verify plugin installation only — no conversation/session state machine — so they live in the plugin directory, not the conversation case catalog or coverage matrix.
- Adds the official `index.json` via the real `addPluginMarketplace()`, then real `installPlugin()` and `listPlugins()`.
- Versions are read dynamically from the post-add overview, never hardcoded to a CDN release; a successful install proves both manifest parseability and `sha256` agreement with the download.
- Asserts cache, `installed_plugins.json`, enabled config, and command/skill discovery.
- Depends on the public network and current official CDN content: manual smoke only, excluded from offline replay/CI suites; deterministic CI coverage is the loopback seed case.

### Fixture strategy

- Test zips are created dynamically by test helpers; no external CDN dependency.
- Production helpers never depend on test-only APIs; all zip fixtures behave identically across macOS/Linux/Windows path semantics.

## 7. Rollout phases

### Phase 1 (shipped)

- Plugin entry `{source:"url", type:"zip"}`; remote HTTPS only, loopback HTTP for fixtures; `sha256` required; safe download, digest verification, safe extraction, root locate; reuse of `resolvePluginSourceRoot()` -> `cacheMarketplacePlugin()`; `docs/claude-code-marketplace-plugin-compat.md` source matrix updated; unit coverage of install, validate, describe, update detection, zip slip, and limits; no marketplace-as-zip, no runtime or UI business-semantics changes.

### Phase 2 open items

- Private CDN credentials: headers move out of marketplace JSON into a credential store or marketplace trust policy.
- Finer trust policy: official/enterprise marketplaces configurable on allowing missing `sha256` and which CDN hosts are allowed.
- Content-addressed temp download cache reusing the same `{url, sha256}` short-term, still materializing into the existing cache directory.
- Marketplace-as-zip needs its own spec — a separate axis, not to be conflated with plugin zip sources.
- Zip or manifest signature verification.
- UI display of integrity state, digest mismatch diagnostics, and download size.
- Network proxy integration e2e covering enterprise proxies and self-signed CAs.

## 8. Open questions / decisions

1. Is `sha256` hard-required? Decision: required by default; third-party marketplaces must provide it, official/dev fixtures may warn. Hard requirement is safest but blocks URL-only ad-hoc marketplaces.
2. `stripRoot` default? Decision: auto-detect and use the single top-level directory; explicit `stripRoot:false` uses the extract root. Most GitHub release zips have one top-level directory, so the default reduces manifest authoring.
3. `headers` in Phase 1? Decision: support non-sensitive public headers, reject sensitive ones. CDN cache/control headers work without opening a plaintext-token path.
4. Update detection without `sha256`? Decision: no identity pin, `version` only; with neither, show “no comparable update”. Avoids writing the downloaded digest into installed records (schema migration).
5. Multiple plugin manifests in one zip root? Decision: without `path`, accept only one plugin root at the extract root or under a single top-level directory; multiple candidates error and require an entry `path`. Avoids installing the wrong plugin.
6. `http://localhost` test sources? Decision: loopback HTTP allowed to exercise the real URL download path; non-loopback HTTP stays forbidden.

## 9. Boundaries that must not change

- No Electron main process / relay business state; no web remote task/session realtime semantics.
- No changes to the plugin cache layout or how the runtime loader reads install artifacts.
- UI only naturally renders existing install/diagnostic results.
