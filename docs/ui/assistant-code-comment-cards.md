# Assistant Code Comment Cards

## Status

- Feature spec for how the ZCode Renderer parses, displays and navigates (read-only Code Review) the Assistant output `::code-comment{...}`.
- The feature derives UI only; it adds no ZCode Protocol, session snapshot, relay, Host or Agent runtime state.
- The capability is off by default. The Desktop and mobile `/remote` workspace bridges enable it explicitly; the plain Web Server entry keeps it off. While off, the existing raw directive display is kept so that review comments already emitted by the Agent are not silently swallowed by the Renderer.

## Summary

| Field         | Conclusion                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change level  | presentation, validation, commit-effect                                                                                                                                                |
| Input         | `::code-comment{...}` in a persisted Assistant text row                                                                                                                                |
| Output        | Projected body text + a turn-local group of single-line code review cards                                                                                                              |
| Click effect  | Directly opens a workspace-scoped `code-review` CodeViewer, locates the line and shows the read-only model comment in the existing comment style; the file need not be in a Git change |
| Rollout owner | Renderer Root capability `assistantCodeCommentCardsEnabled`, default `false`; the Desktop and mobile `/remote` workspace bridges set it to `true` explicitly                           |
| Recovery      | Deterministically rebuilt from the raw row text; no independent card state is persisted                                                                                                |
| Out of scope  | File existence check at card generation, the Assistant Preview Cards 15->10 quota, Composer code-comment drafts, Git diff and historical diff snapshots                                |

## Directive contract

```text
::code-comment{title="[P1] 空指针风险" body="user 为空时仍会访问 user.id" file="src/user.ts" start=42 end=45 priority=1}
```

- Required: `title`, `body`, `file`, non-empty after trim.
- Optional: `start`, `end`, `priority`.
- `start` / `end` are 1-based positive integers; with only `start`, `end=start`; with `end < start` the line range is dropped but the comment card is still shown and locates the file.
- `priority` accepts only `0`, `1`, `2`, `3`; an invalid value degrades to no priority and the comment is not dropped.
- Other syntactically valid parameters are ignored for now.
- Supports single/double quotes, quote and backslash escapes, Unicode, spaces, Windows drive letters and UNC paths.
- No card is generated for a syntax error, a missing required field, or when the latest Assistant row enters `failed`; for a failed turn none of the turn's directives is removed from the body, so earlier comments are not silently lost.
- Examples inside fenced code, inline code and HTML code/pre are not real directives.

## Body projection and card ownership

```text
raw assistant text rows
        |
        +--> projection per row --> visible Markdown (complete valid directives removed)
        |
        `--> merge whole turn text --> comments[]
                                      |
                                      `--> latest terminal assistant text row
                                           complete / interrupted
```

- With the rollout on, a complete valid directive does not enter the body Markdown: a directive alone on a line removes the whole line; an inline one is replaced by one space.
- An unclosed `::code-comment{` at the streaming tail is hidden for now; only the `complete` / `interrupted` terminal states form cards. A `failed` row and content still invalid at the terminal state revert to ordinary body.
- The unclosed content is hidden only while it is still a legal parameter prefix; if output missing `}` is followed by ordinary body, the parameter format is clearly broken, or the protocol sits in a code example, the original text is kept so abnormal model output cannot swallow the rest of the answer.
- Cards attach only to the last terminal Assistant text row of the same turn: during streaming, even a closed directive only updates the body projection and does not produce cards early; on `complete` / `interrupted` all valid cards are rebuilt at once. Unclosed streaming tails, `failed` and non-tail rows show none. When the tail is failed, directive projection is off for the whole turn body and the original text is restored.
- Cards are ordered by directive occurrence in the body (forward), unlike the reverse rule of Assistant Preview Cards.
- Collapsed by default; clicking the title row shows all comments at once. At most 50 are projected per turn, the rest are not shown.
- No call to `fileChanges` or `fileService.checkFilesExist`. The target file is read through the current workspace service by the Preview Pane only after a click.
- Copy and conversation search use only the visible body and must not hit or copy the hidden raw directive syntax; the first version does not add title/body that exist only in the card or Review comment area to conversation full-text search.

## Rollout semantics

| Switch            | Body                                                           | Cards     | Reason                                                                                                           |
| ----------------- | -------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `false` (default) | Keep the current raw directive                                 | Not shown | Compatible with already-started Desktop Agents that may still emit directives; comments are not silently dropped |
| `true`            | Hide complete valid directives; no flash of half-streamed ones | Shown     | Rollout users get the structured review experience                                                               |

If "never show the raw directive even when off" is required later, the same capability switch must also control the directive output requirement in the Desktop context; hiding it only in the Renderer without controlling Agent output is unsafe.

The mobile `/remote` has two workspace bridge assembly paths, external relay and token/WebSocket; both must enable the capability explicitly. The plain Web Server and home-only entries that carry no conversation body keep it off. The switch only controls the Renderer's derived display of the same persisted Assistant row; it does not enter Host, relay or snapshot and does not change `web-remote-replayable` recovery semantics.

