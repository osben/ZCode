# ZCode Plugin Store

Domain vocabulary for the plugin settings page and its marketplace browsing and installation experience. The 2026-07 storefront redesign introduced terms that are easy to confuse; this file is the authoritative source for resolving terminology questions.

## Marketplace and Sources

**Official Marketplace**:
The only distribution channel operated by ZCode. Its ID is `zcode-plugins-official`, and its contents are built-in plugins plus CDN plugins. It is a "distribution channel," not an "author affiliation"; it can include plugins from community authors.
_Avoid_: Calling `claude-plugins-official` the Official Marketplace or using "official" to mean any trusted source.

**Builtin Plugin**:
A plugin distributed with the application and seeded into the Official Marketplace at startup. This is a subset of official plugins.
_Avoid_: "Preinstalled plugin"; "bundled plugin" is acceptable informally, but use "built-in" consistently in documentation.

**CDN Plugin**:
A plugin distributed in the Official Marketplace as a ZIP package from the official CDN, verified with SHA-256, and downloaded on demand.
_Avoid_: "Network plugin," "online plugin."

**Personal Source**:
Any plugin source added by the user: `claude-plugins-official`, Git/GitHub/URL/local directory marketplaces, or inline plugins.
_Avoid_: "Third-party marketplace" for `claude-plugins-official`; "third-party" is inaccurate for this source.

**Manual Refresh**:
A full-marketplace refresh triggered by the refresh button in the store page's top bar. It is not subject to the auto-refresh throttle.
_Avoid_: "Refresh" or "check for updates" in documentation; use "manual refresh."

## Store Page Structure

**Public Segment**:
One segment of the store listing page. It displays entries in the Official Marketplace maintained by the product team. The `publisherType` field is `official`; entries from older catalogs that do not provide it default to public.
_Avoid_: "Official tab," "store tab."

**Community Segment**:
Externally maintained plugins that the Official Marketplace includes. They are published from `external_plugins/` with `publisherType: community`, independent of the usage category.

**Personal Segment**:
The other segment of the store listing page. It displays catalogs from all personal sources, grouped by marketplace.
_Avoid_: "Third-party tab," "My tab."

**Featured**:
A curated section at the top of the public segment. Its contents are controlled remotely by the `featured` field in the official CDN catalog. It exists only in the public segment.
_Avoid_: Confusing it with Recommended.

**Recommended**:
A curated section at the top of the Personal Segment. Its list is maintained in the repository in `recommendedPlugins.json` and currently features selected plugins from `claude-plugins-official`. It exists only in the Personal Segment.
_Avoid_: Confusing it with Featured.

**Installed Strip**:
A row of icons for installed plugins at the top of the listing page. Clicking an icon opens its detail page.
_Avoid_: "Installed list" (that refers to the Manage Installed view).

**Manage Installed View**:
The "Plugin Management" entry at the top right of the store opens a management view within the same page. It keeps global defaults and project overrides, and returning to browsing preserves the search, source, and management scope. The more menu offers only pause/enable and uninstall; updates and restoring inherited state use separate actions.
_Avoid_: "Installed tab" (deprecated IA terminology).

**UI Plugin**:
A plugin whose manifest declares valid `ui.surfaces`; its catalog entry carries `componentTypes: ["ui", …]`. Before installation, catalog capabilities are used; after installation, the actual manifest is authoritative. Pausing does not change its category. Ownership, purpose, and UI capability are independent dimensions. The UI section and search are scoped to the current source segment.

**Default UI Recommendations**:
A curated list for the Side Pane, delivered by the client configuration endpoint's `uiPluginRecommendations`. It is linked to the full marketplace catalog and can recommend plugins that are neither installed nor enabled. Clicking one installs, enables, or opens the real panel. Development and user installs are not added automatically, and this list differs from the full UI section inside the marketplace.

## Metadata

**Store Listing**:
Presentation metadata carried by a catalog entry: display name, icon, category, developer, website/privacy policy/terms of service links, hero image, and example prompts. It describes how the plugin appears in the store and does not affect plugin functionality.
_Avoid_: "Plugin metadata" (ambiguous; it may refer to the manifest).

**Plugin Manifest**:
The functional definition in a plugin package's `plugin.json` (commands/agents/skills/hooks/mcpServers/userConfig…). It describes what the plugin is and does.
_Avoid_: `marketplace.json` (that is a catalog, not a manifest).

**Example Prompt**:
A clickable prompt supplied by a Store Listing. Clicking it starts a new session and pre-fills the prompt without sending it. It is the only "new session" entry point on the detail page; the "Try Now" button was removed on 2026-07-14.
_Avoid_: "Shortcut," "prompt template," "Try Now."

## Lifecycle States

**Plugin Lifecycle**:
The complete product path from discovering a plugin through viewing, installing, configuring, enabling or disabling, using, checking for updates, upgrading, and restoring persisted state, through uninstalling or restoring a built-in plugin. Every stage must verify both the visible UI state and its corresponding persisted or runtime result.
_Avoid_: Calling only "installation succeeded" the complete lifecycle.

**Restorable Builtin**:
A Builtin Plugin that the user has uninstalled and that is now in a persisted suppressed state. The app must not seed it again automatically after restart. It remains in the Public Segment and can be cleanly restored through the Install entry point.
_Avoid_: An uninstalled CDN plugin or a temporarily disabled built-in plugin.

**Orphaned Installed Plugin**:
A plugin whose Personal Source has been deleted while its installation directory and user data remain. It can still be used, configured, enabled or disabled, and uninstalled. It cannot be updated until its source is added again; re-adding the same source restores its catalog association.
_Avoid_: A broken installation, a missing manifest, or an uninstalled plugin.
