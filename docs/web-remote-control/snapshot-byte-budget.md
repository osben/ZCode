# Web Remote Control Snapshot Byte Budget

## Goal

When mobile Web remote control opens a large historical task, the first screen must not be blocked by
transmitting and JSON-parsing the full snapshot of one oversized assistant message. The byte budget applies
only in the Web remote control scenario; the desktop keeps full recovery.

## Rules

- The UI remote control first-screen request carries `messageLimit=10` and `byteBudget=200KB`. It carries no
  `toolLimit`: tool calls keep complete item counts and only the response-state byte budget cuts the inflated
  fields, so the original order of assistant parts/tools is not broken.
- The server trims the tail by message count first, then measures the response JSON size. If it still exceeds
  the budget, it trims `content` / `thought` of assistant messages, `input` / `output` / `raw` of tool calls,
  and `beforeContent` / `afterContent` in `fileChanges`.
- `bodyRefs` carry the field name, full-body hash, full byte count, preview byte count and the fetchable
  `refId`. After tool calls are truncated, `snapshotRefs` are returned on the tool object; after file changes
  are truncated, `contentRefs` are returned on the file snapshot.
- `toolSlice` / `getTaskSnapshotToolCallsSlice()` stay as service capabilities, but the mobile first screen
  does not slice by tool count. If it is re-enabled,
  `getTaskSnapshotToolCallsSlice({ taskId, messageIndex, startToolIndex, limit })` returns slices by original
  tool index range.
- When truncating `raw`, keep associated metadata (`toolCallId`, `kind`, `title`, `status`,
  `_meta.claudeCode.toolName`, `_meta.claudeCode.parentToolUseId`, small `backgroundAgent`) so the ID and
  parent-child relations of historical tool blocks stay intact.
- When the mobile client sees `bodyRefs` it shows "currently showing only the preview" and a "View full
  message" button; clicking calls `getTaskSnapshotBody({ refId })` and, after the hash check passes, replaces
  the preview content in the local store. `getTaskSnapshotRef({ refId })` re-reads the local task JSON and
  returns the full tool field or file content after hash validation.

## Thresholds

- Total first-screen snapshot budget `200KB`: a response-state soft budget; the server trims the most inflated
  fields first, and if the remaining structural metadata itself exceeds the budget it does not delete
  structural fields to force it below.
- Assistant `content` / `thought` preview limit: `min(32KB, max(2KB, floor(byteBudget / 3)))`.
- Tool `input`: over `1KB` is cut to a `256B` preview. Tool `output`: over `4KB` to a `512B` preview. Tool
  `raw`: over `2KB` to a `256B` serialized preview plus the necessary metadata.
- File changes `beforeContent` / `afterContent`: over `8KB` cut to a `4KB` preview.

## Data integrity

- Truncation happens only in the response-state snapshot and is never written back to the local session JSON.
- `refId` uses the persisted message's original index, not the truncated array index, so `messageLimit` cannot
  fetch the wrong message.
- If the hash does not match or the body does not exist, the UI keeps the preview state and allows retry.
- In-flight unpersisted temporary assistant messages generate no `bodyRefs`, avoiding unfetchable references.

## Interaction constraints

- In preview state the copy button prompts "Copy after loading the full message" so preview text is not
  mistaken for the full body.
- The old "Load older messages" (fetches message counts) and the single large message "View full message"
  (fetches one message body) are independent paths. Tool call counts are not truncated on the first screen, so
  there is no independent "View more tool calls" main path.
