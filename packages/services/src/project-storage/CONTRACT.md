# project-storage

Host 项目组织态的持久化升级。调用者持有 app SQLite 连接，CLI 通过协议交接事实，不导入此模块。

`hasProjectWorkspace` reads only the active roots of the current Host's undeleted projects and their task-project links, which the Host uses for first CLI allocation. Tasks retained by a soft-deleted project still count as project workspaces. The default-task migration cleared task ownership, and leftover roots on its soft-deleted container do not take part in allocation. The query neither creates nor persists a process ownership, does not change task.cwd, and does not trigger a process migration when a task is moved. Process ownership is kept by ProcessManager until the original process exits.

- `0005_projects`（旧 ID `0001_projects`）首次迁移旧 settings 中保留的 workspace；不删除或改写旧列语义、不移动目录。
- 首次项目集合与 position 仅来自 lastWorkspaceSession 中本 Host 保留的项目条目，按原顺序去重，保留无任务的已保存项目。conversation、历史 tasks、recentProjects 和 Group 不创建项目；settings 缺失或列表为空时不推断项目。历史任务保留 cwd 与组织态，无匹配项目时保持 NULL；已有 ledger 不重跑转换、不重排或自动清理项目。
- ID 沿用 CLI 的四位递增序号 + snake_case 名称，两个库独立编号；开发期旧 ID 的本机更名不修改 SQL/checksum 或重新执行转换。
- 初始 cli\_\* 从旧列复制一次，之后只由 syncer 写。handoff_pending 为意图与首次判定 bit；NULL project_id 是合法最终组织态。
- 老版本新写行以 host_id IS NULL 识别，同一事务补身份、首次归位与 bit 8；用户在新版移出/新建的空归属不能再次自动分配。
- 普通发现同 host 唯一 root 匹配才归位，主要目录没有优先级。Group 保留独立组织态，不转换为项目。
- fork 首次接纳与子行 INSERT 同事务，按可信 hostId/workspaceKey/父 taskId 继承父 project_id（含 NULL）；父归属未就绪、身份不符或项目引用缺失则回滚。已接纳行不重算，不覆盖后续用户移动，也不批量修复旧空归属。
- settings 的 remote 条目只首次导入本机入口缓存，不能变成本机权威 project；普通启动不再导入。
- 迁移依赖 sqlite-migrations 公共端口；内部文件不被 UI/其他服务直接导入。目录/备份位置与 logger 均由启动入口注入。

App-controlled creation and ordinary creation share the creation receipt of `reserveCreatedTask`: the Host allocates the session ID when it reserves, keyed by `(workspace_key, client_id, command_id)`, and persists it. The App-control commandId is derived by the caller from the requestId, so a retry reuses the same receipt. `findCreationReceipts` is a read-only lookup by `(client_id, command_id)` without a workspace, returning each receipt's task sessionId and directories: App control calls it before resolving the project's main directory, and on a hit reuses the directory from the first attempt, which also covers a lost ACK; it neither reserves nor allocates a new ID. When the task a receipt points to no longer exists, it reports `project.creation-task-missing`. When `releaseReservedTask` revokes a reservation that has no CLI facts yet, it also deletes that session's creation receipt (abandon or "do not use worktree" after worktree creation fails, `docs/git/worktree.md` §3.5); when the row already has CLI facts, neither the row nor the receipt is deleted, and the receipt of a cleared task is kept.

The project repository's transaction surface: save/delete/move/reorder/reserveCreatedTask do not write cli\_\* columns. `discardCreatedTaskReservation` deletes only reservation rows that still match the placeholder signature (no CLI facts), and likewise does not write cli\_\* columns. List and directory resolution complete inside a synchronous SQLite read transaction and do not cross an await. Moving a task whose root is missing requires addMissingRoot=true; restore must be on the same host with an identical roots set. Project unique names are allocated inside the write transaction. A new task's ownership is committed only while undecided; later changes are explicit through moveTask.

项目树任务沿用原列表/Controller 的执行后端过滤：仅 `provider=ZCODE_AGENT_PROVIDER`（当前 glm）。旧后端行即使已补齐 cli\_\* 也不进入项目、置顶、未归类、时间线、归档和未读投影；新导入的当前 CLI 会话保留，不按 migration_source、模型供应商或目录存在性过滤。只读，不改旧数据或 migration，已升级数据库无需再次转换；本地与远端持库 Host 使用同一规则。

新建项目在原写事务内分配同 Host 的最小 position 减一（空集合为 0），排在已有项目之前；编辑/恢复不改 position。position 保留为首次显示的初始化依据；控制端拖拽使用侧栏偏好，不向远端调用 reorderProjects。既有行不重排，不增加迁移。

自动归档以 cli_updated_at 为筛选依据，排除置顶和已有非终态订阅，不按 project_id 或默认目录过滤。新归档与绑定定时任务的暂停使用同一 SQLite 事务；按完整 workspace_key / target_task_id 匹配，只暂停 active 且 enabled 的任务。历史归档不追溯处理，取消归档不恢复调度，已认领轮次沿用现有执行规则。

定时/闲时派发提供已保存的附加目录快照（含空数组），预留只验证同 Host 的既有项目，允许 roots 已编辑或项目已软删除；普通创建仍校验 cwd 属于当前未删除项目。快照不改写项目 roots，重复预留不覆盖已有归属。

