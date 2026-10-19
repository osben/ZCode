# `/plan` Composer 快捷命令

## 目标

为桌面端、Web 端和手机 `/remote` 的 V4 Composer 提供可发现的 `/plan` 快捷命令，
把“切换到 Plan 模式”和“提交一个任务”组合成一次输入操作。

本命令只属于 App Composer 表面，不扩展 CLI TUI、`--prompt` 或 headless 输入入口。

## 语法与结果

| 输入                                       | 结果                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `/plan`                                    | 只开启当前 Composer 的 Plan 标记，不改变权限、不发模型请求。 |
| `/plan <task>`                             | 同一冻结 Submission 携带 `planEnabled=true` 并普通发送任务；provider 和 transcript 只看到 `<task>`。 |
| `/plan` 或 `/plan <task>` 携带附件/context | 开启 Plan，沿普通发送路径提交任务、全部附件和 context；只有无正文且无 payload 的 `/plan` 才只切换标记。 |
| 其他文本（例如 `/planner`）                | 按普通文本处理。                                                                                  |

参数名称大小写不敏感，任务正文去除首尾空白但保留内部换行与内容。
命令被消费后，Composer 清空命令输入；`/plan` 本身不生成 user transcript row。
原始命令可以保留在本地 prompt history，但不得进入 provider prompt 或 conversation transcript。

## 状态与失败边界

```text
Composer submit
      │
      └─ /plan -> current Composer Draft Plan flag + frozen Submission.planEnabled=true
           ├─ no task, attachments or context -> mode-only, no model request
           └─ task or payload -> ordinary sendText(task, frozen attachments/context)
                ├─ worktree preparation -> same prepared session -> activate once
                └─ existing/draft session -> canonical CommandInbox admission
```

发送继续使用现有 config barrier，并在同一冻结 Submission 中携带 Plan 标记；不新增独立配置
写入路径。真正的配置或 admission 失败仍保留完整 Composer 状态。已开启 Plan 时仍允许发送任务。

长文本粘贴自动生成的 `clipboard-text` 附件与普通文件、图片、引用、代码和插件 context 一样保真传递。
`/plan` 只移除正文开头的快捷命令；不丢弃或重新序列化 payload。附件读取、上传和模型能力校验沿用普通发送。
空正文但有附件或 context 是有效任务，不能误当作 mode-only 成功清空输入。`sharedContextRefs` 也属于 payload。

worktree 流程的冻结输入仍由 renderer 拥有，Host 继续拥有 prepared session 和 admission：Git ready
后，同一 session 接纳带 `planEnabled=true` 的输入一次；成功才 consume pipeline 并清除 recovery。

`/plan` 与工具栏共用当前 Composer 的 Plan 标记和冻结 Submission；不改写权限或新任务的默认值。
running/queued 输入仍由 CLI runtime `CommandInbox` 按现有 FIFO 接纳，
不会创建 `/plan` 专用队列或 mode snapshot。

## 跨端边界

desktop local/remote workspace 继续使用可信 `desktop-continuous` attachment，手机 `/remote`
继续使用可信 `web-remote-replayable` attachment。两端复用同一 Composer 命令顺序，但不改变
relay、desktop main、Host、workspace identity、remoteSessionId 或 replayable snapshot/gap 责任。

不新增 V4 wire command、协议字段、持久化结构或独立 runtime。

## 验收证据

- slash catalog 显示 `/plan [task]`，选择后插入 `/plan `。
- draft 空命令只改变模式；已有 session 空命令不产生模型请求或 user row。
- 带任务时同一 `sendText` 携带 Plan 标记，provider/transcript 只出现任务正文。
- `/plan <task>` 保留附件和结构化 context；长文本粘贴与手动附件等价。
- `/plan` 加附件/context（包括 shared context）仍提交 payload；完全空的 `/plan` 不发模型请求。
- worktree ready 后接纳一次 Plan 输入，清除 queued preview 和 recovery；普通 admission 失败仍保留完整状态。
- desktop continuous 与 mobile replayable 只在 delivery profile 上不同，最终命令语义一致。
