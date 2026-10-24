# Dev CUA Sharp Reseed Design

## Context

The CUA MCP bundle externalizes `sharp` because its native binary cannot be embedded in the JavaScript bundle,
so the plugin resolves `sharp` from its own `node_modules` at runtime.

The development cache synchronizer staged the complete Sharp runtime directly into:

```text
~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-cua/0.5.2/node_modules
```

That cache is not the durable source of truth. On desktop startup, bootstrap computes the filesystem seed from
`apps/zcode-cli/packages/zcode-cua-plugin`, removes a stale cache root, and atomically recreates it from the
seed. The source plugin's `node_modules` has no Sharp, so a restart deleted the runtime staged by `sync:cache`
and the next screenshot or zoom call failed with `Cannot find module 'sharp'`.

```text
sync:cache
  source dist/skill -> plugin cache
  desktop Sharp     -> plugin cache/node_modules       (works immediately)
                              |
                              v
desktop restart -> official filesystem reseed
  source plugin/node_modules (Sharp absent)
  rm(cache root) -> copy source -> cache                (Sharp removed)
                              |
                              v
screenshot -> loadSharp() -> MODULE_NOT_FOUND
```

The Helper source override is unrelated: logs show the Windows Helper starts from `ZCODE_CUA_DEV_ROOT` and
reports ready before the MCP image encoder fails.

## Requirements

- `ZCODE_CUA_DEV_MODE=1` desktop startup prepares the filesystem seed source before bootstrap reads it.
- The prepared source contains the same minimal, platform-specific Sharp runtime closure used by desktop
  packaging.
- A bootstrap reseed copies that runtime into the official plugin cache.
- Concurrent desktop workspace Agent startups serialize replacement of the same official plugin version. A
  waiter re-checks the seed marker after acquiring the lock instead of rebuilding an already-current cache.
- Windows `EPERM` and `EBUSY` directory replacement failures are transient replacement races, like `EEXIST`
  and `ENOTEMPTY`.
- `sharp` loads from the reseeded cache's `package.json` resolution base after an actual restart-equivalent
  seed pass.
- Startup without `ZCODE_CUA_DEV_MODE=1` does not stage CUA runtime assets.
- The implementation reuses `stageSharpIntoBundledAgents`; it does not duplicate native package lists or
  platform suffix rules.
- Works on Windows, macOS and Linux using `process.platform` and `process.arch`.
- Production/packaged seeding behavior is unchanged.

## Approaches

- **A. Prepare the filesystem seed source before dev startup (selected).** A focused dev staging script copies
  the Sharp runtime closure into `apps/zcode-cli/packages/zcode-cua-plugin/node_modules` when
  `ZCODE_CUA_DEV_MODE=1`, invoked from the desktop-agent CLI preparation path before Electron starts.
  Bootstrap then hashes and copies a self-contained source plugin exactly as for packaged plugin roots. This
  matches the production invariant (every seed source carries its own runtime), makes cache replacement safe
  and deterministic, reuses the platform-aware staging, and keeps bootstrap independent of desktop dependency
  resolution. The generated runtime lives under the ignored workspace `node_modules` tree and does not alter
  lockfiles or tracked package metadata.
- **B. Re-add Sharp to the cache after every bootstrap seed (rejected).** Bootstrap would import desktop
  packaging code or expose a one-plugin hook, coupling the standalone CLI bootstrap to desktop package layout,
  and the filesystem seed would stay incomplete.
- **C. Update the seed marker in `sync:cache` to suppress reseeding (rejected).** An untracked extra runtime
  would look current though it is not part of the seed hash; it is fragile after source changes, can retain
  stale native binaries, and hides rather than repairs the source/cache contract.

## Components

### Dev runtime staging entry

A repository-level script owns the dev-only policy:

```ts
stageDevCuaPluginRuntime({
  env,
  platform,
  arch,
  desktopPackageRoot,
  pluginRoot,
}): StagedRuntimePackage[]
```

It returns without mutation unless `env.ZCODE_CUA_DEV_MODE === "1"`. When enabled, it validates the plugin
manifest exists and delegates to `stageSharpIntoBundledAgents` with the plugin root as destination. Missing
roots or dependencies fail startup loudly rather than launching a partially functional CUA plugin.

### Desktop-agent preparation wiring

`scripts/build-desktop-agent-cli.mjs` calls the staging entry after building the desktop-agent CLI. Both
`dev:desktop:prod` and direct `@zcode/desktop dev:local-cli` pass through this script, so there is one startup
boundary to maintain.

### Bootstrap seed

The existing `runtimeTopLevelPaths: ["node_modules"]` contract copies the prepared Sharp closure and includes it
in the seed hash. Replacement of one official plugin version is guarded by a filesystem lock because desktop
startup warms multiple workspace Agent processes concurrently. The lock holder performs the seed; waiters
acquire the lock in turn, re-check the marker, and return without another replacement when the first seed is
complete.

The lock is cache infrastructure rather than CUA-specific behavior: atomic directory creation, bounded waiting,
and stale-lock takeover so a crashed process cannot block startup permanently. Existing atomic replacement
remains the commit operation, with Windows transient error classification covering `EPERM` and `EBUSY`.

## Test design

1. A dev-staging test runs the real staging entry against a temporary plugin root and asserts Sharp loads
   through `createRequire(<root>/package.json)`.
2. The same test proves staging is a no-op without `ZCODE_CUA_DEV_MODE=1`.
3. A restart-equivalent integration test prepares a filesystem plugin source, runs the real official bootstrap
   seed into a temporary storage root, and asserts Sharp loads from the resulting cache after replacement.
4. A wiring assertion locks `build-desktop-agent-cli.mjs` to the dev staging entry so direct and root desktop
   launch commands cannot bypass it.
5. A real filesystem lock test holds a version lock in one process, releases it from a second process, and
   proves the waiting seed action runs only after release. A stale lock fixture proves crash recovery.
6. Final verification: targeted tests, full `pnpm typecheck`, full `pnpm lint`, restart desktop with
   `ZCODE_CUA_DEV_MODE=1` and `ZCODE_CUA_DEV_ROOT`, and check the live cache resolves Sharp.

## Non-goals

- Changing screenshot encoding or crop behavior.
- Adding a host-level Sharp fallback such as `ZCODE_ALLOW_HOST_SHARP`.
- Persisting runtime dependencies outside the plugin seed contract.
- Changing packaged application plugin layout.