## Card UI

```text
+----------------------------------------------+
|  [>] 4 comments                              |
+----------------------------------------------+
|        collapsed by default; click title row |
+----------------------------------------------+
```

- The outer shell matches Git status cards with `bg-card border-border rounded-xl shadow-none`; title hover uses `bg-hover`.
- The top shows a localized comment count (for example `2 comments` / `2 条评论`) instead of separate "code review" and count titles; it shows `>` by default, and clicking the title row expands all comments and switches to a down indicator.
- Each card occupies exactly one line: `priority -> title -> path:range`, with no right arrow; a long title and path truncate in their own segments, and the path uses the ordinary UI sans font, not monospace.
- The expanded list uses `border-t border-border`; each item is an outer `bg-background/50` base with an inner clickable row `hover:bg-hover/30`, keeping the same background layering as Git file rows. No dividers between rows.
- Cards do not show `body` in the Assistant body, so review text and ordinary answers do not mix; `body` appears only after opening the `code-review` CodeViewer, in the existing code comment style.
- Card text is explicitly selectable. A drag selection within the same card does not navigate; clicking blank space, a click without selection, and keyboard Enter/Space still open Review.
- The title, priority, line range and body of the `code-review` source all come from this Renderer-local source; the CodeViewer comment block shows only the line range and body consistent with user comments, while title/priority stay on the card. Nothing is written to Git, session snapshot or the Composer comment store.
- P0-P3 use text badges; color is only auxiliary and never the sole information source.
- If the title already starts with the same `[P0]`...`[P3]`, the duplicate prefix is removed for display and the raw data is unchanged.
- The whole row is clickable and supports keyboard Enter/Space; on narrow mobile screens it stays one line, staying compact by segment truncation rather than wrapping.
- Cards render separately from Assistant Preview Cards and share no count limit, file validation or click routing.

## Code Review source and navigation state machine

A click produces a Renderer-local `CodeViewerSource`; no new top-level side-pane type is added:

```ts
interface CodeReviewAnchor {
  requestId: string;
  title: string;
  body: string;
  priority?: 0 | 1 | 2 | 3;
  startLine?: number;
  endLine?: number;
}

interface CodeReviewCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "code-review";
  title: string;
  path: string;
  review: CodeReviewAnchor;
}
```

```text
card click
  -> build CodeReviewCodeViewerSource (path + workspace scope + review)
  -> openCodeViewerSidePane()
  -> Preview Pane uses workspace-scoped fileService.readTextFile()
  -> valid line range: reuse CodeViewer selectedLines + CommentAnnotation
  -> requestId changes: scroll to the target line
  -> no line number or out of range: show the same read-only comment style at the top of the code area
```

- The directive's file path is still resolved by the card builder to an absolute path inside the workspace; `workspacePath` is for file reading and display, and tab isolation uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`.
- The `code-review` tab key is `workspaceKey + code-review + path` without `requestId`: another comment on the same file reuses the same tab and updates the anchor; ordinary `file` tabs and `code-review` tabs stay separate.
- With a valid line number inside the file: highlight `startLine...endLine` and show the existing `CommentAnnotation` after the end line; the comment scrolls with the code, and when `requestId` changes the vertical scroll is adjusted so the comment sits near the lower edge of the viewport while the current horizontal scroll position is kept.
- No line number: open the file and show the same read-only comment block at the top of the code area, with no fake line number or highlight.
- Line number beyond the file: still open the file and show the comment at the top, no fake highlight, plus a notice that the target line does not exist.
- File missing: reuse the Preview Pane's workspace-scoped read error; no Git refresh and no fallback to Git Review.
- Markdown/HTML show source in `code-review` mode; binary/too-large files reuse the Preview Pane's existing error states.
- Model comments pass to CodeViewer only as temporary read-only data inside the source; `useCodeCommentPreviewStore` is neither read nor written, and there is no gutter, box-select, add or delete comment interaction.
- Desktop local/remote and mobile `/remote` share the existing code-viewer side pane / overlay; both mobile workspace bridge Roots enable the capability explicitly like Desktop. Remote selects the right workspace service through `workspaceIdentity` and `workspaceRemoteSessionId` carried by the source; delivery/replayable state is unchanged. The plain Web Server entry keeps the capability default `false`.

## UI surface matrix

| Scenario              | UI entry                                           | Display owner                          | Gating                                                            | Click/commit                                               | Authoritative state           | Mode boundary                                                       | Must isolate                                                |
| --------------------- | -------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Assistant body        | `AssistantTextRowView` / `MessageResponse`         | Pure projection of the raw row         | feature flag + directive validity                                 | none                                                       | session row text              | desktop continuous and mobile replayable rebuild with the same rule | Does not modify row/snapshot                                |
| Review cards          | `AssistantCodeCommentCards`                        | turn-local derived model               | latest terminal row (complete / interrupted), 50-item cap         | Opens `CodeReviewCodeViewerSource`                         | no independent persistence    | Mobile uses the existing side-pane overlay                          | Takes no file-preview quota, writes no Composer store       |
| Read-only Code Review | `PreviewPane` / `CodeViewer` / `CommentAnnotation` | source.review + workspace file content | workspace scope + file read; line range decided by actual content | Reuses the code-viewer tab, updates the anchor and scrolls | workspace-scoped File Service | local/remote service injection differs, UI semantics are the same   | No Git read/write, no Composer comment, no workspace switch |

