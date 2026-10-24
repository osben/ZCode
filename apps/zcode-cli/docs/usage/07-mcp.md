# 07 · MCP

MCP gives the CLI external tools. Runtime configuration uses `mcp.servers`, and each server must declare a transport type. First make sure `features.mcp` is enabled.

## Configuration example

```json
{
  "features": { "mcp": true },
  "mcp": {
    "servers": {
      "example": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/mcp-server.mjs"],
        "enabled": true,
        "timeoutMs": 30000
      }
    }
  }
}
```

`mcp-server.mjs` must be a service that follows the MCP protocol, not a script that just prints JSON. The stdout of a stdio service is reserved for the protocol; write diagnostics to stderr. The program named by `command` and its dependencies must be installed on the target machine; the CLI's SEA artifact does not automatically provide a Node command for external scripts.

Remote services can use `type: "http"` with `url`, optional `headers`, `oauth` and `timeoutMs`; the old SSE transport uses `type: "sse"`. The protocol selection `protocolVersion` supports `auto`, `legacy`, `2026-07-28`; set it explicitly only when service compatibility requires. The exact fields are in the [configuration schema](../../packages/adapters/src/config/schema.ts).

For a server with the same name, the user configuration takes precedence over the project configuration. When diagnosing "I changed the project configuration but it did not apply", first check whether the user configuration and plugins also declare that service.

## Verification and evaluation

Test the connection, schema and returned result with a minimal side-effect-free tool. Check the actual tool name in the request; do not judge success only because the model claims it "can access MCP". Common names carry the `mcp__` prefix; plugin services may add a namespace, so go by the registration result of this run.

A registered tool does not mean authorization is complete, nor that it has permission to run. Non-interactive tasks should complete the required credential setup beforehand; a service whose authorization requires user interaction is not batch-ready.

MCP visibility, tool filtering and permissions are different layers. When removing an MCP tool, record its full name; to disable the capability entirely, turn off `features.mcp` and check whether plugins, a browser or other tools still provide an equivalent channel.

Evaluations record the service version, tool schemas and the necessary non-sensitive configuration. Keys, Authorization headers and OAuth credentials do not go into datasets.
