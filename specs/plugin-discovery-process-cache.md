# Plugin discovery per-process cache

Status: Tier 1 in review as draft PR osben/ZCode#273 (2026-10-21); Tier 2 and the Host ordering fix are proposed, not implemented.

## Problem

Cold session opens and warm workspace switches in ZCode Desktop wait behind synchronous plugin discovery in the CLI:

- `workspace/readPresentation` → `listProtocolSlashCommands` → `listZCodeCustomCommands` → `createCustomCommandDiscovery` → `resolveZCodePlugins` runs on every call. It is fully synchronous and runs on the CLI's serial request queue (`zcode-protocol/transport.ts`); `runtime/capabilities` and the session subscribe sent after it wait until it finishes.
- Session runtime creation (`createZCodeApp`, stage `resolve_plugins`) runs the same discovery through `resolveStartupPlugins`, then the runtime's skills discovery scans the resulting skill roots. One plugin discovery per resume, not two.

## Where the time goes (measured 2026-10-21)

The time goes into seeding the official plugins, not into discovery itself. CPU profile of 30 × `resolveZCodePlugins` on `/Users/osben/Dev/ZCode` (28 plugins, 19 enabled, cloned storage, built dist):

| Part                                                                                         | ms/call | share |
| -------------------------------------------------------------------------------------------- | ------: | ----: |
| `resolveFilesystemSeedSource`: walk, `readFileSync` and SHA-256 of every bundled plugin file |     ~56 |   67% |
| Rest of seeding: seed lock mkdir/rm, marker read, runtime-manifest and marketplace writes    |      ~8 |   10% |
| `discoverPluginsSync` (manifests, components, skill frontmatter, hooks, MCP)                 |    ~18 |   22% |
| `createConfig`                                                                               |    ~0.3 |     — |

Production uses the same code path: the packaged app runs `Resources/glm/zcode.cjs` with Electron as Node (not a SEA binary), the bundled plugins sit beside it in `Resources/glm/packages/*`, and `resolveSeedSource()` takes the filesystem branch. The packaged set is 716 files / 63 MB: read + hash costs 47 ms warm page cache, 117 ms cold; walk + `stat` costs 5 ms. The seed source — the bundled plugin files shipping with the running build — does not change while the process runs, but the CLI rebuilds its hash list from file bytes on every discovery call.

## Decision

Implement **Tier 1**; **Tier 2** is specified and deferred: Tier 1 removes most of the cost with a narrow staleness edge, while Tier 2 would save only the remaining ~25 ms per call and adds staleness windows a shared `~/.zcode` makes hard to close.

### Tier 1: stat-validated seed-file hash memo

- **Owner:** `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`. A module-level, per-process map used only by `collectFilesystemPluginFiles`; nothing else reads or writes it. The memo is inline in this upstream-synced file (a fork delta of ~30 lines) because `apps/zcode-cli` is `managed: false` in `architecture-policy.yaml` and pre-push `architecture:check` rejects new source files in unmanaged modules (rule `unmanaged-new-file`, `scripts/architecture/violations.mjs`; it did reject a sibling `official-plugin-seed-hash-memo.ts`). The file was already over the 20 KB staged-size cap, so it is listed in `.staged-file-size-exemptions` instead of being split.
- **Key:** the absolute source file path.
- **Validator:** the file's exact `stat` signature via `statSync(path, { bigint: true })`: `size`, `mtimeNs`, `ctimeNs`, `ino` — nanosecond integers, not rounded ms doubles.
  - On POSIX, `ctime` cannot be set from user space (`utimes` does not change it), so a content edit that keeps size and mtime (`cp -p`, `rsync -t`) still changes ctime. Verified on macOS APFS by a test that pins mtime to a whole second.
  - An atomic replace changes `ino`.
  - Windows (NTFS change time, synthesized `ino`) and network filesystems (NFS, SMB) are **unverified**; they may report coarser or cached timestamps.
