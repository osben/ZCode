# Settings Top Breadcrumb

## Goal

The window drag area at the top of the Settings content panel shows the current level, helping users keep
their position between a section and its inner details:

```text
current section > section inner detail...
```

## Product Contract

1. The default first level is the current Settings section title, with no fixed "Settings" root node. When
   entering plugin management from the standalone plugin market, the first level may project a source node
   `Plugin Marketplace` crossing the Settings boundary, to keep the user's return path; entering directly from
   Settings still uses `Plugins` as the first level.
2. With only the first level the top bar stays empty; the breadcrumb shows only after entering a second or
   deeper page-level navigation.
3. A section may append read-only detail levels. Project Memory appends the project name and file name in
   turn, forming `Memory > project > file`.
4. The breadcrumb only projects existing navigation state and owns or persists none. Apart from the current
   level, upper levels reuse the section's existing back action; clicking returns to that level, and the
   current level stays read-only text.
5. The separator uses `ChevronRight` and `text-foreground-subtlest`; upper levels use a `ghost + default`
   button with default `text-foreground-subtle` and Hover `text-foreground`; the last level uses main text.
   All levels truncate to a single line and must not squeeze the safe area of the right Help, the Linux caption
   menu or the Windows caption controls.
6. The Settings path container uses `px-2.5` horizontal padding, matching the compact title-bar density. Levels
   and both sides of separators use `gap-0`, with spacing provided by the levels' own padding. The current
   level text uses the same `text-ui-base/relaxed` font size, line height and `px-2` horizontal padding as
   `Button size="default"`.
7. The breadcrumb container keeps `pointer-events-none`; upper-level buttons separately restore
   `pointer-events-auto` and `[app-region:no-drag]`; the title bar outside the buttons stays
   `[app-region:drag]`.
8. When the breadcrumb reaches the second level, the repeated outer Settings section title (e.g. `Memory`) is
   hidden and the detail page's original Back button removed; the back action is carried uniformly by the
   breadcrumb's upper-level button. First-level pages restore the section title. The plugin market source path
   is an exception: the first level of `Plugin Marketplace > Plugins` is an external source rather than the
   current section, so the content area keeps showing the `Plugins` title, making the current page title clear
   after entering plugin management; after entering plugin, MCP or Skill details the `Plugins` middle level is
   still kept.
9. The new/edit content titles of Command, Subagent, MCP and Hook use `text-ui-xl`. The outer Settings section
   title uses `text-ui-settings-title lg:text-ui-settings-title-lg`, keeping 24px / 32px line height on narrow
   screens and 30px / 36px from `lg` at default font size, scaling with the UI font-size setting; it uses a
   dedicated semantic token, avoiding a generic font-size class that violates design-system checks.
10. Model Settings and Usage Stats use no breadcrumb; they always keep the large content title. Model
    Settings' inner provider navigation and Usage Stats' tabs are same-page switches and are not promoted to
    page levels.
11. Desktop, ordinary Web and Mobile reuse the same level semantics; non-Electron environments just ignore
    app-region styles.

## State Chain

```text
SettingsPage.activeSection ----------------+
                                           |
active section page-level navigation state +--> breadcrumb items --> header
```

Sub-levels take part in display only while their section is active. After switching sections, old details must
not leak into other sections.

## Coverage

- Memory: project, file.
- Plugins: plugin details, installed plugin management; the current-level name uses the localized display
  name, unified with list cards and detail titles, never the internal canonical name. With no configured
  `displayName`, a `-` / `_` separated name such as `cloudbase-skills` is formatted as `Cloudbase Skills`.
  Entering plugin settings directly starts the path with `Plugins`; entering from the plugin market starts with
  `Plugin Marketplace` and keeps the `Plugins` middle level on the management page and its plugin, MCP and
  Skill sub-pages.
- Subagents, MCP, Commands, Hooks: new or edit pages.
- Automations: new or edit pages of scheduled and idle-time tasks.
- Model Settings' provider/plan navigation, Usage Stats' tabs, and the standalone Skills section's details,
  confirm dialogs, authorization, sync, search, filter, scope and in-form tabs are not page levels and do not
  enter the breadcrumb. The Skill tab details inside Plugins are plugin-management sub-pages and enter the
  breadcrumb per the plugin path.

## Acceptance

| ID | Setup | Action | Assertions |
| --- | --- | --- | --- |
| SHB01 | Settings General | Open settings | No breadcrumb in the top bar; drag area and right safe margin kept |
| SHB02 | Memory project list | Open Memory | No breadcrumb in the top bar |
| SHB03 | Memory project detail | Click a project | Shows `Memory > project name` |
| SHB04 | Memory file body | Click a file | Appends the file name |
| SHB05 | Memory detail | Go back or switch section | Breadcrumb shrinks in sync, no old level left |
| SHB06 | Memory file body | Click the project button | Returns to the project file list, breadcrumb shrinks to two levels |
| SHB07 | Any second-level page | Click the section button | Reuses that section's back action to the first-level page |
| SHB08 | Any second-level page | Enter details | Hides the outer section title, no duplicate Back |
| SHB09 | Model Settings | Switch provider or plan | No breadcrumb in the top bar; the large title stays in the content |
| SHB10 | Usage Stats | Switch usage tab | No breadcrumb in the top bar; the large title stays in the content |
| SHB11 | Settings plugin list | Open plugin details | Shows `Plugins > Example Plugin` |
| SHB12 | Plugin market | Open market plugin details | Shows `Plugin Marketplace > Example Plugin` |
| SHB13 | Plugin market | Click manage installed | Shows `Plugin Marketplace > Plugins`; content keeps the `Plugins` title |
| SHB14 | Market-sourced plugin management | Open a plugin, MCP or Skill sub-page | Shows `Plugin Marketplace > Plugins > current page`; clicking `Plugins` returns to the management page |
