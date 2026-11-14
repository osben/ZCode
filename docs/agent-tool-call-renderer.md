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
- The identity icon is always `WorkflowAgentFace`: conversation rows, the run list and child-session tabs use the same agent type and configured color; without a configured color the same name-hash color applies. The aggregate entries (composer, run summary) use a neutral avatar of the same style that refers to no instance.
- A conversation summary with no real name yet and no configured color uses a neutral gray `foreground-subtle` avatar and a `foreground` title; the generic localized text "子智能体" (SubAgent) does not take part in name hashing. With a real name the color still comes from the name; an explicit configured color still wins. Acceptance covers zh/en, desktop/mobile width, light/dark themes, and the three cases no identity, real name, explicit color.
- When name and summary are equal show it once; the pending state replaces the summary slot of the second name with "等待中 / Pending" and drops the trailing status text, ending as "子智能体 等待中" or "SubAgent Pending". Other statuses with no separate description omit the repeated summary. A real description and child-tool activity summary still show, and status and details entry are unchanged.
- While running, the Agent summary shows only the animated avatar, no in-progress text. When done, the row keeps the original avatar and eyes and overlays a static round check badge at the bottom-left (success background, matching foreground check, background-color outline; it does not change the avatar footprint and overhangs to the bottom-left). The history collapse content container uses 4px left/right padding and 4px bottom padding with matching negative margins to cancel the layout shift, leaving room to paint the badge and keeping the overflow-hidden the height animation needs; main conversation, mobile and shared read-only history stay consistent. No trailing done text or duplicate check. Failed shows a cross with text, stopped a square with text, pending keeps text; running keeps the animated avatar. Identity color does not change with status. Status comes from the existing parent Agent display status, never inferred from child tools, animation or local timers.
- The run list and Progress share a 14px icon column and 8px gap with title left edges aligned; the avatar is vertically centered in the 20px first-line height of the title, and elapsed time is left-aligned with the title.
- Child-session tab and composer count-entry avatars are fixed at 14px, overriding the avatar's default 20px minimum; other places keep their size.
- On narrow screens compress the description first with an ellipsis to keep room for status; the tab avatar expresses identity only and never infers running state from whether the tab is open.
- Acceptance: two Agents of the same type, one running and one done, are distinguishable without hover; failed and stopped never show done; the row avatar and the done check stay distinguishable on desktop/mobile, light/dark themes and reduced motion. Configured color is consistent across conversation, run list and tabs, and the aggregate entry is a neutral avatar.

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
