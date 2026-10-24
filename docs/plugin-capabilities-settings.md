# Plugin capabilities settings page

## Goal

Settings keeps a single entry named `plugin` (formal section id), managed by `PluginsSection.tsx` for configured Plugins, MCPs, and Skills. MCP, Skills, Commands, and Hooks are separate sections reusing the same capability shell (see “Independent settings pages”). The old `customize` id is fully removed — not in types, parsing, or migration; legacy `plugins`, `mcp`, `skills` nav values exist only for compatibility migration. The plugin marketplace is a Workspace main page on par with automations, rendered by `PluginStorePage.tsx`; it is not part of settings.

## Information architecture

The settings sidebar's Agent capabilities are fixed in order `Memory → subagents → Plugins → MCP → Skills → Commands → Hooks`; the Plugins entry uses the `Blocks` icon and the MCP entry uses `Cable`. Direct servers in MCP lists still use `Server`, distinguishing navigation capabilities from concrete service instances.

```text
Plugin (settings nav)
└─ Plugins (page title)
   ├─ Scope: User / Workspace 1 / Workspace 2 / ...
   ├─ Plugins: plugins installed in the current scope
   ├─ MCPs: current-scope MCP and pending states
   └─ Skills: current-scope skills, grouped by own vs plugin source
```

The top Scope and capability tabs are two independent states: switching scope keeps the tab, switching tab keeps the scope. First entry defaults to User + Plugins. Scope is a strict data boundary shared by the three tabs; items inherited from other scopes are never shown.

The top control row places Scope and capability tabs on the left and the current tab's search box on the right. When the search box has content, the right side uses an `X` icon button to clear that tab's search, not the browser-native clear control; the button reuses `Button`'s `icon-sm` size with `rounded-full` and a `size-3.5` icon. Plugins searches plugin name and source; MCPs searches server name and config content; Skills searches name and description. All three searches are case-insensitive. Each tab keeps its own search term; switching scope keeps filtering the new scope with the current tab's term. While the Plugin page shows the top search box, the MCPs/Skills internal search boxes are not duplicated; the standalone MCP and Skills settings pages keep their original search interaction.

## Scope semantics

