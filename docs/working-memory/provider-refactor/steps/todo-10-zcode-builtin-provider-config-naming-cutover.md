# 10 ZCode Built-in Provider Config Naming Cutover

> Status: Completed
>
> Date: 2026-08-24
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)

## 1. Task Objective

Switch all domain, implementation, and physical naming in Provider Refactor still using `official` to express ZCode built-in configuration to
`zcodeBuiltin` / `zcode-builtin`. After cutover, ZCode's own Provider/Model configuration has only one accurate name:
**ZCode Built-in Provider/Model Config**.

The current branch's Provider Refactor has not shipped; there are no published Provider Config protocols, environment variables, or physical files requiring continued reading.
Therefore this Todo is an atomic rename, not a compatible migration: no aliases, deprecated exports, dual fields, dual read/write, old environment variable
fallbacks, old path fallbacks, or importers retained.

```text
Current naming chain

config/provider/official.json
        |
        v
OfficialProviderConfigSource
        |
        v
officialProviders / officialModels
        |
        v
ProviderConfigService / Resolver / Facade
        |
        +--> Desktop Host init: officialProviderConfigFilePath
        `--> CLI env / SEA: ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE

Target naming chain

config/provider/zcode-builtin.json
        |
        v
ZCodeBuiltinProviderConfigSource
        |
        v
zcodeBuiltinProviders / zcodeBuiltinModelRules
        |
        v
ProviderConfigService / Resolver / Facade
        |
        +--> Desktop Host init: zcodeBuiltinProviderConfigFilePath
        `--> CLI env / SEA: ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
```

This Todo only changes names, not Overlay order, model members, Access, Registry completeness, settings page behavior, or model calling behavior.

## 2. Confirmed Decisions

### 2.1 Domain Terminology

```text
ZCode Built-in Provider Config
        |
        v
 overlay Account Built-in Provider Config
        |
        v
Effective Built-in Provider Config
        |
        v
 overlay Personal Provider Config
        |
        v
Effective Provider Config

ZCode Built-in Model Config Rules
        +
Personal Model Config Rules
        |
        v
Effective Model Config Rules
```

`official` is no longer a domain synonym for this configuration chain. Documentation, public types, internal APIs, local variables, test descriptions, and error messages all use the
above Built-in terminology.

### 2.2 Code and Physical Names

| Current Name                               | Target Name                                     |
| ------------------------------------------ | ----------------------------------------------- |
| `officialProviders`                        | `zcodeBuiltinProviders`                         |
| `officialModels`                           | `zcodeBuiltinModelRules`                        |
| `officialSource`                           | `zcodeBuiltinSource`                            |
| `OfficialProviderConfigSource`             | `ZCodeBuiltinProviderConfigSource`              |
| `createOfficialProviderConfigSource`       | `createZCodeBuiltinProviderConfigSource`        |
| `materializeOfficialProviderConfig`        | `materializeZCodeBuiltinProviderConfig`         |
| `resolveOfficialProviderConfigFilePath`    | `resolveZCodeBuiltinProviderConfigFilePath`     |
| `officialProviderConfigFilePath`           | `zcodeBuiltinProviderConfigFilePath`            |
| `isOfficial`                               | `isZCodeBuiltin`                                |
| `official-provider-config-source.ts`       | `zcode-builtin-provider-config-source.ts`       |
| `official-provider-config-materializer.ts` | `zcode-builtin-provider-config-materializer.ts` |
| `config/provider/official.json`            | `config/provider/zcode-builtin.json`            |
| `ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE`      | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`            |
| SEA `zcode-provider/official.json`         | SEA `zcode-provider/zcode-builtin.json`         |
| Generated files `official-<hash>.json`     | Generated files `zcode-builtin-<hash>.json`     |

While implementing, if other `official*` symbols found on the same fact chain, rename directly by same rule. `zcodeBuiltin` used to clearly express
ZCode product-issued Built-in layer; cannot simplify to source-less `builtin` that would confuse with Account Built-in.

### 2.3 Zero Compatibility

The following practices all prohibited:

- Export old class names or field names as aliases;
- Accept both `officialProviderConfigFilePath` and `zcodeBuiltinProviderConfigFilePath`;
- Read both old and new environment variables;
- Fallback to `official.json` when new path not found;
- Package both old and new asset keys in SEA;
- Add migrations/importers for old naming;
- Tests continue using old helpers, then converting at production boundaries.

Old names appearing mean cutover incomplete, not a compatibility scenario needing protection.

### 2.4 Scope Exclusions

`Official MCP`, Official Plugin/Marketplace, Official CUA, official website, or product copy `official` have independent, correct
business meanings; not belonging to Provider Config naming chain, not mechanically replaced.

## 3. Current Facts and Impact Scope

Targeted scan on 2026-08-24 hit 40 files in production code, plus publishing config files and design/planning documents:

| Area                            | Hit File Count | Primary Responsibilities                                                |
| ------------------------------- | -------------- | ----------------------------------------------------------------------- |
| `packages/provider`             | 11             | Snapshot, Resolver, Service, Facade, and tests                          |
| `packages/provider-node`        | 5              | File Source, watcher, materializer, and runtime                         |
| `packages/services`             | 7              | Service composition, Desktop/Host injection                             |
| `packages/shared`               | 2              | Host init strict schema fields                                          |
| `packages/desktop`              | 9              | Main/Host messages, development, and packaging paths                    |
| `apps/zcode-cli`                | 6              | Environment variables, SEA assets, runtime unpacking, and build scripts |
| `config/provider/official.json` | 1              | Current physical published file                                         |

Targeted scan command:

```bash
rg -n \
  'officialProviders|officialModels|officialSource|OfficialProviderConfig|officialProviderConfigFilePath|ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE|config/provider/official\.json|zcode-provider/official\.json' \
  packages/provider packages/provider-node packages/services packages/shared packages/desktop apps/zcode-cli config
