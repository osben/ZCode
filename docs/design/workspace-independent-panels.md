# Workspace-Independent Panel Layout

## Objectives

Desktop and wide-screen Web keep the sidebar and split the formerly shared-frame session and Side Pane into
independent panels; the window root background and sidebar keep their original semantics.

Platform corner radii of the workspace layout: Windows `rounded-md` (default 6px), macOS Sequoia and earlier
6px, Tahoe 26+ 12px, unknown macOS version temporarily 6px; Linux and Web `xl` (12px). On Windows the settings
page also uses 6px.

The macOS version must be queried through `IPlatformService.getDesktopWindowChromeState` and subscribed through
window state events, then passed to `useAppChromeState` for the workspace corner-radius calculation. The hook
used to exclude macOS, so all macOS took the unknown-version 6px branch; each desktop platform shares the
existing query/event revision override-prevention mechanism, and Web does not query desktop state. Regression
tests must run the real hook and validate the Sequoia/Tahoe radii after async queries and subscription cleanup;
injecting the version into the radius function alone is not enough.

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

- The session and the bottom terminal each use an independent `bg-background`, `rounded-xl`, `border-border`
  outer frame; WorkspaceHeader is inside the session frame. When the terminal is closed the session fills the
  left column.
- The macOS window root background is `bg-background-alt`; Windows, Linux and Web keep `bg-background-win-alt`.
- The Side Pane launcher/tab bar/content share one independent `bg-background` frame; the two panels align top
  and bottom.
- Internal panels default to `xl` corner radius and `border-border` subtle borders; the side adjacent to the
  Windows system edge keeps following the existing native corner / maximized rules. Layout frames do not count
  toward content corner-radius levels.
- The 4px transparent spacing between panels carries the resize handle; when the Side Pane is closed the
  spacing is not kept and the session fills back.
- Workspace Sidebar, Side Pane and Terminal keep 4px transparent drag hotspots with a 2px indicator line, using
  the third-layer text color `foreground-subtlest/50` (see the desktop color section below). Hidden by default;
  visible on hover, keyboard focus and drag. Indicator lines use no mask; vertical lines extend along panel
  height, horizontal lines along panel width, with rounded endpoints inset by the panel corner radius. Drag,
  spacing and mobile hide rules are unchanged.
- The persistent keys, minimum widths, drag and explicit close boundaries of `workspace-body-layout`,
  `conversation-column`, `browser` and session/terminal are kept. The Side Pane does not unmount on toggle or
  main-view switch; Browser Guest screenshot delivery follows the original path.
- Windows/Linux window controls belong to the rightmost Header inline action group: carried by WorkspaceHeader
  when the Side Pane is closed, by the Side Header / empty-state top bar when open; no independent floating
  layer or native window-control placeholder is kept.
- On Desktop the blank area of the Side Pane tab bar supports window dragging; tabs and buttons are excluded
  from window dragging, keeping tab sorting, switching, closing and menu operations. Web and mobile overlay
  panels do not enable window drag areas.
- When collapsed, WorkspaceHeader shows an expand button; when expanded the button moves to the right side of
  the Side Header, and the empty state keeps the same collapse entry. Existing toggles and shortcuts are
  reused; mobile overlay panels keep using the drawer close entry.
- Side Header tab overview, new-tab button and tab items all use the ghost style. Tabs default to the header
  background; hover uses `bg-hover`, selected `bg-selected`, no outline borders. The close button is absolutely
  positioned, takes no title space, overlays no background mask, and the drag preview shows no border; keyboard
  focus hints are kept. A selected tab keeps showing `bg-selected` on hover instead of switching to `bg-hover`.
- The tab close button is visible only when selected, hovered or keyboard focus is within the tab; when hidden
  it does not receive mouse clicks. Icon and text are grouped into a separate item-content; overflow is faded
  by mask only, no ellipsis. When the close button shows, only the fade region shifts left; content width and
  position are unchanged. Touchscreen users select the tab first, then use the close button.
