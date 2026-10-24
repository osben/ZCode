# Conversation Share Public Projection — Entity Identity Rules

Shipped (2026-08-11). Implementation and tests:
`packages/services/src/conversation-share/conversationSharePublicProjection.ts`,
`packages/services/test/conversationSharePublicProjection.test.ts`.

## Rules

- In the public projection, `rowId` and `toolCallId` are unique per share; `entityId` is a
  persistent entity identity that multiple public rows MAY reuse. Reusing one local `entityId`
  across rows (for example a `turnHeader` and a `userInput`) must not fail the build; both rows
  map to the same public id (for example `share-entity-1`).
- A present `entityId` must still match `PUBLIC_ENTITY_ID`; invalid format throws
  `invalid_conversation`.
- Every `triggerEntityId` must resolve inside the collected entity set; dangling references are
  rejected. The validator collects entities into a set for this reference closure only — it does
  not assert row-level uniqueness.
- `toolCallId` uniqueness is still asserted.
- The fix rationale stays as a Chinese comment in the validator: `entityId` is a persistent entity
  identity and one entity can project into multiple rows; only the reference closure is validated.

Boundary: UI, RPC, HTTP API, backend payload schema and realtime delivery are unchanged — only the
assertion semantics in `assertConversationSharePublicProjection` changed.
