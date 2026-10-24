# Side Pane Terminal cross-workspace session keepalive

> Increment to [`docs/ui/side-pane-terminal-tabs.md`](../ui/side-pane-terminal-tabs.md). The original design covered keeping terminals mounted when switching side pane tabs or collapsing the pane; this spec extends the keepalive contract to cross-workspace switching.

## 0. Relation to the existing design (inviolable)

`docs/ui/side-pane-terminal-tabs.md` already states:

- Each side pane terminal tab is an independent terminal instance; the `+` menu always creates a new one, never a singleton.
- The bottom Terminal panel does not share terminal session state with side pane terminal tabs.
- Closing a tab unmounts `TerminalSession` and releases the terminal process; switching other side pane tabs / collapsing the side pane keeps it mounted.

This design strictly keeps: no session sharing with the bottom panel, each side pane terminal still independent per tab.id — only the keepalive contract extends to workspace switching.

## 1. Root cause

`TerminalSession.tsx:309-639` binds XTerm instance + PTY + subscriptions in one effect:

```
effect 创建:  new XTerm(:318) → term.open(container)(:338) → terminalService.create(:440) → 订阅 data/exit
effect cleanup(:606-628):  terminalService.dispose(杀PTY,:622) + term.dispose(销xterm+scrollback,:626)
effect 依赖(:629-639):       [cwd, sessionId, services, onShellLabelChange, 多个 resize callback, ...]
```

Any changed dependency reruns the effect → cleanup → xterm+PTY disposed → history lost. Side pane terminals live in the per-workspace `sidePaneState` system (replaced wholesale by `sidePaneMemoryKey`, `useAppPanels.ts:229-243`), so a workspace switch necessarily unmounts or changes dependencies. A render-level parallel pool + forceMount cannot stop effect-dependency changes and diverges from the sidePaneState replacement mechanism. The correct fix is moving xterm+PTY ownership out of the component tree, so any unmount/remount leaves them intact.

The bottom panel does not lose history because its `panelState` (`Terminal.tsx:99`) was never per-workspace (a single-instance component state holding all workspace sessions) plus forceMount; the per-workspace side pane cannot reuse that.

## 2. Design: module-level registry owns xterm+PTY

A module-level singleton `sidePaneTerminalSessionRegistry` maps `persistentKey(=tab.id) → { xterm instance, fitAddon, terminalId, subscription disposers, cwd, hostEl, profileTheme }`. `TerminalSession` gains a `persistentKey?` prop: with it, the registry reuse path runs; without it, the original path (bottom panel untouched).

```
                      模块级单例（仅 side pane，与下侧 panelState 完全独立）
                  ┌──────────────────────────────────────────────────────────┐
                  │ sidePaneTerminalSessionRegistry                           │
                  │   Map<persistentKey(=tab.id), entry>                      │
                  │   entry = { key, term: XTerm, fitAddon, terminalId,        │
                  │             cwd, workspaceKey, hostEl(常驻 div,            │
                  │             term.open 在它上面), profileTheme(create 返回, │
                  │             跨重挂常驻), dispose(由创建方注入) }           │
                  │   + stashDiv(display:none 挂 document.body)               │
                  └──────────────────────────────────────────────────────────┘
                  API: has/get/register/attachDom/detachDom/release/releaseByPredicate
                       （registry 不内建 factory——资源创建由 TerminalSession 完成，再 register）
                           ▲
                           │
              TerminalSession 加 persistentKey?: string + workspaceKey?: string
              ┌────────────────────────────────────────────────────────────┐
              │ 有 persistentKey（仅 SidePaneTerminalPane 传 = tab.id）:    │
              │   effect:  get(key) 命中→复用 / miss→创建并 register         │
              │             attachDom(key, container)                       │
              │   cleanup: detachDom(key)  ← 不 dispose，hostEl 移回 stash  │
              │ 无 persistentKey（下侧）: 走原 effect（字节级不变）          │
              └────────────────────────────────────────────────────────────┘
```

### Ordering

