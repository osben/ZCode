# Desktop Context Prompt rollout chain and first-Host gate

Spec: how the server-side rollout (Desktop Context Prompt, Desktop SP / DSP) decides whether the Agent emits `::code-comment` directives, and the bounded gate that fixes CR-01 ("the rollout decision had no effective path at first Host creation").

## 1. Background: Desktop Context Prompt

The server ships the single-feature rollout via `/api/v1/client/configs`: `data.configs.desktopContextPrompt.enabled`.

- `enabled: true`: the Agent starts with the **desktop surface**; the system prompt injects the `::code-comment{...}` section (`apps/zcode-cli/packages/core/src/context/sections/desktop.ts`) and the assistant emits inline code-comments.
- `enabled: false` or absent: the Agent starts with the **terminal surface**, skips the section, and emits a normal terminal prompt.

## 2. Frozen chain (core facts)

Once the decision leaves desktop main it is frozen across process boundaries:

```
desktop main 进程
  └ createDesktopContextPromptRollout          ← 拉取 + 缓存裁决（TTL 1h，请求超时 3s）
        │  getSnapshot().enabled（live，随成功 refresh 更新）
        ▼
  └ resolveDesktopContextPromptEnabledForHost()  ← Host fork 时同步读快照
        ▼
  └ spawnHostProcess(env: ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED="0"|"1")  ← 烤进子进程 env
        │  （desktopHostProcess.ts:291）
        ▼
Host 子进程（Local Host / Remote Host）
  └ services/node.ts:614-621 顶层 const 只读一次 env → desktopContextPromptEnabled
        ▼
  └ resolveZCodeAgentPresentationSurface({...})  ← 只在 Host 启动时算一次
        ▼
  └ ZCodeAgentProcessManager.presentationSurface（Host 生命周期内冻结）
        ▼
  └ spawn CLI: --surface desktop | （缺省）--surface terminal
        ▼
Agent 子进程（CLI）
  └ run.ts:192 normalizePresentationSurface → "zcode_desktop" | "terminal"
  └ zcode-protocol-entrypoint.ts:31 runtimeConfig.presentationSurface（进程内冻结）
  └ context/builder.ts:114 仅当 "zcode_desktop" 注入 desktop context section
```

**Two freeze points** mean running Hosts/Agents never re-evaluate the rollout; only a newly forked Host reads the latest snapshot. So the decision's reachability depends entirely on `getSnapshot()` already holding the server truth at Host fork time.

## 3. CR-01: no effective path for the decision at first Host creation

Design tension: network requests must not block Local/Remote Host creation (`index.ts` comment), so `void rollout.refresh()` calls are fire-and-forget — but the surface is frozen at Host/Agent startup. Combined, an async success cannot reach the already-created first Host/Agent: the first `refresh()` is still in flight when the first Host forks, so `snapshot.enabled` reads `false`, `env="0"` is baked in, and even after the network resolves `enabled=true` the whole app session keeps the terminal prompt. Only a request that resolves before the first Host fork (fast network/cache hit) hits the rollout; on slow networks the first session always misses, typically needing a new window or restart, and a remote workspace reusing that Local Host inherits the wrong decision.

## 4. Fix: bounded decision gate before first Host creation

Give the success result one bounded effective path: await the decision once before the first Host fork; on failure/timeout still fail open.

```
app.whenReady
  ├ void rollout.refresh()                  ← 预热（最早发请求，复用 inFlight）
  └ ensurePrimaryWindow → createWindow
        └ dom-ready handler（async）:
              … 同步 setup（cancel/gen/win32 show/oldChild 处理）不变 …
              if (awaitFirstHostSpawnDecision)            ← 新增：有界门
                  await awaitFirstHostSpawnDecision()     ≤2s，first-only 永久 latch
              spawnLocalHost()                            ← 此刻快照已是服务端裁决
```

Key design points:

1. **`rollout.awaitFirstDecision(timeoutMs)`** (`desktopContextPromptRollout.ts`)
   - `Promise.race([refresh(), setTimeout(timeoutMs)→snapshot])`.
   - Reuses `refresh()`'s TTL/inFlight dedupe and the internal 3s request timeout; both branches resolve (refresh catches internally, timeout falls back to the current snapshot); never rejects.
   - **Stateless** — the first-only latch is held by the caller (desktop main).

