# 06 Config Storage Envelope Repository Privatization

> Status: Completed
>
> Date: 2026-08-24
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Target design: [`../design/registry/configuration.md`](../design/registry/configuration.md)
>
> Suggested prerequisites: [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md)、
> [`todo-05-model-ref-retirement.md`](./todo-05-model-ref-retirement.md)

## 1. Task Objective

Delete `ProviderConfigDocument` and `ModelSelectionConfigDocument` from Provider Domain's public API. Move
`schemaVersion`, JSON envelope, parsing, serialization, and migration into Node Repository's private storage implementation.

This Todo does not delete versioned files, nor reduce persistence reliability. Config files still need strict Schema, version migration, backup, atomic
write, file lock, revision, and watcher; the only change is that domain layer and callers no longer perceive these physical storage concepts.

```text
Current

Settings / Config Service / Projection / Legacy Importer
                          |
                          v
         ProviderConfigDocument / ModelSelectionConfigDocument
          |- schemaVersion
          |- Domain Config
          |- toJSON()
          `- parse / migrate
                          |
                          v
                        Node Repository

Target

Settings / Config Service / Projection / Legacy Importer
                          |
                          v
 ProviderConfigLayerUpdate / ModelSelection | undefined
                          |
                          v
                        Node Repository
          |- private Stored*Vn schema
          |- parse / serialize / migrate
          |- backup / atomic write / file lock
          `- revision / watcher
```

## 2. Core Decisions

### 2.1 `Document` Is Not a Domain Concept

Provider Domain only recognizes:

- `ProviderConfigMap`;
- `ModelConfigRules`;
- `ProviderConfigLayerSnapshot`;
- `ProviderConfigLayerUpdate`;
- `ModelSelection`;
- Config Overlay, integrity validation, Registry, and initial model selection parsing.

`schemaVersion`, file top-level object, JSON field layout, and migration only describe "how to save," not constituting new Config Layer,
Effective Config, or runtime state. Therefore `@zcode/provider` must no longer export objects with `Document` semantics.

### 2.2 Do Not Replace `Document` with a New Intermediate Layer

Do not add public `ConfigEnvelope`, `ConfigPayload`, `ConfigState`, `SerializedConfig`, or same-shape DTO. Existing domain values are sufficient:

```ts
interface ProviderConfigLayerSnapshot {
  readonly revision: string;
  readonly providers: ProviderConfigMap;
  readonly models: ModelConfigRules;
}

interface ProviderConfigLayerUpdate {
  readonly providers: ProviderConfigMap;
  readonly models: ModelConfigRules;
}
```

Provider Repository continues using Snapshot/Update as boundary. Model Selection Repository's business read/write values directly use
`ModelSelection | undefined`; do not establish a new public object solely to retain `.configuredDefault` wrapper layer.

### 2.3 Storage Structures Can Have Names, But Must Be Private

`provider-node` internals can declare structures by version:

```ts
interface StoredProviderConfigV1 {
  readonly schemaVersion: 1;
  readonly providers: unknown;
  readonly models: unknown;
}

interface StoredModelSelectionConfigV1 {
  readonly schemaVersion: 1;
  readonly configuredDefault?: unknown;
}
```

Accurate field types constrained by private Zod Schema and serialization functions. Names can use `Stored*Vn` or `*FileVn`, but cannot be exported from
`@zcode/provider-node`'s public barrel, nor become Service, UI, Runtime, or Protocol contracts.

### 2.4 Storage Reliability Fully Retained

Repository privatization does not equal directly `JSON.parse()` and trusting types. The following capabilities all retained:

- Strict runtime Schema validation;
- Current `schemaVersion` and future adjacent version migration;
- High-version rejection and diagnosable errors;
- Personal file migration backup before migration;
- Private permission atomic writes and file locks;
- Revision based on normalized content;
- Watcher deduplication and change notification;
- Official Source and Personal Repository's consistent understanding of the same formal file Schema.

These behaviors guaranteed by Repository/codec tests; cannot be weakened by deleting public class.

## 3. Provider Config Target Boundary

### 3.1 Domain and Repository

```text
@zcode/provider
|- ProviderConfigMap
|- ModelConfigRules
|- ProviderConfigLayerSnapshot
|- ProviderConfigLayerUpdate
|- ProviderConfigService
`- Overlay / Resolver / Registry
             |
             | read/update
             v
@zcode/provider-node
|- NodeOfficialProviderConfigSource
|- NodePersonalProviderConfigRepository
`- private provider-config-file-codec
   |- StoredProviderConfigVn
   |- parse / serialize
   `- migrate