- The separator line between WorkspaceHeader and Side Header uses `border-border/50`; a new-task draft's
  WorkspaceHeader always uses a transparent separator, including when the Side Pane is expanded.
- Existing tasks show a ghost workspace icon button before the name in WorkspaceHeader: Folder for local,
  Cloud for cloud/remote, following the existing workspace identity judgment. The workspace capsule and branch
  switch entry after the name are removed; workspace name (including existing remote host identifiers) and
  current branch are shown on hover, keyboard focus or tap on the icon. Detached HEAD uses the existing
  localized text; non-Git workspaces show no branch. New task drafts do not display this context entry.
  Workspace identity, connection, task menu and other branch switch entries are not modified.
- The WorkspaceHeader workspace-info tooltip reuses `ControlHintTooltip`'s default 2px offset and Tooltip's
  `rounded-lg` corner radius, without overriding distance or radius separately.
- The Side Header tab list uses `gap-1` (4px), and the overflow width budget uses the same spacing.
- The bottom terminal tab has no leading icon and uses `pl-2` (8px) left padding; it also uses ghost: selected
  background hover unchanged, content faded by mask; the close button participates in normal flex layout and is
  visible only when selected, hovered or focus-within; when hidden it keeps its placeholder and the mask does
  not shift left with the display state. Tab spacing is 4px, width follows content up to 144px, with no fixed
  or minimum width. The "Terminal" title stays as is; shell names use normal secondary text, without pill
  background, corner radius or padding.
- New task, normal conversation, plugins and Automations share the same main panel boundary and create no
  second set of business state.
- Mobile remote control keeps the single-column/overlay drawer path with no extra dual-panel spacing;
  responsive collapse must not squeeze out the input area or cause horizontal scrolling.

## Compatibility boundaries

React layout and styling changes only; no protocol/service/Host changes. Desktop `desktop-continuous` and
mobile `web-remote-replayable` attachment, recovery and CommandInbox boundaries are unchanged;
workspaceIdentity / remoteSessionId pass through as is.

## Platform outer-edge dimensions (2026-10-09, supersedes the historical dimensions below)

- Windows workspace right, bottom and top extra gaps, and the left inset after the Sidebar collapses, are all
  6px; Linux keeps 4px; the main panel corner radius stays 12px.
- The Windows settings page also uses 6px gaps on the right, bottom and top plus a 6px corner radius; the left
  side where navigation meets content gets no extra spacing. macOS, Web and mobile keep the existing rules.
- New task, sessions, plugins and Automations reuse the shared workspace boundary; the terminal and Side Pane
  use the same corner radius. The 4px drag hotspot between panels is unchanged.
- The drag indicator keeps its 2px width, edge-following length and existing visibility rules. Sidebar
  indicator endpoints are inset by the platform outer-edge gap plus the corner radius: 12px on Windows, 16px
  on Linux.
- SPT-E2E-000 verifies platform dimensions, the collapsed left inset and dragging; UP-00 verifies the settings
  page; platform unit tests cover Linux, Windows with unknown capability, and normal and maximized windows.

## Desktop drag indicator color (2026-10-09)

Sidebar, Side Pane and the bottom terminal uniformly use the `resize-handle` token: sky-500 in the light theme
and sky-400 in the dark theme, covering macOS, Windows and Linux desktop. Web keeps `foreground-subtlest/50`;
mobile hide rules are unchanged. The indicator keeps its 2px width, rounded endpoints, edge-following length,
and display on hover, keyboard focus and drag, and stays hidden by default. The 4px hotspot and drag logic are
unchanged. SPT-E2E-000 verifies the three indicator colors, lengths, visibility and actual dragging in both
themes.

## Platform corner radius token (2026-10-12)

The Windows and older-macOS 6px panel radii use `rounded-md`, and the left side of Windows' non-native-radius
path uses `rounded-l-md`. The settings page reuses the same token. The 6px value in the platform radius
calculation, the drag-indicator inset and other platform radii are kept; desktop and mobile layout and
interaction are unchanged. The logo base keeps using `rounded`. Unit tests verify token selection; E2E verifies
both the platform class and the computed radius.

