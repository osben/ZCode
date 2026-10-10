# Global Instructions（全局指令编辑）

## 背景（当前源码事实）

- 全局指令即用户默认指令文件 `~/.zcode/AGENTS.md`（home 解析顺序：`HOME` → `USERPROFILE` → `os.homedir()`）。
  CLI 在 `apps/zcode-cli/packages/adapters/src/context/index.ts` 的 `findDefaultUserInstructionFile` 中定位该文件。
- CLI 把它与工作区最近的 `AGENTS.md`（向上查找到 git 根）合并；按解析后的路径去重；每个文件最多读取 100 KiB（超出截断并追加 `[File truncated]`）；仅含空白的文件不注入。
- CLI 只在会话 runtime 的 `ensureContextInitialized` 读取一次指令（`core/src/runtime/methods/context.ts`），因此修改只影响**新会话**。
- 现有唯一写入路径是引导页的 `~/.claude/CLAUDE.md → ~/.zcode/AGENTS.md` 迁移（`ISettingsSyncService.copyClaudeAgentsFileToZcodeAgentsFile`）；此前不存在读取/编辑接口。

## 产品规则

- 设置页新增「指令」分区，位于「Agent 能力」分组内、「记忆」之前；仅编辑全局 `~/.zcode/AGENTS.md`，不展示或编辑项目 `AGENTS.md`。分区描述说明：该指令会与项目 `AGENTS.md` 合并，且只对新会话生效。
- **仅 Desktop 提供**；Web（含手机远控）显示与「记忆」相同风格的只在桌面端可用占位，不加载文件。
- **目标主机 = 当前活动 workspace 所在主机**：本地 workspace 或无 workspace → 本机；远程（SSH）workspace → 远端主机（远端 CLI 读取的正是远端 `~/.zcode/AGENTS.md`）。编辑器上方明确标注「此电脑」或远端主机名，并显示文件绝对路径。
- **编辑器**：等宽 Textarea + 「编辑 / Markdown 预览」两个标签（预览复用 `MarkdownPreviewContent`）。支持 Cmd/Ctrl+S 保存；有未保存差异时显示「有未保存的修改」；「在文件管理器中显示」仅对本机且文件已存在时可用。
- **文件不存在**：显示空编辑器与提示「文件尚未创建」；点击保存时创建 `~/.zcode` 目录与文件。未编辑也允许保存（创建空文件）。
- **保存空内容**：写入空文件；本功能永不删除文件。
- **从 CLAUDE.md 导入**：目标主机上存在 `~/.claude/CLAUDE.md` 时显示按钮；无论全局文件是否存在都可用。导入只把内容填入草稿，需保存才落盘；当前草稿非空且与磁盘不同时先确认替换。
- **大小**：显示当前草稿字节数；超过 100 KiB 时提示「Agent 只会读取前 100 KiB」，仍允许保存。超过 5 MiB 的文件不加载进编辑器，显示只读的过大状态（本机可在文件管理器中打开）。
- **生效时机**：保存成功的 toast 与编辑器下方常驻提示均说明「仅对新会话生效，进行中的会话保持原指令」。
- **未保存草稿**：离开该分区、或活动 workspace 切换导致目标主机变化时，弹出「放弃修改？」确认；取消则保持当前分区与草稿。

### 文件状态处理

| 磁盘状态                       | 读取结果                 | 编辑/保存                                                  |
| ------------------------------ | ------------------------ | ---------------------------------------------------------- |
| 不存在（含 `~/.zcode` 不存在） | `missing`，空内容        | 可编辑；保存时 mkdir + 创建                                |
| 普通文件（含空文件）           | `file`，原样内容         | 可编辑、保存                                               |
| 指向普通文件的符号链接         | `file`，附 `linkTarget`  | UI 显示「链接 → 目标路径」；原子写入目标文件，链接本身不变 |
| 悬空符号链接                   | 错误 `BROKEN_LINK`       | 禁止保存（CLI 视同不存在）                                 |
| 目录或其他非普通文件           | 错误 `NOT_REGULAR_FILE`  | 禁止保存                                                   |
| 非合法 UTF-8                   | 错误 `NOT_UTF8`          | 只读错误态，禁止保存，避免破坏内容                         |
| 超过 5 MiB                     | 错误 `TOO_LARGE_TO_EDIT` | 只读过大态                                                 |
| 无权限 / 其他读取失败          | 错误 `READ_FAILED`       | 错误态 + 重试                                              |

- 行尾与 BOM 原样保留，不做规范化。

### 并发与冲突