- `User` shows user-installed plugins, Built-in Plugins, the user's standalone MCP/Skills, and the MCP/Skills contributed by those plugins. In the Plugins tab, Built-in sits below the Installed group with its own count and is not counted in Installed.
- Workspace shows that workspace's installed plugins, its standalone MCP/Skills, and the MCP/Skills contributed by its plugins.
- The Scope menu lists only currently connectable workspaces: unavailable local directories are hidden; a remote identity/target without a matching `remoteSessionId` counts as disconnected and is hidden. Available local workspaces use `Folder`, connected remote workspaces use `Cloud`; the trigger button and menu items must use the same icon semantics. When the current selection becomes invalid, the settings page falls back to User scope.
- Attribution of plugin-contributed resources follows the owning plugin's install scope; `Skill.scope=plugin` or a plugin MCP source alone cannot bypass scope.
- Built-in means no marketplace install record and runtime `source=official`, and belongs to User scope. With an install record, the record's user/workspace scope always wins; using the official cache must not misclassify a plugin as Built-in.
- Plugins group titles use base primary text with the count in sm secondary text, so counts do not compete with the group name.
- Plugins list icon containers use `bg-background`, distinct from the list's `bg-surface`.
- Clicking a plugin row opens the inline detail page, reusing the store's `PluginStoreDetailView` (intro, hero, sample prompts, capability list, info sections) instead of the simplified management dialog. Enable/disable, update, uninstall, and advanced config for installed plugins reuse the same actions. Entering the detail hides Scope/Tabs/Search; return to the list via the settings breadcrumb.
- The plugin-store entry in the Installed header shows as `New`, using Button default variant, default size, and `rounded-lg`.
- The top Plugins, MCPs, and Skills tabs show `Name count`; the count uses sm secondary text and updates with the current scope, search term, and filtered list. All three panels preload via `forceMount` while `data-[state=inactive]:hidden` keeps only the active one visible, so all counts load without clicking tabs and content is never shown side by side.
- Top-tab counts use `text-foreground-subtle` when active and the weaker `text-foreground-subtlest` when inactive; name and count share the selected state but keep their text hierarchy.
- The MCPs list reuses the Plugins list hierarchy: `bg-surface` borderless container, `bg-hover` row hover, `bg-background` rounded icon container, and separate `bg-border/50` divider elements. MCP status, source badges, auth, and toggle interactions are unchanged.
- MCP, Skills, and Commands use one information architecture: direct Installed plus one group per plugin. Direct config goes only into Installed; plugin MCP groups by stable `pluginId`, with titles using the normalized plugin display name and the filtered count. Plugins with the same name but different ids are not merged.
- The global Needs Attention group and the flat Plugins grouping are removed. States such as pending auth, connection failure, or disabled do not change resource attribution; rows needing attention sort ahead of normal rows within their group.
- Plugin MCP names do not repeat User/Workspace, marketplace, or `Plugin` badges; the group title already expresses source. MCP-specific status, auth button, tool count, and diagnostics remain.
- Plugin-contributed MCP rows lead with the owning plugin's store icon, resolved by pluginId to the listing and reusing `PluginStoreAvatar`; missing or failed icons use that component's unified fallback. Direct MCP uses the Cable icon.
- Plugin page group headers (Plugins and MCPs) use `h-7 items-center`, keeping Installed, Built-in, Needs Attention, and plugin group titles the same height.
- Plugin MCPs do not show the “Manage MCP server configurations used by ZCode Agent.” page description; Import and New sit at the right of the Installed group header, both following the Plugins New button (default size, `rounded-lg`). The normal MCP settings page keeps its description and top Import/Create actions; remote sync actions do not move.
- When the current scope truly has no direct installs, Plugins Installed shows a Browse plugins guide and MCPs Installed shows New MCP server and Import guides; with Built-in or plugin-contributed resources present, the Installed empty guide stays. With a search term, each tab shows only groups with matches: when direct Installed is 0, its title, count, and New/Import actions hide with it; Built-in, Needs Attention, and plugin groups follow the same rule. When no group matches, only a unified transparent dashed “no matches” feedback shows, so an empty search result is not mistaken for “not installed”.
- The shared “not installed yet” guide containers for Plugins, MCPs, and Skills — and the Plugin page's no-match and unavailable empty states — use a transparent background with a `border-border` dashed border, distinct from normal `bg-surface` lists; action buttons inside use `size="lg"`. The Plugin loading state reuses the same container hierarchy and spacing.
- Plugin Skills keep the “direct skills for the current scope + one group per plugin” structure. The direct group is named `Installed`; scope is expressed only by the top selector; skill names do not repeat User, Workspace, or Plugin labels. Group titles, list containers, explicit dividers, icon backgrounds, and row hover match MCPs; the title's right side holds only Import and New, with no manual refresh — the list refreshes automatically after data changes such as import, create, sync, or toggle. Skills has no enable-state filter menu; the list always contains both enabled and disabled skills in the current scope. With no direct skills in the current scope, show the create/import guide while plugin skills stay grouped; empty results caused by search show no install guide.
- Direct plugin skills use the WandSparkles default icon; plugin skills show the owning plugin's marketplace listing icon, falling back to the default icon when no plugin matches.
- Plugin skill group titles reuse `formatCanonicalPluginName` for name casing, consistent with the Plugins and MCPs display names; the tokens `mcp`, `aws`, `zcode` always display as `MCP`, `AWS`, `ZCode`, while internal group keys keep the raw normalized name.
- MCP auth actions uniformly use the `<ExternalLink size-4> Authenticate` link-variant button with explicit `text-sky-500 dark:text-sky-400` and matching hover colors; never `text-brand`, which turns black/white in the Zai theme. Direct and plugin MCP stay consistent.
- The direct MCP default icon is always Cable; plugin MCP uses the plugin icon. Both overlay the status dot at the icon container's bottom-right instead of the name row; the parent is fixed `size-4 bg-background` with centered content and static dots use `size-2.5`, so switching to the connecting spinner does not shift the outer size. Status colors and the reason tooltip are unchanged.
- Entering MCP create/edit subpages hides the Plugin page's Scope, Tabs, and Search toolbar and removes the list-state top spacing; saving, deleting, or canceling back to the list restores the toolbar.
- The MCP create/edit form reuses the full top Scope menu (User plus all workspaces of the current window), not the simplified User/Workspace-only Select. The create form snapshots the parent scope on open; the edit form shows the resource's actual attribution and locks it, so one edit never implicitly migrates config. Switching scope inside the create form changes only this save's target, not the parent scope; after closing, the parent still shows its pre-form selection.
- The MCP form's Form/JSON mode toggle reuses the automation detail's Settings/History segmented tabs: `bg-surface` rounded shell, `bg-background` rounded active item; both places are maintained by one shared component, with no duplicated visual classes.
- Before saving a new MCP, resolve the concrete workspace target from the form scope and wait for that target's `workspacePath + workspaceIdentity` MCP config to finish loading; User uses the current available host's user directory, Workspace writes the selected workspace's `.zcode/config.json`. During target switching, never use the previous workspace's path or the remote directory service.
- Workspace never mixes in User resources; User never mixes in any workspace's resources; workspaces do not share resource projections.
- The workspace list comes from the current window's open workspace tabs, preserving tab order and deduplicating by workspace identity.
- Workspaces show the tab label; the identity key must be `workspaceIdentity?.trim() || workspacePath`.
- In the Scope menu, User uses the `Monitor` icon for the local user-level config; with a username present, the `User` label shows only after the username in the dropdown. With User selected, the top trigger shows only Monitor and the username, without repeating the label. Without a username, only the localized User text shows. Workspace keeps the Folder icon and never shows the User label.
- Service calls keep passing the actual `workspacePath`; remote workspaces also pass `workspaceIdentity`, `remoteSessionId`, and `remoteTarget`.
- Closing the currently selected workspace falls back to User; if the host backing User is unavailable, show the unavailable empty state rather than starting another runtime.

