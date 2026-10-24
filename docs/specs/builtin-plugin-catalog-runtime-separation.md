# Catalog / Runtime separation after uninstalling a built-in plugin

Status: implementation complete (2026-08-21)
Applicable branch: `fix/builtin-plugin-detail-after-uninstall`
Review: Fable's read-only adversarial review passed; conclusion: "the direction holds, the landing point should be the Catalog/seed layer".

## 1. Feature Summary / Impact Brief

| Field            | Value                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | After the built-in Document Skills are uninstalled, the detail page still opens and shows the full component list; behavior matches non-built-in Marketplace plugins |
| Capability       | Plugin Marketplace detail, builtin uninstall/restore, official seed/cache                                                                                            |
| Change layer     | `option-source`, `commit-effect`, `persistence`, `validation`                                                                                                        |
| Operating mode   | `planning` -> implementation                                                                                                                                         |
| Primary seeds    | `bundled-plugins.ts`, `plugins.ts`, `marketplace.ts`, `official-marketplace.ts`, `pluginStoreListing.ts`, Plugin Store detail UI                                     |
| Out of scope     | New protocol/schema, per-component enable/disable, Web/mobile remote, workspace-scope install, conversation E2E                                                      |

### 1.1 Facts

1. A built-in plugin uninstall is expressed through `plugins.suppressedBuiltins`; Agent discovery, Desktop `skillsService`, `commandsService` and the session facade all filter runtime resources by it.
2. `writeOfficialMarketplace` used to filter suppressed built-in plugins out of the bundled marketplace partition.
3. The seed used to delete `cache/<official>/<name>/<version>` for a suppressed plugin and skip materialization.
4. `plugins/describe` for an uninstalled plugin depends on the Marketplace entry and the source root; a `filesystem/sea` entry was read only from `cachePath` or the computed cache directory.
5. The UI projected a suppressed built-in plugin again as `restorable=true`, but the detail page still called `plugins/describe` because `info` was missing, getting `plugin_not_found` or cache missing.
6. The official built-in partition and the CDN partition are already merged under the same `zcode-plugins-official` identity; ADR-0001 requires the listing to belong to the Catalog, not to install state.

### 1.2 Inference

- The root cause is conflating the Catalog (catalog identity, listing, read-only component detail) with the Runtime (whether discovered, enabled, user config, data).
- The built-in cache bytes come from the app bundle/SEA and are not a user-downloaded install artifact; deleting them does not remove real built-in code from the device, it only breaks offline describe and creates a seed<->uninstall mutual-deletion race.
- Keeping the read-only built-in cache while discovery keeps filtering suppression lets the non-built-in plugin describe UI contract be reused without adding a SEA-aware adapter.

### 1.3 Unknown / explicitly deferred

- There is a low-probability lost-update window between the current config read-modify-write and the plugin storage lock; this round does not expand into a cross-process lock rework, recorded as a follow-up task.
- The underlying projection of `ZCodeAvailablePluginSummary.installed` for an active built-in plugin may still be false; this round guarantees Marketplace behavior through a UI join, and the protocol field fix is handled separately.

## 2. Product Contract

### 2.1 User-visible contract

Before and after uninstall, a built-in plugin keeps the same product semantics as an ordinary Marketplace plugin:

| State                          | `installed` | `runtimeLoaded`   | Catalog/detail                                    | Primary action               |
| ------------------------------ | ----------- | ----------------- | ------------------------------------------------- | ---------------------------- |
| Installed                      | true        | true (if enabled) | Full components and metadata viewable             | Manage / Uninstall           |
| Uninstalled built-in           | false       | false             | Catalog, listing, component detail still readable | Install (internally restore) |
| Ordinary uninstalled candidate | false       | false             | describe from Marketplace source                  | Install                      |
| After restore                  | true        | per enabled       | Same as before install                            | Manage / Uninstall           |

Reading detail after uninstall must be read-only: it must not clear suppression, enable the plugin, create an installed record, or trigger a model session or MCP runtime.

### 2.2 State and ownership

