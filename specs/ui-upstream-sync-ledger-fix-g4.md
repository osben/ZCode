# UI upstream sync fix ledger, group G4 (workspace header, status panel, side pane)

Scope: 22 failing tests in 5 files from the 3.16.1 UI sync. No production source changed; every
change is in a test file.

- `v4ConversationStatusPanel.test.ts`: the integrated `v4/ConversationStatusPanel.tsx` already matches
  the fork (identical apart from one import), so the fork test in `9c2434f7` is the spec and the file
  is replaced by it. Two upstream-only tests kept on purpose: "renders expanded panel controls and
  sections" and "projects automatic display mode to the shell" (both pass). The ControlHintTooltip
  mock now spreads `importOriginal`, so `SidebarNativeTooltip` stays real.
- `v4ConversationStatusPanel.test.ts`: upstream-only "keeps the full long Todo content and title" is
  dropped. It contradicts the fork rule (Todo label clamped to two lines, `line-clamp-2`), and the
  fork behaviour wins.
- `WorkflowRunRail.tsx`: upstream keeps `SidebarNativeTooltip` around the rail lamps; the fork uses a
  plain `title`. Left as upstream (no source change). The fork test is not used for the rail.
- `workspaceHeaderTitleSection.test.ts`: the upstream test was failing only because the `usePlatform`
  mock lacked `useOptionalPlatform`; added `useOptionalPlatform: () => null`, as the fork test does.
  The fork test's "keeps the title but hides task-only context" (fork draft keeps the title)
  conflicts with upstream's draft header, which hides the title. The upstream behaviour is kept.
  Open product question, not a fix.
- `workspaceSidePane.test.ts`: plan-detail case moved from `owner: "parent"` to `owner: "root"`. The
  source rule `rootSessionId ?? parentSessionId` is the fork rule, and the plan-detail lifecycle
  belongs to the root task. The fork test file itself fails 12 tests against the integrated API
  (`isSidePaneTabVisibleForParent` vs `...ForScope`), so it is not adopted.
- `sidePaneToggleEmptyState.test.ts`: the base and fork launcher markup (`side-pane-open-tab-list`,
  row-list CSS in `styles.css`, `data-side-pane-open-tab-item`) was replaced by upstream's
  `@container/launcher` grid and `SidePaneLauncherRow` (upstream dropped the CSS and the markup).
  The launcher and empty-state assertions now check the upstream invariants (`tab.type === "new-tab"`,
  the hidden-content condition, the grid class). The collapse-on-last-close assertions now check
  `commitSidePaneState`, which holds the fork behaviour (`setIsSidePaneCollapsed(true)` when no
  visible tab is left). `closeSidePaneTabs` and the `handleCloseSidePaneTab` path are unchanged.
- `taskListItemConnectionOverlay.test.ts`: the integrated row wraps `<li>` in a Radix `Tooltip` for
  the fork's hover card. The root app provides `TooltipProvider`; the test does not. The test now
  wraps the render in `TooltipProvider`. `TaskListItem.tsx` is unchanged, since a row-local provider
  would break cross-row skip-delay grouping.
- Result: the 6 G4 files pass (209 tests in the set with `taskWorkflowRunLines`);
  `pnpm exec tsc -p packages/ui --noEmit` passes; oxlint and oxfmt clean on the changed files.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/ui-upstream-sync-ledger-fix-g4.md
