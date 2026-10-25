# 06 Config Storage Envelope Repository Privatization

> Status: Completed
>
> Date: 2026-08-24
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Target design: [`../design/registry/configuration.md`](../design/registry/configuration.md)
>
> Suggested prerequisites: [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md),
> [`todo-05-model-ref-retirement.md`](./todo-05-model-ref-retirement.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-06-config-storage-envelope-repository-privatization.md`

## 1. Objective

Delete `ProviderConfigDocument` and `ModelSelectionConfigDocument` from the Provider Domain's public API. Move
`schemaVersion`, JSON envelope, parsing, serialization and migration into the Node Repository's private storage
implementation. Versioned files and persistence reliability are not reduced: strict Schema, version migration, backup,
atomic write, file lock, revision and watcher stay; only the domain layer and callers stop perceiving the physical
storage concepts. Before: Settings / Config Service / Projection / Legacy Importer used the Documents (`schemaVersion`,
Domain Config, `toJSON()`, parse / migrate) on top of the Node Repository. Target: they use
`ProviderConfigLayerUpdate` / `ModelSelection | undefined`; the Repository owns private `Stored*Vn` schema, parse /
serialize / migrate, backup / atomic write / file lock and revision / watcher.

## 2. Core Decisions

1. **`Document` is not a domain concept.** The Provider Domain recognizes only `ProviderConfigMap`,
   `ModelConfigRules`, `ProviderConfigLayerSnapshot`, `ProviderConfigLayerUpdate`, `ModelSelection`, Config Overlay,
   integrity validation, Registry and initial model selection parsing. `schemaVersion`, the file top-level object, JSON
   layout and migration describe only how to save; `@zcode/provider` exports no `Document`-semantics objects.
2. **No new intermediate layer** (`ConfigEnvelope`, `ConfigPayload`, `ConfigState`, `SerializedConfig`, same-shape
   DTO). Existing values suffice: `ProviderConfigLayerSnapshot { revision, providers, models }` and
   `ProviderConfigLayerUpdate { providers, models }`. The Model Selection Repository reads/writes
   `ModelSelection | undefined` directly (no new public object only to keep a `.configuredDefault` wrapper).
3. **Storage structures may have names but are private.** `provider-node` may declare `StoredProviderConfigV1`
   (`schemaVersion: 1`, `providers`, `models`) and `StoredModelSelectionConfigV1` (`schemaVersion: 1`,
   `configuredDefault?`), constrained by private Zod Schemas and serializers; names `Stored*Vn` / `*FileVn`; never
   exported from the `@zcode/provider-node` public barrel and never Service, UI, Runtime or Protocol contracts.
4. **Storage reliability fully retained:** strict runtime Schema validation; current `schemaVersion` and future adjacent
   version migration; high-version rejection with diagnosable errors; Personal file migration backup before migration;
   private-permission atomic writes and file locks; revision from normalized content; watcher deduplication and change
   notification; Official Source and Personal Repository share the same formal file Schema. Guaranteed by
   Repository/codec tests, not weakened by deleting the public class.

## 3. Provider Config Target Boundary

`@zcode/provider` keeps `ProviderConfigMap`, `ModelConfigRules`, `ProviderConfigLayerSnapshot`,
`ProviderConfigLayerUpdate`, `ProviderConfigService`, Overlay / Resolver / Registry. `@zcode/provider-node` holds
`NodeOfficialProviderConfigSource`, `NodePersonalProviderConfigRepository` and a private
`provider-config-file-codec` (`StoredProviderConfigVn`, parse / serialize, migrate). The Official Source parses files
and returns `ProviderConfigLayerSnapshot`; the Personal Repository receives `ProviderConfigLayerUpdate` and builds/writes
versioned files internally; Revision stays produced by the Repository from normalized persisted content; the Domain
neither decides file format nor calls `toJSON()` for a storage envelope.

- **Personal projection:** `projectEffectiveProvidersToPersonalConfig()` returned `ProviderConfigDocument`; it now returns
  `ProviderConfigLayerUpdate` (projected Personal Provider Map and Model Rules only). This only corrects the return
  boundary: Effective -> Personal is not re-approved as the normal Settings save path (Settings keeps submitting a
  sparse Personal Overlay); the function serves only the explicit old-config import compatibility window and retires
  with the Legacy importer.
- **Migration types:** `ProviderConfigDocumentMigration = (input: unknown) => unknown` is no longer exported from the
  Domain; formal version migration is storage Schema implementation in the `provider-node` private codec. A versionless
  Legacy importer injected by Bootstrap returns `ProviderConfigLayerUpdate | null`; the Repository validates domain
  values, wraps the current-version file envelope and writes; importers produce no `schemaVersion` and know no formal
  file serialization classes.

## 4. Model Selection Target Boundary

`model-selection-config.ts` mixed file storage and domain parsing and is separated: `@zcode/provider` keeps
`ModelSelection`, `InitialModelSelectionResolution`, `resolveInitialModelSelection()`; `@zcode/provider-node` has
`NodeModelSelectionConfigRepository` and a private `model-selection-config-file-codec` (`StoredModelSelectionConfigVn`,
strict schema, parse / serialize / migrate). Repository public behavior:
`read(): Promise<ModelSelection | undefined>`; `saveConfiguredDefault(selection: ModelSelection | undefined): Promise<void>`
(may return a frozen `ModelSelection | undefined` if callers need post-save values, never a storage Document; final
signatures per what caller tests prove). `resolveInitialModelSelection()` keeps taking `configuredDefault?: ModelSelection`
and a Registry View, unrelated to file version, file missing and migration; it stays in the Domain.

## 5. Legacy vs Formal Migration

Versionless old config -> Legacy Importer (transitional publication facility) -> current Domain value -> Repository
writes the current-version file. Formal `schemaVersion N` file -> Repository private N -> N+1 migration -> current-version
file. The Legacy importer converts only facts old configs explicitly express (no model capability guessing); after the
mandatory upgrade window ends, the Legacy importer, old parser, compatibility constants and tests are deleted entirely;
adjacent version migrations of published formal formats are retained long-term; never-published intermediate Schemas get
no compatibility history; neither migration spreads back to Core, Registry, Settings or Runtime.

## 6. Impact Scope

`packages/provider/src/config/document.ts` (public Document, parser, migration -> delete public storage envelope);
`packages/provider/src/model-selection-config.ts` (keep only selection domain logic);
`packages/provider/src/personal-config-projection.ts` (return Layer Update);
`packages/provider-node/src/personal-provider-config-repository.ts` and `official-provider-config-source.ts` (use
the private codec, shared); `packages/provider-node/src/model-selection-config-repository.ts` (read/write Selection
directly); `packages/provider-node/src/provider-config-runtime.ts` (importer returns Layer Update); CLI/Services Legacy
importer (produce domain values only); Provider/Provider Node tests (split by domain and storage responsibilities).
Verify the complete scope with `rg`, TypeScript references and package exports.

## 7. Tests

- **Domain:** Personal projection returns `ProviderConfigLayerUpdate` with unchanged providers/models semantics;
  `resolveInitialModelSelection()` behavior for configured default, unavailable default and Registry fallback unchanged;
  Domain tests and exports reference no `schemaVersion`, Document, parse/migrate or file JSON; Overlay, integrity
  validation and Registry publish unchanged.
- **Provider Repository:** current-version files parse strictly to the same Layer Snapshot; Layer Update round-trip gives
  correct providers/models and revision; missing version, future version, missing migration and illegal fields rejected
  by existing rules; adjacent migration runs sequentially and cannot skip levels; Personal Legacy import success backs
  up the original and writes the current format atomically; importer failure, Schema failure and backup failure leave
  the original file untouched; Official and Personal use the same formal storage Schema; watcher deduplicates the same
  revision and notifies real changes.
- **Model Selection Repository:** `undefined` and complete `ModelSelection` round-trip; options keep strict validation
  and freeze semantics; unsupported versions and illegal fields rejected; file missing, Legacy import, save and restart
  recovery unchanged; callers consume Selection directly (no `.configuredDefault` Document).
- **Mechanical zero:** `@zcode/provider` exports no `ProviderConfigDocument*` / `ModelSelectionConfigDocument*`;
  `packages/provider` production code has no `schemaVersion` and Config file migration; Service, Bootstrap, UI, Runtime
  do not pass `Document`, `Envelope` or same-shape storage DTO; JSON/version/migration tests live in `provider-node`; no
  new public `Stored*`, `Serialized*`, `ConfigState` substitutes.

## 8. Implementation Order

A. Freeze current storage behavior (add Provider Config and Model Selection file behavior tests to `provider-node`:
JSON, version errors, migration, backup, revision, watcher, atomic write; confirm Todo 03's field structure and Todo 05's
`ModelSelection` are stable). B. Establish the Repository private codec (storage Schema, version constants,
parse/serialize/migrate, errors moved; Official Source and Personal Repository share the Provider Config codec; codec and
Stored types not exported from the barrel). C. Tighten Repository and importer API (Snapshot/Update boundary; projection
and Legacy importer return Layer Update; Model Selection Repository returns Selection; Bootstrap, CLI and Services stop
reading/constructing Documents). D. Delete Domain Document (both Document classes, storage parser/migration and exports
from `@zcode/provider`; keep `resolveInitialModelSelection()` and domain types; move/reorganize tests, deleting those
proving only the public Document class). E. Verify and commit (Provider, Provider Node, Services, Bootstrap, CLI unit
tests; Legacy import and restart recovery regression; `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`; `rg` audit of
the mechanical zero items; independent Conventional Commit).

## 9. Non-Goals, Invariants and Completion

Not done here: changing the Built-in -> Account Built-in -> Personal Overlay order; `builtinModelIds` / `modelIds`,
conflicts or `enabled` semantics; Model Config Rule merging, integrity validation or Active Model; authentication,
Access Type, Provider API assembly or final authorization; Settings UI, model selector, queue, Session or remote sync;
premature deletion of the Legacy importer still in the compatibility window; any general Persistence / Document /
Serialization Framework. Must retain: the same persisted input produces the same domain Config; the same domain update
produces compatible formal files; runtime, Settings and Registry never see the file Envelope nor need to know whether
configuration comes from JSON or another Repository implementation.

Completion: the Provider Domain's public vocabulary is only config layers, config rules, selections and parsing results;
all versioned JSON envelopes, file migration and persistence lifecycle live in the Node Repository; callers pass precise
domain values; formal config files and compatibility behavior stay stable; replacing storage implementation no longer
requires modifying Provider Domain, Settings, Registry or Runtime.
