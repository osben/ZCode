# Store Listing Metadata Lives in the Marketplace Catalog, with plugin.json as Fallback

Plugin store display metadata (icons, hero images, example prompts, privacy/terms links) lives in the **marketplace catalog** (marketplace.json entries), not in the plugin package's plugin.json. The official CDN can change store presentation (including featured listings) by editing catalog JSON alone, without repackaging a zip. The built-in plugin catalog is generated from `official-plugin-definitions.ts` in the repo, and its listing fields are added there.

At display time, catalog listing fields take precedence. Missing fields fall back to the existing author/homepage values in plugin.json, so independently sourced plugins without a listing still get developer/site information.

## Considered Options

- **Inline in manifest** (listing in plugin.json): changing an author name or swapping an image requires republishing the zip and updating the sha256; independently sourced plugins would still lack icons. Rejected.
- **Separate listing service / API**: adds a network dependency and failure mode; the catalog JSON already describes plugins entry by entry. Rejected.

## Consequences

- The CDN's marketplace.json and the built-in seed generation logic are the source of truth for store presentation. Wire types (`AvailablePluginSummary`, etc.) propagate listing fields and manifest fallback fields through to the UI.
- The same information may exist in two places with conflicting values (catalog says author A, manifest says author B); the UI always trusts the catalog.