## Plugins tab

- Titled `Installed N`; shows only plugins installed in the current scope.
- Rows show icon, plugin name, and source.
- `New` opens the plugin marketplace entry; the marketplace Installed area's manage button returns to this tab.
- Clicking a normal row opens the reused full plugin detail; rows directly offer enable/disable, update, and uninstall — no second install-state implementation.

## MCPs tab

- Items needing auth, missing config, or with connection errors stay in their direct or plugin group, sorted first within it.
- Plugin-contributed MCP attribution is expressed by the plugin group; authenticatable items get the `Authenticate` primary action.
- A fixed `New MCP Server / Add a Custom MCP Server` entry creates an MCP in the current scope.
- Direct MCP sits in Installed; plugin MCP groups by plugin display name; the three pages reuse the same group title, list container, spacing, and explicit divider components.

## Skills tab

- Filter strictly by scope first, then group by source. Skills the current scope owns sit in the `User` or workspace group; plugin-contributed skills group by plugin display name.
- Group titles show counts; rows show icon, name, description, and more actions.
- `New` applies only to the currently writable scope and never writes into plugin-contributed groups.

## State and timing

```text
scope/tab change
      │
      ▼
resolve workspace target ──fail──> unavailable empty state
      │
      ▼
request with path + identity
      ├─ target key unchanged ──> commit result
      └─ target key changed   ──> discard stale result

parent scope ── open new ──> form scope snapshot
server owner ── open edit ─> locked form scope
form scope change ────────> resolve form-only target
save ────────────────────> await target config -> persist
cancel/save ─────────────> restore unchanged parent scope
```

Desktop keeps the `desktop-continuous` link; mobile remote keeps `web-remote-replayable`. The Plugin page only consumes existing shared-host services: no new local/remote host, and no changes to snapshot, queue, owner, or reconnect-recovery semantics.

## Responsive and accessibility

- Desktop shows Scope and tabs in one top row; narrow screens may wrap, and tabs scroll horizontally.
- The Scope menu is clamped to the viewport on narrow screens; long workspace names truncate but keep a full accessible name.
- All triggers are keyboard-operable with visible focus; icon buttons must have localized accessible labels.
- Use semantic colors, `text-ui-*` sizes, and the existing Button, Tabs, and DropdownMenu primitives; support light, dark, and Zai themes.

## Acceptance

