# Untracked File Line Count Statistics Reading Budget

Update date: 2026-09-14

## Reason and Scope

Windows 3.12.1 logs showed the Host reaching an external-memory peak of about 2.67 GiB during Git refresh.
Existing `buildUntrackedStats` concurrently calls `readFile` for every untracked file and only identifies binaries after fully loading them.
In an isolated reproduction, a 256 MiB binary file increased external heap memory by about 256 MiB, while the final result still reported zero lines.
`git status`'s 512 KiB output limit constrains only the path list, not the size of file contents.

本次修复 Git 状态刷新中的未跟踪文件统计；不调整 Git 命令、已跟踪文件统计或 diff 预览。

## Behavior Contract

- Single file statistics upper limit 为 1 MiB，超过上限的文件保留 change entry，行数沿用不可统计 file 的 `added=0, removed=0`。
- Ordinary text 在 budget 内保持精确行数：supports empty file、LF、CRLF、末尾无换行及跨块换行。
- 先 check file type 和 size，只读 ordinary file；每次最多读取 64 KiB，任意 block 发现 NUL 即按 binary 返回 zero 行。
- 每次 statistics 最多四个 worker，各自复用一个 64 KiB Buffer；reading buffer total 最多 256 KiB，不随 file 数量或 total 大小 growth。
- 文件在 check 后继续 growth 时，最多读取 1 MiB + 1 字节用于判断越界；越界返回 zero 行，不返回 partial 计数。
- Delete、read 失败、非 ordinary file 保持 zero 行回退；already opened handle 在 success、binary、越界和 exception path 均关闭。
- 不增加持久 cache、background timer、second Git 状态或 new RPC。

## Ownership and Sequence

```text
桌面/手机 Web/远程 workspace 的现有 Git refresh
  → workspace 所在 services 的 GitCliRepo.getStatus
  → 未跟踪条目 → 四个 worker → 大小 check → 分块 statistics → 同一 status 快照
                                          └─ 大文件/二进制/失败 → zero 行，条目保留
```

Reading budget 与 worker 只属于一次 repo query，existing in-flight 合并和 UI 迟到 result 判断保持原样。
File path 仍用 workspacePath/repoRoot；不新增 identity cache，不改变 workspaceIdentity 隔离。
Shared services implementation 覆盖 Windows/macOS/Linux、本地及远端 execution；不涉及 Agent runtime、
CommandInbox、owner、snapshot、desktop continuous 或 mobile replayable 链路。

## Verification Contract

- Single test verification真实 small file line number、over-limit file 不 read content、二进制提前停止、四 worker 上限、growth竞态和 handle 回收。
- Existing Git repo/service 回归 verification条目和 staged/unstaged behavior保持兼容。
- SP13 pending file attachment independent resource回归：真实 watcher auto refresh 后 small file 更新为 `+4 -0`，over-limit text 不计 line number，记录 Host working set 峰值；不依赖 Git pane navigation。
- 以相同 8 × 32 MiB binary file 重跑修复前 memory probe，对照 heap external memory increment。

## This Verification（2026-09-14）

- 相同 8 × 32 MiB binary file，直接 execute actual helper：修复前 heap external memory 增量约 256 MiB，修复后约 0.3 MiB；两次 statistics 结果均为 zero 行。
- Git helper / repo / service：35 项单测通过；新增 reading budget test 在 old implementation 上为 4 failure、1 通过，修复后全部通过。
- 真实 macOS Electron 资源回归通过，auto refresh 后 status bar 为 `+4 -0`，Host working set 峰值增量 1,648 KiB；independent 重跑为 464 KiB（1 case 通过），没有 call model。报告位于 `packages/desktop/.e2e-artifacts/desktop-e2e-20260914-041207-001/summary.md`。
- `pnpm typecheck`、desktop `typecheck:e2e`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 保留原有 42 项 warning，无 error。
- 原有 SP13 `Changes` 打开 Git pane 的 pending 场景本轮 failure，未 execute 到大 file 读取；附加 resource 回归 independent running，不宣称修复该 navigation 问题或整个 pending 文件通过。
- conversation 覆盖率 audit 仍报 I74/I75 unknown abbreviation、计数与生成 document 过期；用 current HEAD 的临时干净 directory 运行得到相同错误，本次不修改 audit baseline。
- Windows、Linux、手机 remote control 与远端 workspace 未实机 verification；shared repo implementation 未改 protocol/identify isolation，E2E 用 Git 元数据变化 trigger refresh 以兼容 Linux non-recursive listen。

Independent resource running command：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-git-review-entry.test.ts \
  --mochaOpts.grep 'Git 自动刷新'
```
