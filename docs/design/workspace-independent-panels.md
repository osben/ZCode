# Workspace-Independent Panel Layout

## Objectives

Desktop and wide-screen Web retain the sidebar, splitting the previously shared-frame session and Side Pane into independent panels; the window root background and sidebar keep their original semantics.

Platform corner radii for the workspace layout: Windows 5px, macOS Sequoia and earlier 6px, Tahoe 26+ 12px, unknown macOS version temporarily 6px; Linux and Web are `xl` (12px). The settings page retains the existing platform radii.

macOS version queries must go through `IPlatformService.getDesktopWindowChromeState` to query and subscribe to window state events, then passed to `useAppChromeState` for workspace corner radius calculation. Previously the hook excluded macOS, causing all macOS to take the unknown-version 6px branch; each desktop platform shares the existing query/event revision override-prevention mechanism, and Web does not query desktop state. Regression tests must run the real hook, validating Sequoia/Tahoe radii after async queries and subscription cleanup — you cannot just inject the version into the radius function.

```text
Window / Sidebar / transparent body layout
                  + conversation frame ---+ 4px + side frame --------+
                  | WorkspaceHeader       |     | Side Pane tab bar  |
                  | conversation          |     | preview/browser    |
                  +-----------------------+     |                    |
                  | 4px resize handle     |     |                    |
                  + terminal frame -------+     |                    |
                  | terminal (optional)   |     |                    |
                  +-----------------------+     +--------------------+
```

- The session and bottom terminal each use independent `bg-background`, `rounded-xl`, `border-border` outer frames; WorkspaceHeader is inside the session frame. When the terminal is closed, the session fills the left column.
- macOS window root background uses `bg-background-alt`; Windows, Linux, and Web continue to use `bg-background-win-alt`.
- The Side Pane's launcher/tab bar/content share an independent `bg-background` frame; the two panels align top and bottom.
- Internal panels default to `xl` corner radius and `border-border` subtle borders; the side adjacent to the Windows system edge continues to follow the existing native corner / maximized rules. Layout frames do not count toward content corner radius levels.
- 4px transparent spacing between panels carries the resize handle; when the Side Pane is closed, the spacing is not retained and the session fills back.
- Workspace Sidebar, Side Pane, and Terminal retain 4px transparent drag hotspots with 2px indicator line width, using the third-layer text color `foreground-subtlest/50` (50% opacity on top of the theme color). Hidden by default; visible on hover, keyboard focus, and drag. Indicator lines do not use masks; vertical lines extend along panel height, horizontal lines along panel width, with rounded endpoints inset by panel corner radius. Drag, spacing, and mobile hide rules remain unchanged.