## Linux aligned with Windows (2026-09-04)

This section supersedes the historical notes below in which Linux kept the old layout. Linux desktop uses the
same 4px outer padding, 5px full border on all four corners, 13px left offset and 5px top offset for the top
tool group, and 8px padding on both sides of the Header as Windows. Normal and maximized windows are
consistent; Linux does not apply the Windows 10 native corner exception.

Windows/Linux share the same inline window control component: 28px buttons, 16px icons, 2px spacing,
close-on-hover destructive; when collapsed it follows WorkspaceHeader's Side Pane toggle, when expanded the
Side Header (including empty state). The old floating window controls and the 120px placeholder for Linux are
removed; WorkspaceHeader uses the standard help entry without an independent dropdown arrow. Window controls
on the settings page follow the menu group, same as Windows. macOS, Web and mobile layouts are unchanged;
Linux's existing frameless and DesktopCommand/status events keep being reused.

Acceptance keeps using SPT-E2E-000/007, running expand/collapse, layout dimensions and native window control
assertions on both Windows/Linux; platform unit tests cover Linux vs. Web/macOS isolation. A Windows
environment cannot substitute for real Linux window manager validation; commit records must list pending items.

## Acceptance

Several dimensions below are historical and superseded by the 2026-10-09 / 2026-10-12 sections above (Windows
5px -> 6px `rounded-md`, 4px -> 6px outer gaps).

- macOS Sequoia (15) and earlier workspace panels use 6px corner radius; Tahoe (26) and later 12px; unknown
  versions temporarily 6px. The session, Side Pane and bottom Terminal all share this version selection.
  Windows, Linux and Web radii are unchanged.
- Settings main content panels use 5px corner radius on Windows, consistent with the Windows main workspace;
  macOS and Linux temporarily keep 12px. The radius applies only to content panels with 4px outer padding and
  does not change the window native edge.
- The settings Sidebar grows 4px: compact width 68px, desktop width 268px. Sidebar and main content add no
  extra spacing; the left side of the content frame keeps the original connection method.
- The settings page removes the independent caption dropdown arrow on Windows/Linux and reuses macOS's
  question-mark help entry; the question mark and inline window controls form the same right-side action
  group, with window control behavior, close-on-hover and 8px right margin unchanged. macOS keeps native window
  controls; Web keeps showing only the question mark.
- Settings main content frames on macOS, Windows and Linux desktop uniformly use 4px outer padding, keeping 0px
  spacing on the side adjacent to navigation and accepting the content panel via 4px top drag padding; Web adds
  no desktop frame padding. The settings content area's own padding is unchanged.
- Side Header and WorkspaceHeader uniformly use 8px left/right padding: tab overview left, window control
  action group right, and launcher empty state consistent; button sizes and internal tab spacing unchanged.
- The onboarding page's Windows/Linux window controls align with Workspace and Settings: the 48px title area
  counts toward 4px outer padding and 1px border, controls sit 15px from the window top and 13px from the
  right, with the same CSS geometry across light/dark themes and window sizes; macOS and mobile Web do not
  display this custom-drawn control group.
- Windows custom-drawn window controls use normal flex layout, placed right after the Side Pane toggle, reusing
  its `icon-md` size, default corner radius and 2px spacing; close-on-hover stays red. When the Side Pane is
  collapsed they belong to WorkspaceHeader, when expanded to the Side Header (including the launcher empty
  state); no absolute-positioned overlay, no extra native caption space reserved. Settings window controls
  follow their existing menu action group.
- Windows main window and settings window use application custom-drawn window controls: 28px buttons, 16px
  icons, 5px corner radius, 4px spacing, close-on-hover destructive color, maximize/restore icon, reusing
  DesktopCommand and window state events. Main window controls are center-aligned with the Header; native
  titleBarOverlay is not enabled; custom-drawn controls and reserved space scale in step with CSS pixels.
  macOS/Linux unchanged.
- Windows Header's terminal/Side Pane buttons use the same compact style as macOS, without the Windows
  caption's 48px full-height click background and zero spacing; system minimize/maximize/close button
  placeholders stay independently reserved.