带显式附加目录的新建将执行快照同事务写入 tasks.execution_directories，后续任何恢复从此不可变值读取；普通 session 为 NULL，继续读取项目当前 roots。重试不得覆盖快照，定义删除不改变生成会话的初始化配置。

旧 Group、成员与顺序保持独立，不按成员目录新增项目。用户手建空项目合法；不修改已发布的 SQL/checksum。

0006_default_workspace_tasks 一次性纠正系统 default 目录误迁移：只处理旧迁移时已创建且未编辑、未改名、单 root 的自动项目，任务 project_id 清空且容器软删；CLI 事实、执行目录、归档/置顶/未读及定时定义不变。只触及 tasks/projects，旧 checksum 不变；后续手建/恢复不会重复纠正。

## 2026-10-10 远程单目录合同

本地仍允许 0..n roots；可信 ownerHostId 非 local 的持库宿主只允许恰好一个固定 root。远程创建必须有项目，prepareSession、reserveCreatedTask 与 moveTask 不得产生无归属或附加目录；根路径更新和缺 root 拖动在写事务中拒绝。客户端 hostId 不能改变持库身份。历史迁移数据不被裁剪，失败不得部分写入。

启动入口复用 session 模块公开的旧 Repo 与迁移适配器：先 SQL 迁移并提交，再逐一 ensureReady/close，最后标记 prepared。Worker 必须注入旧 settings 以完成首次项目导入；进度复制迁移事实，失败不撤回已提交计数。storage-startup 子路径保持不变。

## 2026-10-21 Project tree read projection

`readTree` runs synchronously on the Host event loop for every navigation. Its task query must not select `tasks.searchable_text` (the full-text body, unused by the tree); it keeps every other column dynamic so older table shapes still load. The returned tree is unchanged.

## 2026-10-22 Reservation placeholder startup sweep

`sweepAbandonedReservations` (`project-repository.ts`) deletes only the `RESERVATION_PLACEHOLDER_SQL` rows of host `local`. It runs inside `prepareTasksIndexStorage` after the migration COMMIT and before the repos open, and only when the caller passes `sweepAbandonedReservations: true`. That option must be passed only by the first prepare attempt of the first local Host of an app process. Main sets the flag through `packages/desktop/src/main/storage-sweep-gate/contract.ts` and holds later local `InitLocal` messages until that Host reports a startup phase past `preparing_host_storage` (`preparing_session_storage`, `starting_services`, `ready`) or `failed`, or exits. Rules, the replay argument and the open race are in `specs/first-submission-lifecycle.md` ("Placeholder startup sweep").

## Explicit local open reuses an existing root

`saveProject` accepts a `reuseExistingRoot` option for an explicit local directory open. It is accepted only for a single-root request with no project ID and no editable fields. After the directory is validated asynchronously and normalized, the same Host write transaction either reuses the non-deleted project that contains that root or creates a single-root project. A primary directory match wins; otherwise the choice is stable by `position`, then by ID. Reuse does not change project metadata and does not restore a deleted project. Ordinary saves, the global new-task entry, and remote entries do not enable this option.

## Creation command ID allocation belongs to the Host

创建命令的 ID 分配属于 Host：`session_creation_commands` 以 workspace*key/client_id/command_id 为唯一键，与任务预留在同一写事务提交；首次缺省分配 `sess*${randomUUID()}`，重试只读原映射。显式 ID 冲突、映射对应任务已彻底删除均拒绝，不重新分配。无映射的旧请求仅查询原 3.16 哈希 ID，命中则保留旧 task 行并登记映射。0009 只新建映射表，不重写历史任务；命令执行与 ACK 仍由 CLI 裁决。

`reserveCreatedTask` 在 CLI fork 成功后、ACK 返回前，原子继承同 owner / workspace / root 父任务的项目与执行目录。事实先到与 ACK 先到顺序可交换；已完成归属判定的行（含 NULL）不重分配。受管 worktree 的两条首次写入路径共用父行继承函数，同时保存 cwd、worktree_root 和附加目录，不能将 cwd 当成 workspace。CLI 事实首次摄入优先使用持久化 fork 父引用，不把同目录的其他项目当作父归属。

`0010_remote_task_ownership` 保留 3.17.2 已发布的历史迁移及 checksum：完整同 workspace 父引用，或无父引用时唯一未删除 root 匹配。只写 tasks 的项目与判定位，不改事实/排序/未读/归档/执行目录，不创建项目，不重跑旧 migration。后续事实摄入与 fork ACK 只补齐同一远端 owner 尚未完成归属判定的行；已判定的 NULL 与本地 NULL 保持原值。

3.17.2 集成保留已发布的 `0009_session_creation_commands`，归属修复顺延为 `0010_remote_task_ownership`。普通创建继续返回 Host 首次分配的 taskId 并保持命令回执幂等；fork 分支使用 CLI 已提交的 child ID，不再分配新 ID。

`0010_remote_task_ownership` 与 `0010_task_worktree_root` 是两个独立迁移 ID，合并后按现有顺序保留两者及各自 SQL/checksum；前者修复历史归属，后者增加 worktree 列和索引，不改名或重复执行已有账本记录。

组织库 migration runner（`session/tasksDatabase`）也归本模块，统一维护 tasks-index 迁移账本。归档永久删除增加最小 `task_purge` 准入/完成身份屏障；不保存标题或正文。Host 在事务内复检归档后准入，CLI 确认删除成功后物理清除索引及分组引用，迟到 upsert 被拒绝。
