# Plugin MCP Session Runtime Merge

## Background

The ZCode Dev settings page shows the merged result of plugin MCP and user MCP via `zcode/mcp/list`, but when the desktop creates or restores a session, the `mcpServers` passed to the protocol only came from user config with `source === "zcodeagentmcp"`.

## Problem

`resolveAppRuntimeConfig` treated `runtimeConfig.mcp.servers` as a full override. Once user MCP was passed through the protocol, plugin MCP no longer merged with the runtime config, so the model side only saw the successfully connected user MCP servers: local user MCP such as `context7`, `exa`, `playwright` survived, while plugin MCP such as `plugin:chrome-devtools-mcp:chrome-devtools` and `plugin:ios-simulator:ios-simulator` was lost.

## Fix

Session runtime config resolution always injects plugin MCP first, then merges explicit user MCP:

```ts
{
  ...pluginMcpServers,
  ...(options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers),
}
```

User config keeps priority over same-named MCP, and plugin-registered MCP always enters the new session's runtime.
