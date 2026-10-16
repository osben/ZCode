# Chat Empty-State Time-based Greeting

In the draft state for a new conversation, the empty-state heading no longer shows the workspace or project name. Instead, it displays a greeting based on the user's local time. This copy reduces the chance that users think a task has already been created and avoids tying the entry point to a particular project.

## Behavior

- Select the copy using the current local hour in the user's device browser/Renderer; do not use the server, workspace, or remote host timezone.
- Time ranges:
  - `05:00-08:59`: Early morning
  - `09:00-11:59`: Morning
  - `12:00-13:59`: Noon
  - `14:00-17:59`: Afternoon
  - `18:00-22:59`: Evening
  - `23:00-04:59`: Late night
- Copy must come from the i18n locale in `packages/ui`; do not hard-code user-visible strings in the component.
- Do not insert workspace/project names in the heading, which could cause confusion with the current workspace, remote `workspaceIdentity`, or mobile remote-control context.
- The noon greeting should suggest taking a break instead of emphasizing continuing work.
- The afternoon greeting should have a relaxed tone suggesting that the assistant can take it from here; avoid internet slang such as “slacking off” that could undermine professionalism in a work context.
- The late-night greeting should briefly remind users to take care of themselves without assuming they are already tired.

## English Copy

Preserve the intent for each time of day and use natural local phrasing rather than translating Chinese particles word for word.

| Time period | Copy |
| --- | --- |
| Early morning | Morning, ready when you are |
| Morning | Morning, how can I help? |
| Noon | Noon break? |
| Afternoon | Good afternoon! Leave the rest to me. |
| Evening | Evening, nice work today |
| Late night | It's late—remember to take care of yourself. |

## Visuals

- Use the UI's default sans-serif font for the heading; do not use `font-serif`.
- Keep the existing larger heading hierarchy on desktop and the compact hierarchy in the mobile remote-control draft state.
- The copy must accommodate length differences between Chinese and English; do not rely on project-name concatenation or a fixed width.
- For the empty-state logo, continue using the inline outline graphic in light theme and `packages/ui/src/assets/Z.svg` in dark theme. Render them mutually exclusively through theme classes so they do not both occupy space or appear to screen readers. Keep the bottom fade mask and `opacity-70` on the light outline. The dark asset includes its own gradient and opacity; do not apply another shared mask or opacity.
