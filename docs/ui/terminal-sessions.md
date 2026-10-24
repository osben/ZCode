# Terminal Sessions

The terminal panel supports multiple terminal tabs per workspace, kept alive and isolated by workspace
identity.

## Summary

| Field              | Content                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Behavior           | The first terminal tab does not show `1`; later tabs start at `2`; closing or a PTY exit closes the matching tab in sync |
| User-visible place | The tab strip of the bottom Terminal panel                                                                               |
| State owner        | `Terminal` renderer-local state; PTY lifecycle is managed by each `TerminalSession`                                      |
| Out of scope       | The right side pane Terminal tab, chat session/task realtime, protocol and Host/Agent runtime                            |

## Product Behavior

1. The workspace key is `workspaceIdentity?.trim() || workspacePath`, used only for terminal session
   isolation. `workspacePath` is passed to `terminalService.create()` only as the PTY cwd.
2. Collapsing the terminal panel or switching workspace/task does not dispose created terminal tabs.
3. With more than one terminal tab, closing a tab unmounts the matching `TerminalSession`, disposing the
   backend PTY. With a single tab the close button still shows; clicking it closes the whole Terminal panel
   without unmounting the session, and reopening the panel keeps using the original session.
4. Tabs share the ghost style of the Side Header: no visible border, unchanged selected-background hover,
   4px gap; overflow fades by mask, no ellipsis. The close button takes part in normal flex layout, shows
   only when selected, hovered or focus-within, keeps its placeholder when hidden, and the mask does not
   move with the button's visibility. The "终端" (Terminal) title stays as is; the shell name is ordinary
   secondary text, not a pill.
5. When the shell/PTY session itself exits, the matching tab closes automatically; an ordinary subcommand
   returning non-zero while the shell stays alive does not close it. A background session exit among
   several tabs removes only itself and does not change the active tab; an active session exit uses the
   adjacent-tab fallback of manual close.
6. When the last session of the current workspace exits, the ended session is removed and the whole
   Terminal panel closes; a brand-new session is lazily created on next open, and no `[进程已退出]`
   (process exited) tab is kept. When the last session of a hidden workspace exits, only that workspace's
   terminal state is cleaned and the current workspace's panel is not closed.
7. A terminal start failure is not a PTY exit; the error content stays in the tab for diagnosis.
8. After a workspace tab closes, the panel reclaims hidden terminals by the still-open workspace keys, so no
   background PTY leaks.
9. After opening the panel, switching terminal tab, or creating a new terminal tab, the currently visible
   xterm must automatically get keyboard focus; hidden workspaces/sessions do not steal focus.
10. When dragging to resize the bottom terminal height, xterm fit and backend PTY resize must not run
    synchronously on each `ResizeObserver` callback: during the drag, preview at low frequency by
    `TERMINAL_RESIZE_DRAG_THROTTLE_MS`, flush the final size immediately on release, and de-duplicate equal
    `{ cols, rows }`, so continuous resize does not freeze the UI under Windows / PowerShell.
11. The tab display name uses the session cwd's leaf name; the first number `1` is not shown, e.g.
    `z-code`; number `2` and later show as `z-code 2`, `z-code 3`. The name stays unchanged after creation;
    closing other tabs does not rename existing tabs. A new tab uses the smallest available positive integer
    within the workspace: after closing `z-code 2`, creating again is still `z-code 2`.
12. Plain `http://` / `https://` links in terminal output are recognized by an xterm link provider, show an
    underline and hand cursor on hover, and clicking reuses the UI-layer `onOpenBrowserUrl` to open the
    right browser; Web still uses the existing new-tab fallback.

State and event order:

```text
first open                       new
panel closed ──open──> [z-code] ─────────────> [z-code] [z-code 2]
                          │ close                     │ close z-code 2
                          ▼                           ▼
                     panel closed                 [z-code]
                  (session kept alive)                │ new
                          │ reopen                    ▼
                          └──────────────────────> [z-code] [z-code 2]

[z-code] [z-code 2] ──close z-code──> [z-code 2]
                                         │ new (existing names unchanged, smallest number 1 reused)
                                         ▼
                                   [z-code 2] [z-code]

[z-code] [z-code 2] ──PTY exit 2──> [z-code]
         │
         └─PTY exit 1 (last)──> delete ended session ──> panel closes
                                                            │ reopen
                                                            ▼
                                                     create new [z-code]

subcommand exit code != 0 ──shell still alive──> tab unchanged
```

## Clarified Decisions

Single-tab close closes the whole terminal panel (no tab-less state or auto-created replacement tab); base
name is the current workspace name and the second is the name plus `2` (number `1` hidden); a terminal never
renames once created; closing `2` then creating again reuses `2`; auto-close happens only when the terminal
session itself ends (normal and abnormal shell exits both, subcommand failure not); no hint is kept after
exit and the tab is removed on PTY exit; the last session exiting closes the panel and creates a new
terminal on next open (no ended session kept, no new PTY pulled up in the background); a background tab
exit does not steal focus; a start failure keeps the error and does not auto-close.

## Domain Scope and Cross-Cutting Risks

