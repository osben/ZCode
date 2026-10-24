# Agent Tool Call Renderer

`packages/ui` provides a dedicated `AgentToolCallBlock` for subagent delegation tools.

Current contract:

- The summary line shows `agentName + primaryText + status`; subagents are not numbered.
- v4 Agent/Task rows are always a single summary line; Prompt, output, activity, and child tools are never expanded.
- When a row has `rootSessionId + parentSessionId + childSessionId` and an open callback, the summary line is the details action: click or Enter/Space opens the read-only right tab on desktop and regular Web, and the existing right drawer on mobile `/remote`.
- Before the child is projected, or when it failed before start, the summary stays static and non-clickable; when the child target arrives later the row only becomes clickable, details never open automatically.
- `agentName` prefers real agent names — paired `subagentRow.subagentType`, `output.agentType`, `input.subagent_type` / `input.agent_type` — never the protocol implementation name `Agent`.
- `subagent_type` is three-state: show a resolved explicit type immediately; leave empty while `raw.inputPreviewComplete !== true` and no authoritative type is known; show the real default `general-purpose` only when the input preview is definitely complete and the type is still omitted.
- `primaryText` skips implementation names `Agent` / `Task` / `spawn_agent`, preferring nickname, title, description, or agent type.
- foreground/background affects only the runtime lifecycle, not the details entry.
- Child tool lifecycle may still mirror to the parent runtime with `source: "subagent"` for compatible consumers and diagnostics, but the parent V4 ProductProjection must not materialize these mirrors into `ToolCallRow`; otherwise the child's Read/Bash would be drawn as main's own tool calls. The child session topic still materializes the full tool history; desktop `desktop-continuous` and mobile `web-remote-replayable` use the same isolation rule.
- The parent session keeps only Agent/Task summaries, subagent run status, background work, and blocking interactions with `origin.kind: "subagent"`; waiting on a foreground child is still the main turn's real running state and does not depend on child tool rows.
- The child's current `snapshot.control.lastError` is shown in the read-only details; there is no parent-row inline fallback, timeline row, or persisted field for it.
- `Task` is a Claude Code legacy alias sharing the `Agent` renderer; Workflow is out of scope.
- Do not reuse `Explore` semantics or the generic `ToolCallBody`.

Match conditions:

- `raw._meta.claudeCode.toolName === "Agent"`
- `raw._meta.zcode.toolName === "Agent"`
- `raw._meta.zcode.toolName === "spawn_agent"` / `raw.name === "spawn_agent"` / `kind === "spawn_agent"` (Codex)
- `kind === "think"` with `title === "Agent"` (GLM/ZCode Agent)
- or `kind === "think"` with `input.subagent_type` present

## Streaming type display boundary

`inputText` is incremental JSON. A partial JSON string that does not yet contain `subagent_type` is not equivalent to the model omitting the field; otherwise the first `tool_input_start` frame would briefly show `general-purpose` and jump once the real type arrives.

```text
tool_input_start / row.inputText incremental
                 |
                 v
       +----------------------+
       | authoritative/explicit type present?
       +----------------------+
          | yes           | no
          v               v
      show real type   inputPreviewComplete === true ?
                         | yes               | no
                         v                   v
                 show general-purpose      leave empty

subagentRow.subagentType arrives --------------------> show that authoritative type
```

The Agent tool's runtime semantics — a complete input that omits `subagent_type` defaults to `general-purpose` — are unchanged; only the UI fallback is delayed. Do not guess whether a field will still arrive by scanning partial JSON whitelists.
