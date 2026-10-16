# Store Listing Metadata Lives in the Marketplace Catalog Layer, with Catalog Listing Taking Precedence and plugin.json as Fallback

Plugin store redesign requires display metadata such as icons, hero images, example prompts, and privacy/terms links. We decided to place these fields in the **marketplace catalog** (marketplace.json entries) rather than in the plugin package's plugin.json: the official CDN can adjust store presentation (including featured listings) by modifying catalog JSON alone, without repackaging and publishing a new zip; the built-in plugin catalog is generated from `official-plugin-definitions.ts` in the repo, with fields likewise added within the repo. During display, catalog listing fields take precedence, and missing fields fall back to the existing author/homepage values in plugin.json — this ensures independently sourced plugins that have never written a listing still get developer/site information for free.

## Considered Options

- **Inline in manifest** (listing written into plugin.json): Changing an author name or swapping an image requires republishing the zip + updating the sha256, which imposes unacceptable operational cost; independently sourced plugins would still lack icons, so the problem remains unsolved.
- **Separate listing service / API**: Adds an extra network dependency and failure mode. The catalog JSON already describes plugins entry by entry, so there is no need for anything additional.

## Consequences

- The CDN's marketplace.json and the built-in seed generation logic become the source of truth for store presentation; wire types (AvailablePluginSummary, etc.) must propagate listing fields and manifest fallback fields all the way through to the UI.
- The same piece of information may exist in two places with conflicting values (catalog says author A, manifest says author B) — per this decision, the UI always trusts the catalog.
