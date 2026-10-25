# Settings Search Input

The search boxes of Skills, Hooks, Commands, MCP, Subagents and the plugin market in Settings reuse
`SettingsSearchInput`:

- `Input size="lg"`, height `h-9`, radius `rounded-xl`
- Left search icon `size-4`, input left padding `pl-9`
- Colors, border, Hover and Focus states inherit the standard `Input`

Pages may control only width and layout through the container class and must not override the geometry
above. The status filter on the right of the Skills and Subagents search box uses the same `h-9
rounded-xl`, keeping same-row controls visually consistent.