```
[workspace A] 打开 side pane terminal tab（tab.id = terminal:uuid1）
  SidePaneTerminalPane(persistentKey=tab.id, workspaceKey=A, cwd=A)   ← 不再 useState(createUuid)
   └ TerminalSession effect [有 persistentKey]
       ├ get(tab.id) 命中 → 复用；miss → 创建：new XTerm + open(hostEl) + 创建 PTY + 订阅
       │                    → entry.workspaceKey = workspaceKey → register(tab.id, entry)
       ├ termRef/fitAddonRef/terminalIdRef ← entry 的引用
       ├ attachDom(tab.id, containerRef)  → hostEl 从 stash 移入 container
       └ fitAddon.fit()                   → 按真实尺寸 resize PTY

[切到 workspace B] sidePaneState 整体替换，旧 SidePaneTerminalPane 卸载
  TerminalSession cleanup [有 persistentKey]
   ├ 释放组件局部 observer（ResizeObserver/MutationObserver）
   └ detachDom(tab.id)  → hostEl 移回 stashDiv（term/PTY/订阅 都不 dispose）

[切回 workspace A] SidePaneTerminalPane 重挂（tab.id 稳定）
  TerminalSession effect [有 persistentKey]
   ├ get(tab.id) → 命中，返回已有 entry
   ├ attachDom(tab.id, containerRef) → hostEl 移回 container
   └ fitAddon.fit() → scrollback 历史完整保留 ✓

[显式关闭 side pane terminal tab]（useAppPanels 的 close 单/其他/全部）
  └ release(tab.id) → entry.dispose()(杀 PTY + 销 xterm + 释放订阅) ← 进程回收

[workspace tab 真正关闭]（WorkspaceShellLayout 监听 openWorkspaceKeys）
  └ releaseByPredicate(entry => entry.workspaceKey 不在 openWorkspaceKeys)
       → 回收该 workspace 残留的常驻 PTY，对称下侧 Terminal.tsx:145-177
```

## 3. XTerm instance reuse (technical core)

xterm scrollback lives in the XTerm instance buffer; reuse must keep the same instance — never dispose+new.

