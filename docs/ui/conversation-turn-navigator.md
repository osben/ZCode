# Conversation Query Navigator

The V4 conversation query navigator is the compact jump rail on the left of the chat timeline. It is not a scroll minimap mapped by real message height; it is a set of small bars stacked evenly in the order of user-visible queries. The directory must cover all user queries of the current effective branch: the first frame keeps using a bounded tail snapshot, and when earlier rows exist on a wide screen the existing `rows/range` read-only paging completes the full rows, from which the directory is derived in the renderer projection. It adds no second copy of session facts, replayable queue, relay or main process state.

```text
CLI full projection
  -> bounded v4 snapshot.rows tail
  -> navigator-visible renderer
       -> rows/range(200 rows/page) until firstRowId
       -> epoch/cursor validation (all pages, before any commit)
       -> chunked projection prepend (one page per chunk, yield between chunks)
  -> buildConversationTurnRenderUnits(full rows)
  -> ConversationTimeline virtualizer
       |-> message column
       |-> left compact query rail virtualizer
             one item: one UserInputRow(origin=realUser)
             hover/focus: that user query + owning turn assistant excerpt
             click: mount unitIndex -> align exact rowId
```

## Change boundary and confirmation record

| Decision                | Product semantics                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation granularity  | Each timeline-visible `UserInputRow(origin=realUser)` gets its own item; an ordinary query and an accepted steer/guide are equivalent                                                                                                                                                           |
| Same product turn       | The initial query, guide 1 and guide 2 may share `turnId` / `unitIndex` but must have different `rowId`, navigation items and landing points                                                                                                                                                    |
| Tooltip                 | The first section shows that user query; the second keeps the owning product turn's assistant text excerpt or the running/empty-result fallback; the body of tool, reasoning, subagent or marker is not concatenated                                                                            |
| Queue boundary          | An input still in the pending queue has no timeline row/anchor and does not enter navigation; it enters only after being consumed and projected as a visible real user row                                                                                                                      |
| Full directory          | User confirmed 2026-07-24: the directory cannot cover only the current tail window; it must complete all rows of the current effective branch until `window[0].rowId === firstRowId`                                                                                                            |
| Virtualization          | The full directory mounts only the buttons inside the rail viewport and overscan; `data-item-count` means the total query count, and the DOM button count no longer equals the directory total                                                                                                  |
| Cross-platform boundary | desktop continuous and web remote replayable share the existing `rows/range` read-only query; no cross-platform FIFO, snapshot field or recovery state is added; at `conversation < 864px` no request is sent, and on a wide screen it probes backward when the tail has fewer than two queries |
| Composer hit            | A rail sitting in the transparent left margin of the sticky composer must still hover/click; the transparent outer shell of the composer dock must not capture events, and the real composer content stays interactive                                                                          |

## Scope

- The navigator does not measure the geometry between the pane and the main input column with JavaScript; the final show/hide and reserved space for wide and narrow panes, split view and mobile `/remote` are handled by CSS container queries. The renderer only observes whether the named conversation container reaches the same `864px` data-loading threshold, so an invisible rail does not trigger an expensive full-history backfill.
- It shows only when there are 2 or more navigable queries and the named `conversation` container is at least `864px` wide; below `864px` CSS hides it and no JavaScript width-measuring state is added.
- Each bar represents one visible `UserInputRow(origin=realUser)`; multiple steer/guide queries within the same `ConversationTurnRenderUnit` each get an item.
- A marker-only `timelineOnly` unit v1 does not enter the minimap, so a compact/fork/goal boundary is not misread as a user-and-assistant turn.
- When the navigator reaches `864px` and the snapshot still has earlier rows, it probes the full effective branch in the background; the complete history shows the directory with chunked prepend only when it reaches 2 navigable queries, and with only one it scans to the start but does not keep probing rows resident. While backfilling the directory is marked `aria-busy=true`; on success it must show all queries, and on failure it keeps the current window and waits for a new cursor/explicit retry opportunity without entering a conversation error state.

## Data boundary

The Navigator still consumes only `buildConversationTurnRenderUnits(rows)`, but the directory first has the same `ConversationProjectionStore` complete the rows through the existing `rows/range`:

