# 10 ZCode Built-in Provider Config Naming Cutover

> Status: Completed (2026-08-24)
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-10-zcode-builtin-provider-config-naming-cutover.md`

## 1. Task Objective

All domain, implementation and physical names in Provider Refactor that used `official` for ZCode's own configuration
are switched to `zcodeBuiltin` / `zcode-builtin`. ZCode's own Provider/Model configuration has one accurate name:
**ZCode Built-in Provider/Model Config**.

Provider Refactor has not shipped, so there is no published protocol, environment variable or file to keep reading. The
todo is an atomic rename, not a compatible migration. It changes only names: not Overlay order, model members, Access,
Registry completeness, settings page behavior or model calling behavior.

```text
config/provider/zcode-builtin.json
  -> ZCodeBuiltinProviderConfigSource
  -> zcodeBuiltinProviders / zcodeBuiltinModelRules
  -> ProviderConfigService / Resolver / Facade
       +-> Desktop Host init: zcodeBuiltinProviderConfigFilePath
       +-> CLI env / SEA: ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
```

## 2. Decisions

### 2.1 Domain Terminology

```text
ZCode Built-in Provider Config -> overlay Account Built-in Provider Config -> Effective Built-in Provider Config
  -> overlay Personal Provider Config -> Effective Provider Config
