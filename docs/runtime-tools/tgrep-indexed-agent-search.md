# tgrep 索引化 Agent 搜索契约（规划稿）

状态：normative contract，尚未实现。执行顺序、gate 定义与 TG01–TG14 case 目录见
[实施计划](../plan/2026-10-10-tgrep-indexed-agent-search.md)。本文只固定产品契约；阶段 1 的
技术取证见 [spike 证据](spikes/tgrep-v1.1.0-stage1/README.md)。现有 bfs/ugrep startup 开关的
语义由 [embedded-search-native-build](embedded-search-native-build.md) 继续持有，本文不改变它。

## 目标与范围

用户为单个 workspace 打开「用本地索引加速 agent 搜索」后，ZCode 用随包分发的 tgrep 二进制
为**仓库级 `rg` 查询**提供索引加速；其余搜索（`find`/`grep`、stdin、显式文件列表等）保持现有
路径与语义。默认关闭；未证实新鲜度时一律回落现有搜索，不允许出现假阴性结果。

范围外：语义搜索、MCP、聊天历史搜索、跨 worktree 共享索引、按文件数阈值自动启用、
修改系统 PATH 或用户终端行为。

## 固定版本与交付

- 工具固定为 Microsoft `tgrep v1.1.0`（候选版本；升级必须重新过本文全部 gate）。归档按
  `platform-arch` 固定 SHA-256，来源与摘要与 `scripts/tgrep-stage1/lib/tools.mjs` 一致：

  | 目标          | 归档                                             | SHA-256                                                            |
  | ------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
  | macOS arm64   | `tgrep-v1.1.0-aarch64-apple-darwin.tar.gz`       | `22a750a5d30a11d4e3a2503f2bc40e2ed694b01f011d6dc0cb4c674031503737` |
  | macOS x64     | `tgrep-v1.1.0-x86_64-apple-darwin.tar.gz`        | `f745ab68456534e76fc67c67a4abf503b962de60f1e844f7ac45b010dac105af` |
  | Linux arm64   | `tgrep-v1.1.0-aarch64-unknown-linux-musl.tar.gz` | `ae73fa72c182a55a1176ed64e8ee46a24dc469f23259c9179204001bb87bb205` |
  | Linux x64     | `tgrep-v1.1.0-x86_64-unknown-linux-musl.tar.gz`  | `c6dbb89581453b41eee94ff291de859d37ce7972c4208bf9eab53e67bf6e3f9d` |
  | Windows arm64 | `tgrep-v1.1.0-aarch64-pc-windows-msvc.zip`       | `b1a201f5a561289468d4122b05e47d0af810b16364cb29e564f8a55450b72c72` |
  | Windows x64   | `tgrep-v1.1.0-x86_64-pc-windows-msvc.zip`        | `8a47a00964b4f2a8213693b76807b96c956bbd1ba5eede5eb5a06df992ab3a65` |

- 交付走现有 native-search 资源管线（release plan、`.bundle-meta.json`、归档摘要校验、
  notice），作为**可选加速器**加入：资源缺失/损坏 → 加速不可用并给出原因，绝不阻塞
  Host 启动、remote 连接或现有搜索；不做运行时编译，不做系统安装。
- 资格门禁沿用现有打包边界：macOS deployment target 不高于 Electron 基线；Linux 使用 musl
  静态归档；Windows 过 PE machine/import 静态校验。当前只有 darwin-arm64 完成过 spike
  取证；其余 target 在阶段 2 打包资格中补验，未验证前不得进入发行启用集合。
- 索引与共享存储放在用户数据目录的受管缓存内（tgrep `--shared-storage`），不写入仓库
  worktree；tgrep 默认的 `.tgrep` 仓库内目录不用于本功能。

## 运行模式：必须使用 shared daemon

阶段 1 取证（见 spike 结果）固定了模式选择：

- 普通 `tgrep serve` 只有异步 watcher/poll 刷新，没有显式 refresh 确认命令：写后立即查询
  存在可见延迟窗口（O1 实测），`--no-watch` 下永久陈旧（O2 实测）。普通模式**不能**提供
  本契约要求的新鲜度证明，禁止用于加速态。
