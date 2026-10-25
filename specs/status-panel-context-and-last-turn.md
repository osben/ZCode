# Status panel: Context and Last turn sections

Adds two read-only sections to the V4 `ConversationStatusPanel` (current semantics:
`docs/ui/chat-summary-panel.md`). Git Tools is not changed: same component, rows, visibility rule and data.
Mockup: "Git tools rail" canvas (states board "New card states"). The mockup draws separate cards; the
implementation keeps the existing single panel shell and adds sections to it.

Out of scope: an MCP section (statuses come from the process-level `protocol-settings` pool, not the
session runtime, and refresh only on demand), a session-wide file aggregate (needs a new CLI projection),
and any Git Tools change (sync line, contextual actions, clean-but-ahead visibility).

## Product rules

### Context

1. Shows the current session's context window from `snapshot.usage.contextWindow`, the same fact the
   composer's context indicator reads. No second fetch and no polling.
2. The header shows the title `Context` and the used percentage `round(used / max × 100)%`. When collapsed, the
   percentage follows the chevron (header layout rule: `docs/status-panel-header-layout.md`).
3. The expanded body shows:
   - a progress bar (used / max) with a tick at the auto-compact threshold, drawn only when the threshold is
     authoritative (`autoCompactThresholdAuthoritative === true` and the value is non-null);
   - `used / max` in compact token format, and `N until auto-compact` under the same authority condition;
   - the source breakdown, only when `contextWindow.breakdown` is present: the same buckets and labels as the
     composer popover (`chat.contextUsage.breakdown.*`);
   - cumulative session tokens from `usage.cumulative`: input, output and cache read.
4. Tone follows `resolveContextBudgetTone` with the same inputs as the composer: `normal` uses the default bar
   colour, while `warning` / `critical` colour the bar and the header percentage with the warning or
   destructive token.