- The Windows left top tool group uses 12px horizontal padding plus 1px left margin, actual left offset 13px
  (5px right of the previous position), offset by 4px outer padding + 1px panel border to align with the main
  workspace 48px Header center line; applies to both sidebar expand and collapse; macOS/Linux/Web positioning
  unchanged.
- After removing the Windows Header's independent dropdown arrow the action area restores shared `p-2` with 8px
  right padding; the `pr-0` set for the old caption menu is no longer kept. The system window button area's
  placeholder stays independently reserved. Windows WorkspaceHeader shares the regular action area with macOS,
  removing the terminal-side independent caption dropdown arrow menu and separator placeholder; the standard
  help entry and system window button placeholders stay. Linux and settings menu entries unchanged.
- Windows normal and maximized windows uniformly use a 5px layout corner radius and full 1px border for
  session, terminal and Side Pane: panels have 4px outer padding and no longer serve directly as the system
  window edge. Unknown capabilities use the same default; Windows 10's existing outer right-angle rules are
  temporarily kept; macOS uses Sequoia 6px / Tahoe 12px by version.
- Windows and macOS main workspaces uniformly keep 4px outer padding on top, right and bottom, and 4px on the
  left when the sidebar is collapsed. Sidebar drag line endpoints count toward this padding layer. Linux, Web
  and mobile keep original rules; the Windows caption control area is still reserved by original rules.
- Expanded Side Pane: Header belongs to the session panel, two panels with independent corner radii and
  backgrounds; top/bottom difference <= 1px, panel spacing 4px.
- Collapsed Side Pane: the left panel restores its original width; repeated expand/collapse does not lose
  tabs, terminal content or sessions.
- Both themes verified for backgrounds and borders; existing mobile remote control and Windows/Linux caption
  unit tests pass.
- Run relevant unit tests, Electron E2E, typecheck, lint, and record platform visual validations that could not
  be done independently.

## Verification status

The Windows Electron SPT-E2E-000~007 suites (hotspot sizes, indicator colors/lengths/visibility, real
dragging, light/dark themes, window controls, corner radii, expand/collapse), settings-page E2E (frame, corner
radius, caption entry, 268px sidebar), TTL01-TTL07 and the related unit tests passed during 2026-09-04 to
2026-09-10; the macOS Electron 7/7 run passed for the 4px layout. Not independently verified on real hardware:
Linux (X11/Wayland window manager), macOS native visual material and Sequoia/Tahoe native window appearance,
and mobile; transparent window bottoms in screenshots are not equivalent to the OS's final synthesized vibrancy
material. Full per-run records are in git history.

Fixes found by verification: the drag indicator line disappearing after the terminal cursor leaves the hotspot;
the macOS window-state query skipped by the hook guard (MR !2586 CR-01).

## Recent session activity

The name/path below the info tooltip displays a clock icon with "Last active 2 minutes ago" (replacing
workspace tasks/active statistics). It uses the current session meta's real-time `activity.lastActivityAt`,
falling back to `updatedAt` when missing; not displayed when the time is unknown. The relative time refreshes
every minute while the tooltip is open and the timer is cleared on close. The original statistics component and
list query are removed; no new services, protocols or persistence.

## Workspace info layout

The workspace icon and name are on the same line; the path is displayed below the name, aligned with the left
edge of the name, using secondary foreground and `text-ui-sm`; only the home directory belonging to the current
workspace's host is abbreviated to `~`, and when home is unavailable the original path is shown. Below the path
the current session's most recent activity is shown, with a `border-border/50` separator line before the
branch; non-Git workspaces show no branch or separator. Layout verification: related unit tests 7/7, macOS
Electron TTL01-TTL07 7/7, path measured as `~/ZCodeProject`.

Workspace Sidebar bottom footer left padding stays 16px (`pl-4`), right padding 12px (`pr-3`); top/bottom
padding unchanged. This override is passed only by Workspace callers; the Settings-reused footer keeps the
default left/right 16px (`px-4`).
