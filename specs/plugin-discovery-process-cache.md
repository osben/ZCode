# Plugin discovery per-process cache

Status: Tier 1 in review as draft PR osben/ZCode#273 (2026-10-21); Tier 2 and the Host ordering fix
are proposed, not implemented.

## Problem

Cold session opens and warm workspace switches in ZCode Desktop wait behind synchronous plugin
discovery in the CLI:

- `workspace/readPresentation` → `listProtocolSlashCommands` → `listZCodeCustomCommands` →
  `createCustomCommandDiscovery` → `resolveZCodePlugins` runs on every call. It is fully
  synchronous and runs on the CLI's serial request queue (`zcode-protocol/transport.ts`).
  `runtime/capabilities` and the session subscribe sent after it wait until it finishes.
- Session runtime creation (`createZCodeApp`, stage `resolve_plugins`) runs the same discovery
  through `resolveStartupPlugins`, and then the runtime's skills discovery scans the resulting
  skill roots. Measurement shows one plugin discovery per resume, not two.

## Where the time goes (measured, 2026-10-21)

The time goes into seeding the official plugins, not into discovery itself.

CPU profile of 30 × `resolveZCodePlugins` on `/Users/osben/Dev/ZCode` (28 plugins, 19 enabled,
cloned plugin storage, built dist):

| Part                                                                                         | ms/call | share |
| -------------------------------------------------------------------------------------------- | ------: | ----: |
| `resolveFilesystemSeedSource`: walk, `readFileSync` and SHA-256 of every bundled plugin file |     ~56 |   67% |
| Rest of seeding: seed lock mkdir/rm, marker read, runtime-manifest and marketplace writes    |      ~8 |   10% |
| `discoverPluginsSync` (manifests, components, skill frontmatter, hooks, MCP)                 |     ~18 |   22% |
| `createConfig`                                                                               |    ~0.3 |     — |

Production uses the same code path. The packaged app runs `Resources/glm/zcode.cjs` with Electron
as Node, not as a SEA binary. The bundled plugins sit beside it in `Resources/glm/packages/*`, so
`resolveSeedSource()` takes the filesystem branch. The packaged set is 716 files / 63 MB:

- read + hash costs 47 ms with a warm page cache and 117 ms with a cold one;
- walk + `stat` of the same files costs 5 ms.

The seed source is the set of bundled plugin files that ship with the running build. That set
does not change while the process runs, but the CLI rebuilds its hash list from the file bytes on
every discovery call.

## Decision

Implement **Tier 1** (below). Specify **Tier 2** and defer it. The reason for deferring is that
Tier 1 removes most of the cost with only the narrow staleness edge described below, while Tier 2 would save only the remaining
~25 ms per call and adds staleness windows that a shared `~/.zcode` makes hard to close.

### Tier 1: stat-validated seed-file hash memo (implemented in prototype)

- **Owner:** `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`. A module-level,
  per-process map is used only by `collectFilesystemPluginFiles`, and nothing else reads or
  writes it. The memo is inline in this upstream-synced file, a fork delta of about 30 lines,
  because `apps/zcode-cli` is `managed: false` in `architecture-policy.yaml`. The pre-push
  `architecture:check` rejects new source files in unmanaged modules (rule `unmanaged-new-file`,
  `scripts/architecture/violations.mjs`), and it did reject a sibling
  `official-plugin-seed-hash-memo.ts`. The file was already over the 20 KB staged-size cap, so it is listed in
  `.staged-file-size-exemptions` instead of being split.
- **Key:** the absolute source file path.
- **Validator:** the file's exact `stat` signature, taken with `statSync(path, { bigint: true })`:
  `size`, `mtimeNs`, `ctimeNs`, `ino`. The values are nanosecond integers, not rounded ms doubles.
  - On POSIX filesystems `ctime` cannot be set from user space (`utimes` does not change it), so a
    content edit that keeps size and mtime (`cp -p`, `rsync -t`) still changes ctime. This is
    verified on macOS APFS by a test that pins mtime to a whole second.
  - An atomic replace changes `ino`.
  - Windows (NTFS change time, synthesized `ino`) and network filesystems (NFS, SMB) are
    **unverified**. They may report coarser or cached timestamps.
