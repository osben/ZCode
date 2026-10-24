# Conversation Share — Historical Artifact Discovery Contract

Shipped (2026-08-12). Implementation and tests:
`packages/services/src/conversation-share/conversationShareArtifactDiscovery.ts`,
`conversationShareService.ts`, `conversationShareArtifactSource.ts` and their test files; protocol
watermark in `packages/shared/src/zcode-protocol-v4/transport.ts`.

## Watermark

- `V4ConversationRowsRangeResult.atRevision: number` is required; `conversationRowsRangeV4` returns
  rows with their read watermark `{ revision, logEpoch }`. Every page must report identical
  `atRevision` and `atLogEpoch`; a mismatch throws `invalid_conversation` before any preparation
  request.

## Discovery

- Only local desktop publishing. Remote workspace and mobile replayable behavior are unchanged.
- Discovery inputs are the V4 file-change facts, never content: do not parse assistant text, Bash
  commands or stdout, and do not scan the workspace.
- After turn selection, each selected terminal `turnHeader` whose `fileChanges.files > 0` is queried
  through `conversationFileChangesV4` at the captured revision/epoch, targeting the header's stable
  `rowId`/`entityId`. Stale revision/epoch failures map to `invalid_conversation`.
- Only extensions matching `capabilities.allowed_artifacts` become candidates. Unselected turns,
  unsupported extensions and `state: "reverted"` entries create no transient row.
- Explicit artifact rows win over file-change candidates with the same canonical realpath;
  deduplication is by `canonicalPath`. Count/byte limits are enforced after the merged set is known.

## Materialization and upload

- `ConversationShareArtifactSource.read` returns `{ bytes, canonicalPath }` — the canonical
  realpath from a safe async `realpath -> open -> stat -> bounded read`; outside paths and outward
  symlinks fail closed.
- Explicit rows are materialized first, then selected active candidates: derive MIME/type from the
  matched capability, compute current size and SHA-256, and build deterministic transient
  `ArtifactRow` values associated with the selected header.
- Transient rows are inserted after the source turn's existing selected rows, flow through
  `buildConversationSharePublicProjection`, and the already materialized bytes are uploaded in
  deterministic row order. Files are never reread after preparation; confirmed-preparation
  short-circuit semantics are preserved without uploading.
