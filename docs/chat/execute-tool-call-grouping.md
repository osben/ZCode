# Execute Tool Grouping

## Release state

The feature is on by default as a user setting. The Settings toggle "分组终端命令" (group terminal commands) persists as the app-level `toolGroupingTerminalEnabled`; when missing, `ENABLE_TERMINAL_TOOL_CALL_GROUPING=true` is the fallback. When off, non-read-only Shell calls keep their original standalone tool rows; classification, command, output/error, protocol and session persistence are unchanged.

## Summary

| Field             | Value                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Behavior          | Aggregate consecutive non-read-only Shell calls; the `Execute` parent uses visible stage boundaries and a scrolling command summary |
| Surfaces          | Desktop `desktop-continuous`, plain Web, mobile `/remote` `web-remote-replayable` conversation work items                           |
| Existing behavior | Read-only Shell goes into `Explore`; other consecutive Shell calls aggregate into `Execute`                                         |
| State owner       | The CLI v4 projection owns the raw `ToolCallRow`; the renderer derives grouping, summary and parent status                          |
| Out of scope      | Protocol, tool execution, permission, session persistence, snapshot, relay/main and runtime are unchanged                           |

Scope of the first version: only consecutive Shell calls not absorbed by Explore; Write/Edit/ApplyPatch are excluded. Parent shows overall progress and counts; each child keeps its single-command summary. The parent is a UI container, and a failed child does not make the parent `failed`.

## Boundary decisions

| Boundary       | Decision                                                                                                                                                                                                                                                    | Includes                                                                               | Excludes                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Classification | `identity.family === "shell"` and `isExploreToolCall(...) === false`                                                                                                                                                                                        | Non-read-only Bash/Shell/execute commands, or commands missing the read-only allowlist | Read/Search/Explore, Write/Edit, Agent, Todo, blocking interaction                                        |
| Continuity     | Only consecutive Execute rows in the user's currently visible row sequence                                                                                                                                                                                  | Hidden non-first reasoning may be crossed                                              | Visible reasoning, Explore, text and other tools break the group                                          |
| Status         | Parent is `in_progress` while the Execute sits at the visible tail of a running work segment; after a visible boundary or segment terminal state it is completed/stopped                                                                                    | The model gap after all children complete                                              | Child lifecycle no longer decides parent running; error does not bubble to failed                         |
| Summary        | While running, vertically scroll the full `Running <command>`; styled like Explore, action word `text-foreground-subtle`, command `text-foreground-subtlest`; a fixed `·` separates `Execute` and the summary; stats appear immediately when the stage ends | `Execute · Running <command>`, `Execute · N 个命令`                                    | stdout/stderr and concrete errors stay in children; the old command is not replayed in the terminal state |
| Permission     | The permission dialog keeps rendering a single Execute                                                                                                                                                                                                      | Conversation work item aggregation                                                     | Approval identity is not aggregated                                                                       |
| Group title    | The parent group uses the cross-platform category name `Terminal` / `终端`                                                                                                                                                                                  | PowerShell, cmd.exe, Git Bash, WSL, Unix shell                                         | Does not mean the Windows Terminal app; single-Execute child tool copy is unchanged                       |

## State and event flow

```text
ToolCallRow(shell)
        |
        +-- nonterminal + command absent --> defer render
        |
        `-- command classifiable
                 |
                 +-- readonly/explore --> Explore group
                 |
                 `-- other shell ------> Execute group
                                                |
                                  append while next visible row
                                  is also Execute-compatible

Execute parent status
        |
        +-- visible group tail + segment running ------> in_progress
        +-- visible boundary / segment terminal
        |       `-- any cancelled ---------------------> stopped
        `----------------------------------------------> completed
```

The `Execute` parent is not a protocol tool call and does not correspond to one tool execution. Its key and synthetic tool id anchor to the first child `ToolCallRow`; streaming appends only update children, avoiding component rebuilds and lost expansion state.

## Summary contract

### Parent