## Impact brief

| Rank           | Relationship                              | Conclusion                                                                                                       |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| must-inspect   | raw Assistant rows -> Markdown projection | Directive removal must not break GFM, streaming tolerance, copy and search                                       |
| must-inspect   | turn projection -> code-comment cards     | Shown on the latest terminal row; streaming hides only the unclosed tail; cold resume rebuilds deterministically |
| must-inspect   | card click -> Code Review source          | Source key, workspace service, read-only comment adaptation and line location are one navigation transaction     |
| should-inspect | Desktop context prompt                    | While the rollout is off the Agent may still emit directives, which must not be silently removed                 |
| conditional    | remote/mobile                             | Reuses workspace-scoped File Service and the existing code-viewer overlay; replayable recovery unchanged         |
| invariant-only | Composer code comments                    | The store/event for user code comments attached to the Agent is neither reused nor modified                      |
| invariant-only | Assistant Preview Cards                   | No fileChanges/stat calls, no shared 15->10 quota; code-comment reads the target file only after a click         |

The tooling environment has no codegraph; impact analysis used feature-graph declarations, exact source callers and focused tests as evidence; after implementation the graph code seeds are updated and the full graph validation runs.

## Cases and pruning

| ID    | Setup                                                                                                                                                                            | Action                              | Assertions                                                                                                                                                                                                                                                                    | Status   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| ACC01 | Rollout on, complete turn with two valid directives                                                                                                                              | Render and drag-select card text    | Body has no raw syntax; cards in forward order as single lines with priority/title/path/range, body not shown; text selectable and selection does not navigate                                                                                                                | accepted |
| ACC02 | Target file and valid line range exist in the workspace                                                                                                                          | Click a card                        | Opens the `code-review` CodeViewer, highlights and scrolls to the range; body shown read-only in the existing comment style; no add/delete interaction and no Composer store write                                                                                            | accepted |
| ACC03 | Rollout off                                                                                                                                                                      | Render the same text                | No cards; the raw directive stays as today                                                                                                                                                                                                                                    | accepted |
| ACC04 | streaming half directive, closed directive, complete, interrupted, failed                                                                                                        | Advance state                       | A half-streamed directive does not flash; no card during streaming; cards only on complete/interrupted; failed whole turn and invalid terminal states restore the body                                                                                                        | accepted |
| ACC05 | Persisted historical turn                                                                                                                                                        | cold resume / virtual row remount   | Same body and cards rebuilt from the row text, no new RPC                                                                                                                                                                                                                     | accepted |
| ACC06 | File with no Git change, no line number, out-of-range line, missing file, or several comments on one file                                                                        | Click                               | Git state does not affect opening; without a line number or out of range the read-only comment shows at the top, with a notice for out of range; a missing file shows the read error; the same file reuses the code-review tab and updates the anchor, no workspace switch    | accepted |
| ACC07 | Desktop Host persisted a terminal turn with valid directives; mobile hydrates through the external relay or token/WebSocket `/remote` bridge and switches local/remote workspace | View the same turn and click a card | Both mobile bridge Roots enable the capability; body does not leak raw directives, cards match Desktop deterministically; after a workspace switch the capability stays on and navigation keeps `workspaceIdentity` / `remoteSessionId`; the plain Web Server entry stays off | accepted |

Pruning: the first version has no Git diff or historical diff snapshot; desktop/web/mobile is not crossed with all priority/path/source permutations; Windows/UNC paths are covered by focused tests, and Desktop local is the representative first-batch window E2E. The E2E fixture only needs real existing/missing workspace code files, requires no Git change, and does not fake the file existence check at card generation.

## Main implementation files

- `packages/ui/src/lib/assistantDirectiveParser.ts`
- `packages/ui/src/lib/assistantCodeComment.ts`
- `packages/ui/src/AssistantCodeCommentFeatureProvider.tsx`
- `packages/ui/src/AssistantCodeCommentCards.tsx`
- `packages/ui/src/lib/codeViewer.ts`
- `packages/ui/src/lib/workspaceSidePane.ts`
- `packages/ui/src/PreviewPane.tsx`
- `packages/ui/src/previewPaneCodeReview.ts`
- `packages/ui/src/previewPaneContent.tsx`
- `packages/ui/src/previewPaneCodeContent.tsx`
- `packages/ui/src/components/ui/code-viewer.tsx`
- `packages/ui/src/v4/ConversationRowView.tsx`
- `packages/ui/src/v4/ConversationTurnGroup.tsx`
- `packages/ui/src/v4/conversationRowContext.ts`
- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/App.tsx` and the removal of the old Git navigation callback wiring in the app shell
