# MCP stdio failure stderr diagnostics

## Background

In ticket `ZCT-2071437415552278528`, both MySQL MCP servers failed with `MCP error -32000: Connection closed`. That error only says the MCP stdio child closed the pipe — it cannot tell whether `npx`, server argument validation, env vars, the network, or the server itself crashed.

The adapter already listens to stdio stderr, but stderr only went to debug logs. Production log exports exclude debug by default, so tickets lacked the child process's original error before exit.

## Goals

- Keep the tail of the most recent stderr from each stdio MCP child.
- When `mcp.server.failed` fires, emit the recent stderr as a warn context field.
- The stderr must be length-capped so high-frequency output cannot flood production logs.
- The stderr must be redacted so tokens, passwords, and authorization credentials never reach logs.
- Successful connections emit no extra warn-level stderr, keeping normal logs quiet.

## Behavior

- Each stdio MCP server connection attempt keeps its own in-memory stderr buffer.
- The buffer keeps only a fixed tail length, for locating the last error before startup failure.
- Debug-level `mcp.stdio.stderr` still logs individual chunks, using the same redacted text.
- Warn-level `mcp.server.failed` attaches the `stderr` field only when the buffer is non-empty.
- stdio env values are never logged; env still passes only through child-process launch arguments.

## Verification

- Unit tests cover warn logs containing recent stderr on stdio MCP connect failure.
- Unit tests cover sensitive fields in stderr being replaced by `[Redacted]`.
- `pnpm typecheck` and `pnpm lint` as boundary checks.