```

Current environment has no callable codegraph query tool; impact scope verified by Feature Graph's `capability.provider-registry`, above precise
scan, `dep:refs`, TypeScript, and build tests; cannot rely on text replacement alone.

## 4. Impact Brief

### 4.1 Functionality and Change Layers

| Field            | Conclusion                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Developer intent | Delete incorrect Provider Config `official` terminology; establish unique Built-in naming                          |
| Capability       | Provider Registry / Config Source / Desktop and CLI startup assembly                                               |
| Change layer     | `persistence contract`, `commit-effect`, `validation`, build/package assets                                        |
| Operating mode   | One atomic cutover                                                                                                 |
| Primary seeds    | `ProviderConfigSnapshot`, `OfficialProviderConfigSource`, Host init schema, CLI runtime env                        |
| Out of scope     | Provider behavior, Access, model selection, settings interactions, Queue/Recovery, other Official product concepts |

### 4.2 State Owners and Cross-Process Chains

```text
Repository published files
config/provider/zcode-builtin.json
        |
        +--> Desktop dev/package resolver
        |          |
        |          v
        |    Main -> Host init schema -> Services -> Provider Source
        |
        `--> CLI build / SEA assets
                   |
                   v
            runtime env/path resolver
                   |
                   v
             Provider Source

Personal Repository, Account Source, Registry Overlay, and Active Model unchanged.
```

| State/Fact                       | Authoritative Owner                  | This Todo Result                               |
| -------------------------------- | ------------------------------------ | ---------------------------------------------- |
| ZCode Built-in published content | `config/provider/zcode-builtin.json` | Content unchanged; only physical name changed  |
| Node Source snapshot/revision    | `ZCodeBuiltinProviderConfigSource`   | Watch/reload behavior unchanged                |
| Desktop Host startup parameters  | Shared strict schema                 | Atomically changed to new fields; no dual-read |
| CLI explicit path                | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Only recognizes new variable                   |
| SEA built-in assets              | `zcode-provider/zcode-builtin.json`  | Only packages/reads new key                    |
| Provider Config Snapshot         | Provider Domain                      | Field renamed; parsed results unchanged        |
| Settings Built-in markers        | Settings Facade View                 | Changed to `isZCodeBuiltin`; display unchanged |

### 4.3 UI Surface Matrix

| User Scenario            | Entry                | This Task Visible Changes              | Invariants to Maintain                                         |
| ------------------------ | -------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Provider settings        | Provider Settings    | None; internal read-only field renamed | Built-in display, Personal editing capabilities unchanged      |
| Normal model selection   | Model selector       | None                                   | Candidate order, enabled/visibility, selection state unchanged |
| Off-Peak/internal models | scoped Registry View | None                                   | Hidden Provider and exact creation semantics unchanged         |
| Desktop/Web/mobile       | Each client          | None                                   | continuous/replayable, remote workspace, queue unchanged       |

This Todo does not require new UI E2E; Provider Facade/Protocol unit tests and Desktop/CLI startup, build tests sufficiently cover naming chain. Existing
representative UI regression only used to prove behavior unchanged.

## 5. Implementation Order

### A. Write Failing Tests and Mechanical Gates First

1. Change Source, materializer, Snapshot, Resolver, Facade, Host init, CLI runtime env, and SEA asset tests to target names;
2. Add negative tests for "old environment variables/old paths not read";
3. Establish exact `rg` zero commands for this Todo's Section 7.

Tests and production code atomically switched in same commit; therefore tests allowed temporarily unable to compile during rename mid-points; final commit must
restore complete green lights; no intermediate states maintained via aliases.

### B. Provider Domain and Node Source

1. Rename `ProviderConfigSnapshot`, Resolver input, Service dependency/field/event reason, and Facade input;
2. Explicitly name Model rule fields `zcodeBuiltinModelRules`; avoid `Models` simultaneously expressing members and Rules;
3. Rename Node Source, watcher, materializer, runtime dependency, file names, and all exports/imports;
4. Error messages and test titles uniformly use `ZCode Built-in Provider Config`.

### C. Services, Shared Protocol, and Desktop

