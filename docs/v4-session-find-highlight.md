# V4 Session Find Highlight

This document records the product semantics and implementation boundary of search highlighting in the
V4 conversation area. The capability covers two entries:

- The "Conversation" scope of the task find box opened by `Cmd/Ctrl+F`.
- The temporary jump highlight after searching in the Command Center and selecting a conversation result.

## Product semantics

- The first version searches only `userInput.text` and `assistantText.text`; it does not search tool,
  reasoning, timeline marker or text inside collapsed regions.
- Matching is case-insensitive plain-text search with no regex; hits within the same text node do not overlap.
- The V4 timeline uses virtual scrolling; counts are based on the data index of loaded projection rows,
  and the visual highlight applies only to the currently mounted DOM.
- Search automatically back-fills older history, but only up to `1200` projection rows in the local
  window. Beyond that limit only the count of the currently loaded range is updated, with no extra status text.
- In split view only the focused pane consumes the Cmd/Ctrl+F search state and reports the count;
  non-focused panes draw no highlight and do not override the global count.
- While the session is `running` or `prewarming`, history back-fill does not start and results are not
  reordered in real time by streaming deltas; after the current turn stabilizes the count is recomputed
  and the highlight restored.
- When background back-fill of older history inserts more results before the current hit, the current
  highlight is anchored by `rowId + row kind + hit index within the row` and does not jump to another match.

## State chain

```text
Cmd/Ctrl+F
  -> App conversationFindQuery / activeIndex
  -> focused V4 SessionPane
  -> ConversationTimeline builds the data-level match index
  -> report count / rebased activeIndex
  -> virtualizer.scrollToIndex(unitIndex)
  -> mounted row DOM
  -> CSS Highlight base + active ranges
```

```text
Command Center result
  -> App searchResultHighlightRequest
  -> Shell filters by taskId + workspaceKey
  -> target focused/primary V4 timeline
  -> snippet/query locates the match
  -> virtualizer scroll + temporary CSS Highlight
  -> after 3000ms clear and onSearchResultHighlightDone(requestId)
```

## Implementation boundary

- No new app/agent protocol; the existing `rowsRange` / `loadOlder` is reused.
- CSS uses `--color-find-highlight` and `--color-find-highlight-active`; no new color token is added.
- When the CSS Highlight API is unavailable, count and scroll ability are kept and no `<mark>` fallback is implemented.
- The Command Center jump highlight does not open the Cmd/Ctrl+F find box and does not write `conversationFindQuery`.