- Each `origin=realUser` row in `visibleUserInputs` provides one navigation item and a question summary.
- `assistantTextRows` keeps the old logic providing the assistant reply summary of the owning product turn; several query items in the same turn may share this assistant summary.
- The summary normalizes only the first 4096 raw characters (`PREVIEW_SCAN_CHARS`) of the owning turn text and no longer runs `split` and `replace` on a whole long reply. The prefix result is used only when it can be proven byte-identical to the full normalization (a paragraph already closed by a separator is enough, or the prefix-normalized length exceeds the summary cap); otherwise it falls back to full normalization.
- `rowId` is the exact DOM anchor of the query; `unitIndex` only mounts the owning virtual turn first.
- `isRunning` emphasizes only the last real user query of the running unit.
- The body of tool, reasoning, subagent and compact marker does not enter the hover summary.
- Full backfill pages with `rowsRangeMaxLimit`. All pages are fetched and validated first (epoch, cursor continuity, realUser query count, `hasMore` termination); on validation failure the whole batch is discarded and no rows are committed.
- After validation passes, it prepends in page chunks: commit the most recent page adjacent to the current window first, then earlier pages in turn, yielding one event-loop turn (`setTimeout(0)`) between chunks. The old implementation committed about 1480 rows at once on a 1052-message session and blocked the render main thread for about 570ms in user measurement. Now `buildConversationTurnRenderUnits` reuses a cache by turnId, so the per-chunk cost depends only on the turns that chunk adds; chunking does not change the final state and creates no long task.
- `loadingOlder` stays `true` from the first rows/range request until the last chunk is committed. Scroll-triggered `loadOlder` and in-conversation find are therefore held throughout the chunked period; the terminal states (`hydrated` / `not-enough-queries`) are written only after the last chunk.
- Before each chunk commit the snapshot is rechecked: `logEpoch` must still equal the starting value, and the window's first row `rowId` must equal the cursor this chunk continues from. If either fails (a forced snapshot rewrites the window, truncation removes the first row, the epoch changes or the store is closed) it stops later chunks and returns `stale` without writing a terminal state; chunks already committed are still valid rows of the same epoch, and the Timeline re-triggers the backfill under the new directory revision. Deltas arriving between chunks keep taking effect: an append touches only rowIds after the window, a prepend does not change `seq` alignment, and the reading-position anchoring of a prepend is computed per commit, so chunking needs no extra anchoring logic.
- During the fetch and validation phase, if `logEpoch` changes or the first-row cursor is rewritten by a snapshot/resync, the whole batch is discarded and reviving old-branch rows is forbidden; the abort rules of the commit phase are described in the chunking notes above.
- The full-directory probe returns a discriminated result `hydrated / not-enough-queries / retryable-failure / stale`; `hydrated` and `not-enough-queries` are recorded as terminal by `sessionId + logEpoch`, and an ordinary `loadOlder` changing the renderer's first row must not trigger a repeated scan. A transient failure retries at most twice with `250ms / 1000ms` backoff; stale writes no completion marker and waits for a new snapshot/epoch to re-trigger.

```text
desktop-continuous stream
  -> tail projection
  -> rows/range full hydration
  -> navigator items

web-remote-replayable restore
  -> tail projection
  -> same rows/range full hydration when wide navigator is visible
  -> navigator items
```

Both chains share the same CLI projection and read-only query. The navigator persists no independent directory, does not stuff full rows back into the wire snapshot, and does not restore or stitch the minimap's own history.

## Interaction