- 唯一合格模式是 shared repository daemon：

  ```text
  tgrep serve --shared <workspace-root> --shared-storage <user-cache-dir> [--watch-mode auto]
  tgrep shared attach <workspace-root> --revision <commit> --lease <owner-token>   # JSON: ready/epoch
  tgrep shared refresh <root> --lease <lease> --changed <path>...                  # JSON: processed_epoch
  tgrep shared refresh <root> --lease <lease> --full                               # 校验全部字节
  tgrep status --json <root>                                                       # ready/epoch/published_epoch
  tgrep shared detach <root> --lease <lease>
  ```

- watcher 策略固定为 native watch **开启**（默认 auto）：外部写入事件会关闭 ready（S3 实测），
  这是外部编辑唯一的安全信号。`--no-watch` 会让外部写入保持假 ready（S2 实测），仅允许在
  阶段 1 取证脚本里使用，产品禁止。
- 周期性 reconcile（`--poll-interval`，默认 120s 全量）是漏事件修复机制，**不是**新鲜度
  证明；ZCode 侧对新鲜度有任何怀疑时必须执行 `refresh --full` 并等待确认。
- lease 是 caller-owned token（1–128 位 ASCII），由 workspace 搜索 owner 生成并在发起
  attach 前持久化于内存；detach 失联可凭 lease 幂等恢复。daemon 重启后旧 lease/instance
  失效，owner 必须以同一起始 revision 重新 attach，恢复出的 checkpoint 先经完整校验再谈
  ready。

## 架构与所有权

| 事实             | 唯一 owner                                                        | 说明                                                    |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| 用户 intent      | 现有 SettingService（workspace 级持久化，默认 false）             | UI 只持有 pending；确认值以 SettingService 回读为准     |
| 二进制资格       | execution Host 的 runtime tool resolver（资源准备/摘要/架构校验） | 无效资源 → unavailable，不回退系统 tgrep                |
| 运行时生命周期   | Agent bootstrap 组合根里的 workspace 搜索 manager                 | 同一 Agent 的所有会话、Explore、subagent 共用一个 owner |
| 查询准入与新鲜度 | 同一 manager 的 query gateway                                     | per-request 决策；许可不缓存在 session                  |
| 索引字节         | 受管用户缓存目录里的 tgrep shared storage                         | 生命周期归 owner；清理是缓存 IO，不是 UI 文件操作       |

- identity key 统一 `workspaceIdentity?.trim() || workspacePath`；`workspacePath` 只用于文件
  与 cwd。同一物理 root 上的两个独立 Agent 进程使用**各自**的 shared-storage 命名空间与
  daemon，不共享 view，也不承诺跨进程新鲜度（计划 D06/TG08 的独立取证完成前不放开）。
- 协议新增独立控制契约（保存 intent / 应用 intent+revision / 订阅 status / 查询准入 /
  写入失效），走 shared protocol 严格 schema；不复用 `session/requestRuntimePreferences`
  作为唯一通道（它是 startup-only 语义）。
- 状态投影：`requested`、`applied revision`、`owner instance`、`status sequence`、`phase`
  （off/preparing/indexing/ready/dirty/unavailable）、fallback 原因、qualified version、
  可空 cache 大小。UI 只在同一个 owner instance 内比较 sequence。运行时事实（PID、epoch、
  ready）不持久化，重启后按 unknown 处理。

## 状态机与生命周期

```text
off → preparing → indexing → ready
ready → dirty（owner 提升写 epoch：Edit/Write/ApplyPatch/合格 Bash 写入/分支切换前）
ready|dirty → unknown（watcher 事件溢出、断连恢复、ignore 策略变化、任何怀疑）
dirty|unknown → ready（仅当 refresh 确认覆盖目标 epoch）
任意 → unavailable（资源缺失/损坏、进程崩溃、平台不支持；有界重试，无重启循环）
```

- `off` 使激活 token 失效：旧 token 的迟到 build/status 不得应用；重新开启生成新 token。
- 关闭只影响后续请求；已准入的查询允许正常完成或取消。会话关闭不停止其他会话的索引；
  Agent 退出时 owner 负责 detach 全部 lease 并按归属检查后终止 owned daemon（Windows 先
  释放 root handle 再允许 worktree 删除/移动）。

## 新鲜度契约（gate D09/G1）

1. **写入前置**：任何被准入的修改操作（含部分失败）在产生效果**之前**提升写 epoch，并把
   受影响路径记入 pending 集合。该 guard 覆盖同一 Agent 的全部会话与 subagent。
