# Web Remote Control Snapshot Byte Budget

## Goal

When the mobile Web remote control opens large historical tasks, the first screen must not be blocked by the complete snapshot transmission and JSON parsing of a single oversized assistant message. The current implementation only enables the snapshot byte budget in the Web remote control scenario; the desktop continues with full recovery.

## Implementation

- The UI remote control first screen request carries `messageLimit=10` and `byteBudget=200KB`.
- The UI remote control first screen currently does not carry `toolLimit`. Tool calls keep complete item counts; only the response-state byte budget cuts the inflated fields, avoiding breaking the original order of assistant parts/tools.
- The server first trims the tail by message count, then calculates the response JSON volume.
- If the volume still exceeds the budget, it trims the `content` / `thought` of assistant messages, the `input` / `output` / `raw` of tool calls, and the `beforeContent` / `afterContent` in `fileChanges`.
- `bodyRefs` contain the field name, complete body hash, complete byte count, preview byte count, and the `refId` that can be fetched.
- After tool calls are truncated, `snapshotRefs` are returned on the tool object; after file changes are truncated, `contentRefs` are returned on the file snapshot.
- `toolSlice` / `getTaskSnapshotToolCallsSlice()` are retained as service capabilities, but the current mobile remote control first screen does not proactively slice by tool count.
- When truncating `raw`, retain associated metadata like `toolCallId`, `kind`, `title`, `status`, `_meta.claudeCode.toolName`, `_meta.claudeCode.parentToolUseId`, small `backgroundAgent`, etc., to avoid breaking the ID and parent-child relationships of historical tool blocks.
- When the mobile client sees `bodyRefs`, it displays "currently showing only the preview" and provides a "View full message" button.
- After clicking, call `getTaskSnapshotBody({ refId })` to fetch the full body; after hash validation passes, replace the preview content in the local store.

## Current Thresholds

- Total remote control first screen snapshot target budget: `200KB`. This is a response-state soft budget; the server first trims the most inflated fields; if the remaining structural metadata itself exceeds the budget, it does not continue to delete structural fields to forcibly press below the budget.
- Assistant `content` / `thought`: preview limit is `min(32KB, max(2KB, floor(byteBudget / 3)))`.
- Tool `input`: after exceeding `1KB`, truncated to a `256B` preview.
- Tool `output`: after exceeding `4KB`, truncated to a `512B` preview.
- Tool `raw`: after exceeding `2KB`, truncated to a `256B` serialized preview, while retaining necessary associated metadata.
- File changes `beforeContent` / `afterContent`: after exceeding `8KB`, truncated to a `4KB` preview.

## Data Integrity

- Truncation only happens in the response-state snapshot and is not written back to the local session JSON.
- `refId` uses the persisted message's original index, not the truncated array index, to avoid fetching the wrong message under `messageLimit`.
- If the hash does not match or the body does not exist, the UI retains the preview state and allows retry.
- In-flight unpersisted temporary assistant messages do not generate `bodyRefs`, avoiding unfetchable references.
- `getTaskSnapshotRef({ refId })` re-reads the local task JSON and returns the complete tool field or file content after hash validation, ensuring truncation does not change the integrity of persisted data.
- If tool item slicing is re-enabled in the future, `getTaskSnapshotToolCallsSlice({ taskId, messageIndex, startToolIndex, limit })` returns slices by the original tool index range; the current main path depends on field-level truncation, not tool paging.

## Interaction Constraints

- In the preview state, the copy button prompts "Copy after loading the full message" to avoid mistakenly copying preview text as the full body.
- The old history "Load older messages" and the single large message "View full message" are two independent paths: the former fetches message counts, the latter fetches single message bodies. The tool call count is not currently truncated on the first screen, so there is no independent "View more tool calls" main path.
