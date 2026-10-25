# Retain Installed Plugins When Deleting a Marketplace Source

- Status: Accepted
- Date: 2026-07-15

## Context

A Personal Source is both a "discoverable catalog" and a "future update source". Installed plugins are already copied to the user-level plugin store and may carry configuration, enabled/disabled state, and data. Cascading a source deletion into uninstall would turn a catalog operation into destructive data deletion; hiding the plugins would leave valid on-disk installations without a management entry point.

## Decision

Deleting a Personal Source removes only the marketplace record and catalog projection. It does not delete installations, configuration, enabled/disabled state, caches, or plugin data. Remaining installations enter an `Orphaned Installed Plugin` state:

```text
source present + installed
           |
           | remove source
           v
orphaned installed -------------------+
   | use/configure/enable/disable       |
   | uninstall                          | re-add same source
   | update unavailable                 |
   +------------------------------------+
                       source-associated installed
```

Orphaned plugins still appear in the Installed Strip, details view, and Manage Installed View. The UI shows the missing source honestly, and updates do not run until the source is re-added. Re-adding the same marketplace id/source re-associates the installation and restores the listing and update capability; it must not override user configuration or enabled state.

## Consequences

- Source deletion is a reversible catalog operation with no implicit data loss.
- Installation state and source state are modeled independently; the UI must not infer "not installed" from "not present in the catalog".
- Update detection requires the source; in the orphaned state only the installed version is available.
- Users can explicitly uninstall orphaned plugins from the management page, cleaning up data by the standard uninstall rules.
- Lifecycle E2E tests cover source deletion, orphaned state, continued use, re-association, and explicit uninstall.
