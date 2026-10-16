# Retain Installed Plugins When Deleting a Marketplace Source

- Status: Accepted
- Date: 2026-07-15

## Context

A Personal Source serves both as a "discoverable catalog" and as a "future update source", but installed plugins have already been copied to the user-level plugin store and may carry configurations, enabled/disabled states, and data. Deleting a source that implicitly cascades into uninstall would turn an operation that seems to manage only a catalog into destructive data deletion; hiding plugins entirely would leave valid on-disk installations without a management entry point.

## Decision

Deleting a Personal Source removes only the marketplace record and catalog projection; it does not delete installations, configurations, enabled/disabled states, caches, or plugin data. Installations that remain enter an `Orphaned Installed Plugin` state:

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

Orphaned plugins continue to appear in the Installed Strip, details view, and Manage Installed View. The UI must honestly display the missing source, and updates must not execute until the source is re-added. Re-adding the same marketplace id/source re-associates the current installation, restoring the listing and update capability; it must not automatically override user configurations or enabled states.

## Consequences

- Source deletion becomes a reversible catalog management operation, causing no implicit data loss.
- Installation state and source state must be modeled independently; the UI must not infer "not installed" from "not present in the catalog."
- Update detection requires the source to exist; in the orphaned state, only the currently installed version is available.
- Users can still explicitly uninstall orphaned plugins from the management page, cleaning up data according to standard uninstall rules.
- Lifecycle E2E tests must cover source deletion, orphaned state, continued use, re-association, and explicit uninstall paths.