1. Change Services composition parameters and Local Host initialization fields to `zcodeBuiltinProviderConfigFilePath`;
2. Directly modify `packages/shared`'s strict runtime schema; do not accept old fields;
3. Synchronize Desktop main/host messages, development paths, bundle/package paths, and test fixtures;
4. Verify local Desktop and same-window Host startup chain unchanged; do not modify remote workspace, mobile attachment, or business protocols.

### D. CLI, SEA, Build, and Physical Files

1. Change explicit environment variable to `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`;
2. Change SEA asset key to `zcode-provider/zcode-builtin.json`;
3. Change runtime unpacking and content-addressed materializer file names to `zcode-builtin-<hash>.json`;
4. Atomically rename `config/provider/official.json` to `config/provider/zcode-builtin.json`;
5. Update build/package scripts, manifests, tests, and documentation references; do not retain copies of old files or old assets.

### E. Settings Projection and Document Zeroing

1. Change Provider Settings View's `isOfficial` to `isZCodeBuiltin`;
2. Update Renderer/Protocol consumers and tests; do not change visibility and editing rules;
3. Change current Design, Feature Graph, implementation Todos, and current development documents' Provider Config terminology to Built-in;
4. Historical implementation logs retaining original evidence may show old names in explicit historical quotes; they cannot continue as current API or
   target design terminology.

## 6. Stable Acceptance Cases

| Case ID | Setup                                                 | Action                                 | Assertions                                                                            |
| ------- | ----------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| ZBN-01  | New published files exist                             | Node Source starts and watches updates | Correctly parsed; revision/watch behavior unchanged                                   |
| ZBN-02  | Same Built-in content                                 | Materialize twice                      | Uses stable `zcode-builtin-<hash>.json`; content and atomic write semantics unchanged |
| ZBN-03  | Desktop dev/package                                   | Create Local Host                      | Only through new Host init fields finds config and builds Registry                    |
| ZBN-04  | CLI explicit new environment variable                 | Start Runtime                          | Reads new path and generates same Provider/Model View                                 |
| ZBN-05  | SEA binary                                            | Start without explicit file path       | Unpacks and assembles Built-in Config only from new asset key                         |
| ZBN-06  | Only set old environment variable or provide old path | Start Runtime                          | Does not read old entry points; fails with missing config formal errors               |
| ZBN-07  | Provider Settings View                                | Read Built-in and Personal Providers   | `isZCodeBuiltin` correct; UI behavior and save results unchanged                      |
| ZBN-08  | Same Built-in/Account/Personal input                  | Parse snapshots before/after switch    | Overlay order, Effective Config, and Registry candidates equivalent                   |

## 7. Completion Gates

### 7.1 Mechanical Zero

The following names must be zero in Provider Config formal chain:

```text
officialProviders
officialModels
officialSource
OfficialProviderConfigSource
createOfficialProviderConfigSource
materializeOfficialProviderConfig
resolveOfficialProviderConfigFilePath
officialProviderConfigFilePath
ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE
config/provider/official.json
zcode-provider/official.json
isOfficial (Provider Settings Built-in marker semantics only)
```

Acceptance uses scoped directories and semantic filtering to avoid false positives on Official MCP, Plugin, CUA, or general product copy. Also execute `dep:refs` to check old
exports not lingering through barrels.

### 7.2 Automated Verification

- Provider/Provider Node/Services/Shared/Desktop/CLI affected unit tests;
- Desktop dev and package path resolution tests;
- CLI normal files, explicit env, and SEA asset tests;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm fmt:check`;
- Affected builds and `pnpm test:unit:affected`.

### 7.3 Delivery Conditions

1. No parallel entry points for old and new names;
2. Old physical files, old environment variables, and old SEA assets completely exited;
3. Provider Config parsing outputs and product behavior unchanged;
4. Design, Feature Graph, step index, and review conclusions all point to this Todo;
5. Implementation, tests, and documentation committed with Conventional Commits.

## 8. Non-Goals

- Do not refactor Config content, Overlay, Registry, or ModelFactory;
- Do not change Account/Personal Config, Access, or request authentication;
- Do not change Provider/Model enabled, visibility, members, and conflict semantics;
- Do not modify model selection, Off-Peak, Automation, Subagent, Repo Wiki, or task status;
- Do not change Desktop continuous, Mobile replayable, remote workspace, Queue, or recovery logic;
- Do not clean up `official` business concepts unrelated to Provider Config;
- Do not design migrations and compatibilities for names never published.

## 9. Implementation Result

- Domain, Node Source, Services, Shared Host init, Desktop, Server, CLI, and SEA uniformly using
  `zcodeBuiltin` / `zcode-builtin`;
- Physical published files, runtime materialized files, environment variables, and SEA assets switched to final names in one pass;
- Provider Settings source markers changed to `isZCodeBuiltin`; no old fields retained;
- Old environment variables only exist in negative tests; production code does not read old variables, old paths, or old assets;
- Provider, Provider Node, Desktop, Server, CLI targeted tests and full repository TypeScript checks pass.
