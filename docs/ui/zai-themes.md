# Zai Themes

## Goal

Add the `zai-light` and `zai-dark` brand themes and make them the user-visible Light Theme / Dark Theme. The default `light` / `dark` CSS variables remain as an underlying fallback, but the theme menu no longer exposes the native light / dark entries.

## Implementation

- The `Theme` enum keeps `light` / `dark` as legacy preference values; persistence and application normalize them to `zai-light` / `zai-dark`.
- `resolveTheme()` puts `zai-light` in the light branch and `zai-dark` in the dark branch, so title bar, code preview and mobile remote control keep their light/dark boundary.
- `system` applies `zai-light` or `zai-dark` by the system light/dark preference, never falling back to the default CSS theme.
- In `styles.css`, `.theme-zai-light` / `.theme-zai-dark` map Zai semantic tokens onto the existing `--color-*` semantic variables; components do not depend on primitive color scales.
- Desktop, Web first-paint bootstrap, the process monitor page and the mobile remote control theme menu all use the Zai theme entries, avoiding a first-frame fallback or an unselectable entry.

## Token Mapping

- `bg/page` -> `--color-background`
- `bg/bg` -> `--color-card`, `--color-popover`, `--color-input`, `--color-input-focused`
- `bg/surface` -> `--color-panel`
- `bg/overlay` -> `--color-background-win-alt`, with `--color-background-alt` derived at 60% opacity
- `text/primary` -> `--color-foreground`
- `text/secondary` -> `--color-foreground-subtle`
- `text/tertiary` -> `--color-foreground-subtlest`
- `border/default` -> `--color-border`
- `interactive/bg/primary/default` -> `--color-brand`, `--color-primary`
- `border/strong` -> `--color-input-border-focused`
- `accent/blue/default` -> blue accent helper variables

The Zai dark app-root foreground is `#ffffff`, following the current shell reference class, instead of the near-white `#f8f8f8` in the exported tokens.
