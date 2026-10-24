# Settings Hook list

Hooks keep their own Settings entry and are not merged into the plugins page. The page reuses the Scope, search, group titles, list container, and empty-state information architecture of Plugins, MCPs, Skills, and Commands.

## Scope and sources

- Header is `<Scope> | Hooks {count}` with a search box on the right.
- Scope uses the shared `PluginScopeMenu`: User shows user config plus user-plugin hooks; Workspace shows the current workspace config, compatible sources, and hooks from plugins installed in that workspace.
- `workspaceIdentity?.trim() || workspacePath` isolates workspace state; `workspacePath` is used only for read/write paths.
- The read/write target is decided solely by the selected Scope entry (`resolveHookScopeTarget`): selecting a local project means empty identity and the local service, never borrowing the active chat workspace's remote identity; with no project selected, User keeps the current workspace routing.
- Workspace hooks are manageable but, per the security contract in `docs/hooks-runtime-contract.md`, never enter the Agent runtime.
- The create form inherits the parent Scope; the edit form shows the persisted Scope and it cannot be migrated. Scope sits in the top-right of the form card using the horizontal `Scope + PluginScopeMenu` layout, right-aligned, consistent with MCP and Command forms.

## Grouping

`New` sits at the right of the `Installed` group title; the title row reuses the Commands `flex flex-wrap items-center justify-between gap-3` layout with no fixed height. After a search, only groups with visible rows are shown — no empty `Installed 0` headers. With no search and an empty Installed, the group stays as the create entry.

1. `Installed`: hooks managed directly by ZCode in the current Scope.
2. One group per plugin: the title is the plugin's normalized name; rows are read-only and enable/disable stays in plugin settings.
3. `Legacy`: `.agents` / `.claude` compatible sources, with an Import action.

`Installed` and `Legacy` are UI group names and must be localized via `settings.hooks.group.*`; plugin group titles come from the plugin name and are not translated. Hook Event is a configuration protocol identifier and keeps its raw value.

When a plugin's Scope metadata is unknown, the hook stays visible in both User and Workspace with the "作用域未知" (unknown scope) label — never fabricate a source or silently drop it.

## Hook item

- The main title is the Hook Event (for example `PreToolUse`), not the matcher.
- The second line shows the command or script summary, single-line truncated, using `font-mono text-ui-sm text-foreground-subtle`.
- Direct config and Legacy use the default `Anchor` icon from the settings menu; plugin hooks use the plugin icon, falling back to `Anchor` when unavailable.
- Direct config shows a toggle on the right and opens the editor on row click; Legacy shows Import; plugin hooks are read-only with no toggle.
- Scope and plugin name are not repeated inside the row; matcher and runner details stay in the edit or read-only detail semantics.
- The list uses `rounded-xl bg-surface`; row separators are standalone `h-px bg-border/50` elements.
- Empty, loading, and no-search-result states use a transparent dashed container.

After a hook changes, unused deferred draft sessions still close; running or historical sessions keep the snapshot captured at their start.
