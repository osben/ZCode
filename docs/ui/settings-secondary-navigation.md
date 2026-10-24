# Settings Secondary Page Back Navigation

## Contract

- Secondary pages of Settings use `SettingsBackButton` uniformly: fixed `size="lg"` (32px high) with a 16px
  `ArrowLeft` on the left.
- The component fixes `variant="ghost"`; business pages must not override `size`, `variant` or add
  back-button-specific color, spacing and hover styles.
- Covers the Memory, plugin, command, hook, subagent and MCP secondary pages.
- Copy comes from each business module's i18n resources: Chinese is "返回" (Back), English `Back`; the
  component does not concatenate business names such as project, memory or command.
- The top-level "Back to workspace", list pagination and in-form step navigation are not secondary-page
  back navigation. Automations, idle-time tasks, the "previous step" of the model purchase flow and the
  "back" of the model upgrade plan are out of scope and keep their own implementations.