- **Value:** the file's SHA-256.
- **Read path:** each call still walks the source tree and `stat`s every included file, so added
  and removed files are seen on every call. The file is read and hashed only when its signature
  differs from the memo entry. After each walk of a plugin root, memo entries under that root
  that were not visited are pruned, so deleted files do not accumulate.
- **Unchanged:** the seed lock, `isSeedCurrent`, the copy into the cache, the hash check of copied
  bytes (`readSeedFileBytes` + `hashBytes` while copying), the runtime-manifest refresh and the
  marketplace partition write all still run on every call. The official cache lives in shared
  `~/.zcode` storage that other processes also write (other workspace agents, and the upstream
  build), and these steps keep healing it on every call as they do today.
- **Invalidation:**
  - Implicit: any signature change re-hashes that file.
  - Explicit, one case: when copying into the cache, the existing check of the copied bytes throws
    `Bundled plugin asset hash mismatch`. Before that throw, every memo entry for that plugin's
    source files is now dropped. That discovery call fails, as it did before this change. The
    next call re-hashes from bytes and recovers.
- **What may go stale:** a same-size, in-place edit within one timestamp tick that leaves size,
  mtime, ctime and inode all unchanged. This needs a coarse-timestamp filesystem (HFS+ 1 s, FAT
  2 s, some NFS/SMB mounts) or one with ctime updates disabled.
  - Such an edit keeps the old hash. If nothing else changes, the seed marker still matches and
    the cached copy keeps the old bytes until any later stat change re-hashes the file, or until
    the process restarts. Before this change, the next discovery call would have re-seeded.
  - If another change forces a re-seed, the copy-time hash check catches the mismatch. That call
    fails once, and the self-heal above makes the next call correct.
  - Bundled plugin sources change only in dev checkouts and app updates (new paths/inodes), so
    production exposure is minimal.
  - The SEA branch is not affected; it already uses precomputed hashes.
- **Race:** the file is `stat`ed before it is read. If it changes between the two, the memo stores
  the new hash under the old signature. The next call sees a different signature and hashes again,
  so the error is always toward re-hashing.

### Tier 2: full discovery-outcome cache (specified, deferred)

This is what a cache of the whole `PluginLoadOutcome` would need.

- **Owner:** one per-process cache in bootstrap. `resolveZCodePlugins` and
  `resolveStartupPlugins` would read through it. They share the discovery inputs, but
  `resolveStartupPlugins` also applies incognito and the visualize filter, so the cached outcome
  would have to be treated as immutable and copied before those filters mutate `skillRoots`.
- **Key:**
  - `pluginStorageRoot`
  - `workingDirectory`
  - a canonical hash of the resolved `configResult.config.plugins`. This covers edits to the user
    config, the project config and env made by any process, because `createConfig` re-reads the
    files on every call (~0.3 ms).
  - `officialPluginRoots` extras
  - the env inputs that discovery reads: the CUA feature flag and the template-expansion env
  - `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`
  - `dynamicWorkflowEnabled` is **not** needed here. It filters the slash-command catalog after
    discovery, and the custom-command scan stays live.
- **Invalidation it would need:**
  1. CLI plugin operations (install, uninstall, update, enable/disable, configure, reset,
     restore-builtin, marketplace add/remove/update) bump an in-process generation counter.
  2. Changes from another process: before each hit, compare the `stat` signatures of
     `installed_plugins.json` and `known_marketplaces.json`, plus the directory signature of
     `cache/zcode-plugins-official/*`.
  3. External edits inside plugin roots (`config.plugins.dirs` inline plugins under development,
     hand edits to installed roots) need a signature per plugin root for `plugin.json`,
     `hooks/hooks.json`, `.mcp.json`, `.lsp.json` and the component directories.