| State/fact                             | Authoritative owner                                     | Mirror/cache                                   | Read/write boundary                                                            |
| -------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Official Catalog entry/listing         | Merge layer of the bundled + CDN marketplace partitions | `marketplace.json`                             | Read-only detail/list; refresh updates only the CDN partition                  |
| Built-in source materialized directory | seed boundary (filesystem/SEA -> official cache)        | `cache/<official>/<name>/<version>`            | Does not mean installed; readable by describe                                  |
| Built-in uninstalled state             | user config `plugins.suppressedBuiltins`                | overview `restorableBuiltins`, UI `restorable` | Sole Runtime suppression source of truth                                       |
| enabled/options                        | user plugin config                                      | Agent/UI overview                              | Cleaned on uninstall; does not affect the Catalog                              |
| plugin data                            | `data/<plugin-id>`                                      | none                                           | Deleted on uninstall                                                           |
| Ordinary Marketplace install record    | `installed_plugins.json`                                | UI installed summary                           | Belongs only to cache/Marketplace installs; built-in restore does not write it |

## 3. Architecture Boundary

```text
                 ┌──────────────────────────────────────────────┐
                 │ Immutable bundled source                     │
                 │ packages/*-plugin (dev) / SEA assets (prod)  │
                 └──────────────────────┬───────────────────────┘
                                        │ seed boundary
                                        │ filesystem/SEA -> files+sha -> cache
                                        ▼
      ┌──────────────────────────── Catalog layer ────────────────────────────┐
      │ bundled-marketplace.json (all builtin entries)                         │
      │ cdn-marketplace.json       ── merge by official marketplace identity   │
      │ cache/<official>/<name>/<version> (immutable materialized source)      │
      └───────────────┬───────────────────────────────────┬───────────────────┘
                      │ read-only                         │ read + filter
                      ▼                                   ▼
              plugins/describe                       Runtime discovery
              overview/listing                 adapters / skills / commands / MCP
                      │                                   │
                      │                         suppressed id is excluded
                      │                                   │
                      ▼                                   ▼
              Detail UI                         Effective runtime capabilities

  uninstall builtin = add suppressedBuiltins + clear enabled/options + rm data
                      (never remove Catalog entry or immutable source cache)
  restore builtin   = remove suppressedBuiltins + reseed if cache is missing
  Install UI         = restorable ? restoreBuiltin : marketplace install
```

### 3.1 Seed boundary

- `resolveSeedSource` remains the only place that understands filesystem vs SEA.
- `seedBundledOfficialPlugins` always writes all official plugin entries and materializes missing or outdated cache roots with existing temp-directory + marker + atomic replacement safeguards.
- `writeOfficialMarketplace` writes all bundled entries. Suppression is not compiled into the Catalog.
- `resolveOfficialPluginRoots` may keep accepting suppression only as a compatibility parameter if removing it would create unnecessary churn, but suppression must remain enforced by discovery and direct readers; it must not delete the Catalog/cache.

### 3.2 Runtime boundary

- `discoverNodePluginsSync` continues filtering official candidates by suppressed ID before producing `PluginLoadOutcome`.
- `skillsService` and `commandsService` direct cache scans continue applying the same suppression check.
- `plugin-facade`, browser runtime feature gates and startup marks continue to use the filtered outcome.
- No new reader may treat cache presence as proof of installation or enablement.

### 3.3 Marketplace describe/install boundary

- `plugins/describe` for a suppressed built-in plugin reads the preserved merged Catalog entry and materialized cache; it does not call restore or mutate config.
- `plugins/restoreBuiltin` remains the canonical built-in recovery operation.
- Any direct CLI/protocol install path that resolves an official `filesystem`/`sea` entry must route to built-in restore instead of writing a marketplace-owned installed record. CDN same-name entries with a real CDN source remain normal Marketplace installs.

## 4. UI Surface Matrix

