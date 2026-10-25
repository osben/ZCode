# Assistant Row Actions (Current Facts)

The action area of an assistant turn offers copy, like, dislike, fork and retry, and shows the creation time of that assistant message at the end. The action area is attached only after the last completed assistant text of a turn; when a turn has several text parts it is not repeated on the middle parts.

## Behavior

- Copy copies the merged assistant text of the turn, not just the last part.
- Like / dislike are mutually exclusive feedback. Clicking the currently selected one clears the feedback; clicking the other switches directly.
- Feedback lives only in the local state of the current `ConversationAssistantTextActions` component; it is cleared on remount, refresh or reopening the task, and is not written to the transcript, database or renderer store.
- A click only updates the current button state and reports app telemetry; it sends no V4 command, does not enter provider-visible history and is not injected into later Agent prompts.
- Whether Fork is available is decided entirely by the CLI-projected `row.actions.canFork`; a stable assistant row that is still running can also be released by the CLI stable resolver, and the pane does not guess by phase.
- Retry sends V4 `retryTurn`, targeting the corresponding turn/row.
- Fork sends V4 `forkAssistant`; the successful ACK returns the child sessionId, which then converges through the authoritative sessions/projection.
- The time comes from the CLI-projected `AssistantTextRow.createdAt` and expresses the message creation time, not the working duration of the turn. Today shows only hour:minute, yesterday shows "Yesterday" + hour:minute (UI string "昨天"), earlier this year shows month-day and hour:minute, and a previous year shows year-month-day and hour:minute; an invalid or non-positive timestamp is not shown, avoiding a 1970 placeholder time.

## Time source

```text
live ModelStreaming event.timestamp ──┐
cold message.info.time.created ───────┤
                                      v
                           AssistantTextRow.createdAt
                                      |
                            locale/timezone formatter
                                      |
                    completed assistant action toolbar
                         /                         \
          desktop hover/focus          mobile /remote always visible
```

Live continuous uses the CLI event time directly; cold hydration must pass the transcript assistant message `info.time.created` to the synthesized `text_start` event and must not degrade to "first session time + synthetic sequence". The total event order is still decided by `sequenceNumber`, and the timestamp is only for display. Desktop continuous and mobile replayable both finally consume the same `row.createdAt` fact, each formatted locally in its own locale/timezone.

## Feedback state chain

```text
desktop / mobile assistant action toolbar
                    |
                    v
          localReaction: null / like / dislike
                    |
          +---------+---------+
          v                   v
  aria-pressed / style   fire-and-forget telemetry
```

Feedback has no authoritative fact across the component lifecycle and does not take part in the desktop continuous or mobile replayable message chain. CLI, host, relay, desktop main, transcript and database neither read nor store this state.

## Display and accessibility

- The UI reuses the compact ghost/icon style of `MessageAction` and semantic color tokens; the selected state keeps clear background feedback.
- Uses `aria-pressed`, a localized label and a visible focus state.
- On desktop it shows with hover/focus of the assistant turn; mobile `/remote` has no hover, so the action area is directly visible and buttons are not wrapped in a Tooltip, so that the first tap on a touch screen is not swallowed by hover/portal.
- The time shows and hides together with the action area, placed after all available actions; it is read-only metadata and adds no clickable area.
- The press selection animation respects `prefers-reduced-motion`.

Implementation entry: `ConversationRowView.tsx` and the shared test ids.
