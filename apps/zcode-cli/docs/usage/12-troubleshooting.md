# 12 · Troubleshooting

## Collect minimal evidence first

Save `--version`, `doctor --json`, the build commit or artifact SHA-256, the complete argument array, the effective working directory, the exit code, the signal, stdout, stderr, and the sanitized configuration. Reproduce in an isolated environment first, to avoid changing everyday development configuration and sessions.

## Startup or configuration failures

- `Unknown option`: the flag does not belong to this build. Check whether flags of other CLIs such as `--model`, `--settings`, `--max-turns` were brought in; flags of newer source may also not yet be in an older artifact.
- Model missing, or config changes have no effect: check the personal provider file, the default model selection, the API type and the key; a migrated source build does not re-read the old `model/provider` settings each time. See [Configuration](03-config.md).
- Configuration partly ignored: check JSON syntax and field diagnostics. MCP, Hook and other fields have separate validation; do not attribute every problem to a credential error.
- The build starts but assets are missing: keep the assets adjacent to the bundle and confirm the dependencies and preparation steps are complete; `doctor` does not verify all plugins, models or external programs.
- Platform or execution failure: check the CPU architecture, OS version and execute permission. Windows uses `.exe`; external Hook/MCP dependencies are installed separately.

## Tools produced no result

- `No permission client configured`: this call needs approval but the prompt has no interactive client. Check the mode, the tool and the Hook decision.
- Only a plan is output: check whether plan mode was triggered; for unattended tasks remove the unneeded plan and question tools per the [tool configuration](04-tools.md).
- A project Hook does not run: check enabled, the matcher, the trust state and whether the event naturally occurred; after trusting, a skipped SessionStart is not replayed.
- The plugin list is empty: check the global plugin switch, asset preparation and diagnostics. The current version can list directly and does not require a model request first.
- An MCP call fails after registration: check service authorization, protocol, external dependencies, permissions and timeouts separately; a tool name the model lists is not evidence of execution.

## Output and run records

Local commands such as `/help` may return text and cannot be used to verify the JSON structure of an ordinary prompt. `stream-json` should be parsed line by line and the final result line checked. When the process exits abnormally, is cancelled or its output is truncated, do not assemble a false success result.

Debug logs may contain task text, paths, tool output and model requests. The default model-io log has compression, trimming and retention limits; missing history cannot be recovered from summaries. See [Run records and training trajectories](13-automation.md).

When trajectory conversion fails with `model-io request.body must contain a messages array.`, check whether the original record kept `request.body.messages`. This error was reproduced against the current default log in this check; a file that failed conversion must not be used as a complete training sample, and the message structure of another layer must not be used to patch it. When complete data is needed, keep the actual provider request and response at the collection end.

When filing an issue, provide a minimal reproducible task and sanitized evidence. Remove API keys, login tokens, cookies and private content; keep field structure, error codes and the necessary tool results.
