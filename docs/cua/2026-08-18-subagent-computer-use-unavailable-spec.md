# Subagent Computer Use Unavailable Boundary

Subagents must not use the official `zcode-cua` Computer Use. The restriction binds only to the official CUA server already verified by Host authority, not guessed from a tool name or display name, so third-party MCP is unaffected.

The main Agent keeps using canonical `mcp__computer-use__*` and compatible aliases; desktop `desktop-continuous`, Web remote `web-remote-replayable`, Host, UI and protocol schemas are unchanged.

## Two layers

```text
child spawn
  ├─ authority = computeOfficialCuaServerNames(parent config, trusted names)
  ├─ wildcard profile -> remove official server/tools from the borrowed snapshot
  ├─ explicit CUA server/tool/selector/skill -> configuration error before startup
  └─ child SkillPort -> hide official computer-use

child MCP call (runtime_scope=subagent)
  └─ zcode-cua preflight -> return error, never reach kill-switch/Broker/handler
```

The error code is `SUBAGENT_COMPUTER_USE_UNAVAILABLE` and the error text is `Computer Use is not available in subagent`. The producer trusts only the namespaced `com.zcode/request-context.runtime_scope`; missing, malformed or `main` stays compatible, and a top-level field of the same name is not trusted.

## Subagent semantics

- Without explicit CUA configuration, wildcard, Explore, general-purpose, custom, background and resume subagents all see no official CUA server, descriptor, canonical/raw/alias tool or Skill.
- When an official server, canonical/raw/alias tool, MCP server selector or official Skill is explicitly declared, the child runtime fails before the first model request and does not silently drop the user's configuration.
- Filtering uses the frozen official plugin catalog, plugin id, root path and qualified name; same-named third-party Skills are unaffected.
- The parent snapshot, parent MCP lifecycle and main Agent registry are not modified.

## Producer semantics

All 30 `zcode-cua` tools share one preflight. With `runtime_scope=subagent` it returns `isError` before the kill-switch check, Broker access and handler; request access, stop, wait, clipboard and other tools cannot bypass this boundary. Tool names, schemas, annotations, permission groups and result protocol are unchanged.

## Acceptance

- The subagent's provider-visible tool/Skill surface contains no official CUA, and non-official MCP/Skills still work.
- A direct CUA call bypassing the surface does not trigger the Broker.
- Main Agent official CUA behavior is unchanged.
- Covered by z-code unit tests, zcode-cua producer unit tests and one conversation manual-review/replay case.
