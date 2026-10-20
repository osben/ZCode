# CUA Helper Lazy Startup Specification (macOS / Windows)

## Status

- Status: Implemented (MR1/MR2 deployed on feat/cua-helper-lazy-startup + producer feat/win-lazy-fork@5bcdde06); all gates green (typecheck/lint/architecture/services unit tests 3141); darwin on-machine MC-1/2/3 and Windows full-chain MC-4~7/9 pending on-machine validation
- Date: 2026-09-21
- Scope: Desktop Host (services), Agent spawn/session chain, zcode-cua SDK (producer), Computer Use Helper
- Platforms: macOS and Windows; Linux is outside the scope of this specification
- Prerequisite: M7 has already deployed the lazy startup baseline on darwin (spawn always injects stable socket, SDK first CUA call self-pulls, settings page on-demand launch). This specification narrows darwin residual paths and ports Windows to the same model.
- Replacement relationship: This specification supersedes
  the admission clauses related to spawn env from [Helper lifecycle isolation spec](./2026-09-02-helper-lifecycle-agent-runtime-isolation-spec.md) — namely the "2026-09-10 spawn fast path" entry in §3.1 and the bounded probe entry in §3.3 regarding "whether Agent spawn env can inject the current broker tuple." The remaining clauses of that specification (fail-closed, process identity verification, generation fence, no periodic probing, Helper events must not dispose Agent) remain fully in effect.

## I. Product Invariants

**Core invariant: Agent-facing credentials = (transport path, pluginAuthority) are pure data.**

Creation and derivation involve zero IO; injection (spawn env, resolver, settings page) involves zero IO, zero waiting, zero health dependency.
Helper start/stop and health affect only CUA tool call results and settings page display, never the timing of Host startup, Agent spawn, or session create.

The following must always hold:

