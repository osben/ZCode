# M2: Registry Aggregation and Refresh Chain

> Status: Historical status investigation; conclusions have entered target design and M2 implementation
>
> Date: 2026-08-13
>
> Purpose: Save implementation, boundaries, and outstanding issues at the start of M2; "current" and "still pending" in the main text preserve the context at that time

> Current M2 status is at [`../steps/02-provider-config-and-registry.md`](../steps/02-provider-config-and-registry.md),
> with remaining old chains at [`../steps/02-provider-config-and-registry-cleanup.md`](../steps/02-provider-config-and-registry-cleanup.md).
> Candidate names, pending items, and aggregation schemes in this document are used only to explain the investigation process.

M2 addresses how Models are produced from current Provider facts. When discussing Registries, it is easy to mix three things: how the Registry queries multiple Provider Sources, whether the Registry saves aggregated results, and how changes are delivered to consumers. This document separates them first.

## Where Investigation Conclusions Go

The target design has absorbed the following conclusions:

```text
Config / Account Sources
          |
          | change
          v
Registry constructs immutable View and lightweight index
          |
          +-- Queries return current View
          `-- Change events notify consumers to re-read
```

Each process holds its own Registry instance; Host and Workers share the implementation but not memory objects. Events express that the old View has expired; complete data continues to be provided by query interfaces. Corresponding design is at [`../design/registry/runtime.md`](../design/registry/runtime.md).

What remains to be determined by M2 implementation are how Sources combine proactive invalidation, file watchers, and freshness checks, what strategy to use when a single Source refresh fails, and how the current Host→Worker full Snapshot exits.

The `Builtin Provider Source` and `Temporary Provider` in this document are codenames from the time of investigation. The current design uses Official Config + AccountProviderAccess, and execution-scoped Providers to describe their target boundaries respectively.

## Confirmed Boundaries

Within the same Environment, processes that need Provider capabilities each hold their own Registry instance. Host, Core Workers, Prompt CLI, and TUI share the same Registry implementation but do not share in-process objects.

```text
Provider Facts of the Same Environment
               |
       +-------+--------+
       |                |
       v                v
 Host Registry     Worker Registry
       |                |
       v                v
  View, select models  Parse Selection, create Models

Prompt CLI / TUI
└─ Use the same Registry implementation directly within its own process
```

Host is responsible for model viewing and selection. Submissions carry `ModelSelection`; Core Workers create truly executing Models based on Provider Facts from their own Environment. Host sending complete Registry Snapshots to Workers is the current migration chain; the target state no longer depends on this chain.

Provider Config is only one source of Provider Facts. Builtin Providers, Temporary Providers, and remote environments each have their own states and lifecycles; the entire Registry implementation cannot be inferred from how local configs are refreshed.

This phase does not expand on whether Models internally cache HTTP Clients, connection pools, Provider SDK objects, etc. M2 first determines source, aggregation, query, and refresh boundaries.

## Queries and Notifications Are Two Separate Issues

The Registry can access each Source directly during queries:

```text
registry.listModels()
        |
        +--> Local Provider Source
        +--> Builtin Provider Source
        +--> Other Sources
        |
        v
     Merged Results
```

This implementation does not necessarily need to save complete aggregation copies, but it still may need change notifications. The reason is that consumers like model selectors and model availability gates in the Host need to know when data has expired while keeping open. Otherwise, data would have to be re-fetched on every interaction, or each page would individually decide when to refresh.

Therefore, more accurate responsibilities are:

```text
Query interface
└─ Returns the current Provider / Model view at the time of call

Change events
└─ Tell long-lived consumers: the old View has expired, please re-read
```

"Publishing changes externally" first means in-process events, not broadcasting the entire Registry to other processes, nor does it mean Registries synchronize with each other.

## Aggregation Methods Compared During Investigation

### Query-Time Aggregation

The Registry does not save aggregated results, accessing each Source and merging on every query. Its object relationships are simplest, but each query repeats conflict resolution, sorting, and Descriptor calculations; if multiple Sources change sequentially during a query, the same query may also see inconsistent time points.

### Materialized Aggregation View

The Registry saves one immutable current View. After a Source changes, construct a new View and atomically replace the old one.

```text
Source A contribution ----\
                           +--> Registry View v2
Source B contribution ----/            |
                                       v
                            list / lookup / descriptor
```

Queries are cheap and views are consistent, but the Registry needs to handle refreshes, concurrency, and failures. "Saving one" here does not necessarily mean deep-copying all Providers, Models, or runtime resources; it can only save Source's immutable contributions and lightweight query indexes.

### Per-Source States with Lightweight Index

The more promising approach for continued verification is this one: the Registry retains each Source's current contribution, and the aggregation layer only maintains lightweight indexes for lookups, grouping, sorting, and conflict resolution. Sources themselves are responsible for obtaining and refreshing facts; the Registry does not take over Source internal states.

```text
Local Source   -> Local contribution ----\
                                         +--> lookup / grouped descriptors
