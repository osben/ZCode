# 09 · Hooks

A Hook is a local program that runs on session or tool events; it can log events, add context or block a call. User configuration, project configuration and plugins can all provide Hooks; project Hooks need extra trust.

## Events and minimal configuration

Supported events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`. Enable them explicitly in the runtime configuration:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["/absolute/path/to/guard.mjs"],
              "timeoutMs": 10000
            }
          ]
        }
      ]
    }
  }
}
```

This example requires an external Node. `guard.mjs` reads the stdin JSON; the following example verifies the denial path and denies every matching Bash call:

```js
let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.hook_event_name === "PreToolUse") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "本次测试禁止 Bash。",
      },
    }),
  );
}
```

(The sample reason string means "Bash is forbidden in this test.") This is a Hook protocol example, not a complete security policy. Other tools can still cause file or network side effects.

## Project Hook trust

A Hook placed in the project runtime configuration is untrusted by default. Enabling `hooks.enabled`, opening the project or using yolo does not trust it automatically.

```sh
zcode hooks trust review --workspace /absolute/path/to/project --json
zcode hooks trust grant --workspace /absolute/path/to/project --hook-digest SHA256_FROM_REVIEW
zcode hooks trust status --workspace /absolute/path/to/project --json
zcode hooks trust revoke --workspace /absolute/path/to/project --hook-digest SHA256_FROM_REVIEW
```

Review the command and source first, then use the digest returned by review. To grant the current declarations in bulk, use `--all-current --bundle-digest SHA256_FROM_REVIEW`; do not omit the digest bound to the current content.

```text
发现项目 Hook → 未信任，跳过执行 → review → grant
→ 下一次自然事件可执行
声明改变 → digest 改变 → 再次未信任
```

(Project Hook discovered: untrusted, execution skipped, review, grant; it can run on the next natural event. Declaration changes: the digest changes and it is untrusted again.)

Trust binds the workspace identity and the declaration content. A skipped SessionStart is not replayed in the current task; create a new session to verify. A corrupted trust store fails closed and `status` returns the reason; back up and restore the store per the diagnostics, and do not treat corruption as "authorized".

## Input, output and errors

stdin contains the event name, session, working directory and related tool information; compatibility fields may contain both camelCase and snake_case. Read only the fields the current event needs.

A synchronous `PreToolUse` can return `allow`, `ask`, `deny`, `updatedInput` and `additionalContext`. Exit code `2` means a block; other failures, timeouts and invalid output produce diagnostics, so not every abnormal case counts as a reliable denial. With several Hooks, check the final result through the event record.

`type: "command"` supports shell commands and asynchronous execution. The background output of `async: true` cannot be used to block synchronously or rewrite the tool input of this call; use a synchronous Hook for those effects. `timeoutMs` is in milliseconds; the compatibility field `timeout` is in seconds.

A matcher is not always a regex: `Write|Edit` uses an exact tool name list; it enters regex matching only when it contains other regex syntax. Events match different objects: tool events match the tool name, and SessionStart matches the start source.

Plugins can also contribute executable Hooks. When troubleshooting, check both the plugin enabled state and the Hook source; do not infer from the switch in the user configuration that all plugin Hooks are off. Batch tasks should record the declarations actually loaded and the trust state.
