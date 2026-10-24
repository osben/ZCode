# 13 · Batch tasks and run records

The CLI can serve as a task executor; data preparation, environment isolation, resource budgets and scoring are the external launcher's responsibility. The container, timeout, patch extraction and scoring protocol of an existing benchmark must still be adapted separately; one successful prompt does not mean the benchmark integration is complete.

## What to fix per sample

Save the build commit or binary SHA-256, the CLI version and doctor output, the platform, the model and provider protocol, non-sensitive model options, the task input, the workspace commit, the extension list, tool filtering, the permission mode and the run limit. Do not archive API keys or login credentials.

Each independent sample uses its own working directory, user directory and data base directory. Changing only the sessionId or setting only `ZCODE_STORAGE_DIR` does not isolate personal configuration, plugins, memory and user instructions. Experiments that allow reuse across rounds should record the reuse relationship explicitly.

## Cross-platform launch

The following Node.js snippet shows the argument array and the child process environment. The caller passes real paths and task text; never splice model output into a shell command. The example assumes the model configuration and runtime configuration were already written into the directory for `runHome`; for the formats see [Configuration](03-config.md).

```js
import { spawn } from "node:child_process";

// These values are supplied by the task launcher and never executed from model output.
const executable = process.argv[2]; // absolute path of the SEA; for a Node bundle use the Node path
const workdir = process.argv[3];
const runHome = process.argv[4];
const prompt = process.argv[5];
if (![executable, workdir, runHome, prompt].every(Boolean)) {
  throw new Error("需要 executable、workdir、runHome、prompt");
}

// In real tasks build this from a controlled environment variable allowlist; do not inherit personal credentials.
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir)$/i.test(key)) {
    env[key] = value;
  }
}
Object.assign(env, { HOME: runHome, USERPROFILE: runHome, ZCODE_DATA_BASE_DIR: runHome });

const args = [
  // With a Node bundle, first add the absolute path of zcode.cjs here.
  "--prompt",
  prompt,
  "--cwd",
  workdir,
  "--mode",
  "yolo",
  "--disallowed-tools",
  "AskUserQuestion EnterPlanMode ExitPlanMode",
  "--output-format",
  "stream-json",
  "--no-color",
];
const child = spawn(executable, args, { cwd: workdir, env, shell: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.stderr.write(`${JSON.stringify({ code, signal })}\n`);
  process.exitCode = code ?? 1;
});
```

(In the snippet, the thrown error string means "executable, workdir, runHome and prompt are required"; the code comments were translated from the Chinese original.) This is only a launch snippet. A production launcher must also keep writing stdout/stderr to files, record start and end times, limit disk usage, and have the container or process manager set the run limit and terminate the whole process tree. Killing only the parent process must not be assumed to end all Bash, MCP and background tasks. Verify process tree cleanup on the target system.

## How to judge a run

```text
启动失败 / 被取消 / 超时 → 保存失败证据，不判成功
正常结束 → 解析输出 → 检查工具错误与任务产物 → 独立评分
独立评分完成 → 生成样本状态与分数
```

(Start failure / cancelled / timeout: save failure evidence, never judge as success. Normal end: parse the output, check tool errors and task artifacts, score independently. After independent scoring: produce the sample state and score.)

Keep `sessionId`, `traceId`, `turnId`, the raw exit code, the signal and the timeout state. The JSON response is the final answer; stream-json contains events and the final result. Neither equals the full provider request/response, and neither is automatically a trainable conversation.

Resume a task explicitly with `--resume` and keep the same isolated data directory; do not let concurrent samples contend for the "most recent session" of `--continue`.

## Training trajectories and model-io

The default model-io log is for diagnostics and may use full/delta/tail representation, field trimming and size-based retention. Do not assume the standalone CLI has the App's full model-io retention option enabled. The production default of limited retention is usually 64 MiB per file and the 3 most recent session files; the development defaults differ. Before collection, check the [retention policy](../../../../docs/model-io-full-retention-setting.md) of the current build.

The source repository provides a separate test helper that is not packaged into the production SEA. For existing logs in a compatible format, the conversion command is:

```sh
pnpm --filter @zcode/prompt-trajectory model-io -- --input /absolute/path/to/model-io-session.jsonl --out /absolute/path/to/derived
```

By default the converter focuses on the main turns, expands recoverable deltas and processes continuous segments; it cannot restore requests that were trimmed, overwritten or are missing. A non-incremental request also cannot be interpreted directly as a provider cache miss. For the output format and the recording tool, see the [trajectory tool](../../tools/prompt-trajectory/README.md).

Running the command above on the default log generated by the current source in this check gave `model-io request.body must contain a messages array.`: `request.body.messages` in the record had been trimmed and the converter requires that field. This path did not pass actual conversion acceptance and cannot be used directly as a training data pipeline. Keep the original log and the error; do not stuff the internal `request.messages` back into the provider request body to fake a complete record. In this run the default log was in `.zcode/cli/rollout/` under the isolated data directory.

`record:prompt` of the same helper package also failed on this source baseline: at startup it reported `createModelAdapter requires executionConfig` before any model request was sent. It needs a separate fix and acceptance, and cannot be delivered as a currently usable collection command.

When training data is needed, state the collection layer, the protocol, the message order, the correspondence between tool calls and tool results, the failure-sample policy and the privacy handling. Record full requests/responses with a controlled provider and verify they match the CLI tool events; do not collect only the final answer or let the model paraphrase the trajectory.

For collection, point `api.baseUrl` in the [personal model configuration](03-config.md) at a recording service you manage that is compatible with the selected protocol, then run tasks with the ordinary CLI. The recording service forwards and stores the real requests/responses; keep the streaming chunk order, associate calls and results by tool call ID, and exclude authentication headers. First verify with an inspectable tool task that the record is complete, then run the batch. This flow does not depend on the repository helper package above.

## Verification scope

This guide was checked against the current source on 2026-10-14. The CLI was built on macOS arm64, and a local mock Chat Completions service verified the personal provider configuration, plain JSON, stream-json, explicit session resume, Bash execution, plan denial and synchronous Hook denial. The local plugin structure, skill and command discovery, and project Hook trust review/grant/revoke were also verified. The mock service verifies wiring and format and does not represent real model behavior. The default model-io log conversion and the helper package's record:prompt did not pass; the reasons are above.

This verification was run in the source workspace and did not separately build a complete open-source export tree. Windows, Linux, all SEA targets, real providers, MCP remote authorization and full benchmark scoring were not accepted one by one in this documentation update. Run a minimal task in the target environment before use; do not read this guide as a claim that all platforms and extensions were tested.
