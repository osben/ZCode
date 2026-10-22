# desktop-storage-sweep-gate

Main 进程的启动门：只让每个应用进程里第一个本地 Host 的 InitLocal 带 `sweepAbandonedReservations`，其余本地 InitLocal 等第一个 Host 报告 `ready` / `failed` 或退出后再发送。规则与理由见 `specs/first-submission-lifecycle.md`「Placeholder startup sweep」。

不变量：

- `claim()` 每个进程只对第一次调用返回 `sweepAbandonedReservations: true`，其后都为 false。
- 后续 ticket 的 `open` 只在第一 ticket 的 `settle()` 后兑现；`settle()` 幂等，非第一 ticket 的 `settle()` 为空操作。
- 不使用计时器；卡住的启动由 Host 侧的启动状态超时转为 `failed`。
- 门只延后 InitLocal 的发送，不延后端口创建与交给渲染进程。
- 接线点：`spawnHostProcess`（`desktopHostProcess.ts`）；它的 `localHostStartupGate` 缺省时不门控。
