# M2 New Code Review

> Status: Pre-release review snapshot
>
> Date: 2026-08-20
>
> Initial review baseline: `origin/staging` `7c49a63ee381`, M2 branch `8fd68b123417`
>
> Current status: The initial review identified settings form DTO and public Adapter Factory dual-track have been deleted; current facts are based on M2 Cleanup and subsequent Implementation Log
>
> Phase goal: [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)
>
> Retirement result: [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md)

## Conclusion

M2 has basically completed the Provider fact source switch. Official, Personal, and Account Config form the unique Registry input; old Provider Store, Catalog/Preset branches, and Workspace Provider Snapshot no longer participate in normal long-term Provider steady-state resolution.

At the time of the initial review, approximately `1.4k–1.9k` lines of new production code belonged to the runtime transition boundary, with another approximately `0.7k–0.9k` lines responsible for one-time old config and credential migration. This number explains the issues found in the initial review and no longer represents the current branch size; the settings form DTO, normal execution Runtime Config assembly, and several old Services stores have been deleted in subsequent cleanup.

Two categories of nature need to be distinguished here:

```text
One-time migration
└─ Reads old facts, writes new format, then exits the execution chain

Runtime transition boundary
└─ Old and new types or execution mechanisms still connect in the same run
```

The former affects code volume and maintenance cost, but does not constitute a steady-state dual fact source. The latter reflects that the settings UI, temporary models, and Adapter boundaries still have subsequent cleanup work.

## Change Scale

The following numbers come from `git diff origin/staging...HEAD`. Statistics exclude `pnpm-lock.yaml`; file classification by production source code, tests, and Markdown documents may differ by a few lines from Git totals due to rename detection and a few non-Markdown config files.

| Content                                   |  Added | Deleted |
| ----------------------------------------- | -----: | ------: |
| All branch diffs                          | 42,805 |  54,206 |
| Excluding lockfile                        | 42,754 |  54,205 |
| Production source code and runtime config | 17,275 |  24,915 |
| Tests                                     | 15,441 |  28,237 |
| Markdown documents                        | 10,036 |   1,053 |

Of the added production content, `@zcode/provider`, `@zcode/provider-node`, and Official Config total `6,436` lines, with `4,120` lines as pure domain and Node Source/Repository implementations, and `2,316` lines as Official Config. This part forms M2's most concentrated new design skeleton.

## Fact Chains Already Cut Clean

Normal long-term Providers currently follow the same chain:

```text
Official Config
      +
Personal Config
      +
Account Config
      |
      v
Process Provider Registry
      |
      +-- Settings / Selection View
      +-- Selection validation
      +-- Model creation
      └-- Request execution
```

Production protocol Entry, Prompt CLI, and TUI all start process-level Registry and pass `createZCodeApp()`. When the Registry is enabled, old model lists explicitly do not participate in model candidates; old `modelCatalog` only serves as the first migration input. The steady-state responsibilities of old `ModelProviderService`, OAuth Preset Repo, Catalog Sources, and Workspace Provider Catalog have been deleted.

Therefore, the current main issue is not that the old Provider Store still decides execution in the background, but that new facts need to pass through several old interface shapes to reach consumers that have not yet migrated.

## Runtime Transition Boundaries

### Old Settings Form DTO Has Exited

The initial review discovered that the settings page still converts bidirectionally through old form DTO:

```text
ProviderSettingsView
        |
        v
Old ModelProviderConfig form DTO
        |
        v
User edits
        |
        v
ProviderConfigObject / ModelConfigObject
```

Subsequent cleanup has deleted `providerSettingsLegacyProjection` and the corresponding reverse conversion. The Renderer form now directly carries `ProviderConfigObject` and `ModelConfigObject`; after saving, the Provider Settings Facade writes Personal Config and waits for Registry refresh. Edit drafts still belong to the Renderer's private state, but no longer use old endpoint, kind, modalities, or reasoning patch DTO.

### Core Registry-less Assembly Branch Has Exited

The final cleanup changed `providerRegistry` to a required dependency of `createZCodeApp()`, and migrated Bootstrap tests, Compact / Memory E2E, and Prompt Trajectory. Old `RuntimeModelConfig / ModelCatalog` no longer承担裸 App Factory's Provider facts; tests that need custom models explicitly create a test Registry; protocol Entries continue to use the process Registry.

This cleanup deleted the code-level dual-track identified in the initial review of this section. `RuntimeModelConfig` is still used for the current Turn's temporary Provider input and Core transition fields, not as the App startup source for normal long-term Providers.

