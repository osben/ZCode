# Session Display for Visualize Source Files

## Behavior

An HTML file referenced by a valid `visualize` reference is the source file for an inline visualization. At the end of the assistant turn, do not also show an HTML website card for the same file or include it in the file-change summary's file count, added/deleted line counts, or expanded list. If no regular files remain after filtering, hide the entire change summary, including the undo button. For mixed changes, keep regular files.

Reuse the Gen UI reference parser. Support Unicode, key=value, and JSON forms. Match only complete absolute paths in the current turn's body that pass schema validation; code examples and invalid or unclosed references do not count. A complete reference is sufficient for deduplication; do not mount a streaming visualization prematurely. Match by complete path, support Windows separators, and do not hide files by basename, extension, or all files in a directory named `visualizations`. Keep existing behavior for regular HTML, Markdown, Office/PDF, and localhost website cards.

## Data and Timing

```text
Current-turn assistant body → existing Gen UI parser → HTML source-file path
                                                       ├→ filter end-of-turn preview card
CLI fileChanges → existing detail read and cache → UI filter ─┴→ recompute visible summary
CLI rewind preview / apply ─────────────────────────────────────→ existing whole-turn undo
```

The summary contains aggregate values only, so the header cannot reveal which source file is included. When there is a valid reference, also read existing `fileChanges` details in the collapsed state. Do not show the summary until the read finishes, avoiding a brief display of counts that include the source file. After a turn switch, transition from running to terminal state, summary-count change, or undo, use only the details for the current request. If the request fails, keep the original summary and retry entry point to avoid hiding regular files by mistake; report the error through the UI logger.

Do not modify the CLI's raw change history, persisted data, undo preflight, or apply operation. Undo for mixed changes still undoes the whole turn; the preflight dialog shows the full operation scope. Do not change file-read authorization, Gen UI mounting, or sandbox lifecycle.

Desktop and mobile Web share the filtering rules; mobile retains existing HTML-preview restrictions and does not gain a Gen UI runtime. Do not change desktop-continuous or web-remote-replayable transport, recovery, ownership, or queues. Match and read remote paths within the existing `workspaceIdentity` / `remoteSessionId` context.

## Verification

| Scenario                                                                                                    | Assertion                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Only a `visualize` HTML file                                                                                | Visualization remains; HTML card and entire change summary disappear                                 |
| Mixed `visualize` and regular HTML/source files                                                             | Regular cards remain; counts and expanded list include only regular files                            |
| Three reference forms, code examples, invalid/incomplete references, same filename in different directories | Exclude only the complete path of a valid reference                                                  |
| Async detail request, late old response, terminal/undo-state change, read failure                           | Do not flash old source-file counts or use old details; preserve the existing entry point on failure |
| 390px / desktop, light/dark themes, mobile compact mode                                                     | Filtering is consistent and regular files remain expandable                                          |

Unit tests cover card candidates, asynchronous summary projection, and turn-end wiring. The existing `node packages/desktop/scripts/gen-ui-e2e.mjs` uses real Electron, the Gen UI sandbox, and the file-summary component to verify visibility and expansion. The fixture does not represent real SSH or mobile network-recovery verification.