- Retain the existing persistent keys, minimum widths, drag, and explicit close boundaries for `workspace-body-layout`, `conversation-column`, `browser`, and session/terminal. The Side Pane does not unmount due to toggle or main view switch; Browser Guest screenshot delivery follows the original path.
- Window controls for Windows/Linux belong to the rightmost Header inline action group: carried by WorkspaceHeader when Side Pane is closed, by Side Header/empty-state top bar when open; no independent floating layer or native window control placeholder is retained.
- The Desktop Side Pane tab bar blank area supports window dragging; tabs and buttons exclude window dragging, preserving tab sorting, switching, closing, and menu operations. Web and mobile overlay panels do not enable window drag areas.
- When collapsed, WorkspaceHeader shows an expand button; when expanded, the button moves to the right side of Side Header, with the empty state also retaining the same collapse entry. Reuses existing toggles and shortcuts; mobile overlay panels continue to use the drawer close entry.
- Side Header tab overview, new tab button, and tab item uniformly use ghost style. Tabs default to header background; hover uses `bg-hover`, selected uses `bg-selected`, all without outline borders. The close button is absolutely positioned, does not take title space, does not overlay background masks, and the drag preview also does not show borders; keyboard focus hints are retained.
- The tab close button is only visible when selected, hovered, or keyboard-focus-focused within the tab; when hidden, it does not receive mouse clicks. Icons and text are grouped into a separate item-content; overflow is faded via mask only, no ellipsis is shown. When the close button is displayed, only the fade region shifts left; content width and position remain unchanged. Touchscreen users select the tab first, then operate the close button.
- The selected tab continues to show `bg-selected` on hover, without switching to `bg-hover`.
- The separator line between WorkspaceHeader and Side Header uses `border-border/50`; the WorkspaceHeader for a new task draft always uses a transparent separator line, including when Side Pane is expanded.
- Existing tasks display a ghost workspace icon button before the name in WorkspaceHeader: Folder for local, Cloud for cloud/remote, following the existing workspace identity judgment. The workspace capsule and branch switch entry after the name are removed; workspace name (including existing remote host identifiers) and current branch are shown on hover, keyboard focus, or tap on the icon. Detached HEAD uses the existing localized text; non-Git workspaces do not show a branch. New task drafts do not display this context entry. The workspace identity, connection, task menu, and other branch switch entries are not modified.
- WorkspaceHeader workspace info tooltip reuses `ControlHintTooltip`'s default 2px offset and Tooltip's `rounded-lg` corner radius, without overriding distance or corner radius separately.
- The Side Header tab list uses `gap-1` (4px), with overflow width budget using the same spacing.
- The bottom terminal tab has no leading icon and uses `pl-2` (8px) left padding.
- The bottom terminal tab also uses ghost: selected background hover unchanged, content faded via mask; the close button participates in normal flex layout, only visible when selected, hovered, or focus-within; when hidden, it retains its placeholder, and the mask does not shift left with the display state. Tab spacing is 4px, width follows content, maximum 144px, with no fixed or minimum width. The "Terminal" title remains as-is; shell names use normal辅助 text, without pill background, corner radius, or padding.
- New task, normal conversation, plugins, and Automations all share the same main panel boundary, without creating a second set of business state.
- Mobile remote control maintains the single-column/overlay drawer path, with no additional dual-panel spacing; responsive collapse must not squeeze out the input area or cause horizontal scrolling.

## Compatibility Boundaries

Changes to React layout and styling only, no protocol/service/Host changes. Desktop `desktop-continuous` and mobile `web-remote-replayable` attachment, recovery, and CommandInbox boundaries remain unchanged; workspaceIdentity / remoteSessionId passed through as-is.

## Linux Aligned with Windows (2026-09-04)

This section supersedes the historical notes below where Linux retained the old layout. Linux desktop uses the same 4px outer padding, 5px full border on all four corners, 13px left offset and 5px top offset for the top tool group, and 8px padding on both sides of the Header as Windows. Normal and maximized windows are consistent; Linux does not apply the Windows 10 native corner exception.

Windows/Linux share the same inline window control component: 28px buttons, 16px icons, 2px spacing, close-on-hover is destructive; when collapsed, follows WorkspaceHeader's Side Pane toggle; when expanded, follows Side Header (including empty state). Old floating window controls and 120px placeholder for Linux are removed; WorkspaceHeader uses the standard help entry, without an independent dropdown arrow. Window controls on the settings page follow the menu group, same as Windows. macOS, Web, and mobile layouts are unchanged; Linux existing frameless and DesktopCommand/status events continue to be reused.

Acceptance continues to use SPT-E2E-000/007, executing expand/collapse, layout dimensions, and native window control assertions on both Windows/Linux; platform unit tests cover Linux vs. Web/macOS isolation. Windows environments cannot substitute for real Linux window manager validation; commit records must clearly list pending items.

## Acceptance

- macOS Sequoia (15) and earlier workspace panels use 6px corner radius; Tahoe (26) and later use 12px. Unknown versions temporarily use 6px. The session, Side Pane, and bottom Terminal all share this version selection. Windows, Linux, and Web radii remain unchanged.

- Settings page main content panels use 5px corner radius on Windows, consistent with the Windows main workspace; macOS and Linux temporarily keep the existing 12px. Corner radius applies only to content panels with 4px outer padding, without changing the window native edge.