- 读取返回 `revision`（文件字节 sha256；不存在时为 `null`）。保存携带 `expectedRevision`。
- 服务端在文件锁内重新计算磁盘 revision；与 `expectedRevision` 不同（包括期间被创建、修改或删除）时返回 `REVISION_CONFLICT`，不写入。
- UI 收到冲突后弹窗：「从磁盘重新加载」（丢弃草稿）或「覆盖」（以当前磁盘 revision 重试写入）；关闭弹窗保持草稿不变。
- 写入失败：toast 提示，草稿保留。

## 状态所有者与事件顺序

```text
用户编辑 → UI 草稿（分区局部状态，非服务端事实）
  → 保存 → IUserInstructionsService.write（活动 workspace 所在主机）
      → 文件锁 → 重算 revision → realpath → 原子写入 → 新 revision
  → 磁盘 ~/.zcode/AGENTS.md（唯一事实源）
      └─ 新会话 runtime ensureContextInitialized 读取（进行中的会话不重读）
```

- 唯一事实源是目标主机磁盘上的文件；UI 只持有 `loaded`（最后一次读取/保存的内容与 revision）和 `draft`。不引入缓存、设置项或广播同步。
- 服务在每个主机进程注册（`packages/services/src/node.ts`），UI 通过 `useWorkspaceServicesResolution(workspacePath, remoteSessionId, workspaceIdentity)` 选择目标主机；无 workspace 时使用本机服务。身份 key 遵循 `workspaceIdentity?.trim() || workspacePath`。
- 不变量：服务端解析的文件路径必须与 CLI adapter 完全一致（`HOME` → `USERPROFILE` → `os.homedir()` + `.zcode/AGENTS.md`）；与 `settingsSyncService` 共用同一个路径 helper。

## 接口

新增 `IUserInstructionsService`（新的 `ServiceChannels` 项，类型放在 `packages/shared`）：

```ts
type UserInstructionsReadResult =
  | {
      kind: "ok";
      path: string;
      linkTarget?: string;
      state: "missing" | "file";
      content: string;
      revision: string | null;
      sizeBytes: number;
      agentReadLimitBytes: number; // 102400
    }
  | {
      kind: "error";
      path: string;
      linkTarget?: string;
      code: "BROKEN_LINK" | "NOT_REGULAR_FILE" | "NOT_UTF8" | "TOO_LARGE_TO_EDIT" | "READ_FAILED";
      message?: string;
    };

interface IUserInstructionsService {
  read(): Promise<UserInstructionsReadResult>;
  write(params: {
    content: string;
    expectedRevision: string | null;
  }): Promise<
    | { kind: "ok"; revision: string; sizeBytes: number }
    | { kind: "conflict"; currentRevision: string | null }
  >; // 其他写入失败以异常抛出
  readClaudeImportSource(): Promise<{ available: boolean; path: string; content?: string }>;
}
```

- 引导页现有迁移接口保持不变。

## 版本偏斜

- 新 UI + 旧远端主机（未注册该服务）：调用失败 → 分区显示「远端主机版本不支持」错误态，不影响其他设置。
- 旧 UI + 新主机：无行为变化。

## 验收场景

1. 本机无 `~/.zcode`：打开「指令」→ 空编辑器 + 「文件尚未创建」；输入并保存 → 目录与文件创建，toast 提示仅对新会话生效；新建会话的上下文包含该内容。
2. 文件已存在：内容原样加载；修改后显示未保存标记；Cmd/Ctrl+S 保存；未修改时保存按钮禁用。
3. 清空并保存 → 文件存在且为空；新会话不注入用户指令。
4. 外部修改文件后在编辑器保存 → 冲突弹窗；「重新加载」显示磁盘内容；「覆盖」写入草稿。编辑期间文件被外部删除同样触发冲突。
5. 符号链接 → 显示「链接 → 目标」；保存后链接仍为链接，目标文件内容更新。悬空链接显示错误且禁止保存。
6. 草稿超过 100 KiB → 显示截断提示，保存成功。超过 5 MiB 的文件显示只读过大态。
7. 目录占位 / 非 UTF-8 / 无读取权限 → 对应错误态，保存禁用。
8. 存在 `~/.claude/CLAUDE.md` → 「从 CLAUDE.md 导入」把内容填入草稿；脏草稿先确认；保存前磁盘不变。
9. 远程 SSH workspace 激活 → 标注远端主机并读写远端文件；「在文件管理器中显示」不可见；从远端切回本地 workspace 且有脏草稿时弹出放弃确认。
10. 有脏草稿时切换到其他设置分区 → 放弃确认；取消则留在原处且草稿保留。
11. Web / 手机远控打开设置 → 「指令」分区显示仅桌面可用占位。
12. 预览标签正确渲染当前草稿（含未保存内容）的 Markdown。

## 验证

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 交互场景需要 E2E；`packages/services` 与 `packages/ui` 当前没有单测脚本——测试入口待确认后补充，未执行前不视为已覆盖。
