# Automations Main Window Drag Region

## Background

When the Workspace main view switches to `automations`, it does not render `WorkspaceHeader`. Regular chat and draft pages rely on the `[app-region:drag]` area at the top of the header to drag the desktop window. Without it, desktop users cannot click and drag the top of the scheduled-tasks view to move the app window.

## Specification

- On desktop, keep an `h-12` `[app-region:drag]` strip at the top of the scheduled-tasks main view, aligned with the title-bar drag height of other main views.
- Keep the scheduled-tasks content area independently scrollable; do not place list cards, menu buttons, or the create button inside the drag region.
- Web and mobile remote control do not need desktop-window dragging; do not add extra title-bar height.
- If the scheduled-tasks main view later restores the shared `WorkspaceHeader`, remove the separate drag placeholder to avoid two title bars.

## Editor Breadcrumbs

The 48px desktop drag region in the Workspace Automations main view also carries the secondary-page breadcrumb. The list page has only the top-level “Automations” page and hides the breadcrumb according to the global rule. Create and edit pages show “Automations > New task/Task name.” The top-level button must call the editor view's existing dirty-state back-navigation logic; it must not bypass the unsaved-changes confirmation. Mobile Web does not render the desktop drag strip.