- Settings page Sidebar increases by 4px from the original size: compact width 68px, desktop width 268px. The Sidebar and main content do not add extra spacing; the content frame's left side maintains the original connection method.

- The settings page removes the independent caption dropdown arrow on Windows/Linux, reusing macOS's question mark help entry; the question mark and inline window controls form the same right-side action group, with window control behavior, close-on-hover, and 8px right margin unchanged. macOS continues to use native window controls; Web continues to show only the question mark.

- Settings page main content frames on macOS, Windows, and Linux desktop uniformly use 4px outer padding: retaining the existing 0px spacing for the left side adjacent to navigation, and accepting the content panel via 4px top drag padding; Web does not add desktop frame padding. This unifies the large structural margins without changing the settings content area's own padding.

- Side Header and WorkspaceHeader uniformly use 8px left/right padding: tab overview left, window control action group right, and launcher empty state are consistent; button sizes and internal tab spacing remain unchanged.

- The onboarding page's Windows/Linux window controls align with Workspace and Settings: 48px title area counts toward 4px outer padding and 1px border, controls 15px from window top and 13px from right. Maintains the same CSS geometry across light/dark themes and window sizes; macOS and mobile Web do not display this custom-drawn window control group.

- Windows custom-drawn window controls use normal flex layout, placed right after the Side Pane toggle, reusing its `icon-md` size, default corner radius, and 2px spacing; close-on-hover stays red. When Side Pane is collapsed, it belongs to WorkspaceHeader; when expanded, it belongs to Side Header (including launcher empty state); no absolute positioning overlay, no extra native caption space reserved. Settings page window controls follow their existing menu action group.

- Windows main window and settings window use application custom-drawn window controls: 28px buttons, 16px icons, 5px corner radius, 4px spacing, close-on-hover uses destructive color. The maximize/restore icon, reusing DesktopCommand and window state events. The main window controls center-aligned with the Header; native titleBarOverlay is not enabled; scaling custom-drawn controls and reserved space scale synchronously with CSS pixels. macOS/Linux unchanged.

- Windows Header's terminal/Side Pane buttons use the same compact style as macOS, without the Windows caption's 48px full-height click background and zero spacing; system minimize/maximize/close button placeholders remain independently reserved.

- The Windows left top tool group uses 12px horizontal padding plus 1px left margin, actual left offset 13px, shifted 5px to the right from the previous position; vertical alignment with Linux/macOS positioning unchanged.

- The Windows left top tool group is offset by 4px outer padding + 1px panel border, aligning with the main workspace 48px Header center line; applicable to both sidebar expand/collapse; macOS/Linux/Web original positioning unchanged.

- After removing the Windows Header's independent dropdown arrow, the action area restores shared `p-2`, with right padding of 8px; no longer retains `pr-0` set for the old caption menu. The system window button area's placeholder remains independently reserved.

- Windows WorkspaceHeader shares the regular action area with macOS, removing the terminal-side independent caption dropdown arrow menu and separator placeholder; standard help entry and system window button placeholders are retained. Linux and settings page menu entries unchanged.

- Windows normal and maximized windows uniformly use 5px layout corner radius and full 1px border for sessions, terminals, and Side Pane: panels have 4px outer padding, no longer directly serving as the system window edge. Unknown capabilities use the same default value; Windows 10 existing outer right-angle rules are temporarily retained; macOS uses Sequoia 6px / Tahoe 12px by version.

- Windows and macOS main workspace uniformly retain 4px outer padding on top, right, and bottom; 4px on the left when the sidebar is collapsed. Sidebar drag line endpoints synchronously count toward this padding layer. Linux, Web, and mobile layouts keep original rules; Windows caption control area still reserved by original rules.

- Expanded Side Pane: Header belongs to the session panel, two panels with independent corner radii and backgrounds; top/bottom difference <= 1px, panel spacing 4px.
- Collapsed Side Pane: left panel restores original width; repeated expand/collapse does not lose tabs, terminal content, or sessions.

