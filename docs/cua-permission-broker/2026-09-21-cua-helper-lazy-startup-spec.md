# CUA Helper Lazy Startup Specification (macOS / Windows)

## Status

- Status: implemented (MR1/MR2 deployed on feat/cua-helper-lazy-startup + producer feat/win-lazy-fork@5bcdde06); all gates green (typecheck/lint/architecture/services unit tests 3141). Open: darwin on-machine MC-1/2/3 and Windows full-chain MC-4~7/9 await on-machine validation.
- Date: 2026-09-21.
- Scope: Desktop Host (services), Agent spawn/session chain, zcode-cua SDK (producer), Computer Use Helper. Platforms: macOS and Windows; Linux is out of scope.
- Prerequisite: M7 deployed the lazy startup baseline on darwin (spawn always injects a stable socket, the SDK's first CUA call self-pulls, the settings page launches on demand). This spec narrows darwin residual paths and ports Windows to the same model.
- Supersedes the admission clauses on spawn env in the [Helper lifecycle isolation spec](./2026-09-02-helper-lifecycle-agent-runtime-isolation-spec.md): the "2026-09-10 spawn fast path" entry of §3.1 and the bounded probe entry of §3.3 on "whether Agent spawn env can inject the current broker tuple". The remaining clauses (fail-closed, process identity verification, generation fence, no periodic probing, Helper events must not dispose Agent) stay in effect.

## I. Product invariants

Core invariant: Agent-facing credentials = (transport path, pluginAuthority) are pure data. Creation and derivation involve zero IO; injection (spawn env, resolver, settings page) involves zero IO, zero waiting and zero health dependency. Helper start/stop and health affect only CUA tool call results and settings page display, never the timing of Host startup, Agent spawn or session create.

1. Host process startup does not trigger Helper installation, startup or probing (orphan harvesting occurs only through the lazy creation of the authorization flow's host).
2. Agent spawn env resolution includes no Helper IO: no `checkHealth`, no `waitForTransport`, no acquire, no deadline race.
3. Only three kinds of actors may trigger Helper startup: the Agent's first CUA call via SDK `ensureBrokerAvailable` (the sole first-call path); explicit user action (settings page `getStatus` launch, authorization flow); Host maintenance (`restartAfterPermissionGrant` and other resolver restart entry points).
4. Standalone mode 300 s idle self-exit is a feature: if nobody uses it, it exits; no long-lived process.
5. Credentials injected at spawn stay constant for the Host process lifetime (Windows stable pipe name, macOS stable socket derivation); Helper restart or generation change does not reissue credentials and Agents holding credentials need no update action.

## II. Baseline facts at design time (2026-09-21)

darwin (M7 deployed, residual paths):

- Spawn env already injects the stable socket + spawn authority at creation (`node.ts:2184`); the resolver is already peek-only pass-through (`node.ts:2308`); the SDK first-call self-pull includes installation and bundled refresh (producer `computer-use-runtime.ts:91`).
- Residual blocking: when the authorization flow just built a managed host, spawn goes through the warm `checkHealth(1000)` / marker recovery probe / pre-allocation race of `buildCuaProductHelperAgentEnv` (`node.ts:1123`), consuming the full 1 s in Helper scenarios.
- The `warmHelperForBuiltInPlugin` preheat path conflicts with lazy startup semantics.

win32 (old model):

- Spawn `await getOrCreateDefaultCuaProductHelper` (includes runtime resolution IO) + `waitForTransport(1000)` (`node.ts:1186/1193`).
- SDK `ensureBrokerAvailable` is a no-op on win32; the Helper can only be forked by the Host (`windowsCuaDevHelperHost.ts:308`; the pipe name is already minted by the Host and passed via argv `--socket`).
- Settings page `getStatus` on win32 directly returns "CUA permissions are only available on macOS" (`node.ts:1900`), exposing no state.

Structural waste: the 1 s grace race on the spawn side waits for full startup (750-1080 ms bundle signature verification + Gatekeeper + health), but the tuple it needs is available after the first `start()` await (placeholder bind, millisecond level); the conclusion is the same regardless of the wait.

## III. Normative behavior

### 3.1 Credential creation and injection (both platforms)

| Platform | Transport path | pluginAuthority |
| --- | --- | --- |
| darwin | `resolveBrokerSocketPath()` stable derivation (from ZCODE_HOME), zero IO | Created at spawn (per-bootstrap config-provenance, current behavior preserved) |
| win32 | Stable pipe name created once by the Host app process (includes a random segment; module-level singleton; reused on Host rebuild; must differ across app runs) | Same as darwin |

- Spawn env injection is a pure table lookup; no `await` on Helper-related IO inside the function.
- win32 spawn env additionally injects the fork recipe (§3.3).
- The resolver is always pass-through (no acquire, no credential rewriting); CUA MCP credentials flow only through the agent process env, aligned with M7 darwin.

### 3.2 Helper startup timeline

Figure 1: macOS cold start -> spawn -> first CUA call (clean machine)

```text
Host                                Agent(SDK)                     Helper(standalone)
 │ app startup (zero Helper IO)       │                                │
 ├─ resolveSpawnEnv ─────────────────► │ spawn, <5ms return              │
 │   env = { stable socket, authority }│ (no socket connect, no health)  │
 │                                     │ ── non-CUA turn runs normally ──│
 │                                     │ ══ first CUA tool call ══      │
 │                                     │  connect(stable socket) ✗ ENOENT│
 │                                     │  onUnavailable → ensure(5s cooldown)│
 │                                     │   ① ensure-installed (first install)│
 │                                     │   ② LS open standalone ───────►│ bind stable socket
 │                                     │                                 │ flock single instance, no launcherPid
 │                                     │                                 │ ⇒ 300s idle self-exit enabled
 │                                     │  ◄─ warmup-retry ───────────────┤ authenticate(sig gate)
 │                                     │ ─── broker call ───────────────►│
```

Figure 2: Windows cold start -> spawn (zero IO) -> first-call self-fork

```text
Host                                Agent(SDK)                     Helper(forked node)
 │ app startup: mint stable pipe name (once)  │                                │
 ├─ resolveSpawnEnv ─────────────────► │ spawn, <5ms return              │
 │   env = { PIPE name, authority,       │ (no acquire, no wait)            │
 │          RECIPE (see 3.3) }          │                                │
 │                                     │ ══ first CUA tool call ══      │
 │                                     │  connect \\.\pipe\… ✗          │
 │                                     │  ensure(win32 branch) fork ──────►│ bind pipe(~300-500ms)
 │                                     │   (--socket stable name,        │ authenticate/peer gate
 │                                     │    --parent-pid hostPid)        │ native initialization
 │                                     │  ◄─ warmup-retry(2s window) ───────┤
 │                                     │ ──── broker call ──────────────►│
 │  Concurrent first-call: second fork binds and exits, harmless; both Agents connect to the same Helper  │
```

Figure 3: recovery after death/idle (identical on both platforms)

```text
Agent(SDK)                                    Helper
 │ ── (darwin) 300s no connections && no in-flight ──► idle_exit: exit(0)
 │ ── (any platform) kill / crash ─────────────────► disappears
 │ ── subsequent CUA call ──► connect ✗
 │   ensure (pull once within 5s cooldown)
 │     darwin: LS open (flock stale cleanup then rebind stable socket)
 │     win32:  fork (same stable pipe name → new instance exclusive bind)
 │   ◄── warmup-retry connected ── recovery; caller credentials unchanged
```

Figure 4: Helper lifecycle state machine

```text
 [Not exists] ──Agent first-call ensure──► [Starting bind+native] ──ready──► [In service]
    ▲                                │                            │
    │                                │ Startup failed (peer gate/missing components)│ 300s no connection (darwin)
    │                                ▼                            │ kill / crash
    └────────────────────────────────┴────────────────────────────┘
 Host startup / spawn / session create / resolver never appear on any transition edge (pure data reads only).
```

Figure 5: settings page (user explicit demand boundary)

```text
User                        Host(settings page/getStatus)              Helper
 │ Directly enters computer control settings page  │                                 │
 │ ──────────────────────────────────────────────► │ probe(300ms ping) ── ✗ ────────│ (not exists)
 │  (page loading)             │ darwin: LS open standalone ────►│ bind
 │                             │ win32:  Host fork ─────────────►│ bind pipe
 │                             │ poll ping(≤5s) ◄───────────────── ready
 │  ◄── permission_status truth │                                 │ idle timer starts
 │  Cannot launch → idle:true fallback text ("Will start automatically when first using Computer Use")
```

### 3.3 win32 SDK fork contract (producer side)

- `ensureStandaloneHelperLaunched` adds a win32 branch: `fork(recipe.entryPath, ["--socket", stable pipe name, "--parent-pid", recipe.hostPid], { env: { ELECTRON_RUN_AS_NODE: "1", [ADDON_ENV]: recipe.addonPath, …whitelist } })`.
- The recipe is injected via spawn env under the key `ZCODE_CUA_WIN_HELPER_RECIPE` (JSON value: `entryPath`, `command`, `root`, `addonPath`, `commandEnv`, `hostPid`). Constants are registered in producer helperConstants; the z-code side uses the same name literal; consistency across repos is a cross-repo contract.
- `--parent-pid` is always hostPid: Helper lifecycle hangs on the Host (the watchdog recognizes only the Host pid), not on the forked Agent's exit. The Helper survives after the Agent process dies; broken writes on the stdio control channel are an acceptable loss (that channel gives observability only to the forker).
- Single instance via named pipe exclusive bind. A second fork from a concurrent first call binds and exits, harmlessly; both Agents connect to the same Helper.
- The `transport_ready` control channel belongs to the forker (Agent); Host spawn, status query and `restartHelper` do not depend on it (the Host connects directly to the pipe for queries; restart re-forks using the Host's own runtime recipe).
- The peer gate status (M8 fail-closed, missing 4 native peer primitives) is not changed by this spec; only lifecycle timing changes, not the capability surface.

### 3.4 Death and recovery

- After Helper death or idle exit, recovery = the next CUA call's ensure pulls it again (same path/pipe name, credentials unchanged); calls that die during execution are handled by delivery-state (`possibly_sent` forbids automatic replay).
- No periodic probe on the Host side (isolation spec §3.3); the resolver's `checkHealth` + `restartHelper` remain only for post-authorization restart and permission maintenance entry points.

### 3.5 Settings page (both platforms)

- `getStatus`: probe (300 ms ping, does not launch); if absent, launch (darwin LS open / win32 Host fork; the Host keeps runtime resolution capability for this); after ready, query `permission_status`.
- Launch failure -> `{ available:false, idle:true }` with friendly text, no error, no disturbance.
- Launch candidates and install variants are synchronized with the source (producer `standaloneHelperCandidatePaths`): stable/preview/dev runtimes each enumerate only their own variant's install root. Production runtimes must not enumerate dev roots: with dev residue, silently selecting an unsigned package makes the settings page always "launch failure" and masquerades as a permission issue (2026-09-22 ZCT-2102352739585175552). The dev runtime is additionally compatible with the one-click bundle installed under the `dev/` root as a stable name (2026-09-10 fix intent). Missing candidates follow the launch-failure path with install guidance.
- win32 removes the "only available on macOS" shortcut (permission truth query is a platform-agnostic broker method call).

### 3.6 Authorization flow coexistence window (darwin, conservative trade-off)

- The authorization flow's managed host launches a managed Helper (random socket, `launcherPid=Host`, no idle exit). During the window spawn still always injects the stable socket; two Helpers briefly coexist without interference (different sockets, flock does not conflict); the host disposes the managed instance at host dispose.
- Enhanced option (not included): use the stable socket for the mac managed host and adopt both existing standalone instances, eliminating the coexistence window. Deferred until practical testing shows it is a real problem.

## IV. Boundaries and state owners

| State/Fact | Authoritative owner | Notes |
| --- | --- | --- |
| Stable pipe name (win32) | Host module-level singleton | Created once per app process, reused on Host rebuild |
| Stable socket path (darwin) | `resolveBrokerSocketPath()` pure derivation | Zero state |
| pluginAuthority | Created on the spawn side | config-provenance semantics; the Helper does not verify it |
| Helper process lifecycle | Launcher watchdog (recognizes hostPid) + idle timer (darwin standalone) | Exits if nobody uses it |
| Helper health | On-demand query (call retry, settings page, permission maintenance) | No periodic probe |
| spawn admission marker | Obsolete | Recovery generation inside resolver restart is retained but no longer consumed by spawn env |

## V. Implementation phases

### MR1 (pure services, darwin wrap-up; fully verifiable locally)

- Remove the peeked-host branch from spawn env: darwin always injects the stable socket + authority; `buildCuaProductHelperAgentEnv` becomes unreachable on darwin.
- Tests: MC-1, MC-3; `cuaPermissionBrokerProductAgentEnv.test.ts` adjusted accordingly.
- On darwin the app passes through the installer before launching, matching the SDK first-call path. When the bundled Helper exists (`resolveBundledCuaHelperAppPath`; in packaged builds `Contents/Resources/cua-helper/…`), first run `createCanonicalCuaHelperInstaller(...).ensureInstalled()` (signature / Team / buildId validation; on mismatch atomically replace at the same path to preserve TCC authorization), then launch the path returned by the installer. If installation fails, degrade as a launch failure (`idle:true` + warn log) and never fall back to launching the old installed copy. Only when the bundled Helper is absent (dev runs) is the installed-candidate enumeration used. Counter-example (2026-09-29, packaged 3.14.3): the settings page directly opened the installed 3.14.1 Helper (IPC v2); the broker rejected the new client (IPC v3) and the new bundled Helper could never be installed.

### MR2 (producer + services, win32 port + cleanup)

- Producer: `ensureStandaloneHelperLaunched` win32 fork branch + unit tests; remove the `warmHelperForBuiltInPlugin` preheat path (conflicts with invariant 3); producer pin bump via the atomic command `pnpm --filter @zcode/zcode-cua-plugin bump:producer`.
- Services: stable pipe name singleton; spawn env injection of pipe name + authority + recipe (removes win32 acquire / `waitForTransport`); `getStatus` win32 aligned with §3.5.
- Cleanup (in this MR or a separate MR3): remove the `buildCuaProductHelperAgentEnv` corpse, `CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS`, spawn-side admission marker consumption, and the `cuaProductHelperWorkspaceRegistry.setEnabled` spawn call site.
- Tests: MC-4/5/6/7/8/9; state Windows on-machine validation gaps honestly in the MR.

## VI. Verification matrix

| Case | Platform | Initial state | Event | Expected |
| --- | --- | --- | --- | --- |
| MC-1 | darwin | Cold-start app | spawn env resolution | No Helper IO (fake host asserts start/checkHealth not called), milliseconds |
| MC-2 | darwin | Clean machine | First CUA call | SDK install + launch then call succeeds (M7 regression) |
| MC-3 | darwin | Authorization flow just ended (host present) | spawn | Still always injects the stable socket; no probe, no 1 s wait |
| MC-4 | win32 | Cold-start app | spawn env resolution | Zero wait, zero acquire; env contains pipe name + recipe |
| MC-5 | win32 | No Helper | First CUA call | SDK fork -> connected within warmup window -> call succeeds |
| MC-6 | win32 | Helper killed | Next CUA call | Fails retryable -> ensure re-forks (same pipe name) -> recovers |
| MC-7 | win32 | Dual Agent concurrent first call | Concurrent ensure | Pipe single instance; second fork failure harmless; connects to the same Helper |
| MC-8 | both | Helper restarted / regenerated | spawn env and existing Agent credentials | Transport path constant (same socket/pipe); Helper generation change does not reissue credentials; darwin authority is created at spawn, each agent may differ (existing semantics) |
| MC-9 | win32 | No conversation open | Enter settings page directly | Probe -> Host fork -> permission truth; failure yields idle:true fallback |
| MC-10 | darwin | Packaged build, installed Helper with old buildId | Enter settings page directly | ensureInstalled replaces with the bundled Helper before launch; on install failure degrade with idle:true and never launch the old copy |

Regression red line (isolation spec §7, still in effect): Helper lifecycle logs contain no `workspace-dispose` directly caused by readiness/recovery; normal Agent spawn / session create timing includes no Helper IO; non-CUA module startup time includes no Helper health budget.

Verification commands (per root AGENTS.md): `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests; changes involving apps/zcode-cli additionally per [CLI rules](../../apps/zcode-cli/AGENTS.md); desktop CUA E2E per the existing case catalog.

## VII. Risks and unverified items

1. Windows on-machine gap: the development machine is macOS; MR2's fork recipe, pipe bind and transport_ready behavior are covered only by unit tests, and on-machine verification waits for a Windows colleague (state honestly in the MR).
2. Windows M8 peer gate: CUA is currently fail-closed on win32. This spec changes only lifecycle timing, not the capability surface; behavior is unchanged after the peer gate is lifted.
3. Idle self-exit side effect (darwin): after 300 s with no connections PiP / ghost cursor closes with the Helper. Consistent with current CLI behavior and the natural semantics of lazy startup.
4. Authorization flow coexistence window (darwin): see §3.6.
5. Race between agent-side ensure and managed Helper startup (darwin authorization flow window): flock for different sockets is independent; worst case is briefly dual instances within the window; the authorization flow host disposes the managed instance.

## VIII. Implementation order

1. Confirm this spec.
2. MR1 implementation and full verification locally.
3. MR2: producer (win32 fork branch + unit tests) -> pin bump -> services integration -> unit tests; note the Windows gap.
4. Evaluate and update the desktop CUA E2E case catalog per the [E2E workflow](../../.agents/skills/e2e-case-lifecycle/SKILL.md).
5. Run the §VI verification commands; platforms that cannot be verified on-machine list risks and pending evidence in the MR.