- **What it still could not see:**
  - Nested edits: a new `SKILL.md` two levels down, a changed command file under a nested
    directory. Command and skill _contents_ stay live, because their adapters re-scan the roots.
    But `skillCount` and the component lists in plugin metadata would go stale.
  - Re-seeding by another build into the shared official cache. A cache hit skips the seed and
    runtime-manifest refresh, so the self-healing that runs on every call today would be lost
    until the next miss.
- **Gain over Tier 1:** about 18–25 ms per discovery call.

**Not cached in either tier:**

- the `.zcode/commands`, skills and agents directory scans;
- `createConfig`.

These stay live on every call, so edits made outside the CLI to workspace commands, skills and
plugin dirs show up exactly as they do today.

## Measured effect of Tier 1 (stdio A/B, 2026-10-21)

**Setup:**

- Each run starts a fresh CLI bundle (`zcode.cjs app-server --stdio --surface desktop`, Node
  26.11.1, `ZCODE_RUNTIME_ENV=production`) with the workspace `/Users/osben/Dev/ZCode` as cwd.
- Bundled plugin sources are staged beside the bundle, as in the packaged app.
- Writes are isolated: plugin storage, session DB and logs are clones in a scratch directory.
  The user config is read as-is.
- Per run, the harness:
  1. syncs the workflow policy;
  2. sends `readPresentation` with `runtime/capabilities` queued right behind it;
  3. sends five more `readPresentation`s;
  4. opens three sessions via `v4/conversation/subscribe` (`historyFirst`) and reads
     `resolve_plugins` from the startup log.
- Variants alternate, 8 runs each. A first batch of 6 runs each agreed with these numbers.

| Metric                                     | Before median (range) | After median (range) |
| ------------------------------------------ | --------------------: | -------------------: |
| readPresentation #1 on a fresh CLI         |       113.5 (109–196) |      117.2 (104–389) |
| `runtime/capabilities` queued behind #1    |       113.5 (109–196) |      117.2 (104–389) |
| readPresentation, repeated (n=40)          |         98.3 (90–731) |        47.5 (39–112) |
| `resolve_plugins` on session resume (n=24) |         80.0 (68–220) |         26.5 (23–59) |
| `runtime/capabilities`, empty queue        |                   0.4 |                  0.4 |

What the numbers show:

- Repeated readPresentation, the warm-switch case, is about 2× faster.
- `resolve_plugins` is about 3× faster.
- The first readPresentation of a fresh process is unchanged. It fills the memo, so the
  `runtime/capabilities` request queued behind it still waits about 115 ms.

**Worth it?** Yes. The change is about 35 lines in one file. Invalidation is implicit by stat,
with one explicit self-heal on a hash mismatch. It removes 50–55 ms from every discovery call
after the first.

It does not fix the fresh-client wait, because the first discovery call of a process still pays
the cold hash. The ordering fix covers that case (measured below). Tier 1b is the alternative, not
proposed: persist the stat→hash memo across processes in a `fork_`-prefixed sidecar next to the
plugin storage, so a new process can skip the cold hash. It is held back because it adds a
cross-process file format.

## Cold (cache-miss) breakdown and option ranking (2026-10-21)

The cold call is the first discovery in a fresh process. Tier 1 does not change it.

**Method:** a fresh Node process imports the built modules, then makes one call under the
in-process V8 profiler (50 µs sampling). Only samples inside bootstrap/adapters code are counted;
the `Profiler.start` overhead is excluded. The workspace is `/Users/osben/Dev/ZCode` with cloned
plugin storage, 3 runs per scenario. A separate preload counted fs calls on a fresh CLI.

**readPresentation, cold** (in-discovery ≈ 98 ms; wall ≈ 185–205 ms including first-call
warm-up):

