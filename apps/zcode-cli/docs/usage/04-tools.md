# 04 · Tools and evaluation setup

The tool set is determined jointly by the build, model capabilities, runtime configuration, plugins, MCP and the host. Do not write the tool count of one run as a fixed product contract, and do not treat tool names the model lists by itself as the registered list.

## Confirm that a tool is available

Common capabilities include file reading and editing, command execution, web access, skills, subtasks and session control. The actual names are those in the request sent to the provider and in the run events. For a strict comparison of the tool surface, record the `tools` field of the request on a controlled test provider and save the tool schemas; production requests can contain task content and credential-related information, which must be sanitized before archiving.

Tool presence, permission to run and successful execution are three conditions:

```text
配置与注册过滤 → 模型请求中的工具声明 → 模型发起调用
→ 参数校验、权限与 Hook → 实际执行 → 工具结果 → 模型回复
```

(Configuration and registration filtering, tool declaration in the model request, model issues a call, argument validation / permission / Hook, actual execution, tool result, model reply.)

The embedded search branch can hide the standalone Glob/Grep tools when Bash is available. After disabling Bash the search tool surface can change; do not infer from disabling one tool that a capability has disappeared entirely.

## Non-interactive task template

```sh
zcode --prompt "任务说明" --cwd /absolute/path/to/task --mode yolo --disallowed-tools "AskUserQuestion EnterPlanMode ExitPlanMode" --json --no-color
```

An ordinary `--prompt` has no interactive approval client. Tools that need to ask or request approval may fail. For tasks needing no human intervention, removing the tools above avoids entering the plan or question flows; this changes the experimental conditions and should be recorded in the evaluation configuration. `yolo` also does not guarantee that every tool that declares forced confirmation can run.

Decide per task protocol whether to disable subtasks, memory, skills, MCP, plugins and workflows. To disable subtasks, turn off `features.subagent` and remove `Agent Task` together. The current source accepts `--workflow-mode disabled`; with older builds, detect flag support first and do not add it unconditionally.

`--disallowed-tools` removes whole tools at the tool registration layer, which suits fixing the experimental tool surface. `permission.disallowedTools` in the configuration belongs to permission judgment and is not an equivalent replacement; in particular, do not assume every permission setting constrains `yolo`.

Removing WebSearch/WebFetch does not cut the network: Bash, MCP, plugins or a browser can also reach the network. Network, filesystem, process and resource limits should be enforced by the task container or the operating system.

## Minimal acceptance

In a throwaway workspace, run one specified file-write task and one command task. Check the actual file content, tool results and process state, then judge success with an independent script. Also run a denial scenario to confirm the restriction really applies. Evaluation scoring must not depend on the model's last sentence "done".

Training data should keep real tool calls and results, including denials, timeouts and failures; do not turn the model's paraphrase of a tool into a successful call. For output and trajectory notes, see [Batch tasks](13-automation.md).
