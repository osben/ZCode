# review-last-turn

The Review side pane's "Last turn" source (spec: `specs/review-last-turn-source.md`, ISSUE-056).

Invariants:

- The v4 projection owns per-turn file changes (`turnHeader.fileChanges` and `v4/conversation/fileChanges`).
  This module only reads them; it adds no store slice, persistence or protocol.
- "Last turn" is the latest turn with `fileChanges.files > 0`; a later turn without changes does not clear it.
- Only the read-only bridge renders inside `V4PaneConversationProvider`. `GitPane` stays outside, so its Git
  calls keep the shell services. When the provider is unavailable the bridge unmounts and the source is empty.
- Results are keyed by workspace key, session, log epoch, row, entity, turn state and aggregate; a response for
  an older key is dropped.

Intersection with other modules: `AnimatedSidePanePanel` renders `GitPaneWithLastTurn` in place of `GitPane`.
`readonlyDiffPatch.ts` deliberately duplicates the private `formatPatch` in the upstream-owned
`v4/ConversationFileSummaryList.tsx`, so that chat file stays upstream-identical and outside this module's graph.