| Area                                        |  ms | Composition                         |
| ------------------------------------------- | --: | ----------------------------------- |
| seed: read + SHA-256 of bundled files       |  44 | ~21 syscalls + ~21 SHA-256 CPU      |
| seed: lock, marker, runtime-manifest writes |   8 | mostly syscalls                     |
| seed: walk                                  |   6 | syscalls                            |
| discovery: load/components                  |  10 | ~4.5 syscalls, ~3 JS, ~1 parsing    |
| discovery: metadata enumeration             |   9 | ~5 syscalls, ~2 frontmatter parsing |
| createConfig                                |   4 | ~2.7 JSON/zod parsing               |
| custom commands scan                        | 0.5 |                                     |
| other JS / first-call warm-up               | ~13 |                                     |

By type, the totals are: syscalls ≈ 45 ms, SHA-256 ≈ 21 ms, parsing ≈ 5–8 ms, other JS ≈ 19 ms.

**fs calls per readPresentation** (fresh CLI):

- **Cold:** 6,200 calls in total:
  - 1,554 `statSync`, 1,152 `readFileSync`, 807 open/read/close for hashing;
  - 516 `lstatSync`, 308 `readdirSync`;
  - 130 `SKILL.md` reads.
- **Warm, with Tier 1:** 3,088 calls. The 807 open/read/close for hashing are gone. 107 `SKILL.md`
  reads remain, from plugin metadata enumeration. readPresentation does not need them; it only
  needs `commandRoots`.

**Resume, cold:**

- createConfig is 4.5 ms.
- `resolve_plugins` is 93–100 ms: the same split as above, plus about 3 ms more parsing.
- Skills discovery is 24–42 ms of wall time but only ~4 ms of CPU. The rest is awaiting the
  libuv threadpool across ~156 skill files one at a time. It is asynchronous, so it does not
  block the request queue, but it delays runtime readiness.

**Duplicate scans within one request:** none found. One readPresentation and one resume each walk
the seed source once and read `installed_plugins.json` once. The repeated work is _across_
requests: readPresentation, then resume, then the next readPresentation each redo the same
discovery for the same workspace.

**Option ranking:**