- `term.open(el)` runs once (at first creation, opened onto the entry's `hostEl`).
- Reuse physically moves `hostEl` (with the `.xterm` DOM subtree) into the current container via `appendChild`; call `fitAddon.fit()` after moving to restore size.
- detach moves `hostEl` back to `stashDiv` (`display:none`, attached to `document.body`, lazily created by the registry), preventing React unmount of the container from destroying the xterm DOM.
- Community precedent: VS Code terminal tab switching reuses xterm by DOM movement; canvas/webgl renderers recover with a fit after the move.

### 3.1 Input subscriptions must be registry-scoped (key contract, once broken)

`term.onData` (keyboard → PTY) and the Windows IME textarea fallback must go into `registryDisposers` (persistent with the entry), never `localDisposers`.

- `localDisposers` are fully disposed at cleanup (detach) — `term.onData` there would be cancelled while the reuse path never rebinds, leaving scrollback intact but input dead after switching back (PTY/xterm alive, only the input chain severed).
- `registryDisposers` persist with the entry; only `release` (tab close / workspace close) via `entry.dispose` cleans them.
- The Windows textarea fallback originally relied on the single-effect closure variable `ptyCancelled`; in the registry it must drop that check (`ptyCancelled` turns true after detach and would permanently disable the fallback). At release the disposer removes the listener; after PTY disposal, write is a no-op — safe.
- The persistentKey path's `onData` must stay byte-aligned with the original path (including `inputFallbackKeydownCandidate` dedup + `recordTerminalInputFallbackHandledData`/`recordTerminalInputFallbackRecentData` history maintenance). A simplification once dropped this, breaking Windows Chinese IME direct input via Shift. `customKeyEventHandler` attaches to term at first creation and persists with it, writing candidates on keydown; the registry-scoped onData consumes candidates and maintains history; the textarea fallback consumes history — all three share the first-creating component instance's refs and stay consistent across detach/reattach.
- After PTY readiness, `flushTerminalServiceResize()` must run (symmetric with the original path): sizes queued by the ResizeObserver into `pendingTerminalSizeRef` during creation flush immediately after `terminalIdRef.current = id`; otherwise `scheduleFitAndResize("init")` skips on pending dedup and the PTY stays at wrong cols/rows.
- Exit subscription mirrors the original path: with `onExit` it calls back (autoClose), otherwise writes the exit hint. The side pane currently passes no `onExit` so both are equivalent; keep symmetric for future wiring.

## 4. Implementation strategy: independent registry path, original path untouched

To guarantee zero regression for the bottom terminal (core feature), the persistentKey path in `TerminalSession` has its own resource-creation logic (factory) instead of extracting or disturbing the original ~300-line effect:

- Original path (no persistentKey, bottom): effect logic, cleanup, and dependency array byte-identical.
- Registry path (persistentKey): the effect branches at the top into `ensureSession(key, factory)`; the factory news XTerm + opens(hostEl) + creates the PTY + subscribes (logically symmetric to the original path but a standalone function, reusing the same `terminalService`).

Cost: duplication between factory and original creation logic. Benefit: zero risk to the bottom panel; the registry path is independently controllable and testable.

## 5. Boundaries and compatibility

- Side pane only: `persistentKey` comes only from `SidePaneTerminalPane` (= `tab.id`). The bottom `Terminal.tsx` does not pass it and keeps the original path.
- `terminalService` untouched: the PTY stays in the root-level shared singleton (local workspaces share `baseServices`); only the dispose timing is registry-controlled (dispose only on explicit tab close).
- The `sidePaneState` replacement mechanism is untouched: browser/subagent/plan tabs behave as before.
- The registry isolates by `persistentKey`(=tab.id), never matching by `workspacePath` (per workspace-identity constraints). A remote workspace's PTY still belongs to the current window services; the registry stores only PTY id references and changes no ownership.
- No session/task realtime or replayable/continuous involvement: pure renderer terminal DOM reuse.
- Complete reclaim points (no orphan PTUs):
  - Explicit side pane terminal tab close → `useAppPanels`'s `handleCloseSidePaneTab` / `handleCloseOtherSidePaneTabs` / `handleCloseAllSidePaneTabs` call `release(tab.id)`.
  - Real workspace tab close → `WorkspaceShellLayout` watches `openWorkspaceKeys` and batch-`releaseByPredicate` by `entry.workspaceKey` (mirroring the bottom `Terminal.tsx:145-177`). `workspaceKey` is passed through `SidePaneTerminalPane → TerminalSession` into the entry.
  - Registry module unload/tests → `clearForTest()`.

Implementation landed as: `packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts`, `persistentKey?`/`workspaceKey?` props on `TerminalSession`, `SidePaneTerminalPane` passing `sessionId`(=tab.id) + `persistentKey` + `workspaceKey` (no more `useState(createUuid)`), `AnimatedSidePanePanel` forwarding both, and the release wiring above. Verified with `sidePaneTerminalSessionRegistry.test.ts`, the `TerminalSession` reuse contract tests, `terminalPanelState.test.ts` regression, typecheck, and lint.

## 6. Risks

- xterm DOM physical-move renderer refresh (§3) — fit must restore; fallback is a React Portal projecting the persistent `hostEl` (still no instance disposal).
- Registry memory: every workspace/tab close must release, avoiding orphan PTYs.
- Long-term sync of factory vs original-path duplication — guarded by `TerminalSession` reuse contract tests + `terminalPanelState.test.ts`, but the two copies have drifted 3 times (§8); the real fix is the §8 `wireTerminalProcessing` convergence refactor.

## 8. Pending refactor: converge terminal processing into one `wireTerminalProcessing` (design, not implemented)

> This section records the architecture defect exposed after keepalive landed and the target refactor. Not yet implemented; reserved for a dedicated effort.

### 8.1 Problem: the two paths are copies, not shared

The ideal (and product intent) is a single terminal-processing implementation, with the persistentKey and original paths forking only on container management. Today `TerminalSession.tsx`'s effect holds two ~370-line parallel branches kept byte-aligned manually by comments plus structural assertions in `terminalSessionFocus.test.ts`.

```
当前结构（问题）：
useEffect(() => {
  if (persistentKey) {
    复用路径: registry.get → attachDom/fit/focus
    首建路径: new XTerm → open(hostEl)
              ┌─────────────────────────────────────┐
              │ customKeyEventHandler               │  ◀── 终端处理
              │ themeObserver / registerLinkProvider│      （第一份拷贝）
              │ .create().then(flush+opts+data+exit │
              │   +onData+textareaIME)+resize+catch │
              └─────────────────────────────────────┘
    → registryDisposers / localDisposers
    cleanup: detachDom（保活）          ┐
  }                                    │ 容器管理（合理分叉）
  else {                               │
    new XTerm → open(el)               │
    ┌─────────────────────────────────┐│
    │ 同样的处理逻辑，再写一遍         ││  ◀── 终端处理（第二份拷贝）
    └─────────────────────────────────┘│
    → disposables（effect 局部）        │
    cleanup: dispose 全部（销毁）       ┘
  }
})
```

### 8.2 Evidence: three drifts already happened

| # | Item | Consequence | Status |
|---|----|------|------|
| 1 | `flushTerminalServiceResize()` | persistentKey path did not flush queued resizes after id ready; PTY stuck at wrong cols/rows | Fixed (f8cfca38b7) |
| 2 | exit subscription checking `exitHandlerRef` | persistentKey path's exit subscription did not check the onExit callback, asymmetric with the original path | Fixed (f8cfca38b7) |
| 3 | paste shortcut `logger.debug("[Terminal] paste via shortcut")` | persistentKey path's customKeyEventHandler missed this debug log | Aligned |

All three are direct products of two inevitably-drifting copies.

### 8.3 Target structure

Extract the single terminal-processing function; both paths keep only pure container management:

```
// 终端处理：全局唯一
function wireTerminalProcessing(term, host, ctx): {
  termDisposers: IDisposable[],   // 跟随 term 生命周期（data/exit/onData/linkProvider）
  domDisposers:  IDisposable[],   // 跟随 DOM 容器生命周期（themeObserver/resizeObserver）
  cancelPtyCreate: () => void,    // cleanup 早于 create resolve 时的孤儿 PTY 守卫
}
{
  // 以下全部只写一次：
  // - attachCustomKeyEventHandler（IME candidate + Ctrl/C/V）
  // - themeObserver（documentElement class → 配色）
  // - registerLinkProvider
  // - terminalService.create().then(
  //     flushTerminalServiceResize + windowsPty/font/theme options +
  //     (theme 写入 entry.profileTheme，跨重挂常驻；observer 从 entry 读，禁用组件局部 ref——CR-01) +
  //     onDynamicData + onDynamicExit + onData(IME 三段去重) + textarea 兜底 +
  //     scheduleFitAndResize("init") + requestFocus)
  // - ResizeObserver（observe host）
  // - .catch（写失败提示 + 释放 registry 占位 entry：ownership 校验
  //   registry.get(key)===本次 entry 才 release，避免僵尸 entry 被复用快路径
  //   误用导致终端永久无法连接；校验防重挂后新 entry 被误删）
}

useEffect(() => {
  if (persistentKey) {
    const existing = registry.get(persistentKey)
    if (existing) { attachDom(hostEl); fit; focus; return () => detach }   ┐
    const term = new XTerm({...}); term.open(hostEl)                        │ 容器管理
    const { termDisposers, domDisposers, cancelPtyCreate } =               │ （分叉）
        wireTerminalProcessing(term, hostEl, {...})                         │
    registry.register(persistentKey, { term, termDisposers, workspaceKey }) │
    localDisposers = domDisposers                                          │
    return () => { cancelPtyCreate(); detachDom; drain(domDisposers) }      ┘
  }
  const term = new XTerm({...}); term.open(el)                             ┐
  const { termDisposers, domDisposers, cancelPtyCreate } =                 │ 容器管理
      wireTerminalProcessing(term, el, {...})                               │ （分叉）
  const disposables = [...termDisposers, ...domDisposers]                  │
  return () => { cancelPtyCreate(); drain(disposables); dispose(term+pty) } ┘
})
```

### 8.4 Why two disposer classes

- term-following (`termDisposers`): `onDynamicData` / `onDynamicExit` / `term.onData` / `registerLinkProvider` — the PTY ↔ term data links. In the persistentKey path the term survives detach, so these subscriptions must persist with it (otherwise scrollback survives but input dies — the root cause of bug #1 / commit 9e32c2d2d9).
- DOM-following (`domDisposers`): `themeObserver` (observes documentElement), `ResizeObserver` (observes the current `el`). In the persistentKey path every remount gets a new node, so observers rebind per effect.

In the original path the term does not survive the effect, so both classes go into one `disposables` — exactly the post-refactor form (`[...termDisposers, ...domDisposers]`).

### 8.5 Test-first (red before green when refactoring)

1. New contract test: assert the `TerminalSession` effect calls the same `wireTerminalProcessing` in both branches (source-level: grep occurrence count = 2, not duplicated inside one if). This mechanically guarantees one copy of processing logic.
2. Keep the existing `terminalSessionFocus.test.ts` behavior contracts (IME onData bytes, exit symmetry, flush timing) — all must stay green after the refactor.
3. Regression: `terminalPanelState.test.ts` (bottom) + `sidePaneTerminalSessionRegistry.test.ts` (keepalive) must not degrade.

### 8.6 Risks and preconditions

- Scope: extract ~250 shared lines, each effect branch shrinks to ~40. Mostly mechanical, but touches async create timing, pending resize flush, and three-stage IME dedup — timing/IME-sensitive areas.
- No e2e safety net today (this feature's e2e was "optional later" in the original plan). Before refactoring, add one cross-workspace-switch + IME-input e2e (following the `browser-tab-close-cross-workspace.test.ts` skeleton); otherwise regression relies on unit tests + manual smoke.
- The refactor is pure structure, zero behavior change: after merging, both paths' externally observable behavior (scrollback keepalive, input, IME, resize, theme, exit hints) must match one by one. Ship it as its own MR with no behavior changes attached.

### 8.7 Origin

The 2026-08-12 audit of persistentKey-vs-original differences found the 3 drifts in 8.2. The user judged the duplicated branches a design flaw, required the design to be fixed in writing first with the refactor later; only the found drifts were aligned at the time. This section is that recorded design.
