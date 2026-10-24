# Conversation Share — Backend API Revision 23 Contract

Shipped (2026-08-11). Implementation and tests: `packages/shared/src/conversation-share.ts`,
`packages/services/src/conversation-share/conversationShareIntegrity.ts`,
`conversationShareService.ts`, `conversationShareMockApiClient.ts` and their test files.
The UI and RPC contract are unchanged.

## Confirm request

- The confirm DTO has exactly four top-level fields: `selected_product_turn_ids`, `projection`,
  `integrity`, `disclosure_confirmation`. The schema is strict: it must reject a legacy body
  containing `payload_sha256` (mock returns code `3001`).
- Confirm must not send `schema_version`, `client_request_id`, `title`, `access_mode`,
  `content_selection_id`, `artifacts`, or `integrity.payload_sha256`.

## Integrity

- Preview and Continuation integrity contains only `projection_sha256` and `artifact_set_sha256`
  (two-hash integrity). `payload_sha256` no longer appears in any response integrity.
- Publish integrity is split from preparation idempotency: the service hashes the complete slim
  confirm DTO with `sha256ConversationShareJson(confirmRequest)` and passes that stable lower-case
  value only as `preparation.payload_sha256`.
- `projection_sha256` is computed from `projection.rows`; `artifact_set_sha256` is computed from the
  sorted local-only artifact descriptors that are intentionally absent from the confirm DTO.

## Naming

- `ConversationRow` fields stay camelCase; share-service HTTP fields stay snake_case.

## Mock reconstruction

- `StoredShare` keeps `title`, `accessMode` and sorted uploaded artifacts separately from the slim
  confirm request, because revision 23 intentionally removes preparation metadata and artifact
  descriptors from confirm. The mock reconstructs them like the backend.
- Confirm requires `preparation.uploads.size === preparation.request.artifact_count`, rebuilds the
  expected two hashes with `buildConversationShareConfirmRequest`, and compares only those hashes.
  Response metadata comes from preparation; artifact responses come from `StoredShare.artifacts`.
- Unchanged: desktop continuous delivery and web remote replayable recovery; unrelated dirty
  worktree changes are preserved.
