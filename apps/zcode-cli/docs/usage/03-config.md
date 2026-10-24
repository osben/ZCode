# 03 · Configuration

## Two kinds of configuration files

The current source manages model configuration and runtime configuration separately:

```text
个人 provider、模型选择 → ~/.zcode/v2/provider_config.json
运行、权限、MCP、Hook、插件 → ~/.zcode/cli/config.json
项目运行设置 → <project>/zcode.json、<project>/.zcode/config.json
账号登录凭据 → 凭据存储，不作为普通模型配置公开
```

(Personal providers and model selection live in `~/.zcode/v2/provider_config.json`; runtime, permissions, MCP, Hooks and plugins in `~/.zcode/cli/config.json`; project runtime settings in `<project>/zcode.json` and `<project>/.zcode/config.json`; account login credentials in the credential store and are not exposed as ordinary model configuration.)

`ZCODE_DATA_BASE_DIR` changes the data base directory for providers, credentials and similar data. The personal model file can be set explicitly with `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`. Paths and compatibility entry points can differ between builds; check the behavior of the CLI you run.

Runtime configuration generally layers built-in defaults, user, project, environment variables and entry flags. For an MCP server with the same name, the user configuration has higher priority; project Hooks must also pass a separate workspace trust. One "later write overrides earlier write" rule cannot summarize every field.

## Personal model configuration example

This is the current file format. It is for a custom OpenAI Chat Completions compatible service; the address, model name and key must be replaced. The spelling of `api.baseUrl` differs from `options.baseURL` in the old format.

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "example",
          "providerName": "Example API",
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "REPLACE_WITH_API_KEY" },
            "api": {
              "type": "openai-chat-completions",
              "baseUrl": "https://api.example.com/v1"
            },
            "personalModelIds": ["example-model"]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [],
      "manualProviderModelRules": []
    },
    "defaultModelSelection": {
      "providerId": "example",
      "modelId": "example-model"
    }
  }
}
```

Supported API types are `openai-chat-completions`, `openai-responses` and `anthropic-messages`. The service must support the selected protocol and the tool calls the task needs. Model capabilities, reasoning options and output limits are also constrained by model rules; do not assume all options are compatible just by changing a model name.

A custom API key can be written into a temporary configuration by a launcher from a controlled credential source. That file contains the plaintext key, so restrict its file permissions, do not commit it to Git, and do not put it in evaluation result archives. Configuration reading does not promise `${ENV}` substitution in the `apiKey` string.

`providerModelRules` is for model rule overrides; `manualProviderModelRules` is for complete manual model definitions; the same provider/model cannot appear in both. The exact schema is in the [provider file codec](../../../../packages/provider-node/src/provider-config-file-codec.ts) and the [model rules](../../../../packages/provider/src/config/rule-data-schema.ts). The `options` of the default model selection can store options the model supports; do not fill in a reasoning level the model does not support.

## Migrating from the old configuration

Old builds used `model` and `provider` in `~/.zcode/cli/config.json`. When the personal model file does not exist, the current standalone CLI tries a one-time import of the old user configuration; it does not overwrite the personal file again at every start.

```text
个人模型文件不存在 → 尝试导入旧用户配置 → 保存个人配置
个人模型文件已存在 → 读取个人配置 → 后续修改个人配置
```

(If the personal model file does not exist: try to import the old user configuration, then save the personal configuration. If it already exists: read the personal configuration and make later changes there.)

So after migration, continuing to edit `model`/`provider` in the old file is not a reliable way to switch. Project-level old providers and the old `ZCODE_MODEL`/`ZCODE_API_KEY` environment variables must not be treated as a general override entry for the new format. `ZCODE_BASE_URL` is also tied to the product service endpoint in the current code; do not put the model API address into it instead of `api.baseUrl`.

The old model configuration may contain fields that cannot be migrated; when an error appears, keep the original file and read the diagnostics first. Do not delete the personal configuration to force repeated imports.

## Runtime configuration example

```json
{
  "features": { "mcp": false, "subagent": false, "memory": false, "skill": false },
  "memory": { "use": false },
  "plugins": { "enabled": false },
  "skills": { "enabled": false },
  "hooks": { "enabled": false },
  "ui": { "locale": "zh-CN" },
  "modelStream": { "idleTimeoutMs": 600000 }
}
```

This is an evaluation configuration that reduces extension interference, not a general feature default. Tasks that need MCP, skills or plugins should enable them explicitly and record the configuration. JSON does not support comments. A wrong field can invalidate the whole configuration or cause parts to be skipped, so "the process started" is not proof that the configuration took effect.

## Environment variables and network

Common runtime variables include `ZCODE_STORAGE_DIR`, `ZCODE_SESSION_DB_PATH`, `ZCODE_LOG_DIR`, `ZCODE_LOG_CONSOLE=1`, `ZCODE_HTTP_PROXY`, `ZCODE_NO_PROXY`, `ZCODE_AGENT_CA_CERT` and `ZCODE_MAX_TOOL_CONCURRENCY`. `ZCODE_LOG_LEVEL` is not a supported log level setting.

The CLI looks for `.env` upward from the effective working directory; existing environment variables are not overridden. Evaluation workspaces and their parent directories must not leave a stray `.env`. Configure CLI networking with `network.httpProxy` or `ZCODE_HTTP_PROXY`; do not assume all of the caller's standard proxy, certificate or telemetry variables enter the runtime unchanged.

Full isolation must consider the user directory, data base directory, working directory and existing environment variables together; see [Batch tasks](13-automation.md).
