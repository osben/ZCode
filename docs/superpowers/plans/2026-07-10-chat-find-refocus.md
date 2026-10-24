# Chat Find Re-focus

> Historical implementation plan (2026-07-10), implemented and archived; the V4 find chain
> now owns the behavior. Current scope/navigation contract:
> [Task Find Dialog](../../ui/task-find-dialog.md); current code entries are
> `packages/ui/src/v4/useConversationTimelineFind.ts` and
> `packages/ui/src/quickpick/TaskFindDialog.tsx`. The old `ChatView` /
> `useConversationFindHighlights` paths have been deleted. Kept for the navigation-request
> and mobile-overlay contracts below.

**Goal:** Repeated previous/next/Enter/Shift+Enter navigation re-centers a single search
match in both conversation content and file-change diffs, even when the active index does
not change.

## Contract

- Query and active index are selection state; each scope (conversation, file-change) has an
  independent monotonically increasing navigation request id owned by `App`. Explicit
  navigation events increment the id; ordinary query/index changes preserve it.
- `TaskFindNavigationState` (`packages/ui/src/quickpick/taskFindNavigationState.ts`):
  `changeTaskFindSelection` preserves the request id; `navigateTaskFindSelection` increments
  it even when the index is unchanged (two consecutive same-index navigations yield ids 1
  and 2). Keyboard navigation is ignored when `total === 0`.
- The highlight/scroll dedupe key includes `navigationRequestId` (query, index, range count,
  request id), so a repeated navigation to the same index still produces a new scroll
  request. DOM-mutation scroll deduplication within one request id is preserved.
- Escape priority: a pre-cancelled Escape (`event.defaultPrevented === true`) must not close
  the find dialog; an unhandled Escape closes it and becomes default-prevented.
- Mobile boundary: the find dialog renders through `WebRemoteControlMobileShell`'s
  `chatOverlay` slot (`data-mobile-chat-overlay="true"`, pointer events restored) as a
  sibling of the inert/`aria-hidden` mobile chat surface — never inside it. The desktop
  render site and mobile `inert` semantics are unchanged.

## Evidence

- `CFR` pending manual-review E2E
  (`packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-chat-find-refocus.test.ts`,
  WDIO-only `window.__zcodeSessionStoreE2E` bridge, no provider requests) provides evidence
  for catalog cases CF01 (conversation) and CF02 (file-change). Both stay `planned` in the
  coverage matrix with no replay fixture, Docker admission, or CI promotion claim until a
  human approves promotion.
- Unit: `conversationFindSearch.test.ts`, `taskFindNavigationState.test.ts`,
  `taskFindDialogNavigation.test.ts`, `webRemoteControlMobileShell.test.ts`,
  `workspaceShellRemoteMobileLayout.test.ts`.
