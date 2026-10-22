# Model trajectory input projection

## Problem

The runtime's normalized `request.messages` keep an assistant message's tool calls in a top-level `toolCalls` array (`{ id, name, input }`), not inside `content`. The reader mapped only `content`, so every historical tool call vanished from a call's input while the matching `role: "tool"` results stayed as orphans (one real session: 140 `tool_use` blocks on the wire, 0 projected).

## Owner

Host projection: `mapMessages` in `packages/services/src/zcode-agent/modelTrajectory.ts`. The model-io disk format does not change. Delta and reconstruction rules stay in `specs/model-trajectory-input-deltas.md`.

## Product rules

1. An assistant message's `toolCalls` entries are projected as `tool-call` parts, appended after the message's `content` parts, in recorded order.
2. They map exactly like `response.toolCalls` (`mapResponseToolCall`): `id` becomes `toolCallId`, `name` becomes `toolName` (default `"tool"`), and `input` is bounded with the same per-part budget and `truncated` marker.
3. `toolCalls` on non-assistant messages are ignored. A missing or empty `toolCalls` adds nothing.
4. The input-delta identity is the serialized projected message, so tool-call parts are part of the prefix comparison. Prefix detection is otherwise unchanged.
5. The viewer renders these mixed assistant input rows through the existing mixed-message path: every part is shown, and text comes before the tool input in the preview.

## Acceptance scenarios

Unit tests: `packages/services/test/modelTrajectoryInputToolCalls.test.ts`.

1. An assistant message with `content: [reasoning, text]` and `toolCalls: [{ id, name, input }]`, followed by a tool result. The projected assistant message is `[reasoning, text, tool-call]`, and the tool result's `toolCallId` matches the tool-call part.
2. String `content` plus `toolCalls` projects to `[text, tool-call]`.
3. A tool-call input over the part budget is bounded and carries `truncated`.
4. A main call whose input extends the previous one by an assistant message with tool calls and a tool result is still a delta with the right `sharedPrefixCount`. Its reconstruction equals the full projection.