- **Value:** the file's SHA-256.
- **Read path:** each call still walks the source tree and `stat`s every included file, so added and removed files are seen on every call. The file is read and hashed only when its signature differs from the memo entry. After each walk of a plugin root, memo entries under that root that were not visited are pruned, so deleted files do not accumulate.
- **Unchanged:** the seed lock, `isSeedCurrent`, the copy into the cache, the hash check of copied bytes (`readSeedFileBytes` + `hashBytes` while copying), the runtime-manifest refresh and the marketplace partition write still run on every call. The official cache lives in shared `~/.zcode` storage that other processes also write (other workspace agents, the upstream build); these steps keep healing it on every call as today.
- **Invalidation:** implicit — any signature change re-hashes that file. Explicit, one case: the copy-path self-heal below.
- **Racily-clean guard (as in git):** `Date.now()` is taken before each read. A file whose `mtime` or `ctime` falls within 2 s before that moment is hashed but not memoized, so the next call hashes it again — a later same-size edit can no longer hide inside the same coarse timestamp tick (HFS+ 1 s, FAT 2 s, coarse ktime, NTFS) behind an unchanged signature. Without the guard, the old hash would feed `plugin.hash`, `isSeedCurrent` would report the cache current, the copy-time check would never run, and the cached copy would silently keep the old bytes. Cost: files written in the last 2 s are re-hashed on every call — only freshly rebuilt dev sources; packaged sources are old.
- **What may go stale:** an edit that keeps size, `mtime`, `ctime` and inode unchanged even though the file was last written more than 2 s earlier. That needs timestamp granularity coarser than 2 s, ctime updates disabled, or a file timestamp clock running behind the local clock (NFS/SMB stamped by the server). Windows and network filesystems are unverified.
- **Self-heal (copy path only):** when copying into the cache, the existing check of the copied bytes throws `Bundled plugin asset hash mismatch`. Before that throw, every memo entry for that plugin's source files is dropped. That discovery call fails, as before, and the next call re-hashes and recovers. This only helps when something else forces a re-seed; the racily-clean guard covers the case where the seed marker still matches.
- The SEA branch is not affected; it already uses precomputed hashes.
- **Race:** the file is `stat`ed before it is read. If it changes between the two, the memo stores the new hash under the old signature; the next call sees a different signature and hashes again, so the error is always toward re-hashing.

### Tier 2: full discovery-outcome cache (specified, deferred)

