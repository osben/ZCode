# 05 · Permissions

When starting a non-interactive task, set `--mode` explicitly; do not rely on defaults from user configuration or an interactive terminal. `--prompt` defaults to `yolo`.

## Mode semantics

- `plan`: restricts ordinary writes and command execution, mainly for analysis. It is not an OS-level read-only sandbox; the current implementation also allows some non-destructive MCP and session control capabilities.
- `build`: ordinary writes and tools with side effects usually need approval.
- `edit`: workspace file edits usually need no approval; everything else follows the build judgment.
- `yolo`: ordinary tools skip permission prompts; suited to isolated unattended tasks.
- `guarded`: supported by the current source. Ordinary calls use a lenient policy and dangerous commands still need per-call approval; not suited as an "auto-approve" mode for unattended tasks. Older builds may not support it.

`auto` is an internal reserved value and not a usable CLI automatic mode.

## Why yolo can still deny

Tool-level interaction requirements, `alwaysAsk`, the separate Plan state, workspace Hook trust and Hook interception each have their own rules. yolo must not be simplified to "any code runs unconditionally". Ordinary deny/allow rules in the configuration also do not replace OS isolation.

```text
工具未注册 → 无法调用
工具已注册 → 校验与权限判定 → allow / ask / deny
ask + 无审批客户端 → 工具失败
allow + Hook 阻断 → 工具失败
执行成功 → 仍需验证任务产物
```

(Tool not registered: cannot be called. Registered: validation and permission decision, allow / ask / deny. ask with no approval client: the tool fails. allow with a Hook block: the tool fails. Execution succeeded: the task artifacts still need verification.)

This diagram shows user-observable outcomes, not the strict call order of every internal check. For details, the [permission service](../../packages/core/src/permission/service.ts) and the tool executor are authoritative.

## Verify permissions

Test Read, Write and Bash in a throwaway directory. For ordinary built-in file tools, plan should deny writes and edit may write files; build write approval may fail in a prompt with no client. With custom tools, plugins or MCP, verify their capability declarations and permission rules separately.

When `No permission client configured` appears, check whether the current mode and tool need interaction. Do not try to fix it by repeating the prompt to the model. Remove the interactive tools you do not need, or choose an interactive entry with an approval client.

After a tool is denied the model may still continue answering and the process may return `0`. Check streamed events, tool results and file artifacts together. A synchronous `PreToolUse` Hook can block a kind of tool by arguments, but a simple command regex is not a complete sandbox; see [Hooks](09-hooks.md).