```

- Official Source parses files and returns `ProviderConfigLayerSnapshot`;
- Personal Repository receives `ProviderConfigLayerUpdate`, internally constructs and writes versioned files;
- Revision continues produced by Repository based on normalized persisted content;
- Domain does not decide file format, nor calls `toJSON()` to generate storage envelope.

### 3.2 Personal Projection

`projectEffectiveProvidersToPersonalConfig()` currently returns `ProviderConfigDocument`. Target is to return
`ProviderConfigLayerUpdate`, expressing only the projected Personal Provider Map and Model Rules.

This Todo only corrects the return boundary; does not re-approve Effective -> Personal as Settings normal save path. Formal Settings continues
submitting sparse Personal Overlay formed by user's actual modifications; this projection function only serves still-compatible-window explicit old config import, to be retired together with
Legacy importer subsequently.

### 3.3 Migration Types

`ProviderConfigDocumentMigration = (input: unknown) => unknown` no longer exported from Domain. Formal version migration is
storage Schema implementation, managed by `provider-node` private codec.

If Bootstrap needs to inject versionless Legacy importers during transition, it returns `ProviderConfigLayerUpdate | null`;
Repository validates domain values, wraps current version file envelope, and writes. Legacy importers do not produce `schemaVersion`, nor know
formal file serialization classes.

## 4. Model Selection Target Boundary

Current `model-selection-config.ts` mixes file storage and domain parsing; must separate:

```text
@zcode/provider
|- ModelSelection
|- InitialModelSelectionResolution
`- resolveInitialModelSelection()

@zcode/provider-node
|- NodeModelSelectionConfigRepository
`- private model-selection-config-file-codec
   |- StoredModelSelectionConfigVn
   |- strict schema
   `- parse / serialize / migrate
```

Repository public behavior tightened to:

```ts
read(): Promise<ModelSelection | undefined>;
saveConfiguredDefault(selection: ModelSelection | undefined): Promise<void>;
```

If callers truly need post-save values, `saveConfiguredDefault()` can return frozen `ModelSelection | undefined`, but cannot
return storage Document. Final signatures determined by what caller tests prove minimally needed.

`resolveInitialModelSelection()` continues receiving `configuredDefault?: ModelSelection` and Registry View; unrelated to file version,
file missing, and migration; must stay in Domain.

## 5. Legacy and Formal Migration Boundaries

Two types of migration must be distinguished:

```text
Versionless old config
    |
    v
Legacy Importer (transitional publication facility)
    |
    v
Current Domain Value
    |
    v
Repository writes current version file

Formal schemaVersion N file
    |
    v
Repository private N -> N+1 migration
    |
    v
Current version file
```

- Legacy importer only converts facts explicitly expressed by old configs, does not guess model capabilities;
- After mandatory upgrade window ends, Legacy importer, old parser, compatibility constants, and tests deleted entirely;
- Published formal file format adjacent version migrations retained long-term;
- Intermediate Schemas never published do not establish compatible history;
- Neither Legacy nor formal migrations spread back to Core, Registry, Settings, or Runtime.

## 6. Current Impact Scope

At least check the following consumers before implementation:

| Scope                                                               | Current Leak                                | Target                                       |
| ------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `packages/provider/src/config/document.ts`                          | Public Provider Document, parser, migration | Delete public storage envelope               |
| `packages/provider/src/model-selection-config.ts`                   | Storage and selection parsing mixed         | Retain only selection domain logic           |
| `packages/provider/src/personal-config-projection.ts`               | Returns Document                            | Return Layer Update                          |
| `packages/provider-node/src/personal-provider-config-repository.ts` | Imports public Document                     | Use private codec                            |
| `packages/provider-node/src/official-provider-config-source.ts`     | Imports public migration                    | Use same private codec                       |
| `packages/provider-node/src/model-selection-config-repository.ts`   | read/save returns Document                  | Directly read/write Selection                |
| `packages/provider-node/src/provider-config-runtime.ts`             | Importer type leaks Document                | Importer returns Layer Update                |
| CLI/Services Legacy importer                                        | Constructs Document                         | Only produce domain values                   |
| Provider/Provider Node tests                                        | Uses public Document as test subject        | Split by domain and storage responsibilities |

Verify complete scope with `rg`, TypeScript references, and package exports during implementation; cannot mechanically migrate based on above file list alone.

## 7. Tests First

### 7.1 Domain

