# MCP Platform Boundary

MCP native user-directory management is a platform capability, not a UI-layer capability. The UI package can render and coordinate MCP settings for desktop, web, and mobile, but it must not call Electron preload APIs directly.

## Boundary

- `packages/ui` depends on `IPlatformService` for native MCP operations.
- Desktop implements the MCP platform methods by forwarding to the existing preload bridge.
- Mobile `/remote` forwards MCP platform requests through the existing shared-host attachment app-payload path to the desktop window that owns the host.
- Plain web without a desktop attachment returns empty/unsupported fallbacks and must not create an independent Agent runtime or local host.

## Methods

The platform abstraction owns these operations:

- `loadMcpFromUserDirectory`
- `saveMcpToUserDirectory`
- `migrateLegacyCommonMcp`

This keeps Electron-specific `window.zcode` access inside desktop renderer bootstrap code and preserves UI reuse across desktop, web, and mobile remote control.

## MCP 2026-07-28 runtime boundary

- Plain stdio / Streamable HTTP MCP clients default to dual-era `auto`: try modern `server/discover` first, fall back to `initialize` only on transport-specific legacy evidence; explicit legacy config keeps skipping probing.
- The built-in `node_repl` is fixed to MCP `2026-07-28`; each `js` use runs a one-shot execution kernel, uses no `Mcp-Session-Id`, and adds no model-visible Browser context handle.
- `_meta` is client-provided request context, not an authorization fact; the host must revalidate with the private stdio/pipe token, the current session registry, and handle binding.
- Within one agent runtime, stateless `node_repl` processes may be shared by `workspaceKey`; third-party servers keep session isolation by default.
- Mobile `/remote` only reuses the agent/MCP runtime already attached to the desktop shared host; relay and desktop main store no MCP tool/kernel state or conversation state.
- The desktop `desktop-continuous` and mobile `web-remote-replayable` delivery boundaries do not change due to MCP process sharing.

Full contract: `docs/mcp-stateless-node-repl.md`.
General client negotiation contract: `docs/mcp-dual-era-version-negotiation.md`.