- Both themes verified for backgrounds and borders; existing mobile remote control, Windows/Linux caption unit tests pass.
- Execute relevant unit tests, Electron E2E, typecheck, lint, and record independently unverifiable platform visual validations.

## Verification Results

- 2026-09-10 restored original length: indicator lines extend along panel edges, inset by corner radius, retaining foreground-subtlest/50, no mask. Windows Electron SPT-E2E-000 first round hover timeout, re-run of the same build passed (`desktop-e20260910-034045-447`); covers length, light/dark themes, and dragging. typecheck, typecheck:e2e, lint passed (44 existing warnings). Other platforms not re-verified on actual hardware.

- 2026-09-10 fixed-length handle: indicator lines changed to centered 48px, retaining 2px stroke width and foreground-subtlest/50, mask removed. Windows Electron SPT-E2E-000 verified light/dark themes with fixed length, no mask, show/hide, and real dragging (`desktop-e20260910-033653-782`); typecheck, typecheck:e2e, lint passed (44 existing warnings). Other platforms not re-verified on actual hardware.

- 2026-09-10 gradient line downgraded to foreground-subtlest/50: Windows Electron SPT-E2E-000 ultimately passed (`desktop-e20260910-033454-339`). First round corrections referenced missing Tailwind utility test false positives; second round hover timeout, same build re-run passed. typecheck, typecheck:e2e, lint passed (44 existing warnings), other platforms not re-verified on actual hardware.

- 2026-09-10 gradient line uses third-layer color foreground-subtlest: Windows Electron SPT-E2E-000 passed, run ID `desktop-e20260910-032826-700`; typecheck, typecheck:e2e, lint passed (44 existing warnings). Gradient, drag, and show/hide behavior unchanged; other platforms not re-verified on actual hardware.

- 2026-09-10 secondary color gradient line: Windows Electron SPT-E2E-000 passed, covering secondary colors for all three handles, gradient mask, default hidden, hover/drag visible, real dragging, and light/dark themes. Run ID `desktop-e20260910-032455-191`. 17 unit tests passed, 1 existing skipped; typecheck, typecheck:e2e, lint passed (44 existing warnings). macOS/Linux, mobile on actual hardware not re-verified.

- 2026-09-10 removed handle indicator lines: Windows Electron SPT-E2E-000 passed; all three transparent hotspots show no indicator lines on hover, drag, and light/dark themes, while real size adjustment remains effective. 17 related unit tests passed, 1 existing skipped; typecheck, typecheck:e2e, lint passed (44 existing warnings). macOS/Linux and mobile on actual hardware not re-verified.

- 2026-09-10 handle sky color scheme: light sky-500, dark sky-400, no additional opacity reduction. Windows Electron SPT-E2E-000 passed, covering all three handle sizes, real dragging, and light/dark assertions; run ID `desktop-e20260910-031310-945`. 16 related unit tests, typecheck, typecheck:e2e, lint passed (44 existing warnings). macOS/Linux and mobile on actual hardware not re-verified.

- 2026-09-10 Sequoia corner radius fix: 20 version-identification and radius unit tests passed; typecheck, typecheck:e2e, lint passed (44 existing warnings). Windows Electron first round 6/8 (tab hover, minimize timing failure), same renderer re-run 8/8, run ID `desktop-e20260910-030905-004`. Sequoia/Tahoe native window appearance still requires macOS on-machine validation.

- 2026-09-10 handle third-layer text color: Windows Electron SPT-E2E-000~007 all 8/8 passed, covering dragging and Zai light/dark colors for all three handles; related unit tests 14 passed, 1 existing skipped. typecheck, typecheck:e2e, lint passed (46 existing warnings). macOS/Linux and mobile on actual hardware not run; modifications only involve shared indicator line colors; mobile hide rules unchanged.