- Hovering or keyboard-focusing a bar shows a `HoverCard`: the first section is that user query and the second is the first few paragraphs of the owning product turn's assistant text; with no terminal body, running/empty-result copy is shown.
- On click, if the row is already mounted it aligns directly by `rowId`; if not mounted it first calls `virtualizer.scrollToIndex(unitIndex, { align: "start" })` and aligns exactly by `rowId` in a later animation frame, without falling back to the first query of the same turn.
- If the user enabled `prefers-reduced-motion: reduce`, click uses instant/auto scrolling; otherwise smooth.
- The real user row currently shown near the top of the viewport is derived as the active query. In the default state active is expressed only by color/opacity and does not change the bar width or height.
- Bar position uses neither `getOffsetForIndex()` nor a real scroll ratio; active is judged only by the virtualizer's visible window.
- On hover/focus that bar temporarily takes the visual focus with a "mountain" effect: the center bar is longest and brightest, and the nearest 1-2 bars lengthen only decreasing by distance, with no stepped color gradient. After mouseleave/blur the mountain disappears and only the scroll-active color state remains.
- The rail uses fixed-row-height virtual scrolling, rendering only visible items and a small overscan; when the timeline's active query changes, the rail scrolls the matching directory item into its own viewport with the public virtualizer API.
- Only transform, opacity, color or height animate, with `motion-reduce:transition-none` supported.

## Layout

- The rail is fixed on the left inside the timeline viewport, using a compact equally spaced vertical stack; bar spacing does not vary with message height.
- At `conversation < 864px` the rail is hidden with `visibility + opacity + translateX`, and from `864px` it fades in and slides back; the transition must support `prefers-reduced-motion`. When hidden, Markdown tables must no longer reserve the rail's `48px` left space.
- The rail's full interaction area stays `48px` wide; React neither measures the geometry between the main input column and the timeline nor decides rail mounting through `ResizeObserver`; ResizeObserver only provides the container eligibility for full-history backfill and does not take part in layout.
- The rail stack is vertically centered inside its owning `ConversationTimeline` container. In split view each pane uses its own timeline container's midline, not the whole app/window height.
- Adjacent button hit areas must be contiguous, with no CSS `gap` leaving a hole, so the hover state does not break when the mouse slides vertically across blank space.
- The full-width transparent outer shell of the sticky composer dock uses `pointer-events:none` and restores `pointer-events:auto` only on the actual content column; the rail must keep hover, focus and click even when it extends into the composer's vertical range.
- Inline expansion of the right status panel does not change the rail's left-edge position. The rail takes no part in the body column width and message height computation.
- No raw colors; bars and hover card use semantic tokens such as `bg-popover`, `text-popover-foreground`, `border-popover-border`, `foreground-subtle/subtlest`.

## Testing

Coverage is registered in the `TN` group of `docs/conversation-session-case-catalog.md` and in `docs/testing/conversation-session-e2e-coverage-matrix.md`. Unit tests cover per-query item derivation, active row derivation for multiple queries in one turn, full paging with validate-first then chunked prepend (including abort on a mid-way epoch or cursor change, and deltas taking effect between chunks), golden equivalence of bounded assistant preview normalization with full normalization, and the hover-only mountain visual levels; E2E covers wide-pane display, hiding and restoring in a narrow pane after the window narrows, compact left-attached contiguous hit areas, hits in the composer's vertical coverage area, the query + assistant tooltip, directory virtualization and exact click jump.

## Impact brief and pruning

| Field                 | Conclusion                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change layer          | `presentation + recovery(read-only pagination)`                                                                                                                                                              |
| UI surface            | `ConversationTimeline -> ConversationTurnNavigator`                                                                                                                                                          |
| Display owner         | renderer `ConversationProjectionStore` and the React virtualizer                                                                                                                                             |
| Authoritative owner   | CLI `ProductProjection`; the directory does not become a new source of facts                                                                                                                                 |
| commit/effect         | No write command; calls only the existing `v4/conversation/rowsRange`                                                                                                                                        |
| Downstream to inspect | scroll prepend anchoring, conversation find, active query, sticky composer hit, wide/narrow pane gate                                                                                                        |
| Isolation invariants  | Do not enlarge the wire snapshot; do not modify queue/owner/lease; do not confuse continuous/replayable; zero requests in a narrow pane; the tail's partial query count is not used as the full-branch count |

Pruning conclusion: a large completed conversation is the representative for full and virtualized; running only adds the epoch/cursor concurrency guard and is not crossed with model/provider, queue, goal, compact, theme, locale. Desktop wide is the pointer hit-test representative; plain Web and mobile share DOM/CSS, and narrow mobile is pruned by the hydration eligibility gate. Remote only verifies reuse of the existing `rows/range` and the epoch boundary and does not duplicate a directory business state.