### Turn Temporary Models Continue to Borrow Runtime Overlay

This part is approximately `200–300` lines, mainly located in:

- `apps/zcode-cli/packages/bootstrap/src/app/turn-execution-model-source.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/turn-model-overlay.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/runtime-model-factory.ts`

Normal Providers are now provided by the new Registry. Temporary inputs for off-peak tasks etc. still convert through the old Turn Overlay to `ExecutionScopedModelSource`:

```text
Normal long-term Provider -> Process Registry

Turn temporary Provider -> Runtime Overlay -> ExecutionScopedModelSource
```

This boundary has been limited to Turn scope; it does not write to the Registry or Workspace Preferences. Workspace/Session-level Provider Overlay has been deleted. After the subsequent execution-scoped Provider design is complete, the old Runtime Model Config and Catalog conversion can be deleted.

### New Registry Compiles to Existing AI SDK Execution Registry

`provider-registry-model-runtime.ts` adds approximately `448` lines, compiling the Provider Registry into the existing `AiSdkModelRegistryConfig`, and creating M1 `Model` through the existing `AiSdkModelAdapter`.

```text
Provider Registry
        |
        v
AI SDK Runtime Registry
        |
        v
AiSdkModelAdapter
```

This is a runtime implementation projection, not a second fact source: whether a model exists, Properties, Option Specs, and Selection are all determined by the new Registry. It still exposes that the Adapter internally retains another set of Provider representations, and reasoning parameters also need to be converted to the old `providerOptions` shape here.

This layer can continue to evolve following the Adapter/Reasoning topic, and does not block M2's Config and Registry launch. If "transition code" is defined as all implementations that need to be replaced in the future, it should be counted; if only auditing dual fact sources, it does not constitute a failure item.

### Account Identity Narrow Compatibility

Old account-unscoped `accessId` and old Coding Plan Keys retained a small amount of parsing and first-import logic, approximately `50–100` lines. New Account Source only produces scoped accessId with account identity; request-phase compatibility is only used to identify existing old Model/Session during migration.

The exit condition is the end of the compatibility window for old Sessions and old Credential Store. New code must no longer produce account-unscoped Account Access IDs.

## One-time Migration Code

One-time migration is approximately `0.7k–0.9k` lines, mainly concentrated in:

- `legacy-cli-personal-provider-config-importer.ts`;
- `legacyPersonalProviderConfigImporter.ts`;
- `legacyAccountProviderApiKeyLoader.ts`;
- Personal Config and Model Selection Repository `importLegacy` boundaries.

They follow the same lifecycle:

```text
New config does not exist or version is too old
        |
        v
Read old physical format
        |
        v
Generate and validate versioned new Config
        |
        v
Backup, atomic write
        |
        v
Only read new Config going forward
```

This group of code contains old Catalog, old Provider Model, old reasoning patch, and compatible defaults, with relatively high complexity, but is not called in reverse by the steady-state Registry path. After the migration window ends, these modules should be deleted as a whole to avoid evolving into a long-term format compatibility layer.

## Complex But Target-Design Code

Account Provider connection parsing, Personal/Team Key, request-phase auth, and Account Source code are equally complex, but the complexity comes from accounts, entitlements, and dynamic credentials themselves. They have now converged to:

```text
Account and entitlement facts -> Account Config
Request credentials       -> Request Auth Service
Static Provider           -> Registry
```

As long as these modules do not regenerate Provider static facts and do not backfill the Registry from old Provider Store, they should not be classified as compatibility debt merely because of code complexity.

## Subsequent Cleanup Order

The core gate to maintain before release is: normal production entries must assemble the new Registry; old Store can only be used for one-time migration; Turn Overlay must not expand to steady-state Providers.

The recommended post-release cleanup order is:

1. Replace `turnRuntimeModel` and the old Overlay during the execution-scoped Provider phase.
2. Continue converging the AI SDK Runtime Registry projection during the Adapter/Reasoning phase, avoiding the business layer re-understanding `providerOptions`.
3. Delete old Personal Config, Account Key, and unscoped accessId migration code after the compatibility window ends.

Production `createZCodeApp()`'s Registry dependency has become a required mechanical constraint; test Harnesses must also explicitly assemble the Registry; it no longer belongs to subsequent items. M2 can currently enter the release cleanup, but "fact source has been unified" cannot be mistakenly written as "all old types and execution mechanisms have been deleted." The former is established; the latter still requires the above several explicit, measurable retirement steps.