- 2026-09-07 E2E completion: all three handles verified with 4px hotspots, 2px `bg-foreground` indicator lines, default hidden, hover/drag visible, and real size changes; simultaneously verified settings page Sidebar desktop width 268px. Testing discovered and fixed the issue of drag indicator lines disappearing after terminal cursor leaves the hotspot. Workspace E2E 7/7, Settings E2E 5/5, related unit tests 47/47 passed; run IDs: `desktop-e20260907065558567-p30371-3b85b0c85fbbae83`, `desktop-e20260907065702167-p33040-7fa462d329a4436b`.

- 2026-09-07 Windows settings page corner radius alignment: main content panels use 5px, macOS/Linux keep 12px. 14 related unit tests, 4 Windows Electron settings page E2E, typecheck, lint passed (44 existing warnings, 0 errors); E2E run ID `desktop-e20260907034259243-p15484-0c781c55b70b3943`.

- 2026-09-07 Settings page caption entry alignment: Windows/Linux removed old dropdown arrow and native overlay dynamic placeholder, reused macOS question mark help entry, forming a 134px action group with three inline window controls. 15 related unit tests, 4 Windows Electron settings page E2E, typecheck, lint passed (44 existing warnings, 0 errors); E2E run ID `desktop-e20260907033146942-p24568-0c3e36ba64f67d99`.

- 2026-09-07 Settings page desktop frame alignment: macOS, Windows, Linux main content frames uniformly use 4px outer padding, Web keeps 0px; 22 related unit tests, typecheck, lint passed (41 existing warnings, 0 errors). Linux/macOS visual validation not independently executed in the current environment.

- 2026-09-04 Linux aligned with Windows: 60 related unit tests passed; Windows Electron 8 interaction regressions passed, run ID `desktop-e20260904131942845-p10384-c7851f1c1af7bbc7`, covering shared window controls real minimize/close, maximize/restore, and panel expand/collapse. typecheck, lint passed (41 existing warnings, 0 errors). Linux branch included in the same E2E assertions; current Windows environment did not execute real Linux/X11/Wayland window manager validation; macOS and mobile not independently visually re-verified.

- 2026-09-04 Windows inline custom-drawn window controls: 8 Windows Electron E2E passed, covering post-expand/collapse ownership and adjacent 2px spacing, 28px size, maximize/restore icons, real minimize/close events, and existing panel interactions. Run ID `desktop-e20260904125135324-p11372-6864a58ebc85a27d`. Related unit tests, typecheck, lint passed (41 existing warnings). Windows native hover Snap Layout not implemented; macOS/Linux/mobile keep original paths, not independently visually re-verified. Old windows require restart to apply frameless creation parameters.

- 2026-09-04 Windows layout corner radius final adjustment to 5px: CDP measured all four corners as 5px; 28 unit tests, 7 Windows Electron E2E, typecheck, lint passed (41 existing warnings).

- 2026-09-04 Windows Header buttons restored to macOS compact style: CDP measured terminal and Side Pane toggle heights both as 28px; 10 Header unit tests, 7 Windows Electron E2E, typecheck, lint passed (41 existing warnings).

- 2026-09-04 Windows top tool group alignment: CDP measured pre-adjustment left/right centers as 24px/29px, post-adjustment both 29px; 3 related unit tests, 7 Windows Electron E2E, typecheck, lint passed (41 existing warnings).

- 2026-09-04 Windows Header right margin fix: removed old `pr-0`, CDP measured recovery from 0px to 8px; 10 Header unit tests, 7 Windows Electron E2E, typecheck, lint passed (41 existing warnings).

- 2026-09-04 Windows Header removed independent dropdown arrow: runtime confirmation retains only standard help and terminal operations; 33 related unit tests, 7 Windows Electron E2E, typecheck, lint passed (41 existing warnings).

- 2026-09-04 Maximized Side Pane fix: runtime confirmation old style was 0px corner radius, only 1px left border; after fix, all four corners 6px, all four sides 1px. 28 unit tests, typecheck, lint passed; Windows Electron E2E 7/7 with real maximize/unmaximize passed, run ID `desktop-e20260904121343959-p7064-eb22b5d3fbfec48a`.

