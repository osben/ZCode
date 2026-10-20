# UI upstream 3.16.1 sync: fork re-application ledger (bucket 4), part 2

## Test files

Test files were merged with `git merge-file --ours`, then imports and helpers that upstream removed but the fork
test bodies still use were restored by hand: commandCenterTypography (CommandCenterConversationTimestamp),
hooksSection (HookForm), settingsSearchInput (readFileSync), overlayWindowControls (readFile, resolve),
v4ConversationDraftSuggestedPrompts (readFileSync/resolve, stylesSource/componentSource),
v4ConversationFileSummaryPanel (collectClassNames helper). Fork-removed source-grep tests stay removed.

Passing after the merge (13 of 20 test files): commandCenterTypography, contextQuotaResetOpportunityReminder,
conversationShareBundleBoundary, executeGroupToolCallBlock, feedbackBackgroundUploadIndicator, hooksSection,
officeFilePreview, overlayWindowControls, permissionDialog, settingsNavigation, settingsSearchInput,
v4ConversationDraftSuggestedPrompts, v4ConversationFileSummaryPanel. The 7 files below still fail.

Open test failures (34 cases in 7 files). All are waiting for code or i18n keys that live in other buckets:

| Test file                                             | Failing cases | Owner of the missing code / keys                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| test/conversationShareConfirmationDock.test.ts        | 6             | v4/ConversationShareConfirmationDock.tsx (fork expects radiogroup permission labels, data-testids `conversation-share-back` / `conversation-share-confirm`, an `animate` on the review row; the test mock throws `reviewRowRef.current?.animate is not a function`). |
| test/createWorkflowToolCallBlock.test.ts              | 14            | ToolCallBlocks/renderers create-workflow component (fork header/footer layout, phase and feedback copy). Needs i18n keys `chat.toolCall.workflow.feedback.count.one` / `.other` and `chat.toolCall.workflow.card.phases.*`.                                          |
| test/highspeed/sessionPaneHighspeedActivation.test.ts | 2             | SessionPane highspeed activation (SessionPane bucket).                                                                                                                                                                                                               |
| test/quickPickCommands.test.ts                        | 1             | quickpick command registry: `manage-sessions` command and `quickPick.command.manageSessions` zh-CN key (i18n PR).                                                                                                                                                    |
| test/settingsPageConfig.test.ts                       | 7             | settings/settingsPageConfig.ts (section order, `usage` section, `migration` fallback to `general`, Worktrees section, Web voice dictation entry).                                                                                                                    |
| test/v4ConversationComposerErrorBanner.test.ts        | 2             | v4 composer error banner: remote gate (`available=false`) and initializing remote project.                                                                                                                                                                           |
| test/v4SlashCommands.test.ts                          | 2             | v4/slashCommands.ts: `/plan` must return `planShortcut` with attachments and context (fork commit "Fix /plan submissions with attachments and context"). Bucket 2 owns the code.                                                                                     |

## Dropped or unverified fork content

- useWorkspaceActiveTaskState title merge and per-task subscription (see row above).
- Fork test `settingsPageConfig` expectations on section order were not verified against upstream's
  settings catalog; they will be decided when the settings bucket lands.
- Locale catalogs (en-US, zh-CN, uk-UA) were not edited. Fork keys still needed by ported code:
  none added by this bucket. Keys needed by the open failures are listed above.

## Exemptions

Added under the `# TEMPORARY upstream 3.16.1 sync (ui bucket 4)` block in `.staged-file-size-exemptions`:
CommandCenterDialog.tsx, WorkbenchPane.tsx, ConversationTimeline.tsx, useAppPanels.ts,
createWorkflowToolCallBlock.test.ts, v4ConversationFileSummaryPanel.test.ts, permissionDialog.test.ts,
hooksSection.test.ts, conversationShareConfirmationDock.test.ts.