| State                  | Primary summary                                                                                                                  | Status      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| running                | `Running <command>`; when all children are terminal, fall back to the latest command; the full action summary scrolls vertically | in progress |
| completed, all success | `N 个命令`                                                                                                                       | completed   |
| completed, failures    | `N 个命令，M 个失败`                                                                                                             | completed   |
| stopped                | `N 个命令，K 个已停止`, failure count kept                                                                                       | stopped     |

The parent shows no stdout, stderr or concrete error; failure detail stays on the child tool card so failure state is not duplicated.

### Child

Children keep using `ExecuteToolCallBlock`: collapsed shows the action and command; expanded shows `$ command` and the result or error; a terminal state with no output shows the existing "no output" copy. When the group is expanded while in progress, the parent summary shows only `Terminal · N commands`; the current command is expressed by the child tool summary below.

## Pruning decisions

| ID      | Pruned combinations                                 | Guard/invariant                                                                      | Representative coverage         |
| ------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| ETG-P01 | All Bash/execute/shell tool-name permutations       | `resolveToolCallIdentity` already unifies them into the Shell family                 | family representative unit test |
| ETG-P02 | Write/Edit/ApplyPatch mixed with Execute            | file-write goes into its own Changes group and keeps file summary and undo semantics | boundary unit test              |
| ETG-P03 | theme/locale/OS/workspace-type permutations         | shared renderer + i18n; no platform or workspace state read                          | zh/en copy and focused UI test  |
| ETG-P04 | continuous/replayable physical network permutations | grouping consumes only final UI rows, no transport change                            | renderer unit + existing STIP03 |
| ETG-P05 | permission/approval combinations                    | PermissionDialog does not pass through the conversation grouping builder             | existing permission tests       |

## Accepted cases

| ID    | Setup                                                      | Action                                        | Assertions                                                                                                                     | Evidence                  | E2E status   |
| ----- | ---------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ------------ |
| ETG01 | Single non-read-only Shell                                 | build work items                              | Keeps the original Shell tool row; no single-child parent group                                                                | UI unit                   | covered-unit |
| ETG02 | At least two consecutive non-read-only Shell calls         | stream-append rows                            | Parent group appears when the second arrives, same parent key/tool id, children order unchanged                                | UI unit                   | covered-unit |
| ETG03 | Explore/text/visible reasoning on either side of Execute   | build work items                              | Split into several groups; never crosses a visible boundary                                                                    | UI unit                   | covered-unit |
| ETG04 | Only hidden non-first reasoning on either side of Execute  | turn reasoning off                            | Merged; split when reasoning is on                                                                                             | UI unit                   | covered-unit |
| ETG05 | Shell command not yet arrived                              | build, then add readonly/other command        | Hidden in first frame; afterwards only Explore or Execute appears, one of them                                                 | UI unit                   | covered-unit |
| ETG06 | Execute is the real visible tail of a running segment      | all children complete or more commands append | Parent stays in_progress; new command summary scrolls vertically                                                               | UI + renderer unit        | covered-unit |
| ETG07 | Execute expanded                                           | render parent group                           | Children keep showing command, output/error                                                                                    | renderer unit             | covered-unit |
| ETG08 | desktop/replayable recovery yields the same final rows     | build work items                              | Same grouping result, no new recovery state                                                                                    | shared renderer invariant | partial      |
| ETG09 | Visible non-Execute row after Execute, or segment terminal | build work items                              | Parent completed/stopped; a running child still shows only in detail; aggregate stats appear immediately in the terminal state | UI + renderer unit        | covered-unit |

## E2E handoff notes

- The first version's core is a deterministic row-to-render-item mapping and renderer summary, covered by focused unit tests.
- If promoted to formal E2E, the controlled-stream fixture sends two non-read-only Bash calls with visible/hidden reasoning in between and asserts the parent group identity, the summary and the two commands after expanding.
- Mobile `/remote` must not be proven with the desktop fixture; reuse the STIP03 final-row recovery contract.