- 2026-09-04 Windows layout corner radius unified `rounded-md`: 28 unit tests, typecheck, lint passed (41 existing warnings); CDP measured both session and Side Pane corners as 6px. Windows Electron E2E first run 6/7, Tooltip delay assertion failed, re-run with same build 7/7 passed; layout corner radius assertions passed both times. macOS, Linux, and mobile did not undergo independent visual re-verification this time.

- 2026-09-04 Windows outer padding aligned with macOS: 23 layout unit tests, 7 Windows Electron E2E, `pnpm typecheck`, `pnpm lint` passed (41 existing warnings). CDP measured main panel top 4px, content right/bottom padding both 4px. E2E run IDs: `desktop-e20260904120237923-p17680-a5f5b3aeaa873805`. macOS, Linux, mobile not independently visually re-verified this time.

- 2026-09-04 Terminal independent outer frame: 39 related unit tests, 7 Electron E2E, typecheck, lint passed; E2E verified terminal is outside session frame, in the same left column, 4px spacing, and three-panel light/dark theme backgrounds are consistent. Run ID: `desktop-e20260904104922835-p29510-089fd6229a80617c`. Windows native edge logic retained; Windows/Linux and mobile independent visual verification pending.

- 2026-09-04: 8 related unit test files, 51 passed, 1 existing skipped. New Header ownership and control area reservation test cases first failed then passed.

- `pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm lint` passed; Lint 41 existing warnings, 0 errors.

- macOS Electron final 4px version: 7/7 passed; run ID `desktop-e20260904084050358-p6937-68e000533efda13e`.

- Runtime validation includes: 4px spacing, top/bottom alignment, dual xl outer frames, Header ownership, real pointer dragging to change width, bottom terminal independent outer frame, width recovery after close, tab bar toggle and zoom interactions, and light/dark theme background consistency. Screenshots for both themes have been checked.

- Windows/Linux caption and mobile remote control paths have unit test coverage; independent visual E2E for these platforms has not been executed; transparent window bottoms in screenshots are not equivalent to the OS's final synthesized vibrancy material.

## Recent Session Activity

The name/path below the info tooltip displays a clock icon with "Last active 2 minutes ago" (English: Last active 2 minutes ago), replacing workspace tasks/active statistics. Uses the current session meta's real-time `activity.lastActivityAt`, falling back to `updatedAt` when missing; not displayed when time is unknown. Refreshes relative time every minute while the tooltip is open, clears the timer after closing. Removes the original statistics component and list query; adds no new services, protocols, or persistence.

## Workspace Info Layout

The workspace icon and name are on the same line; the path is displayed below the name and aligned with the left edge of the name. The path uses secondary foreground and `text-ui-sm`; only home directories belonging to the current workspace's host are abbreviated to `~`; when home is not available, the original path is displayed. Below the path, the current session's most recent activity is shown, with a `border-border/50` separator line before the branch; non-Git workspaces do not show a branch or separator line.

Layout verification: related unit tests 7/7, macOS Electron TTL01–TTL07 7/7, path measured as `~/ZCodeProject`; typecheck, lint passed (46 existing warnings). Run record: `desktop-e20260907080616432-p60066-d11800800bd11757`.

- 2026-09-10 MR !2586 CR-01: Fixed macOS window state query being skipped by hook guard. Two new real-hook regressions first failed then passed; 26 related unit tests, typecheck, lint (44 existing warnings, 0 errors) passed. Windows Electron SPT-E2E-000 passed, run ID desktop-e20260910-040930-907. macOS native visual and mobile on actual hardware not verified.

- Workspace Sidebar bottom footer left padding remains 16px (`pl-4`), right padding 12px (`pr-3`); top/bottom padding unchanged. This override is only passed by Workspace callers; Settings-reused footer keeps default left/right 16px (`px-4`).
