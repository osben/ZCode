# Subagents Tool Badge

The Settings subagent list shows only a tool-permission summary, not the real tool list.

- When `tools` is missing, an empty array, or contains `"*"`, the subagent inherits or is allowed all tools
  and the list badge shows `All tools` / `全部工具`.
- Only when `tools` explicitly lists concrete tool names without `"*"` does the badge show `{count} tools`
  / `{count} 个工具`.

This avoids showing the wildcard `"*"` as `1 tool`.