| Domain                              | Included       | Decision                                                                                                                              |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| File/Git/Terminal UI                | Yes            | Changes renderer-local naming, closing and number allocation of the bottom Terminal tabs                                              |
| UI shell / responsive               | Yes            | Desktop and mobile Web share the `Terminal` component with the same behavior and no per-platform branch                               |
| Workspace identity / remote runtime | Representative | Non-empty workspace identity is used for isolation first, else workspace path; `workspacePath` is still only for cwd and name display |
| Mobile replayable / conversation    | Pruned         | No change to session/task stream, snapshot, queue, protocol or delivery kind                                                          |
| Right side pane Terminal            | Pruned         | Has its own tab model, unchanged                                                                                                      |

## Concepts and State Owners

| Concept                                      | Authoritative state / code entry                            | Observable evidence                                                                 |
| -------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| workspace terminal registry                  | renderer state in `packages/ui/src/Terminal.tsx`            | The current workspace's tab strip                                                   |
| session number and smallest available number | `packages/ui/src/terminal/terminalPanelState.ts`            | Tab title and pure-state unit tests                                                 |
| PTY lifecycle                                | `packages/ui/src/terminal/TerminalSession.tsx`              | Component unmounts after multi-tab close; stays mounted after a single-tab collapse |
| Panel switch                                 | `isTerminalOpen` in `packages/ui/src/hooks/useAppPanels.ts` | Terminal panel visibility                                                           |

## State Combinations

| Case ID     | Tab state                       | User action                 | Expected effect                                                                          | Class    |
| ----------- | ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| TERM-TAB-01 | First created, only number `1`  | Look at tab title           | Shows workspace name, not `1`                                                            | accepted |
| TERM-TAB-02 | Number `1` exists               | New tab                     | New tab shows `workspace 2`; first tab name unchanged                                    | accepted |
| TERM-TAB-03 | Numbers `1`, `2` exist          | Close `2`, then new         | New tab reuses number `2`                                                                | accepted |
| TERM-TAB-04 | Numbers `1`, `2` exist          | Close `1`                   | Number `2` keeps its name, not renamed to the base name                                  | accepted |
| TERM-TAB-05 | Single tab                      | Click tab close button      | Collapses the whole Terminal panel, session kept alive                                   | accepted |
| TERM-TAB-06 | More than one tab               | Close any tab               | Releases only the target session; if the active tab is closed, an adjacent tab is chosen | accepted |
| TERM-TAB-07 | Multi-tab, background PTY alive | Background PTY exit         | Removes the exited tab, active tab and focus unchanged                                   | accepted |
| TERM-TAB-08 | Multi-tab, active PTY alive     | Active PTY exit             | Removes the exited tab, activates an adjacent tab                                        | accepted |
| TERM-TAB-09 | Current workspace single tab    | PTY exit then reopen panel  | Panel closes first; reopening creates a brand-new base-name tab                          | accepted |
| TERM-TAB-10 | Hidden workspace single tab     | Hidden PTY exit             | Cleans only the hidden workspace, current panel not closed                               | accepted |
| TERM-TAB-11 | Shell alive                     | Subcommand returns non-zero | No PTY exit, tab kept                                                                    | pruned   |
| TERM-TAB-12 | terminal create fails           | Promise reject              | Tab keeps the start error, not auto-closed                                               | accepted |

Pruning: theme, locale and desktop/mobile viewport do not change the naming and closing state machine; only
representative assertions of the shared component are kept. No protocol, provider fixture, network timing
or Docker isolation is needed.

## Coverage Plan

| Case                 | Setup / action / assertion                                                                       | Evidence layer                   | Status                     |
| -------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------- |
| TERM-TAB-01/02/03/04 | Build workspace terminal state, create/close, assert stable numbering and titles                 | renderer state + UI label helper | covered unit + runtime CDP |
| TERM-TAB-05          | Close a single session, assert the close-panel intent is returned and the session is not deleted | renderer state + panel callback  | covered unit + runtime CDP |
| TERM-TAB-06          | Close in multi-session, assert target deleted and fallback active session correct                | renderer state                   | covered unit + runtime CDP |
| TERM-TAB-07/08       | PTY exit in multi-session, assert background/active tab deletion and active fallback             | renderer state + exit event      | covered unit + runtime CDP |
| TERM-TAB-09/10       | Last PTY exit of current/hidden workspace, assert panel-close boundary and lazy rebuild          | renderer state + panel callback  | covered unit + runtime CDP |
| TERM-TAB-11/12       | Subcommand failure produces no exit; create reject keeps the error tab                           | terminal service/event contract  | covered by invariant       |

E2E handoff: this change sends no provider request and needs no replay/file fixture; a later desktop E2E
should assert tab title, close button, panel visibility and whether the PTY DOM stays alive, and keep the
right side pane Terminal out of the same case.

File layering:

- `packages/ui/src/Terminal.tsx`: terminal panel, workspace session registry, tab UI.
- `packages/ui/src/terminal/TerminalSession.tsx`: a single xterm instance and backend PTY lifecycle.
- `packages/ui/src/terminal/terminalPanelState.ts`: pure data helpers for terminal tab/workspace state.
- `packages/ui/src/terminal/terminalLinks.ts`: HTTP link recognition in the terminal buffer and xterm range
  computation.
