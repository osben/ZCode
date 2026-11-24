# Settings Search Input

The search boxes of Skills, Hooks, Commands, MCP, Subagents and the plugin market in Settings reuse
`SettingsSearchInput`:

- `Input size="lg"`, height `h-9`, radius `rounded-xl`
- Left search icon `size-4`, input left padding `pl-9`
- Colors, border, Hover and Focus states inherit the standard `Input`

Pages may control only width and layout through the container class and must not override the geometry
above. The status filter on the right of the Skills and Subagents search box uses the same `h-9
rounded-xl`, keeping same-row controls visually consistent.

## Global settings search entry

"Search settings" in the sidebar is a button that opens the search dialog. It is not the in-page search input
above. Its height and radius match the "Back to workspace" button: `Button size="lg"`, `rounded-xl`, 32px high when
expanded. In the narrow icon mode both use `max-lg:size-10` (40px). When expanded, both use `px-1.5` (6px)
horizontal padding, a `size-4` icon and a `gap-2` icon-text gap, so the icon and the label start at the same
position. The existing border, colors and open-dialog behavior are kept.
