# MCP Default-Unreachable Test Server

Test MCP servers that are enabled by default but never connect, used to reproduce the state flow
where an unreachable server first showed green and only turned red after the real connection failed.
One entry covers HTTP connection failure, one covers STDIO process-start failure.

## Configuration

Written to the user-level ZCode Agent MCP configuration:

```json
{
  "mcp": {
    "servers": {
      "zcode-unreachable-http-test": {
        "type": "http",
        "url": "http://127.0.0.1:9/mcp",
        "timeoutMs": 3000
      },
      "zcode-unreachable-stdio-test": {
        "type": "stdio",
        "command": "zcode-mcp-stdio-server-that-does-not-exist-for-test",
        "args": [],
        "timeoutMs": 3000
      }
    }
  }
}
```

Notes:

- No `enable: false`: default-enabled, to observe both the initial state and the post-failure
  transition.
- The HTTP entry uses `127.0.0.1:9` — loopback only, no external network.
- The STDIO entry uses a nonexistent command name, expected to fail process start.
- If local port 9 is taken, switch the HTTP entry to another unlistened local port.

## Expected verification

1. Start the desktop app and open Settings -> MCP Servers.
2. `zcode-unreachable-http-test` and `zcode-unreachable-stdio-test` appear in the ZCode Agent MCP
   list.
3. Toggling a server or refreshing MCP status must not stay green connected for long.
4. After the real connection attempt, show failed/error with the message kept; the STDIO entry's
   error must point at the command failing to start or not being found.

This configuration is for local diagnosis only and must not ship as a default product
configuration.
