# MCP tool call rendering

Conversation MCP tool calls use MCP discovery metadata as their display source. The UI must not infer business semantics from the synthetic model tool name (`mcp__<server>__<tool>`).

## Data flow

```text
MCP server tools/list
  name + description
          |
MCP adapter + configured server name
  serverName + toolName + description
          |
Core MCP registry metadata
          |
Scheduled / started / result display payload
          |
V4 ToolCallRow.display
          |
Conversation MCP renderer
```

`serverName` is the configured MCP server key. `toolName` and `description` come from the server's `tools/list` response. The synthetic model-visible name remains the stable execution identifier and is shown only as a technical fallback.

## Summary

- Every MCP lifecycle row renders the stable kind label `MCP`, the server source as adjacent plain inline text, and the tool action after a quiet middle dot. The source is not a badge and has no border, background or rounded container. Plugin-scoped server keys such as `plugin:firebase:firebase` are display identifiers, not user copy: the source uses the final configured server segment (`Firebase`). When the tool identifier repeats that server prefix, it is removed mechanically (`firebase_get_environment` becomes `Get environment`).
- Trusted discovery metadata is attached when the call is scheduled and preserved by started, result, error and turn-cancel projection updates. Pending, approval, running, failed and stopped rows never regress to the synthetic tool name.
- Pending, running and completed are normal lifecycle phases and add no status copy. Stopped and failed remain visible terminal exceptions, separated from the action by the same quiet middle dot. Order: `MCP  Server · Action · Terminal status`.
- The UI only formats identifiers mechanically (separator-to-space, word capitalization); it does not translate verbs or invent domain meaning.
- Historical rows that predate presentation persistence are recognized only when the execution identifier has the protocol-owned `mcp__<server>__<tool>` envelope. That envelope cannot losslessly recover discovery metadata, so the compatibility summary shows `MCP` plus a mechanically formatted tool identifier and omits server source and description. It still uses the MCP detail layout, not the generic debugger card.
- Missing or invalid presentation metadata on calls without that explicit MCP envelope falls back to the generic tool-call renderer.
- `description` is supporting information: the summary tooltip and the content of the secondary call-details disclosure only; never a replacement title or part of the primary result.
- Discovery metadata is external input. Before it enters tool events or persistence, server/tool identifiers are trimmed and bounded to 256 characters and descriptions to 4 KiB. Empty bounded identifiers suppress the MCP presentation payload.
- Host Node REPL tools keep their dedicated renderer even with MCP presentation metadata; the MCP label must not replace their code, error, artifact or reset/configuration UX.

## Detail

- The default expanded detail shows the normalized tool result when one exists. Running rows may show their lifecycle state as quiet supporting text until a result exists. It never leads with description or parameters.
- Pending and stopped rows are summary-only lifecycle markers: no expand affordance, no detail content.
- A secondary `View call details` disclosure follows the result and reuses the transparent BUA / Node REPL detail pattern. It holds the discovery description and normalized input when available; empty input is allowed because this surface is diagnostic.
- The disclosure control and layout stay outside content cards. JSON or long technical data may use the existing bordered code surface inside the disclosure.
- Result presentation reuses the BUA / Node REPL primitives: a single-line result up to 160 characters uses the compact bordered card; multiline or JSON output uses the bounded scrollable code surface with result actions; failures use the compact destructive result surface. With trusted presentation metadata, MCP must not fall back to the generic uppercase `RESULT` / `ERROR` debugger layout.
- The generic fallback's duplicate full `toolCall` JSON block is not rendered for MCP rows, including legacy rows recovered from the explicit MCP envelope.
- The synthetic tool name, IDs and raw projection fields stay available through diagnostics and snapshots, not in the default reading path.
- Existing text, image and structured output rendering stays authoritative.

### Lifecycle matrix

| Row state | Summary | Primary detail | Secondary call detail |
| --- | --- | --- | --- |
| input streaming / pending approval | MCP source + action; omit pending status | not expandable | not expandable |
| running | MCP source + action; omit running status | current status until output exists | description + normalized input |
| success | MCP source + action; omit completed status | result | description + normalized input |
| error | MCP source + action + failed status | error/result | description + normalized input |
| cancelled / stopped | MCP source + action + stopped status | not expandable | not expandable |

## Compatibility and boundaries

- The display payload is optional and additive. Old persisted MCP sessions use the bounded legacy compatibility presentation above; other old providers use the generic fallback.
- Presentation metadata does not participate in permission or security decisions. MCP identity for permission policy still comes from the tool capability declaration.
- Desktop continuous and Web remote replayable consume the same persisted V4 row field; there is no separate stream, queue, snapshot or recovery state.
- Pending and running tool-part persistence carries the bounded MCP display metadata. Cold hydration reuses it when an unfinished call is closed as stopped, so `MCP server · tool · stopped` never regresses to the generic `Tool call · Stopped` summary.
- Streaming-early tool execution is a first durable writer: its pending and running part writes carry the same bounded MCP display metadata before tool scheduling/execution. A turn Stop or process loss may happen before end-of-stream drain, so no later model-step write may be required to make cold/replayable recovery presentation-complete.
- Labels use existing semantic color and `text-ui-*` tokens and stay usable on desktop and mobile Web, in both themes and locales.