1. Host process startup must not trigger Helper installation, startup, or probing (orphan harvesting occurs only via the lazy creation of the authorization flow's host).
2. Agent spawn env resolution must not include any Helper IO: no `checkHealth`, no `waitForTransport`, no acquire, no deadline race.
3. Only three categories of actors can legitimately trigger Helper startup:
   - Agent's first CUA call via SDK `ensureBrokerAvailable` (the sole first-call path);
   - Explicit user action: settings page `getStatus` launch, authorization flow;
   - Host maintenance action: `restartAfterPermissionGrant` and other resolver restart entry points.
4. Standalone mode 300s idle self-exit is a feature: no one uses it, it exits, no long-lived process.
5. The credentials injected at spawn remain constant for the Host process lifetime (Windows stable pipe name, macOS stable socket derivation); Helper restart or generation change does not reissue credentials, and Agents holding credentials need no update action.

## II. Current Problems (2026-09-21 Baseline Facts)

**darwin (M7 deployed, residual paths remain):**

- spawn env already injects stable socket + spawn authority at creation (`node.ts:2184`); resolver already peeks-only pass-through (`node.ts:2308`); SDK first-call self-pull includes installation and bundled refresh (producer `computer-use-runtime.ts:91`).
- Residual blocking: when the authorization flow just built a managed host, spawn goes through the warm `checkHealth(1000)` / marker recovery probe / pre-allocation race of `buildCuaProductHelperAgentEnv` (`node.ts:1123`), blocking in Helper scenarios consumes the full 1s.
- `warmHelperForBuiltInPlugin` preheat path conflicts with lazy startup semantics.

**win32 (still using the old model):**

- spawn `await getOrCreateDefaultCuaProductHelper` (includes runtime resolution IO) + `waitForTransport(1000)` (`node.ts:1186/1193`).
- SDK `ensureBrokerAvailable` is a no-op on win32; the Helper can only be forked by the Host (`windowsCuaDevHelperHost.ts:308`, the pipe name is already minted by the Host and passed via argv `--socket`).
- Settings page `getStatus` on win32 directly returns "CUA permissions are only available on macOS" (`node.ts:1900`), with no state exposed.

**Structural waste (confirmed by M7's darwin changes):** The 1s grace race wait on the spawn side is for full startup (including 750–1080ms bundle signature verification + Gatekeeper + health), yet the tuple it needs to send is available after the `start()` first await (placeholder bind, millisecond-level); the conclusion is the same regardless of how long you wait.

## III. Normative Behavior

### 3.1 Credential Creation and Injection (Unified Both Platforms)

| Platform | Transport Path                                                                                                                                               | pluginAuthority                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| darwin   | `resolveBrokerSocketPath()` stable derivation (derived from ZCODE_HOME), zero IO                                                                             | Created at spawn time (per-bootstrap config-provenance, current behavior preserved) |
| win32    | Stable pipe name created once by the Host app process (includes random segment; module-level singleton; reused on Host rebuild; must differ across app runs) | Same as darwin                                                                      |

- Spawn env injection = pure table lookup; no `await` Helper-related IO within the function body.
- win32 spawn env additionally injects **fork recipe** (see 3.3).
- Resolver always pass-through (no acquire, no credential rewriting); CUA MCP credentials flow only through the agent process env, aligned with M7 darwin.

### 3.2 Helper Startup Timeline

Figure 1: macOS cold start → spawn → first CUA call (clean machine)

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

Figure 2: Windows cold start → spawn (zero IO) → first-call self-fork

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

Figure 3: Recovery after death/idle (identical both platforms)

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

Figure 4: Helper lifecycle state machine (trigger labels shown)

```text
 [Not exists] ──Agent first-call ensure──► [Starting bind+native] ──ready──► [In service]
    ▲                                │                            │
    │                                │ Startup failed (peer gate/missing components)│ 300s no connection (darwin)
    │                                ▼                            │ kill / crash
    └────────────────────────────────┴────────────────────────────┘
 Host startup / spawn / session create / resolver never appear on any transition edge (pure data reads only).
```

Figure 5: Settings page (user explicit demand boundary)

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

### 3.3 win32 SDK Fork Contract (producer side addition)

- `ensureStandaloneHelperLaunched` adds a win32 branch:
  `fork(recipe.entryPath, ["--socket", stable pipe name, "--parent-pid", recipe.hostPid],`
  `{ env: { ELECTRON_RUN_AS_NODE: "1", [ADDON_ENV]: recipe.addonPath, …whitelist } })`.
- Recipe injected via spawn env, key name finalized as `ZCODE_CUA_WIN_HELPER_RECIPE` (value is JSON:
  `entryPath`, `command`, `root`, `addonPath`, `commandEnv`, `hostPid`; constants registered in
  producer helperConstants, z-code side uses the same name literal, consistency across repos is a cross-repo contract).
- `--parent-pid` is always **hostPid**: Helper lifecycle hangs on the Host (watchdog only recognizes Host pid), not on the forked Agent's exit; the Helper survives after the Agent process dies, and stdio control channel broken writes are an acceptable loss (this channel provides only observability for the forker, see below).
- Single instance: named pipe exclusive bind. Concurrent first-call's second fork instance binds and exits, harmless; both Agents connect to the same Helper.
- The `transport_ready` control channel belongs to the forker (Agent); the Host's spawn, status query,
  `restartHelper` do not depend on it (the Host connects directly to the pipe for queries; restart uses the Host's own runtime recipe to re-fork).
- The peer gate status (M8 fail-closed, missing 4 native peer primitives) is not changed by this specification; this specification only modifies lifecycle timing, not the capability surface.

### 3.4 Death and Recovery

- After Helper death or idle exit, recovery = the next CUA call's ensure pulls it again (same path/pipe name, credentials unchanged); calls that die during execution are handled via delivery-state (`possibly_sent` prohibits automatic replay).
- No periodic probe on the Host side (following the isolation spec §3.3); the resolver's `checkHealth` + `restartHelper` remain only for post-authorization restart and permission maintenance entry points.

### 3.5 Settings Page (Unified Both Platforms)

- `getStatus`: probe (300ms ping, does not launch) → if not present, launch (darwin LS open / win32 Host fork, Host side retains runtime resolution capability for this purpose) → after ready, query `permission_status`.
- Launch failure → `{ available:false, idle:true }` with friendly text, no error, no disturbance.
- Launch candidates and install variants are source-synchronized (producer `standaloneHelperCandidatePaths`): stable/preview/dev runtimes each enumerate only their own variant's install root. **Production runtimes must not enumerate dev roots** — when dev residue is present, silently selecting an unsigned package makes the settings page always "launch failure" and masquerades as a permission issue (2026-09-22 ZCT-2102352739585175552). Dev runtime additionally compatible with the one-click bundle installed under `dev/` root as a stable name (2026-09-10 fix intent preserved). Missing candidates → follow the launch failure path for install guidance.
- win32 removes the "only available on macOS" shortcut (permission truth query logic itself is a platform-agnostic broker method call).

### 3.6 Authorization Flow Coexistence Window (darwin, conservative trade-off)

- The authorization flow's managed host launches a managed Helper (random socket, `launcherPid=Host`, no idle exit); during the window, spawn still always injects a stable socket; two Helpers briefly coexist, mutually non-interfering (different sockets, flock does not conflict); the host disposes of the managed instance at host dispose.
- Enhanced option (not included this time): use stable socket for the mac managed host and adopt both existing standalone instances, eliminating the coexistence window. Deferred until practical testing shows actual困扰 from the coexistence window.

## IV. Boundaries and State Owners

| State/Fact                  | Authoritative Owner                                                     | Notes                                                                                        |
| --------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Stable pipe name (win32)    | Host module-level singleton                                             | Created once per app process, reused on Host rebuild                                         |
| Stable socket path (darwin) | `resolveBrokerSocketPath()` pure derivation                             | Zero state                                                                                   |
| pluginAuthority             | Created on spawn side                                                   | config-provenance semantics, Helper does not verify it                                       |
| Helper process lifecycle    | Launcher watchdog (recognizes hostPid) + idle timer (darwin standalone) | Exit if no one uses it                                                                       |
| Helper health               | On-demand query (call retry, settings page, permission maintenance)     | No periodic probe                                                                            |
| spawn admission marker      | Obsolete (this spec)                                                    | Recovery generation inside resolver restart is retained, but no longer consumed by spawn env |

## V. Implementation Phases

### MR1 (pure services, darwin wrap-up; fully verifiable on local machine)

- Remove the peeked-host branch from spawn env: darwin always injects stable socket + authority;
  `buildCuaProductHelperAgentEnv` becomes unreachable on darwin.
- Tests: MC-1, MC-3; `cuaPermissionBrokerProductAgentEnv.test.ts` adjusted accordingly.
- On darwin, the app must pass through the installer before launching, matching the SDK first-call path. When the bundled Helper (`resolveBundledCuaHelperAppPath`; in packaged builds `Contents/Resources/cua-helper/…`) exists, first run `createCanonicalCuaHelperInstaller(...).ensureInstalled()` (signature / Team / buildId validation; on mismatch, atomically replace at the same path to preserve TCC authorization), then launch the **path returned by the installer**. If installation fails, degrade as a launch failure (`idle:true` + warn log) and **never fall back to launching the old installed copy**. Only when the bundled Helper is absent (dev runs) is the installed-candidate enumeration above used.
  Counter-example (2026-09-29 on device, packaged 3.14.3): the settings page directly `open`ed the installed 3.14.1 Helper (IPC v2); the broker rejected the new client (IPC v3), and the new Helper bundled with the app could never be installed.

### MR2 (producer + services, win32 port + cleanup)

- Producer: `ensureStandaloneHelperLaunched` adds win32 fork branch + unit tests; removes
  `warmHelperForBuiltInPlugin` preheat path (lazy startup "no candidates means no preheat" conflicts with invariant 3);
  producer pin bump uses the atomic command
  `pnpm --filter @zcode/zcode-cua-plugin bump:producer`.
- Services: stable pipe name singleton; spawn env injection of pipe name + authority + recipe (removes
  win32 acquire / `waitForTransport`); `getStatus` win32 aligned with 3.5.
- Cleanup (can be merged into this MR or a separate MR3): remove `buildCuaProductHelperAgentEnv` corpse,
  `CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS`, spawn-side admission marker consumption,
  `cuaProductHelperWorkspaceRegistry.setEnabled` spawn call site.
- Tests: MC-4/5/6/7/8/9; Windows on-machine validation gaps stated honestly in the MR.

## VI. Verification Matrix

| Case  | Platform       | Initial State                                     | Event                                    | Expected                                                                                                                                                                        |
| ----- | -------------- | ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MC-1  | darwin         | Cold-start app                                    | spawn env resolution                     | No Helper IO (fake host asserts start/checkHealth not called), milliseconds                                                                                                     |
| MC-2  | darwin         | Clean machine                                     | First CUA call                           | SDK install + launch then call succeeds (M7 regression)                                                                                                                         |
| MC-3  | darwin         | Authorization flow just ended (host present)      | spawn                                    | Still always injects stable socket; no probe, no 1s wait                                                                                                                        |
| MC-4  | win32          | Cold-start app                                    | spawn env resolution                     | Zero wait, zero acquire; env contains pipe name + recipe                                                                                                                        |
| MC-5  | win32          | No Helper                                         | First CUA call                           | SDK fork → connected within warmup window → call succeeds                                                                                                                       |
| MC-6  | win32          | Helper killed                                     | Next CUA call                            | Fails retryable → ensure re-forks (same pipe name) → recovers                                                                                                                   |
| MC-7  | win32          | Dual Agent concurrent first-call                  | Concurrent ensure                        | Pipe single instance; second fork failure harmless; connects to same Helper                                                                                                     |
| MC-8  | Both platforms | Helper restarted / regenerated                    | spawn env and existing Agent credentials | Transport path constant (same socket/pipe), Helper generation change does not reissue credentials; darwin authority created at spawn, each agent can differ, existing semantics |
| MC-9  | win32          | No conversation open                              | Enter settings page directly             | Probe → Host fork → permission truth; failure yields idle:true fallback                                                                                                         |
| MC-10 | darwin         | Packaged build, installed Helper with old buildId | Enter settings page directly             | ensureInstalled replaces with the bundled Helper before launch; on install failure, degrade with idle:true and never launch the old copy                                        |

Regression red line (following the isolation spec §7, still in effect):

- Helper lifecycle logs must not contain `workspace-dispose` directly caused by readiness/recovery;
- Timing of normal Agent spawn / session create does not include Helper IO;
- Non-CUA module startup time does not include the Helper health budget.

Required verification commands (per root AGENTS.md): `pnpm typecheck`, `pnpm lint`,
`pnpm architecture:check --changed`, affected unit tests; changes involving apps/zcode-cli additionally verified per
[CLI rules](../../apps/zcode-cli/AGENTS.md); desktop CUA E2E per existing case catalog.

## VII. Risks and Unverified Items

1. **Windows on-machine gap**: Development machine is macOS. MR2's fork recipe, pipe bind, and transport_ready behavior can only be covered by unit tests; on-machine verification waits for a Windows colleague to接力, stated honestly in the MR.
2. **Windows M8 peer gate**: Current CUA fail-closed on win32. This specification does not change the capability surface, only lifecycle timing; behavior remains unchanged after the peer gate is lifted.
3. **Idle self-exit side effect (darwin)**: After 300s with no connections, PiP / ghost cursor closes with the Helper. Consistent with CLI current behavior, this is the natural semantics of lazy startup.
4. **Authorization flow coexistence window (darwin)**: See 3.6; enhanced option deferred until needed.
5. **Race between agent-side ensure and managed Helper startup (darwin authorization flow window)**: flock for different sockets is independent; worst case is briefly dual instances within the window; the authorization flow host disposes of the managed instance.

## VIII. Implementation Order

1. This specification confirmation (this document).
2. MR1 implementation and full necessary verification completed on local machine.
3. MR2: first producer (win32 fork branch + unit tests) → pin bump → services integration → unit tests; Windows gap noted.
4. Evaluate and update the desktop CUA E2E case catalog per the [E2E workflow](../../.agents/skills/e2e-case-lifecycle/SKILL.md).
5. Run the Section VI verification commands afterward; platforms unable to verify on-machine must list risks and pending evidence in the MR.
