# UI upstream sync ledger, bucket 6

Scope: fork code re-applied onto upstream 3.16.1 (`0a1fc56d`) for the bucket-6 files. Each row names
what the fork needs from files outside this bucket; those dependencies are resolved by the other
buckets, so the tree does not compile on this branch alone.

## Files with no fork code change (translation or comment only)

- `packages/ui/src/PreviewPane.tsx`: import formatting and Chinese-to-English comments. Upstream kept.
- `packages/ui/src/RemoteConnectionFields.tsx`: comments and one formatting-only ternary. Upstream kept.
- `packages/ui/src/v4/ConversationShareConfirmationDock.tsx`: comments only. Upstream kept.

## Re-applied

- `packages/ui/src/PermissionDialog.tsx`: digit shortcuts only move the selection and no longer confirm (commit "guard against accidental confirm"). Re-applied: removed `respondWithOption(shortcutOption)` and its dependency.
- `packages/ui/src/TaskListItem.tsx`: sidebar markers (incognito, worktree, PR), pin on left or right of the leading slot, task hover card (`TaskSidebarHoverCard`), `onDeleteTask` wiring, `executionWorktree` in the memo comparison. Re-applied on upstream structure (kept upstream `hoverEnabled`, `connectionOverlay`, `TaskRowActionButton`, idle-dot removal).
- `packages/ui/src/SettingsPage.tsx`: Sessions, Worktrees, Incognito, Instructions, Output Styles, System Prompt, Voice Dictation sections; guarded navigation for unsaved drafts; Ctrl/Cmd+W guard; palette, terminal WebGL, UI/mono font family, resource telemetry, coding-plan auto-continue, memory index-as-context toggles; `isLocale` / `isThemePalette` in place of the locale and theme lists; sessions full-width layout. Re-applied in full; depends on the rows below.
- `packages/ui/src/styles.css`: palettes (`.palette-*`), font stacks (Inter, JetBrains Mono), PR/incognito/worktree/pinned-turn tokens, `[role="option"]` cursor rule. Re-applied via 3-way merge; upstream rules and tokens preserved. Two conflicts resolved: comment text (upstream kept) and `--font-mono` (fork stack plus upstream settings-title tokens).

## Dependencies outside this bucket

| Owner file                                                           | Needed by                                        | What is missing on this branch                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/lib/settingsNavigation.ts`                          | SettingsPage.tsx                                 | `SettingsSectionId` lacks `sessions`, `incognito`, `worktrees`, `instructions`, `outputStyles`, `systemPrompt`. `SettingsSectionIntentEventDetail` lacks `sessionsScope`. `consumePendingSettingsSessionsScope` is not exported. `SettingsSessionsScope` is exported on the fork side only. |
| `packages/ui/src/settingsPageHelpers.tsx` (`GeneralSectionContent`)  | SettingsPage.tsx                                 | Props `resourceTelemetryEnabled`, `onResourceTelemetryEnabledChange`, `terminalWebglEnabled`, `onTerminalWebglEnabledChange`, `codingPlanLimitAutoContinueDefaultEnabled`, `onCodingPlanLimitAutoContinueDefaultEnabledChange`. |
| `packages/ui/src/settingsPageHelpers.tsx` (`AppearanceSectionContent`)| SettingsPage.tsx                                | Props `palette`, `setPalette`, `uiFontFamily`, `setUiFontFamily`, `monoFontFamily`, `setMonoFontFamily` are passed; the component type must accept them.                                                                  |
| `packages/ui/src/settings/MemorySettingsSection.tsx`                 | SettingsPage.tsx                                 | Props `memoryIndexAsContext`, `onMemoryIndexAsContextChange`.                                                                                                                                                             |
| `packages/ui/src/settings/WorktreesSection.tsx`                      | SettingsPage.tsx                                 | `workspaceTabs` is typed as `WorktreeTaskProjectTab[]`, but SettingsPage passes `WorkspaceTabState[]`. Align one of the two types.                                                                                        |
| `packages/ui/src/settings/settingsPageConfig.ts`                     | SettingsPage.tsx                                 | Still lists `zai-dark` / `zai-light` as `Theme` values; the fork removed them in favor of palettes.                                                                                                                       |
| `packages/ui/src/TaskActionMenuContent.tsx`                          | TaskListItem.tsx via TaskListItemContextMenu.tsx | Props `onDeleteTask` and `deleteDisabledReason` are passed from TaskListItemContextMenu but not declared on TaskActionMenuContent.                                                                                       |
| `packages/ui/src/TaskList.tsx`                                       | TaskListItem.tsx                                 | `MemoTaskItem` and `TaskListItemContextMenuContent` now accept `onDeleteTask`; TaskList must pass it (fork: session delete flow).                                                                                         |
| `packages/ui/package.json`                                           | styles.css                                       | `@import "@fontsource-variable/inter/index.css"` and `@import "@fontsource-variable/jetbrains-mono/index.css"` need the `@fontsource-variable/*` dependencies. Not installed on this branch.                              |
| i18n catalogs                                                        | SettingsPage.tsx, TaskListItem.tsx               | New keys used: `settings.instructions.discard.*`, `settings.outputStyles.discard.*`, `settings.systemPrompt.discard.*`, `taskDelete.remoteUnavailable`, `taskList.*` marker labels (owned by other buckets; not added here). |

`pnpm exec tsc -b packages/ui` on this branch reports only the dependency rows above, plus a
use-before-declaration in TaskListItem fixed in this commit series.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/ui-upstream-sync-ledger-b6.md