ZCode Built-in Model Config Rules + Personal Model Config Rules -> Effective Model Config Rules
```

`official` is no longer a domain synonym for this chain in documentation, public types, internal APIs, locals, test
descriptions or error messages.

### 2.2 Code and Physical Names

| Old name                                   | Target name                                     |
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

Other `official*` symbols on the same fact chain are renamed by the same rule. `zcodeBuiltin` is not shortened to
`builtin`, which would be confused with Account Built-in.

### 2.3 Zero Compatibility

Prohibited: old names as aliases or deprecated exports; accepting both old and new Host init fields; reading both old and
new environment variables; falling back to `official.json`; packaging both old and new SEA asset keys; migrations or
importers for old naming; tests using old helpers converted at production boundaries. An old name appearing means the
cutover is incomplete.

### 2.4 Scope Exclusions

`Official MCP`, Official Plugin/Marketplace, Official CUA, official website and product copy keep their own correct
meaning of `official` and are not mechanically replaced.

## 3. Impact Scope

The 2026-08-24 scan hit about 40 production files: `packages/provider` (11: Snapshot, Resolver, Service, Facade, tests),
`packages/provider-node` (5: File Source, watcher, materializer, runtime), `packages/services` (7: composition,
Desktop/Host injection), `packages/shared` (2: Host init strict schema), `packages/desktop` (9: Main/Host messages, dev
and packaging paths), `apps/zcode-cli` (6: env vars, SEA assets, runtime unpacking, build scripts) and the published
`config/provider` file. Impact was verified with Feature Graph `capability.provider-registry`, a scoped `rg` scan,
`dep:refs`, TypeScript and build tests.

State owners after the cutover:

| State/Fact                       | Authoritative owner                  | Result                                   |
| -------------------------------- | ------------------------------------ | ---------------------------------------- |
| ZCode Built-in published content | `config/provider/zcode-builtin.json` | Content unchanged; physical name changed |
| Node Source snapshot/revision    | `ZCodeBuiltinProviderConfigSource`   | Watch/reload behavior unchanged          |
| Desktop Host startup parameters  | Shared strict schema                 | New fields only; no dual-read            |
| CLI explicit path                | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Only the new variable is recognized      |
| SEA built-in assets              | `zcode-provider/zcode-builtin.json`  | Only the new key is packaged/read        |
| Provider Config Snapshot         | Provider Domain                      | Field renamed; parsed results unchanged  |
| Settings Built-in markers        | Settings Facade View                 | `isZCodeBuiltin`; display unchanged      |

Personal Repository, Account Source, Registry Overlay and Active Model are unchanged. There are no user-visible UI
changes (Provider settings, model selector, Off-Peak scoped View, Desktop/Web/mobile semantics all unchanged), so no new
UI E2E is required.

## 4. Implementation Constraints

1. Tests and production code switch atomically in one commit; no intermediate state is kept alive by aliases.
2. `zcodeBuiltinModelRules` names Model rule fields explicitly so `Models` does not express both members and Rules.
3. `packages/shared` strict runtime schema is changed directly and does not accept old fields.
4. `config/provider/official.json` is renamed atomically; no copies of old files or assets; build/package scripts,
   manifests, tests and documentation references are updated; error messages and test titles use
   `ZCode Built-in Provider Config`.
5. Current Design, Feature Graph, Todos and development docs use Built-in terminology; historical logs may show old names
   only as explicit historical quotes.
6. Desktop local and same-window Host startup chain is unchanged; remote workspace, mobile attachment and business
   protocols are untouched.

## 5. Stable Acceptance Cases

| Case ID | Setup                                              | Action                                 | Assertions                                                                       |
| ------- | -------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| ZBN-01  | New published files exist                          | Node Source starts and watches updates | Correctly parsed; revision/watch behavior unchanged                              |
| ZBN-02  | Same Built-in content                              | Materialize twice                      | Stable `zcode-builtin-<hash>.json`; content and atomic write semantics unchanged |
| ZBN-03  | Desktop dev/package                                | Create Local Host                      | Config found and Registry built only through the new Host init fields            |
| ZBN-04  | CLI explicit new environment variable              | Start Runtime                          | Reads new path and generates the same Provider/Model View                        |
| ZBN-05  | SEA binary                                         | Start without explicit file path       | Unpacks and assembles Built-in Config only from the new asset key                |
| ZBN-06  | Only old environment variable or old path provided | Start Runtime                          | Old entry points not read; fails with the formal missing-config error            |
| ZBN-07  | Provider Settings View                             | Read Built-in and Personal Providers   | `isZCodeBuiltin` correct; UI behavior and save results unchanged                 |
| ZBN-08  | Same Built-in/Account/Personal input               | Parse snapshots before/after switch    | Overlay order, Effective Config and Registry candidates equivalent               |

## 6. Completion Gates

Mechanical zero in the Provider Config formal chain (scoped directories and semantic filtering to avoid false positives
on Official MCP, Plugin, CUA and product copy; `dep:refs` confirms old exports do not linger through barrels):
`officialProviders`, `officialModels`, `officialSource`, `OfficialProviderConfigSource`,
`createOfficialProviderConfigSource`, `materializeOfficialProviderConfig`, `resolveOfficialProviderConfigFilePath`,
`officialProviderConfigFilePath`, `ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE`, `config/provider/official.json`,
`zcode-provider/official.json`, `isOfficial` (Provider Settings Built-in marker only).

Delivery: no parallel old/new entry points; old physical files, env variables and SEA assets are gone; parsing outputs
and product behavior unchanged. Old environment variables exist only in negative tests.

## 7. Non-Goals

No refactor of Config content, Overlay, Registry or ModelFactory; no change to Account/Personal Config, Access or request
authentication; no change to Provider/Model enabled, visibility, members or conflict semantics; no change to model
selection, Off-Peak, Automation, Subagent, Repo Wiki or task status; no change to Desktop continuous, Mobile replayable,
remote workspace, Queue or recovery; no cleanup of `official` business concepts unrelated to Provider Config; no
migrations or compatibility for never-published names.

## 8. Result

Domain, Node Source, Services, Shared Host init, Desktop, Server, CLI and SEA use `zcodeBuiltin` / `zcode-builtin`
uniformly; physical files, materialized files, environment variables and SEA assets switched in one pass; Provider
Settings markers are `isZCodeBuiltin`. Provider, Provider Node, Desktop, Server and CLI targeted tests and repository
TypeScript checks passed.
