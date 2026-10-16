# Workspace Sidebar Footer

## Goal

Unify account-area interactions at the bottom of the Workspace and Settings sidebars so the two entry points behave consistently.

## Current Behavior

- When signed out, show `Login` for both the avatar area and its label; clicking it opens the login dialog directly.
- When signed in, show the current username in the avatar area; the avatar area is no longer a login entry point.
- After receiving the host `update-ready` event, show an `Update` button to the left of the Settings button.
- The Settings button opens a unified dropdown containing language, theme, and sign-in/sign-out actions.
- Reuse the same footer component at the bottom of the Settings sidebar, but do not duplicate the “Settings” entry in its menu.
- Do not show Coding Plan `Usage Remaining` in the footer avatar menu:
  - Keep only account, preferences, upgrade/renewal, and sign-in/sign-out entry points in the footer avatar menu.
  - Always show the upgrade/renewal entry. If the current context cannot resolve a provider, default to Z.ai Coding Plan.
  - Keep remaining-quota details on the Usage page and in the chat input context popover to avoid duplicating the same entry in the avatar menu.
  - Show the plan badge only next to the username at the top of the expanded account menu. The sidebar-footer trigger shows only the avatar and username. The badge itself does not open the remaining-quota panel.

## Displaying and Copying the User ID

- Clicking the avatar or username at the bottom of the sidebar opens the menu. When signed in, show account information at the top: avatar on the left; username followed by the plan badge on the first line; `ID: {id}` followed by a separate copy-icon button on the second line. Follow this with a divider, then the existing language, theme, and other menu items. Remove the separate Copy ID menu item from the bottom. Reuse the footer's existing entitlement state and badge for the plan; hide it when no valid plan is available, and add no requests or state. In the menu, style the plan badge with a light border, transparent background, and regular font weight. Do not add extra spacing between the two account lines; use 6px of vertical padding.
- Use `text-ui-sm` and secondary text color for the ID. Show `ID: {id}` in both Chinese and English, without a tag background. Clicking the ID text does not copy it; only the adjacent icon button copies. Support mouse, touch, and keyboard activation, with the hover tooltip “Click to copy user ID.” The button is transparent by default and shows a background only on hover or visible keyboard focus, preserving its existing hit area. Truncate long usernames and IDs to one line, but always copy the complete ID.
- Reuse the footer's `user` for avatar, username, and ID; do not request extra account data or persist the ID. When signed out, hide the entire account header and its divider. If the ID is empty, hide only the ID row.
- Reuse the browser Clipboard API, consistent with existing UI copy actions: click the copy button → write to the clipboard → show “User ID copied” on success. If the API is unavailable or writing fails, show “Copy failed; try again”; never report success incorrectly.
- Keep behavior consistent in Chinese and English, desktop and mobile Web, Zai Light and Zai Dark.
- Acceptance: only the icon button copies; clicking the ID does not copy; plan badge stays on the username row; the complete ID is copied; a long ID is truncated visually but copied in full; keyboard activation works; account header is hidden when signed out or ID is empty as specified; clipboard denial and unavailability report failure.
- Browser candidate case: `packages/ui/test/browser/manual-review/pending/sidebar-user-id.test.mjs` (real footer component, with account and platform data supplied by fixtures; not equivalent to host acceptance in Electron).

## Implementation Locations

- Account-area component: `packages/ui/src/WorkspaceSidebarFooter.tsx`
- Settings sidebar mounting: `packages/ui/src/SettingsPage.tsx`
- Login-dialog entry wiring: `packages/ui/src/Root.tsx`
- Usage display: `packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`