| User scenario                    | UI entry                                 | Shared implementation                  | Display/draft owner                        | Validation/gating                                              | Commit action                | Authority/persistence                              | Mode boundary                                                                | Must remain isolated from                  |
| -------------------------------- | ---------------------------------------- | -------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- | ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| Browse public plugin             | `PluginStorePage` list/card              | `buildStoreItems`, `PluginStoreCard`   | Plugin management store projection         | Catalog entry exists; `restorable` controls the primary action | `onOpenDetail` / `onInstall` | Agent `plugins/overview`, Catalog partitions       | Desktop local and the existing Web service abstraction; no new remote branch | Runtime enablement                         |
| View uninstalled built-in detail | `PluginStoreDetailView`                  | same detail + `plugins/describe` cache | `describeCache` keyed by stable plugin ID  | Catalog/cache readable; no runtime `info` required             | read-only `plugins/describe` | Agent Catalog + immutable cache                    | No session/clientMode change                                                 | `suppressedBuiltins`, enable/options, data |
| Uninstall built-in               | detail/card/manage menu + confirm dialog | `usePluginUninstall`, management store | operation state in plugin management store | explicit confirmation; built-in is uninstallable               | `plugins/uninstall`          | user config + data cleanup; Catalog untouched      | Desktop local lifecycle only                                                 | Marketplace source removal semantics       |
| Restore built-in                 | Install button on a restorable item      | `handleInstall`, `restoreBuiltin`      | operation state + refreshed overview       | `item.restorable === true`                                     | `plugins/restoreBuiltin`     | suppression removed; seed self-heals missing cache | Desktop local lifecycle only                                                 | ordinary installed record                  |
| View installed detail            | detail/manage                            | `ZCodePluginInfo` runtime projection   | `item.info`                                | runtime info available                                         | no mutation for read         | discovery outcome                                  | unchanged                                                                    | catalog-only detail fallback               |

## 5. Shared And Divergent Behavior

| Concern        | Shared across surfaces                                   | Deliberately different                                                                                                          | Why it matters                                                                        |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Catalog/detail | All Marketplace entries use listing + `plugins/describe` | Built-in source is local immutable cache; Git/URL source may clone/download                                                     | The user-visible detail contract stays identical without making the adapter SEA-aware |
| Runtime        | All effective capabilities come from filtered discovery  | Built-in suppression uses config; ordinary plugin absence uses installed record/source state                                    | Cache presence must never imply runtime presence                                      |
| Install        | UI always shows Install for `installed=false`            | Built-in Install routes to restore; an ordinary candidate routes to install                                                     | Prevents a built-in plugin being rewritten as marketplace-owned                       |
| Uninstall      | UI confirmation and cleanup semantics                    | Built-in clears suppression/config/data but preserves source Catalog/cache; an ordinary plugin removes its install cache/record | Aligns product behavior while respecting the immutable App-bundled source             |
| Failure        | Describe failure is visible and retryable                | Missing cache is a seed/storage fault, not a normal "uninstalled" state                                                         | Avoids deterministic Retry loops after a valid uninstall                              |

## 6. Impact Relationships

| Rank           | From                     | Semantic edge    | To                  | Condition                         | Why inspect it                                    | Evidence                                           |
| -------------- | ------------------------ | ---------------- | ------------------- | --------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| must-inspect   | official seed            | materializes     | Catalog/cache       | filesystem or SEA source          | Fixing suppression must not break packaged assets | `bundled-plugins.ts`, `official-marketplace.ts`    |
| must-inspect   | Catalog/cache            | read-by          | `plugins/describe`  | detail has no runtime info        | Direct root cause of the screenshot               | `marketplace.ts:941-1025`                          |
| must-inspect   | suppression              | filters          | Runtime discovery   | official stable ID                | Preserve the no-runtime invariant                 | adapters `index.ts`, services scanners             |
| must-inspect   | UI restorable projection | routes-to        | restoreBuiltin      | duplicate available/restorable ID | Prevent wrong installed-record ownership          | `pluginStoreListing.ts`, `PluginStorePage.tsx`     |
| must-inspect   | uninstall                | persists-to      | user config + data  | built-in confirm path             | Separate Catalog from user state                  | `plugins.ts`, config adapter                       |
| should-inspect | Catalog merge            | overrides        | CDN same-name entry | official CDN source present       | Preserve official identity/ownership              | `official-marketplace.ts`, ADR-0001                |
| invariant-only | plugin management        | executes-through | Agent Host          | local or remote workspace         | No new process/remote runtime                     | lifecycle catalog scope                            |
| evidence-only  | lifecycle contract       | covered-by       | PLM cases/matrix    | manual-review fixtures            | Regression proof                                  | `docs/plugin-management-lifecycle-case-catalog.md` |

