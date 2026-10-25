# Workspace Sidebar Footer

## Goal

Unify the account-area interactions at the bottom of the Workspace and Settings sidebars so both entry points behave the same.

## Current Behavior

- Signed out: the avatar area and its label show `Login`; clicking opens the login dialog directly.
- Signed in: the avatar area shows the current username and is no longer a login entry point.
- After the host `update-ready` event, an `Update` button appears to the left of the Settings button.
- The Settings button opens a unified dropdown with language, theme, and sign-in/sign-out actions.
- The Settings sidebar reuses the same footer component, but its menu does not repeat the "Settings" entry.
- Coding Plan `Usage Remaining` is not shown in the footer avatar menu:
  - The menu keeps only account, preferences, upgrade/renewal, and sign-in/sign-out entries.
  - The upgrade/renewal entry is always shown; if the context cannot resolve a provider, it defaults to Z.ai Coding Plan.
  - Remaining-quota details live on the Usage page and in the chat input context popover.
  - The plan badge appears only next to the username at the top of the expanded account menu. The footer trigger shows only avatar and username. The badge does not open the remaining-quota panel.

## Displaying and Copying the User ID

- Clicking the avatar or username opens the menu. When signed in, the top shows account information: avatar on the left; username followed by the plan badge on the first line; `ID: {id}` followed by a separate copy-icon button on the second line. A divider follows, then the existing language, theme, and other items. There is no separate Copy ID menu item at the bottom.
- The plan comes from the footer's existing entitlement state and badge; hide it when no valid plan is available and add no requests or state. In the menu the badge has a light border, transparent background and regular font weight. The two account lines have no extra spacing between them; use 6px vertical padding.
- The ID uses `text-ui-sm` and secondary text color, shown as `ID: {id}` in both Chinese and English, without a tag background. Clicking the ID text does not copy; only the adjacent icon button copies. The button supports mouse, touch and keyboard activation, with the hover tooltip "Click to copy user ID." It is transparent by default and shows a background only on hover or visible keyboard focus, keeping its existing hit area. Long usernames and IDs truncate to one line, but the complete ID is always copied.
- Avatar, username and ID come from the footer's existing `user`; no extra account data is requested and the ID is not persisted. When signed out, the whole account header and its divider are hidden. If the ID is empty, only the ID row is hidden.
- Copy uses the browser Clipboard API, as other UI copy actions do: click the copy button, write to the clipboard, show "User ID copied" on success. If the API is unavailable or writing fails, show "Copy failed; try again"; never report success incorrectly.
- Behavior is identical in Chinese and English, desktop and mobile Web, Zai Light and Zai Dark.
- Acceptance: only the icon button copies; clicking the ID does not copy; the plan badge stays on the username row; the complete ID is copied; a long ID is truncated visually but copied in full; keyboard activation works; the account header is hidden when signed out or when the ID is empty as specified; clipboard denial and unavailability report failure.
- Browser candidate case: `packages/ui/test/browser/manual-review/pending/sidebar-user-id.test.mjs` (real footer component, with account and platform data supplied by fixtures; not equivalent to host acceptance in Electron).

## Implementation Locations

- Account-area component: `packages/ui/src/WorkspaceSidebarFooter.tsx`
- Settings sidebar mounting: `packages/ui/src/SettingsPage.tsx`
- Login-dialog entry wiring: `packages/ui/src/Root.tsx`
- Usage display: `packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`