2. **加速准入**：仅当 `refresh --changed <pending>`（或怀疑时的 `--full`）返回
   `processed_epoch ≥ 目标 epoch` 且 `ready === true` 时，本查询走索引。等待确认期间的
   查询走 baseline；禁止用固定 sleep 冒充确认。
3. **外部写入**：native watch 事件关闭 ready（事件到达即 dirty）。窗口内漏掉的事件由
   周期 reconcile 修复，但修复完成前不恢复加速；对 restored-mtime/同尺寸编辑，唯一恢复
   手段是 `refresh --full`（S2 实测：`--no-watch` 下假 ready，`--full` 后可见）。
4. **流式冲突**：查询开始流式输出后若 writer 开始，准入时固定的策略不得中途更换；writer
   先于结果发布开始时，未发布的结果必须丢弃并改走 baseline。已流式输出的部分不得在之上
   叠加 fallback 输出（避免重复行）。
5. baseline 指**现有搜索路径**（当前 `rg` shell function / 随包 rg 14.1.1），不是
   `tgrep --no-index`：关掉索引不消除过滤器与 regex 引擎差异。

## 查询路由与允许清单

- 路由点在 Bash execution 的 per-query prelude 组装处（`embedded-search-prelude.ts` 所属
  层），不改 provider-visible tool 矩阵；只路由**仓库级 `rg`** 调用。`find`/`grep`
  （bfs/ugrep，BRE 语义）不参与加速。
- 初始允许清单（阶段 3 按 G3 parity 测试逐步解锁，不因 "ripgrep-compatible" 名称放行）：
  裸 `rg` + 字面量 pattern 的普通行输出、`-l`、`-c`；每扩展一项（regex、`-i`、context、
  glob/type、JSON）都需要独立 parity fixture。stdin/管道输入、root 外路径、显式文件参数、
  不兼容 flags/encoding/ignore 语义、不受支持 shell → baseline，保持 argv、stdin、stdout、
  stderr、退出码与取消语义原样。
- fallback 调用原来已解析的同一可执行文件（用户 `rg` 或随包 rg），不递归进 shell function；
  保留用户 `RIPGREP_CONFIG_PATH` 等配置语义；gateway 无法证明有效 config 时用 baseline。
- Bash 准入是独立 gate：仅「可证明纯搜索」的调用参与加速（复用现有 parser，若其确实
  可判）； substitutions、重定向、后台任务、`cd`、管道与复合命令不得用 regex 集合判安全。
  未知 Bash 在启动前取得 writer token，并在潜在写入期间保持 dirty；后台写入保持 dirty 直至
  确认结束。shell function 与 owner 之间的 bridge 通过现有 internal CLI 入口或等价最小
  adapter，走当前用户限定的本地 transport；endpoint/token 不写日志；bridge 不可能成为
  权限/沙箱绕过。无 bridge 或不兼容 → baseline。

## 缓存、观测与资源

- 缓存按 workspace 隔离、按最后使用做有界保留；显式 clear/rebuild 只作用于该 workspace 的
  受管索引，不影响活跃读者。关闭保留可用缓存。版本/格式变化不把旧缓存当 ready。
- 预算沿用现有 execution 输出限制；sidecar/查询准入前保留全部现有 permission/sandbox
  检查；缓存私有于当前用户，不随设置同步、不发布。
- 日志走现有 UI/service logger 体系：记录 version、effective engine、时长、fallback 原因、
  生命周期事件（info 级）；不记录文件内容、查询 pattern、凭据或内部地址；不逐查询打 info。
  daemon 崩溃/OOM 不触发无限重启。

## 验收

gate 定义（G1–G5）与 case 目录（TG01–TG14）在实施计划中维护，验收以 fixture/test 证据
关闭，不以口头描述关闭。本契约的关键不变量：

1. 无系统 tgrep 时，开关 on/off 下现有搜索行为完全不变。
2. 一个开关、离线、clean package 即可激活；不要求重启已打开会话。
3. 未证实新鲜度的索引不得产生「无匹配」结论（含部分匹配丢失）。
4. workspace/worktree/Host 身份隔离；同路径不同远端机器不合并。
5. 结果、权限与取消语义不因加速改变；加速仅发生在 parity 证明过的查询集合上。