- **Owner:** one per-process cache in bootstrap; `resolveZCodePlugins` and `resolveStartupPlugins` would read through it. They share discovery inputs, but `resolveStartupPlugins` also applies incognito and the visualize filter, so the cached outcome must be treated as immutable and copied before those filters mutate `skillRoots`.
- **Key:** `pluginStorageRoot`; `workingDirectory`; a canonical hash of the resolved `configResult.config.plugins` (covers edits to user config, project config and env made by any process — `createConfig` re-reads the files on every call, ~0.3 ms); `officialPluginRoots` extras; the env inputs discovery reads (CUA feature flag, template-expansion env); `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`. `dynamicWorkflowEnabled` is not needed — it filters the slash-command catalog after discovery, and the custom-command scan stays live.
- **Invalidation it would need:**
  1. CLI plugin operations (install, uninstall, update, enable/disable, configure, reset, restore-builtin, marketplace add/remove/update) bump an in-process generation counter.
  2. Changes from another process: before each hit, compare `stat` signatures of `installed_plugins.json` and `known_marketplaces.json`, plus the directory signature of `cache/zcode-plugins-official/*`.
  3. External edits inside plugin roots (`config.plugins.dirs` inline plugins under development, hand edits to installed roots): a signature per plugin root for `plugin.json`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json` and the component directories.
- **What it still could not see:** nested edits (a new `SKILL.md` two levels down, a changed command file under a nested directory) — command and skill _contents_ stay live because their adapters re-scan the roots, but `skillCount` and component lists in plugin metadata would go stale; and re-seeding by another build into the shared official cache (a hit skips the seed and runtime-manifest refresh, losing the per-call self-healing until the next miss).
- **Gain over Tier 1:** about 18–25 ms per discovery call.

**Not cached in either tier:** the `.zcode/commands`, skills and agents directory scans, and `createConfig`. These stay live on every call, so edits made outside the CLI to workspace commands, skills and plugin dirs show up exactly as today.

## Measured effect of Tier 1 (stdio A/B, 2026-10-21)

Fresh CLI bundle (`zcode.cjs app-server --stdio --surface desktop`, Node 26.11.1, `ZCODE_RUNTIME_ENV=production`), workspace `/Users/osben/Dev/ZCode` as cwd, bundled sources staged beside the bundle, writes isolated to scratch clones; harness per run: policy sync → `readPresentation` with `runtime/capabilities` queued behind → five more `readPresentation`s → three sessions via `v4/conversation/subscribe` (`historyFirst`) reading `resolve_plugins` from the startup log. 8 runs per variant; a first batch of 6 agreed.

| Metric                                     | Before median (range) | After median (range) |
| ------------------------------------------ | --------------------: | -------------------: |
| readPresentation #1 on a fresh CLI         |       113.5 (109–196) |      117.2 (104–389) |
| `runtime/capabilities` queued behind #1    |       113.5 (109–196) |      117.2 (104–389) |
| readPresentation, repeated (n=40)          |         98.3 (90–731) |         47.5 (39–112) |
| `resolve_plugins` on session resume (n=24) |         80.0 (68–220) |         26.5 (23–59) |
| `runtime/capabilities`, empty queue        |                   0.4 |                  0.4 |

Repeated readPresentation (the warm-switch case) is ~2× faster; `resolve_plugins` ~3× faster; the first readPresentation of a fresh process is unchanged — it fills the memo, so the queued `runtime/capabilities` still waits ~115 ms. Worth it: ~45 lines in one file, implicit stat invalidation with a racily-clean guard and one explicit self-heal, 50–55 ms removed from every discovery call after the first. It does not fix the fresh-client wait (first call still pays the cold hash); the ordering fix covers that. Tier 1b — persisting the stat→hash memo across processes in a `fork_`-prefixed sidecar next to the plugin storage — is the not-proposed alternative, held back because it adds a cross-process file format.

## Cold (cache-miss) breakdown and option ranking (2026-10-21)

The cold call is the first discovery in a fresh process; Tier 1 does not change it. In-process V8 profiler on a fresh Node process (50 µs sampling, bootstrap/adapters samples only), `/Users/osben/Dev/ZCode`, 3 runs per scenario; a separate preload counted fs calls on a fresh CLI.

**readPresentation, cold** (in-discovery ≈ 98 ms; wall ≈ 185–205 ms including first-call warm-up):

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

By type: syscalls ≈ 45 ms, SHA-256 ≈ 21 ms, parsing ≈ 5–8 ms, other JS ≈ 19 ms.

**fs calls per readPresentation** (fresh CLI): cold 6,200 (1,554 `statSync`, 1,152 `readFileSync`, 807 open/read/close for hashing, 516 `lstatSync`, 308 `readdirSync`, 130 `SKILL.md` reads). Warm with Tier 1: 3,088 — the 807 hashing calls are gone; 107 `SKILL.md` reads remain from plugin metadata enumeration, which readPresentation does not need (it only needs `commandRoots`).

**Resume, cold:** createConfig 4.5 ms; `resolve_plugins` 93–100 ms (same split plus ~3 ms parsing); skills discovery 24–42 ms wall but ~4 ms CPU — the rest awaits the libuv threadpool across ~156 skill files one at a time; asynchronous, so it does not block the request queue but delays runtime readiness.

**Duplicate scans within one request:** none. The repeated work is across requests: readPresentation, resume, then the next readPresentation each redo the same discovery for the same workspace.

**Option ranking:**

| Option                                                                                | readPresentation                | Cold resume                                                             | Staleness / regression risk                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Tier 1 stat-validated hash memo (this branch)                                     | warm 98 → 48 ms; cold unchanged | `resolve_plugins` 80 → 27 ms after any earlier discovery in the process | Racily-clean guard covers same-tick edits up to 2 s granularity. Remaining: >2 s granularity or a lagging file-timestamp clock (copy path self-heals). Every file is still stat-ed; seeding still runs every call.     |
| (a') Tier 2 outcome cache                                                             | ~−25 ms more                    | ~−25 ms more                                                            | Nested plugin edits and re-seeds by another build go stale; needs a generation counter plus file signatures.                                                                                                          |
| (b) Remove duplicate scans within a call                                              | 0                               | 0                                                                       | Nothing to remove.                                                                                                                                                                                                    |
| (c1) Skip metadata enumeration when only `commandRoots` are needed (readPresentation) | −~9 ms                          | 0 (resume consumers read plugin metadata)                               | Low, but adds a second shape of `PluginLoadOutcome`.                                                                                                                                                                  |
| (c2) Read skill files in parallel during skills discovery, keeping order              | 0                               | skills 24–42 → ~10 ms wall (estimate)                                   | Low; priority order must be kept when merging.                                                                                                                                                                        |
| (c3) Build-time seed hash manifest for packaged builds (like SEA)                     | cold −~44 ms                    | cold −~44 ms                                                            | Medium. Codesigning or notarization rewrites native binaries after staging, so a stale manifest would fail the copy-time hash check and degrade seeding. Needs a packaging-pipeline change.                           |
| (c4) Tier 1b: persist the stat→hash memo in a `fork_` sidecar                         | cold −~40 ms                    | cold −~40 ms                                                            | Low to medium; adds a cross-process file format.                                                                                                                                                                      |
| (d) Rust/native discovery                                                             | —                               | —                                                                       | Not justified. Parsing CPU is 5–8 ms of ~100 ms; the syscall count stays the same; SHA-256 already runs in native OpenSSL.                                                                                            |

**Recommendation:** ship (a) together with the Host ordering fix below, which moves the one remaining cold hash off the first-subscribe path. (c1) and (c2) are small optional follow-ups. Revisit (c4) only if fresh-process latency still matters after the ordering fix.

## Alternatives considered

### 1. Ordering fix: defer readPresentation behind the first subscribe (measured)

On a fresh client, send the first `v4/conversation/subscribe` (`historyFirst`) before the first `workspace/readPresentation`, still after the workflow-policy sync. The CLI is unchanged; this is a Host ordering change.

```text
current (fresh CLI, serial queue)                 reordered
Host        CLI queue                             Host        CLI queue
policy ───▶ policy sync                           policy ───▶ policy sync
readPres ─▶ readPresentation [cold hash here]     subscribe ▶ subscribe ack (history)
caps ─────▶   ...waits                            caps ─────▶ capabilities (9 ms)
subscribe ▶   ...waits → ack                                  runtime creation [cold hash here]
              runtime creation (warm memo)        readPres ─▶   ...waits → readPresentation (warm)