5. No section when `contextWindow === null` (capacity unknown, before the first model reply, some ACP agents), or
   when `usedTokens <= 0`, `maxTokens <= 0` or either is not finite (the composer's `getRenderableTaskUsage` gate).
6. Default state: collapsed. The open state is renderer-local per pane, like Terminals and Agents, and resets on
   session switch.
7. No actions in this iteration. The composer's Compress entry stays the only place to compact.

### Last turn

1. Lists the files changed by the **latest turn that has file changes** (`turnHeader.fileChanges.files > 0`
   with an `entityId`), the same turn selection as the Review pane's "Last turn" source
   (`specs/review-last-turn-source.md`, `selectLastFileChangeTurn`). A later turn without file changes does not clear it.
2. The header shows the title `Last turn` and the turn aggregate `N files +A -D` from the turn header (no detail
   fetch needed). A reverted turn (`fileChanges.state === "reverted"`) adds a `Reverted` label and keeps listing its files.
3. Expanded, the section lists every file of that turn (workspace-relative path, `+additions -deletions`,
   and `×writeCount` when > 1) inside the standard `12rem` section scroll viewport. Rows are ordered as returned by
   `v4/conversation/fileChanges`.
4. Clicking a file opens its read-only patch through `onOpenCodeViewer` (type `patch`), exactly as the chat's
   turn file summary does. When `onOpenCodeViewer` is absent (for example mobile remote without that side pane), rows are not interactive.
5. A trailing `Open in Review` row opens the Review pane with source `last-turn` through the existing
   `onOpenGitReview` callback. The row is hidden when that callback is absent.
6. While details load, the expanded body shows the aggregate line only. On failure it shows the aggregate line and
   retries on the next expand or aggregate change.
7. No turn with file changes in the loaded rows: the section is not rendered.
8. Default state: collapsed. Details are fetched only while the section is expanded.

### Visibility and order

- **Decision (confirmed 2026-10-24):** the new sections render only when the panel already has content
  (`model.hasContent` from the existing sections). They do not change `hasContent`, do not mount the panel by
  themselves, do not add the inline offset, and do not add a mini-pill summary. This keeps every current panel
  visibility, offset and pill rule unchanged.
- Order inside the shell: Git Tools, **Last turn**, Goal, Plans, Progress, Terminals, Agents, Workflows,
  **Context**. Separators follow the existing "second and later sections" rule.
- Office mode: same as Git Tools: Last turn is hidden. Context stays visible.

## Owners and data path

```text
CLI v4 ProductProjection (single owner)
  ├─ usage.contextWindow / usage.cumulative ─────────────┐  snapshot + ordered deltas
  └─ rows.window[turnHeader].fileChanges {files,+,−,state}┤
                                                          ▼
SessionPane (reader; holds the session projection lease)
  ├─ snapshot.usage ─────────────────────────────────────────► ConversationStatusPanel ► Context section
  ├─ selectLastFileChangeTurn(snapshot.rows.window) ─────────► ConversationStatusPanel ► Last turn section
  └─ handleFetchFileChanges(target, {cachePolicy, state}) ───► (on expand) items[path, +/−, writeCount, patches]
        shared request cache with the chat's turn file summary: no duplicate request for the same turn
```

- No new protocol field, RPC, store slice, persistence or `setting.json` key. The panel keeps no copy of
  usage or file lists beyond the current render and the in-flight detail result.
- Last-turn details are cached under the request key
  `[workspaceKey, remoteSessionId, sessionId, logEpoch, rowId, entityId, cachePolicy, header.fileChanges]`. While the
  turn runs, `cachePolicy` is `in-flight` and a refetch happens only when the aggregate changes. Once settled,
  `terminal` is used. A response for an older key is dropped (stale-result rule).
- Event order: a model call completes, the CLI updates the usage projection, the delta reaches SessionPane, and
  the panel re-renders. A file write updates the turn header aggregate, the delta changes the request key, and an
  expanded Last turn section refetches. Collapsed sections only re-render header numbers.
- Desktop (`desktop-continuous`) receives both facts from the live stream. Mobile remote
  (`web-remote-replayable`) receives them from snapshot plus gap repair through the same SessionPane. Both resolve
  identity with `workspaceIdentity?.trim() || workspacePath` and `remoteSessionId`.

## Code placement

- New fork-owned managed module `packages/ui/src/status-panel-insights/` (layer `ui`, registered with
  `pnpm architecture:adopt`). It holds the pure models `buildContextSectionModel(usage)` and
  `buildLastTurnSectionModel(header)` plus the two section **bodies** and their header trailing content. Its public entry is
  `index.ts` / `contract.ts`. It never imports from `ConversationStatusPanel.tsx`, so no import cycle is created.
- It requires `shared`, `ui` and `review-last-turn` (for `selectLastFileChangeTurn` through its public index).
- `ConversationStatusPanel.tsx` gains new props (`usage`, `lastTurn`, `fetchFileChanges`,
  `onOpenCodeViewer`, `workspaceRemoteSessionId`) and wraps the module's bodies in its private `StatusSection` shell. The new section ids
  (`context`, `lastTurn`) are added to the `section` prop union and to `STATUS_SECTION_SCROLL_POLICY` (both
  scroll within `12rem`). `conversationStatusPanelModel.ts` and the Git Tools section are untouched.
- `SessionPane.tsx` passes:
  - `snapshot?.usage`;
  - the memoised last turn;
  - the same gated value the chat receives (`runtimeReady ? handleFetchFileChanges : undefined`);
  - `onOpenCodeViewer`.
- The Last turn body derives `cachePolicy` (`in-flight` while `header.state === "running"`, else `terminal`) and
  `fileChangesState` exactly as `ConversationFileSummaryPanel` does. Otherwise SessionPane's cache key differs and
  the chat and the panel would issue two requests for one turn.
- Reference stability: `ConversationStatusPanel` is memoised and covered by stable-reference tests, and
  `snapshot.rows.window` changes on every streamed delta. SessionPane memoises the last turn on primitive keys
  (`rowId`, `entityId`, `state`, `fileChanges.files/additions/deletions/state`), so the prop keeps its identity until
  one of them changes. `usage` is passed as-is only if the projection store keeps its identity across unrelated
  deltas; this is verified in the store's patch path before implementation. If it does not, the prop is memoised on
  its scalar fields. The stable-reference test is extended to cover the new props.
- The composer's usage mapping in `V4ComposerToolbar.tsx` (upstream file) is not refactored. The module mirrors
  its 15-line mapping in `buildContextSectionModel` and a unit test pins the two to the same tone and threshold
  results, following the precedent of `review-last-turn/readonlyDiffPatch.ts`.
- i18n: reuse `chat.contextUsage.*` for breakdown labels. New keys go in `en-US`, `zh-CN` and `uk-UA`:
  `chat.statusPanel.context`, `chat.statusPanel.contextUntilAutoCompact`,
  `chat.statusPanel.contextCumulative.{input,output,cacheRead}`, `chat.statusPanel.lastTurn`,
  `chat.statusPanel.lastTurnFiles.{one,other}` (uk-UA adds `few`, `many`), `chat.statusPanel.lastTurnReverted`,
  `chat.statusPanel.lastTurnOpenReview`, `chat.statusPanel.lastTurnWriteCount`. The percentage uses `Intl.NumberFormat`.

## Known limits

- The last turn is searched only in the loaded snapshot tail (60 rows plus history the chat already loaded),
  the same limit as the Review pane source. An older editing turn hides the section.
- Context numbers update per model call, not per streamed token.
- The chat's turn summary hides gen-UI source files (`collectGenUiSourcePaths(assistantText)`) and recounts.
  The panel uses the raw turn aggregate and item list, so for such turns its numbers can be higher than the chat's.
  This is accepted for this iteration.

## Acceptance

1. A session whose panel shows Progress and whose last turn edited `src/math.js` (+4): Last turn appears after
   Git Tools as `1 file +4 -0`. Expanding lists `src/math.js +4 -0`; clicking it opens the patch viewer with the turn's hunks.
2. A following turn with no file edits keeps the same Last turn content.
3. A running turn that writes a second file: the collapsed header updates to `2 files …` without reopening; an
   expanded section refetches once per aggregate change.
4. Rewinding that turn shows `Reverted` and keeps the file list.
5. Context appears last with `N%`. After the next model reply the percentage changes without user action. With
   authoritative threshold data, expanding shows the threshold tick and `N until auto-compact`.
6. Usage at or above the warning threshold colours the bar and the header percentage like the composer indicator.
7. `contextWindow === null`: no Context section. No turn with file changes: no Last turn section.
8. A session with no other panel content (no Git changes, goal, todo or running work): the panel stays unmounted
   even though usage and last-turn data exist.
9. Git Tools renders exactly as before in all of the above.
10. Mobile remote shows the same sections with the same numbers. Without `onOpenCodeViewer`, file rows are static.

## Tests

- Unit (`packages/ui/test/statusPanelInsights*.test.ts`): both section models (null usage, non-authoritative threshold,
  tone parity with the composer mapping, reverted turn, missing `entityId`); the hook keeps its identity across streamed
  rows and changes it with the aggregate (scenario 3); the panel renders no new section when `hasContent` is false;
  section order; file open, Review entry and the stale-key drop for detail results.
- Desktop E2E (`conversation-session/conversation-session-status-panel-last-turn.test.ts`, default replay with a
  case-local fixture): scenarios 1 and 5. The fixture turn runs TodoWrite then a single Write; the E2E workspace is not
  a Git repository, so the todo is what mounts the panel (scenario 8's rule holds).
- Visual: desktop and mobile web, light and dark, en-US and zh-CN label lengths.
