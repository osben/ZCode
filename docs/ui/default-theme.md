# Default Theme

## Current policy

- On first app launch with no persisted local `zcode-theme` value, the default theme is `dark`.
- Once the user switches the theme explicitly, the locally saved value is read first afterwards and is not overwritten by the default.

## Implementation

- Zustand store default: `packages/ui/src/store/index.ts`
- Fallback of the old `useTheme()` hook: `packages/ui/src/useTheme.ts`
