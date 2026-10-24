# Unclassified Shell Tool Rendering

A v4 conversation Shell tool must not first show as an ordinary Bash/Shell row before its command arrives and then merge into "Explore" (flicker).

## Summary

| Field | Value |
| --- | --- |
| Behavior | Defer rendering of a Shell row until its command is classifiable; then show it only as Explore or Execute |
| Surfaces | Desktop `desktop-continuous`, plain Web, mobile `/remote` `web-remote-replayable` conversation work items |
| State owner | The CLI v4 projection owns `ToolCallRow`; the renderer only derives whether the current row is visible and whether it belongs to Explore |
| Out of scope | Tool input protocol, delta pacing, tool execution timing, permission, relay/main, snapshot schema |

Decisions: all Shell types are handled uniformly by `resolveToolCallIdentity(...).family === "shell"`; a row that finally fails or is denied and never has a command is shown (error/denied result wins over the pending-classification hiding rule); desktop continuous and mobile replayable use the same renderer visibility contract.

## Domain scope

| Concept | Owner | Contract |
| --- | --- | --- |
| Conversation/session behavior | CLI ProductProjection | `tool_input_start` may first produce a `ToolCallRow` with only a tool name and no command |
| Rendering/performance | renderer `buildAssistantWorkRenderItems` | An unclassified Shell is a temporary input state, not the final product classification of an ordinary Shell |
| Permission/tool | shared tool identity | All Shell tools converge through the family; non-Shell tools (Read/Write, ...) are unaffected |
| Mobile replayable | delivery profile + renderer | replayable may filter live `inputText` deltas, but once the final upsert/snapshot arrives the same classification rule applies |

```text
tool_input_start { toolName: Shell, command: absent }
  -> ToolCallRow(inputStreaming)
  -> renderer: defer

tool input becomes classifiable
  |-- readonly command -> Explore group
  `-- other command    -> Execute group

tool reaches error/denied without command
  -> visible error row
```

## Accepted candidates

| ID | Row state | Shell input | Expected effect |
| --- | --- | --- | --- |
| USR01 | `inputStreaming` / `running` | command absent | No visible work item; wait for later row updates |
| USR02 | nonterminal | readonly command | Immediately merges into the Explore group by existing rules |
| USR03 | nonterminal | non-readonly command | Immediately enters the Execute group |
| USR04 | `error` / denied result | command absent | Show the error Shell row; do not swallow the error body |
| USR05 | desktop continuous / web remote replayable | any terminal state above | Same row input gives the same visible result; each delivery's semantics unchanged |

## Pruning decisions

| ID | Pruned combinations | Guard/invariant | Representative coverage |
| --- | --- | --- | --- |
| USR-P01 | Bash/execute/shell tool-name permutations | `resolveToolCallIdentity` converges them to the Shell family | family representative + existing identity tests |
| USR-P02 | theme/locale/OS/workspace type | The guard is a pure row derivation with no copy, layout or platform dependency | focused renderer unit test |
| USR-P03 | continuous/replayable physical network permutations | No transport change; the final-row renderer contract is identical | renderer unit + existing STIP03 profile test |
| USR-P04 | permission UI behavior | permission/elicitation have a separate blocker surface; this only decides the conversation work item | existing permission tests |

## Accepted cases and evidence

| ID | Setup | Action | Assertions | Evidence | E2E status |
| --- | --- | --- | --- | --- | --- |
| STIP04 | A v4 running turn receives Shell `tool_input_start`; input/inputText has no command yet | renderer builds work items; then a readonly and a non-readonly command are supplied separately | No Bash/Shell in the first frame; after the readonly update only Explore appears; after a non-readonly command only an Execute group appears | UI row derivation + runtime log ordering | partial (focused unit) |
| STIP05 | Shell row without command in error/denied state | renderer builds work items | The error row is visible; the error body is still shown by the tool error surface | UI adapter + tool error rendering | partial (focused unit) |

## E2E handoff

- No conversation E2E yet; the core guard is a pure deterministic row-to-render-item function covered by focused unit tests.
- If promoted to formal E2E, use a `controlled-stream` fixture that sends `tool_input_start` and the command delta separately, asserting the Bash copy is absent in the first frame and exactly one stable work item appears after classification.
- Real mobile gap/snapshot recovery stays with STIP03; the desktop continuous fixture must not stand in for physical replayable proof.