1. Settings shows exactly one plugin capability entry; no Plugin or old marketplace entry inside settings.
2. The plugin settings default to User + Plugins; the Workspace sidebar's “插件” entry opens the standalone marketplace main page.
3. The Scope menu lists User and all open workspaces, isolated by workspace identity.
4. Tab selection survives scope switches; lists show only the target scope's data; plugin-contributed MCP/Skills must resolve to plugin install records in the current scope.
5. The top search box follows the active tab's placeholder and filter rules; the three tabs' search terms are independent and keep filtering after a scope switch.
6. Works on desktop and mobile Web; no new runtime; the remote replayable boundary stays intact.
7. With the parent on User or any workspace, opening New shows the same scope; the create form offers the full scope list, switching does not change the parent selection, and saving writes to the form's chosen target. The edit form shows the MCP's actual attribution and cannot migrate it.

## Independent settings pages

- The settings sidebar registers seven formal sections under Agent capabilities — `memory`, `subagents`, `plugin`, `mcp`, `skill`, `commands`, `hooks` — per `settingsPageConfig.ts`; `plugin`, `mcp`, and `skill` share one capability-management shell. The Plugin page keeps its Plugins, MCPs, Skills tabs; the MCP and Skills sections lead directly to the same MCP/Skill lists without duplicating list, scope, search, or CRUD implementations.
- Entries sharing the shell share the scope state model: User/Workspace filtering, plugin-resource attribution, and remote workspace identity passing must stay consistent. The standalone MCP/Skill pages hide the switchable capability tabs but keep a vertical divider and a read-only `MCPs N` / `Skills N` count next to the scope, with search and the list on the right; counts track the current scope and search results.
- The old `customize` is gone: the value is treated as an invalid settings section, cleaned up with fallback. Legacy `plugins` migrates to `plugin` and legacy `skills` to `skill`; `mcp` is directly a formal entry.
- `McpSettingsSection` and `SkillsSection` keep only the Plugin-embedded mode; the standalone-page-only title descriptions, internal search, old grouped lists, scope labels, and header action layouts are removed.
- MCP/Skills loading, editing, importing, creating, toggling, deleting, auth, diagnostics, and remote sync are unchanged; they still execute against the actual `workspacePath` and isolate by `workspaceIdentity?.trim() || workspacePath`.
- This convergence changes only settings navigation and presentation component contracts — not MCP/Skills services, protocol, or persistence formats, and not the desktop continuous or mobile replayable links.
- The marketplace Installed area's manage button goes directly to the settings “插件” Plugins tab; the marketplace keeps no separate “manage installed” sub-page, avoiding two installed lists, filters, and detail entries.

# Commands capability integration

- Plugin management exposes three capability tabs: Plugins, MCPs, and Skills. Commands is not a Plugin-page tab.
- Commands remains an independent Settings entry and continues to reuse the shared scoped capability shell. Plugin-provided commands remain visible there in plugin groups.
- The parent User/Workspace scope controls both visible commands and the default destination for newly created commands. User scope includes direct user commands and commands from user-scoped plugins; Workspace scope includes direct project commands and commands from workspace-scoped plugins.
- New/Edit Command reuses the same `PluginScopeMenu` as the parent capability header. New inherits the parent scope and may select another available scope; Edit shows the command's persisted scope and disables scope migration. The form menu aligns to the end.
- Commands use the same header, search, loading, empty-search, empty-install, grouped-list, background, separator, icon, and action sizing conventions as Skills.
- Direct commands appear under Installed. Plugin commands are grouped by their canonical plugin display name and use the corresponding plugin icon when available.

## 2026-09-16 plugin localization and add entry

The Plugins management list and enable/disable feedback link store listings by full pluginId; names and descriptions use the same localization resolution as the store, falling back to the original text when a translation is missing. Same-name plugins from different marketplaces share no metadata. Plugins search matches the current-language name/description plus the original name, ID, and marketplace, case-insensitively; pinyin full and initial matching for Chinese names shared with the store (for example feishu, fs) also works in the English UI — see [search conventions](plugin-creator.md#plugin-search).

The User view's old New button becomes an “添加” (Add) menu offering “创建插件” (create plugin) and “添加插件市场” (add plugin marketplace); create only prefills the official plugin-creator skill reference, and add-marketplace uses the store's unified dialog. The Workspace config view keeps no marketplace entry. Contract and acceptance: [plugin creation entry](plugin-creator.md).
