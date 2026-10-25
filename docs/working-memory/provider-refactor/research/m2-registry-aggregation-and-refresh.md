# M2: Registry Aggregation and Refresh Chain

> Status: Historical status investigation; conclusions have entered target design and M2 implementation
>
> Date: 2026-08-13
>
> Purpose: Implementation, boundaries, and outstanding issues at the start of M2; "current" and "still pending" preserve the context at that time.
>
> Current M2 status is at [`../steps/02-provider-config-and-registry.md`](../steps/02-provider-config-and-registry.md),
> with remaining old chains at [`../steps/02-provider-config-and-registry-cleanup.md`](../steps/02-provider-config-and-registry-cleanup.md).
> Candidate names, pending items, and aggregation schemes here only explain the investigation process.

M2 addresses how Models are produced from Provider facts. Registry discussions mix three things: how the Registry queries multiple Provider Sources, whether it saves aggregated results, and how changes reach consumers. This document separates them.

## Where Investigation Conclusions Go

The target design absorbed:

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

Each process holds its own Registry instance; Host and Workers share the implementation but not memory objects. Events express that the old View has expired; complete data continues to be provided by query interfaces. Design at [`../design/registry/runtime.md`](../design/registry/runtime.md).

Left for M2 implementation: how Sources combine proactive invalidation, file watchers, and freshness checks; the strategy when a single Source refresh fails; how the Host→Worker full Snapshot exits. `Builtin Provider Source` and `Temporary Provider` here are investigation-time codenames; the current design uses Official Config + AccountProviderAccess, and execution-scoped Providers, respectively.

## Confirmed Boundaries

Within one Environment, every process needing Provider capabilities holds its own Registry instance. Host, Core Workers, Prompt CLI, and TUI share the Registry implementation but not in-process objects.

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

Host is responsible for model viewing and selection; Submissions carry `ModelSelection`; Core Workers create truly executing Models from their own Environment's Provider Facts. Host sending complete Registry Snapshots to Workers is the migration chain; the target state no longer depends on it. Provider Config is only one source of Provider Facts — Builtin Providers, Temporary Providers, and remote environments each have their own states and lifecycles; the Registry implementation cannot be inferred from how local configs refresh. Whether Models internally cache HTTP Clients, connection pools, or SDK objects is out of scope; M2 fixes source, aggregation, query, and refresh boundaries.

## Queries and Notifications Are Two Separate Issues

The Registry can access each Source directly at query time (`registry.listModels()` → Local / Builtin / other Sources → merged results) without necessarily saving an aggregation copy, but long-lived consumers (model selectors, availability gates) still need to know when data expired while staying open — otherwise every interaction refetches or each page decides refresh timing alone. Accurate responsibilities:

```text
Query interface
└─ Returns the current Provider / Model view at the time of call

Change events
└─ Tell long-lived consumers: the old View has expired, please re-read
```

"Publishing changes" means in-process events, not broadcasting the Registry to other processes or synchronizing Registries with each other.

## Aggregation Methods Compared During Investigation

- **Query-time aggregation** — merge Sources on every query: simplest object relationships, but each query repeats conflict resolution, sorting, and Descriptor calculation, and sequential Source changes during a query can expose inconsistent time points.
- **Materialized immutable View** — after a Source changes, construct a new View and atomically replace the old one: cheap consistent queries, but the Registry must handle refreshes, concurrency, and failures.
- **Per-Source states with lightweight index (adopted)** — the Registry retains each Source's current contribution; the aggregation layer keeps only lookup/grouping/sorting/conflict-resolution indexes. Sources own fetching and refreshing; the Registry does not take over Source internal states, network, files, or account state.

This comparison produced the current "immutable View + lightweight index" target design.

## How Pre-Migration Code Works

Record preserved to explain the migration reason. The old Desktop Host cached a Snapshot and invalidated it on change (`packages/services/src/model-provider/modelProviderService.ts`): `getProviderRegistrySnapshot()` cached `ZCodeProviderRegistrySnapshot`; save/delete, Plan status, or runtime Header changes triggered `emitProviderRegistryChanged()` — invalidate, re-read, and carry the complete Snapshot in events.

The pre-migration Host → Core Worker chain: `ModelProviderService.onDidChangeProviderRegistry` → `ZCodeAgentService` (queue per active workspace; deduplicate and prevent old snapshots overwriting via revision / generatedAt) → `workspace/updateProviderRegistry` → Core Worker Workspace Catalog (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`; clear and rebuild Provider Map, update Session projections, publish state changes). This cross-process complete-snapshot copy chain exited the local production path in M2; the desktop-attached remote compatibility exit is recorded separately and must not be used to restore local global pushes.

The pre-migration Renderer did not subscribe to one Registry View: `useModelProviders` kept a module-level Provider Config snapshot (`getAllCached()`, `getAll()`, optimistic saves, explicit refreshes); draft availability gates subscribed to `onDidChangeProviderRegistry` and adopted the event Snapshot; Repo Wiki used the event only as an invalidation signal then re-read `getAllCached()`; App-root subscriptions marked remote workspaces "needing re-sync." The system simultaneously had Provider Config UI Snapshots, Host Registry Snapshots, Worker Workspace Catalogs, and multiple refresh methods — the notification mechanism was not the problem; the Views' sources, semantics, and cross-process responsibilities had not converged. The old `IModelProviderService.onDidChangeProviderRegistry` is deleted; what remains is the new Registry Service's own View change notifications plus old Service internal cache invalidation for compatibility connectivity testing.

## Notification Semantics Already in Target Design

For long-lived consumers in the same process: initial fetch + change notification + refetch.

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

Events can carry only revision, reason, or affected scope; complete data stays behind query interfaces, so notifications and data reads do not form two authoritative sources. Whether more granular events are needed is decided after sorting out settings pages', selectors', and execution sides' reading purposes.

Core Workers must also ensure the Registry reflects the latest Provider Facts when creating new Models. This differs from UI subscriptions: specific Sources can proactively refresh, listen for external changes, or freshness-check before queries. Registry callers must not know about file watchers, mtime, or a particular Plan request's details.

## Issues M2 Still Needs to Solve

1. How Local Provider Sources uniformly handle Service writes, external file modifications, and concurrent refreshes.
2. When a single Source refresh fails, whether to retain the previous successful View or publish results with the failed Source removed.
3. Whether Registry invalidation events carry revision, reason, or affected scope; complete Views must not be placed in events.
4. The exit order of the Host→Worker full Snapshot push chain while maintaining internal CLI/TUI usage capability.

Model caching within Registries and Provider runtime resource ownership are not decided here; see [`../design/registry/model-creation.md`](../design/registry/model-creation.md).
