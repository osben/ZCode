# Synthetic Timeline Dividers

The chat area has several non-body timeline dividers: context compaction, session fork, model change and goal verification. They explain session state changes and are not assistant body. The turn view model is in [conversation-turn-view-model.md](./conversation-turn-view-model.md); the persistence spec is in [conversation-transcript-storage.md](./conversation-transcript-storage.md).

## Behavior constraints

- A timeline divider is first classified as worklog or boundary, then turned into a ChatView render row.
- Compact is an assistant-turn worklog: a completed auto compact may attach to the history prefix of the following assistant and be folded by "worked for xxx"; a running / retrying compact stays visible.
- goal verification and session fork are boundaries: they must not attach to the history prefix / suffix of the previous or next assistant.
- When compaction starts, sending `/compact` immediately inserts a local `context_compaction` started divider, so the user sees the "compressing context" state at once; on completion the same divider updates to completed.
- The local optimistic compact divider and the agent lifecycle divider must merge into one UI message. The agent lifecycle may carry no `inputId`; then fall back to matching "the latest local running compact divider + a non-local operationId".
- A running `context_compaction` and `goal_verification` timeline are already dedicated progress feedback, so the bottom ChatLoading is hidden during that active work. `session_fork` and `model_change` are explanatory dividers only and do not keep the main turn in running state.
- A running / retrying compact and goal verification are assistant output boundaries, not part of the previous or next assistant's work duration; before entering such a divider the ordinary assistant still streaming must be frozen. A completed auto compact renders as the following assistant's worklog prefix and is no longer frozen as a top-level boundary. `session_fork` and `model_change` do not freeze assistant duration.
- `session_fork` and `goal_verification` come from the agent / snapshot synthetic timeline and are restored with the snapshot.
- Legacy `model_change` is a renderer-local UI timeline marking where a model switch happened. Under transcript v2 a newly occurring model change is written as agent-side `part.type="timeline"`. It is still not injected into agent context and not persisted as an agent message.

## Stable identity

- `ZCodePersistedMessage.id` stores the protocol-side original `messageId`. Snapshot restore prefers it so live and restored messages use the same id.
- For an old snapshot without `id`, the UI generates a fallback id from timeline semantics:
  - `context_compaction`: `operationId`
  - `goal_verification`: `targetId + goalIteration` (`verificationId` is only the verifier attempt)
  - `session_fork`: `parentSessionId + targetMessageId + targetCheckpointId`
- Terminal snapshot alignment dedupes timelines by both id and semantic identity, so old data, replayable recovery and the desktop continuous terminal snapshot never insert the same divider twice or move it.

## Multi-end boundary

Only message projection, recovery dedupe and ChatView rendering change; task realtime paths do not:

- Desktop stays `desktop-continuous` direct realtime.
- Mobile remote stays `web-remote-replayable` snapshot / gap recovery.
- The relay and main process add no task/session business state.
