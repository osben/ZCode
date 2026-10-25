# Conversation message pins (Message Pins) v1 spec

Users can pin important messages (their own inputs or assistant replies) in the
conversation timeline. Pinned messages show as a compact chips bar above the
timeline; clicking a chip scrolls to the original message. A pin is a human-facing
bookmark: it persists in the conversation transcript but **never enters model
context** (the model-visible state has its own `ui/update-model-context` mechanism,
which this feature must not use).

The feature mirrors the existing `feedback` (like/dislike) product path end to end:
display-only, transcript-first persistence, live/cold projections from the same
source. See `assistant-feedback-persistence.ts` and the `AssistantFeedbackUpdated`
event chain.

## v1 scope

1. Two row kinds can be pinned:
   - `assistantText` rows (the turn's final text segment, same anchor as
     Copy/Fork), only when `state === "complete"`;
   - `userInput` rows (the user's own input: `origin === "realUser"` and a
     transcript anchor messageId exists; backgroundResult / mailbox / synthetic /
     workflowLaunch and other system-generated rows cannot be pinned).
2. Data model (all additive, optional):
   - wire row schemas: `assistantTextRowSchema` / `userInputRowSchema` gain
     `pinnedAt?: number` (unix ms, CLI clock). The field's presence means pinned; the
     timestamp drives "newest pin first" ordering.
   - Old snapshots/sessions without `pinnedAt` must still parse (additive
     compatibility tests cover this).
   - Persisted messages (`ZCodePersistedMessage`) gain `pinnedAt?: number`, sibling
     to and in the same style as `feedback`; display/metrics only, never injected
     into Agent context.
   - Authoritative transcript storage: message `info.metadata.pinnedAt` (same level
     as `assistantFeedback`).
3. Command: `setRowPinned: { target: conversationRowTarget, pinned: boolean }`.
   - Added to `COMMANDS_REQUIRING_BASE_REVISION` (CAS) and `ROW_TARGETING_COMMANDS`;
   - gateway's `rowTargetActionForCommand` gains `setRowPinned`;
   - product-projection guard: `assistantText` requires `state === "complete"` and a
     resolvable messageId; `userInput` requires a resolvable messageId
     (`messageIdByRowId` anchor); otherwise `guard.actionUnavailable`.
4. Internal event: `SessionEventType.RowPinnedUpdated`, payload
   `{ entityId, pinnedAt: number | null }`. ProductProjection reduces it to
   `row.upserted` (with/without `pinnedAt`), structurally identical to the feedback
   reduction.
5. Persistence semantics (transcript-first, same as feedback):
   - write transcript metadata first, then append the event; on append failure,
     rollback compensation restores the original message;
   - once the event is persisted, a live projection failure does not return a
     failure ACK (resync/hydration converges);
   - idempotency: repeated pinning keeps the first `pinnedAt` (no timestamp
     refresh); unpinning an unpinned row is a no-op.
6. Cold start: `transcript-hydration` reads `pinnedAt` from assistant/user message
   metadata and replays `RowPinnedUpdated` after row creation events, so live and
   cold structures match.

## UI (v1)

- Pin button: one pin toggle (lucide Pin icon) in the assistant row action bar
  (Copy/like/dislike/Fork group) and the user row action bar (Copy/Edit group).
  Toggle semantics: clicking again unpins.
- Optimistic UI with failure rollback, same as `ConversationRowView`'s
  localFeedback pattern; in compact remote-control mode the toolbar is always
  visible and the button is inherited automatically, with no special casing.
- Pinned rows show a small pin badge icon inline.
- Chips bar (`ConversationPinnedBar`): rendered above the timeline;
  - each chip = text preview (about 60 characters, single-line ellipsis) + an
    in-chip "unpin" button;
  - horizontal scroll, no count limit; the empty state takes no space;
  - sorted by `pinnedAt` descending (newest first);
  - clicking a chip scrolls to the original message via the existing timeline jump
    mechanism (same path as `scrollToQuery`, locating by rowId).
- v1 limitation: chips reflect only the currently loaded row window
  (`rows.window`); historical pins outside the window do not appear until that
  range is loaded (follow-up: full range query).
- i18n: `chat.message.pin` / `chat.message.unpin` / `chat.pinnedBar.*` (all three of
  en-US, zh-CN, uk-UA are mandatory); testIds: `TID_V4_PIN` (row button),
  `TID_V4_PINNED_BAR`, `TID_V4_PINNED_CHIP` / `TID_V4_PINNED_CHIP_UNPIN` (the latter
  two carry a dynamic rowId suffix).
- Telemetry: `message_pin` (eventRegion `chat`, same shape as
  `assistant_message_feedback`).

## Out of scope (v1)

- Pin markers on `ConversationTurnNavigator` (follow-up);
- "share pins only" / pin digest;
- pin count limits/quotas;
- pinning in legacy (non-v4 / services legacy) conversations:
  `setAssistantMessageFeedback` has no callers in the services layer (dead code);
  pins do not copy that layer and use the single v4 command path.

## Follow-ups

1. TurnNavigator pin markers;
2. full chip-bar history (rows/range query aggregation);
3. cross-conversation pin export/sharing.

## Test boundaries

- executor: command parses target, passes host; stale writes rejected; invalid kind
  rejected;
- persistence: transcript-first write, idempotent repeat, event-failure rollback;
- hydration: old format (no pinnedAt) parses; assistant/user rows with `pinnedAt`
  restore on cold start;
- shared schema: additive compatibility (old row objects still parse);
- UI: pin click sends the command, failure rolls back, chips sort/jump/unpin;
- E2E (conversation-session): pin → chip appears → click chip scrolls to the message
  → unpin removes the chip.