```

Stdio A/B, fresh CLI, one session, 6 runs per cell, medians in ms from the end of the policy sync:

| Build       | Order     | capabilities | subscribe ack | runtime ready (mode switch) | slash commands ready |
| ----------- | --------- | -----------: | ------------: | --------------------------: | -------------------: |
| baseline    | current   |           95 |           104 |                         172 |                   95 |
| baseline    | reordered |            9 |             9 |                          91 |                  186 |
| Tier 1 memo | current   |          101 |           111 |                         139 |                  101 |
| Tier 1 memo | reordered |            9 |             9 |                          92 |                  141 |

Reordering moves the cold hash onto runtime creation (`resolve_plugins` 68 ms) and still has the runtime ready ~47 ms sooner than the current order with the memo; capabilities and the history ack become immediate. Slash commands arrive later because readPresentation queues behind the synchronous runtime creation — the memo keeps that at 141 ms instead of 186 ms. Neither change regresses anything visible before history.

**Recommendation:** do both — the ordering fix is the bigger win for opening a fresh client; Tier 1 is the win for warm workspace switches, every later session runtime creation, and the readPresentation that follows the reordered subscribe.

### 2. Do nothing

Every readPresentation and runtime creation keeps paying 47–117 ms of hashing in production (warm vs cold page cache), and on a fresh client the mode switch stays ~80 ms later than it needs to be.

## Acceptance scenarios (Tier 1)

Memo invalidation (`bootstrap/tests/bundled-plugins-hash-memo.test.ts`):

- With unchanged source files, a second `resolveOfficialPluginRoots` call reads none of the seed source files except `plugin.json`, which the marketplace description and runtime manifest re-read on purpose. Every included file is still `stat`ed.
- When a source file's content changes (new size or mtime), the next call re-hashes it. The seed marker no longer matches, and the cache is re-seeded with the new bytes.
- A same-size edit with mtime pinned to the same whole second is detected through ctime. The test fails if ctime is removed from the signature.
- After a hash mismatch caused by an edit the stat signature missed (simulated with a frozen stat), that call fails and the next call re-seeds the new bytes. The test fails without the self-heal.
- A same-tick, same-size edit of a recently written file is re-hashed while the seed marker still matches (frozen stat, real clock). The test fails without the racily-clean guard.
- A file added under an included top-level path is picked up on the next call. A removed file drops out of the seed file list and out of the reseeded cache.
- Existing seed resilience behaviour is unchanged (`bundled-plugins-resilience.test.ts`, `official-plugin-runtime.test.ts`, `official-plugin-seed-lock.test.ts`).

Nothing else is cached (`bootstrap/tests/plugin-discovery-liveness.test.ts`). Within one process, the next call sees:

- a workspace `.zcode/commands` file added or removed outside the CLI;
- a `commands/` directory added to an inline plugin outside the CLI;
- a CLI disable op (`setZCodePluginEnabled`) and a direct edit of the config file that re-enables the plugin.