## 7. Must-Preserve Invariants

| Invariant                                                             | Surfaces/modes                                           | Proof needed                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ | --- | ------------------------------- |
| A suppressed built-in plugin never contributes Skill/Command/MCP/Hook | Agent discovery, Desktop direct scanners, session facade | cache exists + suppressed; runtime lists omit the plugin                 |
| The Catalog remains readable after uninstall                          | Public list, card, detail                                | describe returns components/metadata; no config diff                     |
| Describe is read-only                                                 | detail/retry                                             | suppression/config/data/cache unchanged before/after                     |
| Built-in restore does not create an ordinary installed record         | Install button and direct protocol install               | `installed_plugins.json` unchanged; suppression removed; runtime returns |
| CDN same-name ownership remains source-based                          | official merged Catalog                                  | CDN source uses Marketplace install; bundled source uses restore         |
| Seed and uninstall do not oscillate the cache                         | startup/list/overview + uninstall                        | no delete/recreate loop; cache marker remains valid                      |
| Desktop continuous and web-remote-replayable boundaries unchanged     | all plugin settings surfaces                             | no session/task stream or remote delivery changes                        |
| Workspace identity contract unchanged                                 | local/remote service calls                               | existing `workspaceIdentity?.trim()                                      |     | workspacePath` fallback remains |

## 8. Accepted Cases And Pruning

### 8.1 Accepted cases

| Case ID                                      | Setup                                                                          | Action                                                                | Assertions                                                                                                                                                                                                                                                | Evidence layers                                     | Status                           |
| -------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------- |
| `PLM-LC-014 builtin-uninstall-detail-parity` | Isolated HOME; built-in seeded and enabled with config/data                    | Open detail; uninstall; remain on detail; retry; restart; restore     | After uninstall: `installed=false`, suppression present, runtime absent, Catalog/cache and full components still visible, no error banner; retry is read-only; restart preserves detail; Install restores runtime and leaves no ordinary installed record | UI + protocol + config/data/cache + fresh discovery | accepted / focused unit coverage |
| `PLM-LC-015 bundled-install-ownership`       | Suppressed built-in and merged official entry; optional CDN same-name fixture  | Invoke Install through UI and direct protocol paths                   | bundled source routes restore; CDN source routes Marketplace install; no stale suppression/duplicate ownership                                                                                                                                            | protocol + installed record + runtime               | accepted / focused unit coverage |
| `PLM-LC-016 seed-cache-runtime-separation`   | Suppressed built-in with cache present/missing; dev filesystem and SEA fixture | Resolve/list/describe/skills/commands; remove cache and resolve again | Suppression always filters runtime; missing cache self-heals from seed; describe works before/after; no Catalog filtering                                                                                                                                 | bootstrap + adapter + services tests                | accepted / focused unit coverage |

### 8.2 Reuse / update existing case

`PLM-LC-006 builtin-suppress-restore` remains the lifecycle case, but its assertions change:

- remove the "cache cleanup" and "restart does not reseed" assertions;
- require Catalog/cache preservation and detail readability;
- continue requiring config/data cleanup, suppression persistence, runtime absence, and clean restore.

### 8.3 Pruned combinations

| Dimension             | Pruned values                                       | Reason                                                                                |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Client                | Web standalone, mobile `/remote`                    | no new remote protocol or delivery behavior                                           |
| Scope                 | workspace-scope plugin install                      | current UI contract is user-scope only                                                |
| Component runtime     | MCP + Skill closure; Command/Agent/Hook enumeration | existing lifecycle catalog covers representative runtime paths                        |
| Source                | public network SEA and real CDN in formal CI        | use deterministic local filesystem/SEA/HTTP fixtures; real CDN remains a manual smoke |
| Locale/theme/viewport | existing pairwise UI contract                       | not a new presentation change                                                         |

## 9. Implementation scope (summary)

Spec/catalog/matrix and feature graph first; failing bootstrap/adapter tests (full bundled manifest, cache
retained/self-healed, describe succeeds, runtime still filtered) and UI listing/detail tests (duplicate
`available + restorable` ID); then change seed/catalog/uninstall ownership in `bundled-plugins.ts` and
`plugins.ts`, fix the `buildStoreItems` merge and built-in install routing, keeping protocol schemas unchanged.