1. Personal projection returns `ProviderConfigLayerUpdate`; providers/models semantics unchanged;
2. `resolveInitialModelSelection()` behavior for configured default, unavailable default, and Registry fallback unchanged;
3. Domain tests and exports no longer reference `schemaVersion`, Document, parse/migrate, or file JSON;
4. Config Overlay, integrity validation, and Registry publish behavior unchanged.

### 7.2 Provider Repository

1. Current version Provider files parsed strictly and yield same Layer Snapshot;
2. Layer Update round-trip yields correct providers/models and revision;
3. Missing version, future version, missing migration, and illegal fields rejected by existing rules;
4. Adjacent version migration executed sequentially and cannot skip levels;
5. Personal Legacy import成功后 (after success) backs up original file and writes current format atomically;
6. Importer failure, Schema failure, backup failure do not modify original file;
7. Official and Personal use the same formal storage Schema;
8. Watcher deduplicates same revision; real changes notified normally.

### 7.3 Model Selection Repository

1. `undefined` and complete `ModelSelection` correctly round-trip;
2. Selection options maintain strict validation and freeze semantics;
3. Unsupported versions and illegal fields rejected;
4. File missing, Legacy import, save, and restart recovery behavior unchanged;
5. Callers no longer access `.configuredDefault` Document, consuming Selection directly from Repository return.

### 7.4 Mechanical Zero

- `@zcode/provider` no longer exports `ProviderConfigDocument*`;
- `@zcode/provider` no longer exports `ModelSelectionConfigDocument*`;
- `packages/provider` production code has no `schemaVersion` and Config file migration;
- Service, Bootstrap, UI, Runtime do not pass `Document`, `Envelope`, or same-shape storage DTO;
- JSON/version/migration tests fully belong to `provider-node`;
- No new public `Stored*`, `Serialized*`, `ConfigState` substitute types.

## 8. Implementation Order

### Step A: Freeze Current Storage Behavior

- First add Provider Config and Model Selection file behavior tests to `provider-node`;
- Fix existing JSON, version errors, migration, backup, revision, watcher, and atomic write behavior;
- Confirm TODO 03's Provider/Model field structure and TODO 05's `ModelSelection` stabilized, avoiding repeated storage Schema modifications.

### Step B: Establish Repository Private Codec

- Establish private Provider Config and Model Selection codec in `provider-node`;
- Move storage Schema, version constants, parse/serialize/migrate, and errors;
- Official Source and Personal Repository share Provider Config codec;
- Do not export codec and Stored types from package barrel.

### Step C: Tighten Repository and Importer API

- Personal Provider Repository maintains Snapshot/Update boundary;
- Personal projection and Legacy importer changed to return Layer Update;
- Model Selection Repository changed to directly return Selection;
- Bootstrap, CLI, and Services callers stop reading or constructing Document.

### Step D: Delete Domain Document

- Delete both Document classes, storage parser/migration, and corresponding exports from `@zcode/provider`;
- Leave `resolveInitialModelSelection()` and related domain types in Provider Domain;
- Move and reorganize tests; delete tests only proving public Document class existence.

### Step E: Verification and Commit

- Run Provider, Provider Node, Services, Bootstrap, and CLI related unit tests;
- Run Legacy import and restart recovery representative regression;
- Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`;
- Audit mechanical zero items with `rg`;
- Independent Conventional Commit.

## 9. Non-Goals and Invariants

This Todo does not:

- Modify Built-in -> Account Built-in -> Personal Overlay order;
- Modify `builtinModelIds` / `modelIds`, conflicts, or `enabled` semantics;
- Modify Model Config Rule merging, integrity validation, or Active Model;
- Modify authentication, Access Type, Provider API assembly, or final authorization;
- Refactor Settings UI, model selector, queue, Session, or remote sync;
- Prematurely delete Legacy importer still in product compatible window;
- Opportunistically establish general Persistence, Document, or Serialization Framework.

Must retain: same persisted input produces same domain Config; same domain update produces compatible formal files; runtime, Settings, and Registry
cannot see file Envelope, nor need to know whether configuration comes from JSON, other file formats, or future different Repository implementations.

## 10. Completion Definition

Provider Domain's public vocabulary remains only config layers, config rules, selections, and parsing results. All versioned JSON envelopes, file migration, and
persistence lifecycle encapsulated within Node Repository; callers only pass accurate domain values. Formal config files and compatible behavior remain stable;
replacing storage implementation no longer requires modifying Provider Domain, Settings, Registry, or Runtime.