| Option                                                                                | readPresentation                | Cold resume                                                             | Staleness / regression risk                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Tier 1 stat-validated hash memo (this branch)                                     | warm 98 → 48 ms; cold unchanged | `resolve_plugins` 80 → 27 ms after any earlier discovery in the process | Only a same-tick, unchanged-stat edit on coarse-timestamp filesystems (self-heals on a hash mismatch). Every file is still stat-ed; seeding still runs every call.                          |
| (a') Tier 2 outcome cache                                                             | ~−25 ms more                    | ~−25 ms more                                                            | Nested plugin edits and re-seeds by another build go stale; needs a generation counter plus file signatures.                                                                                |
| (b) Remove duplicate scans within a call                                              | 0                               | 0                                                                       | Nothing to remove.                                                                                                                                                                          |
| (c1) Skip metadata enumeration when only `commandRoots` are needed (readPresentation) | −~9 ms                          | 0 (resume consumers read plugin metadata)                               | Low, but adds a second shape of `PluginLoadOutcome`.                                                                                                                                        |
| (c2) Read skill files in parallel during skills discovery, keeping order              | 0                               | skills 24–42 → ~10 ms wall (estimate)                                   | Low; priority order must be kept when merging.                                                                                                                                              |
| (c3) Build-time seed hash manifest for packaged builds (like SEA)                     | cold −~44 ms                    | cold −~44 ms                                                            | Medium. Codesigning or notarization rewrites native binaries after staging, so a stale manifest would fail the copy-time hash check and degrade seeding. Needs a packaging-pipeline change. |
| (c4) Tier 1b: persist the stat→hash memo in a `fork_` sidecar                         | cold −~40 ms                    | cold −~40 ms                                                            | Low to medium; adds a cross-process file format.                                                                                                                                            |
| (d) Rust/native discovery                                                             | —                               | —                                                                       | Not justified. Parsing CPU is 5–8 ms of ~100 ms. The syscall count would stay the same. SHA-256 already runs in native OpenSSL.                                                             |

**Recommendation:**

- Ship (a) together with the Host ordering fix below. The ordering fix moves the one remaining cold
  hash off the first-subscribe path.
- (c1) and (c2) are small optional follow-ups.
- Revisit (c4) only if fresh-process latency still matters after the ordering fix.

## Alternatives considered

### 1. Ordering fix: defer readPresentation behind the first subscribe (measured)

On a fresh client, send the first `v4/conversation/subscribe` (`historyFirst`) before the first
`workspace/readPresentation`, still after the workflow-policy sync. The CLI is unchanged; this is
a Host ordering change.

```text
current (fresh CLI, serial queue)                 reordered
Host        CLI queue                             Host        CLI queue
policy ───▶ policy sync                           policy ───▶ policy sync
readPres ─▶ readPresentation [cold hash here]     subscribe ▶ subscribe ack (history)
caps ─────▶   ...waits                            caps ─────▶ capabilities (9 ms)
subscribe ▶   ...waits → ack                                  runtime creation [cold hash here]
              runtime creation (warm memo)        readPres ─▶   ...waits → readPresentation (warm)
```

Stdio A/B, fresh CLI, one session, 6 runs per cell. All times are medians in ms, counted from the
end of the policy sync:

| Build       | Order     | capabilities | subscribe ack | runtime ready (mode switch) | slash commands ready |
| ----------- | --------- | -----------: | ------------: | --------------------------: | -------------------: |
| baseline    | current   |           95 |           104 |                         172 |                   95 |
| baseline    | reordered |            9 |             9 |                          91 |                  186 |
| Tier 1 memo | current   |          101 |           111 |                         139 |                  101 |
| Tier 1 memo | reordered |            9 |             9 |                          92 |                  141 |

What the table shows:

- Reordering moves the cold hash onto runtime creation (`resolve_plugins` 68 ms) and still has
  the runtime ready about 47 ms sooner than the current order with the memo.
- Capabilities and the history ack become immediate.
- Slash commands arrive later, because readPresentation now queues behind the synchronous runtime
  creation. The memo keeps that cost at 141 ms instead of 186 ms.
- Neither change regresses anything that is visible before history.

**Recommendation:** do both.

- The ordering fix is the bigger win for opening a fresh client.
- Tier 1 is the win for warm workspace switches, every later session runtime creation, and the
  readPresentation that follows the reordered subscribe.

### 2. Do nothing

Every readPresentation and every runtime creation keeps paying 47–117 ms of hashing in production
(warm vs cold page cache), and on a fresh client the mode switch stays about 80 ms later than it
needs to be.

## Acceptance scenarios (Tier 1)

Memo invalidation (`bootstrap/tests/bundled-plugins-hash-memo.test.ts`):

- With unchanged source files, a second `resolveOfficialPluginRoots` call reads none of the seed
  source files except `plugin.json`, which the marketplace description and runtime manifest
  re-read on purpose. Every included file is still `stat`ed.
- When a source file's content changes (new size or mtime), the next call re-hashes it. The seed
  marker no longer matches, and the cache is re-seeded with the new bytes.
- A same-size edit with mtime pinned to the same whole second is detected through ctime. The test
  fails if ctime is removed from the signature.
- After a hash mismatch caused by an edit the stat signature missed (simulated with a frozen
  stat), that call fails and the next call re-seeds the new bytes. The test fails without the
  self-heal.
- A file added under an included top-level path is picked up on the next call. A removed file
  drops out of the seed file list and out of the reseeded cache.
- Existing seed resilience behaviour is unchanged (`bundled-plugins-resilience.test.ts`,
  `official-plugin-runtime.test.ts`, `official-plugin-seed-lock.test.ts`).

Nothing else is cached (`bootstrap/tests/plugin-discovery-liveness.test.ts`). Within one process,
the next call sees:

- a workspace `.zcode/commands` file added or removed outside the CLI;
- a `commands/` directory added to an inline plugin outside the CLI;
- a CLI disable op (`setZCodePluginEnabled`) and a direct edit of the config file that re-enables
  the plugin.