2. **`firstHostSpawnDecisionPromise` + `awaitFirstHostSpawnDecision()`** (`index.ts`)
   - Module-level permanent latch (never cleared after the first creation). All later forks await the already-resolved promise at ~0ms.
   - Timeout `DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS = 2_000` (< the internal 3s request timeout, leaving buffer).
   - Even if the first Host times out and falls back to `false`, the background request eventually succeeds and `getSnapshot()` turns true — later forks (new window/reload) read the live snapshot and hit the rollout; no latch re-arm needed.

3. **Local path** (`desktopWindowLifecycle.ts`)
   - The dom-ready handler becomes `async`; between the reattach early-exit path and `spawnLocalHost`, insert `if (options.awaitFirstHostSpawnDecision) { await options.awaitFirstHostSpawnDecision(); }`.
   - **An `if` guard, not `await cb?.()`**: with no callback, no await happens at all and the async handler runs synchronously — zero regression for existing callers and tests that inject no gate.
   - `spawnHostProcess`'s signature/return type is unchanged; `spawnLocalHost` stays synchronous.

4. **Remote path** (`desktopRemoteSessions.ts`)
   - `createRemoteWorkspaceSession` (covering the SSH/WSL/Dedicated fork points) and `createBotRemoteWorkspaceRuntimePort` (a 4th fork point not going through createRemoteWorkspaceSession) await the gate after the `appShutdownStarted` check.
   - **Teardown re-check**: mirroring the existing "window/app may tear down across an await" guard around `:1841`, re-validate `appShutdownStarted` and `win.isDestroyed()` after the gate await; on a hit, throw — never fork outside the quit barrier.
   - `spawnHostProcess`'s signature/types are unchanged; the 4 fork points need no async conversion and no pool changes.

### Timeout / latency semantics

| Scenario                                 | First-Host latency                             |
| ---------------------------------------- | ---------------------------------------------- |
| Fast network/cache hit (request < 500ms) | ~0ms (gate resolved before dom-ready)          |
| Slow network (request > 2s)              | at most +2s (fail-open continues with `false`) |
| All forks after the first Host           | ~0ms (latch resolved; live snapshot read)      |

The +2s on slow networks lands before "first workspace opens", not before the window shows. Accepted trade-off.

## 5. Multi-surface / boundary compatibility

- **Desktop**: the gate lives only in desktop main; Local and Remote (SSH/WSL/Docker) share the one first-only latch.
- **Web/mobile**: no host fork, unaffected. Mobile `/remote` attaches to a desktop Local/Remote Host that already exists and inherits that Host's creation-time decision — exactly why the first-Host decision must be correct.
- **Web remote-control protection**: the gate sinks no session/task/stream state to relay/main; it is a one-time await inside main. The `continuous` (desktop) and `replayable` (mobile) boundaries are unaffected.

## 6. Test coverage index

| File                                                        | Covers                                                                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/test/desktopContextPromptRollout.test.ts` | rollout parsing, TTL, inFlight dedupe, 3s timeout; `awaitFirstDecision` slow-response/timeout-fallback/concurrency; CR-01 integration (slow `enabled=true` + bounded await → synchronous snapshot reads truth) |
| `packages/desktop/test/desktopWindowLifecycle.test.ts`      | Local dom-ready → spawn flow; no spawn before the gate resolves, spawn after it resolves                                                                                                                       |
| `packages/desktop/test/desktopRemoteSessions.test.ts`       | Remote fork points; gate blocks spawn, session completes after resolve; teardown during gate await → re-check intercepts, no spawn                                                                             |

## 7. Constants / env vars

| Name                                           | Location                             | Meaning                          |
| ---------------------------------------------- | ------------------------------------ | -------------------------------- |
| `ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV`     | `packages/shared/src/runtimeEnv.ts`  | Main→Host env name (`"0"`/`"1"`) |
| `DESKTOP_CONTEXT_PROMPT_REQUEST_TIMEOUT_MS`    | `desktopContextPromptRollout.ts:9`   | Per-request timeout 3s           |
| `DESKTOP_CONTEXT_PROMPT_CACHE_TTL_MS`          | `desktopContextPromptRollout.ts:10`  | Success cache TTL 1h             |
| `DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS` | `packages/desktop/src/main/index.ts` | First-Host gate timeout 2s       |
