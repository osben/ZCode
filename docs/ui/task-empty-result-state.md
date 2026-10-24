# Task Empty Result State

## Background

When a task has been created but has no visible message, the old UI fell back to a nearly blank chat area.
The mode pill in the input area (e.g. `Plan`) was still visible, which users misread as "the plan panel has
state but its content failed to render".

## Spec

- A new draft still shows the original welcome empty state.
- A historical task in the `creating` / `restoring` / `submitting` phase still shows loading.
- For a bound task with empty messages, no visible error and not in a restore phase, the chat area shows a
  lightweight empty-result hint.
- The hint only says this turn produced no displayable content; it does not explain the mode pill as plan
  content.
- Copy goes through i18n; styles use design-system semantic tokens, compatible with desktop, Web, narrow
  mobile screens, and light and dark themes.