Code files in scope: `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`,
`apps/zcode-cli/packages/bootstrap/src/plugins.ts`,
`apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts` (only if the suppression parameter is removed),
`apps/zcode-cli/packages/ui/src/settings/pluginStoreListing.ts`,
`apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` (only if bundled install routing needs a narrow
helper), plus tests for the accepted cases.

Explicitly not changed: `packages/shared` protocol schemas; Web remote / mobile replayable state; conversation
case catalogs; the component-level enable/disable model; a cross-process config locking redesign.

## 10. Rollback / Failure Boundaries

- If Catalog/cache retention causes a runtime leak, rollback must first prove every reader still filters suppression; do not "fix" it by hiding the detail UI.
- If a seed fails, retain the previous valid cache marker and expose a diagnostic; do not write a partial cache.
- If restore fails, suppression remains and the plugin stays absent from Runtime; Catalog detail remains readable when the cache is valid.
- If direct install ownership cannot be distinguished safely for CDN same-name entries, keep the UI restore path and defer the direct CLI route as a separately gated fix; never create a duplicate installed record.

## 11. Feature Boundary Planner Output

Neither checkout had a `.codegraph/` index, so the scan used current source/docs/tests with `rg`. The primary
depth-2 path:

```text
PluginStorePage
  -> pluginManagementStore.describePlugin / restoreBuiltin / installPlugin
  -> Agent plugins/overview + plugins/describe + plugins/restoreBuiltin
  -> bundled seed + marketplace resolver + runtime discovery
  -> skillsService / commandsService / session facade
```

Graph drift candidates: the existing graph has `capability.plugin-source-acquisition` and
`persistence.plugin-marketplace-installed-cache` but no explicit Catalog-vs-Runtime separation or built-in
suppression owner; the lifecycle case `PLM-LC-006` encoded the superseded cache-deletion contract; the UI
`restorableBuiltins` and `plugins/describe` relationship is not a separate graph edge.

Proposed graph delta: add `capability.plugin-catalog-runtime-separation` with code seeds for the bundled seed,
merged official marketplace, describe resolver, suppression filter, built-in uninstall/restore, UI detail and
lifecycle evidence, with edges: capability -> Catalog/cache persistence (`must-inspect`); capability -> Runtime
suppression/discovery (`must-preserve-runtime-contract`); Catalog/cache -> `plugins/describe` (`read-by`,
`must-inspect`); restorable UI projection -> `restoreBuiltin` (`commits-to`, `must-inspect`); capability ->
PLM-014/015/016 evidence (`covered-by`, evidence-only).

## 12. Planning Handoff

| Item                            | Destination                                                                   | Status                                                        |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Feature spec / dossier          | this file                                                                     | complete before code                                          |
| Existing lifecycle case catalog | `docs/plugin-management-lifecycle-case-catalog.md`                            | update PLM-LC-006 + add PLM-LC-014/015/016                    |
| Coverage matrix                 | `docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md`             | add/update rows                                               |
| Feature graph                   | `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` | add confirmed capability and edges                            |
| Formal proof                    | `packages/formal-proof`                                                       | not applicable; no conversation state-space change            |
| E2E handoff                     | plugin manual-review pending specs                                            | planned after focused tests; no formal promotion in this task |

## 13. Implementation and Verification

- `bundled-plugins.ts` always materializes the complete official Catalog/cache and leaves Runtime suppression to discovery.
- Built-in uninstall preserves the official Catalog/cache while still clearing suppression-controlled config and plugin data.
- Direct install of a suppressed bundled `filesystem`/`sea` entry routes through `restoreBuiltin`; CDN-backed entries retain Marketplace ownership.
- The UI joins duplicate available/restorable IDs so listing metadata and component detail remain available in the uninstalled state.
- Focused verification: Bootstrap `tests/plugins.test.ts` 33/33, Adapters `tests/plugins.test.ts` 74/74, UI listing/card tests 20/20; package typechecks pass; root `pnpm typecheck` and `pnpm lint` pass (lint reports existing warnings only).