Builtin Source -> Builtin contribution --/
```

This comparison pushed the current "immutable View + lightweight index" target design. Sources retain their own fetching and refreshing mechanisms; the Registry materializes static views suitable for queries and does not take over Source network, file, or account states.

## How Pre-Migration Code Works

This record documents the old implementation before M2 began; it is preserved to explain the migration reason. The old Desktop Host once had a "cached snapshot, invalidated, and notified" implementation:

```text
Provider Store / Family Settings / Runtime Headers / Plan status
                              |
                              v
                 ModelProviderService
                 ├─ Caches Registry Snapshot
                 ├─ save/delete operations invalidate the cache
                 └─ Reconstruct Snapshot and trigger global event
```

The code was located at `packages/services/src/model-provider/modelProviderService.ts`. `getProviderRegistrySnapshot()` caches
`ZCodeProviderRegistrySnapshot`; when saving or deleting Providers, Plan status, or runtime Header changes,
`emitProviderRegistryChanged()` invalidates the cache, re-reads, and carries the complete Snapshot in events.

The pre-migration Host to Core Worker chain was:

```text
ModelProviderService.onDidChangeProviderRegistry
                    |
                    v
ZCodeAgentService
├─ Queue for each active workspace
├─ Deduplicate and prevent old snapshots from overwriting using revision / generatedAt
└─ workspace/updateProviderRegistry
                    |
                    v
Core Worker Workspace Catalog
├─ Clear and rebuild Provider Map
├─ Update related projections of existing Sessions
└─ Publish workspace state / session settings changes
```

`packages/services/src/zcode-agent/zcodeAgentService.ts` once subscribed to Host-side events and pushed snapshots;
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts` once applied snapshots within Workers.
This is a cross-process complete snapshot copy chain, which has exited the local production path in this round of M2 migration; the desktop-attached remote compatibility exit path is recorded separately and cannot be used to restore local global pushes.

The pre-migration Renderer did not uniformly subscribe to one Registry View:

- `useModelProviders` maintains another module-level Provider Config snapshot, updating settings and chat pages through `getAllCached()`, `getAll()`, optimistic saves, and explicit refreshes.
- Draft model availability gates once subscribed to `onDidChangeProviderRegistry`, directly adopting the event Snapshot when events arrived; on first mount, proactively read one Snapshot.
- Repo Wiki once subscribed to the same event, but the event only served as an invalidation signal, followed by re-calling `getAllCached()`.
- Subscriptions at the App root were mainly used to mark remote workspaces as "needing to re-sync Provider Registry."

So the old system simultaneously had Provider Config UI Snapshots, Host Registry Snapshots, Worker Workspace Catalogs, and multiple refresh methods. The notification mechanism itself is not the problem; the real problem is that these Views' sources, semantics, and cross-process responsibilities did not converge. The current version has deleted the old
`IModelProviderService.onDidChangeProviderRegistry`; what remains is the new Registry Service's own View change notifications, and old Service internal cache invalidation for compatibility connectivity testing.

## Notification Semantics Already in Target Design

For long-lived consumers within the same process, "initial fetch + change notification + refetch" is clearer:

```text
Consumer starts
    |
    +--> registry.list...() obtains current View
    |
    `--> Subscribe to registry.onDidChange
                       |
                       v
                  Receive invalidation notification
                       |
                       `--> Re-read current View
```

Events can carry only revision, reason, or affected scope; complete data is still provided by query interfaces. This way, notifications and data reads do not form two authoritative sources. Whether more granular events are needed must be decided after sorting out the reading purposes of settings pages, model selectors, and execution sides.

Core Workers also need to ensure that the Registry they use reflects the latest Provider Facts when creating new Models. This requirement is not equivalent to UI subscriptions: specific Sources can proactively refresh, listen for external changes, or perform freshness checks before queries. Registry callers should not know about file watchers, mtime, or details of a particular Plan request.

## Issues M2 Still Needs to Solve

1. How Local Provider Sources uniformly handle Service writes, external file modifications, and concurrent refreshes.
2. When a single Source refresh fails, whether to retain the previous successful View or publish results with the failed Source removed.
3. Whether Registry invalidation events need to carry revision, reason, or affected scope; complete Views must not be placed in events.
4. The order in which the current Host→Worker full Snapshot push chain exits, while maintaining internal CLI/TUI usage capability.

Model caching within Registries and Provider runtime resource ownership are not decided by this investigation; see [`../design/registry/model-creation.md`](../design/registry/model-creation.md).
