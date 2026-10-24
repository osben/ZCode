# M2 New Code Review

> Status: Pre-release review snapshot
>
> Date: 2026-08-20
>
> Initial review baseline: `origin/staging` `7c49a63ee381`, M2 branch `8fd68b123417`
>
> Current status: the settings form DTO and the public Adapter Factory dual-track found by the initial review have been deleted; current facts follow M2 Cleanup and the Implementation Log
>
> Phase goal: [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)
>
> Retirement result: [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/02-provider-config-and-registry-review.md`

## Conclusion

M2 completed the Provider fact source switch. Official, Personal and Account Config are the only Registry inputs; old
Provider Store, Catalog/Preset branches and Workspace Provider Snapshot no longer take part in steady-state Provider
resolution.

At the initial review, about 1.4k-1.9k new production lines were runtime transition boundary and about 0.7k-0.9k
were one-time old config/credential migration (the settings form DTO, normal execution Runtime Config assembly and
several old Services stores were deleted afterwards). Initial scale: 42,805 added / 54,206 deleted overall;
`@zcode/provider`, `@zcode/provider-node` and Official Config added 6,436 lines (4,120 domain and Node
Source/Repository, 2,316 Official Config).

Two kinds of non-steady-state code must be told apart:

- **One-time migration**: reads old facts, writes new format, then leaves the execution chain. It costs code volume
  but is not a dual fact source.
- **Runtime transition boundary**: old and new types or execution mechanisms still connect in the same run.

## Fact Chain (cut clean)

```text
Official Config + Personal Config + Account Config
        |
        v
Process Provider Registry
   +-- Settings / Selection View
   +-- Selection validation
   +-- Model creation
   `-- Request execution
```

Production protocol Entry, Prompt CLI and TUI start the process-level Registry and pass it to `createZCodeApp()`.
With the Registry on, old model lists do not take part in model candidates; old `modelCatalog` is only the first
migration input. Old `ModelProviderService`, OAuth Preset Repo, Catalog Sources and Workspace Provider Catalog
steady-state duties were deleted. The remaining issue is new facts passing through old interface shapes to consumers
not yet migrated.

## Runtime Transition Boundaries

1. **Old settings form DTO (exited).** `providerSettingsLegacyProjection` and its reverse conversion were deleted;
   the Renderer form carries `ProviderConfigObject` / `ModelConfigObject` directly, and the Facade writes Personal
   Config then waits for Registry refresh.
2. **Core Registry-less assembly (exited).** `providerRegistry` is a required dependency of `createZCodeApp()`;
   Bootstrap tests, Compact / Memory E2E and Prompt Trajectory were migrated; tests needing custom models create an
   explicit test Registry. `RuntimeModelConfig` remains only for the current Turn's temporary Provider input and Core
   transition fields.
3. **Turn temporary models borrow the Runtime Overlay (about 200-300 lines).** Files:
   `apps/zcode-cli/packages/bootstrap/src/app/turn-execution-model-source.ts`, `turn-model-overlay.ts`,
   `runtime-model-factory.ts`. Normal Providers come from the Registry; temporary inputs such as off-peak tasks still
   convert through the old Turn Overlay to `ExecutionScopedModelSource`. It is limited to Turn scope and writes
   neither the Registry nor Workspace Preferences (Workspace/Session-level Provider Overlay was deleted). Exit: after
   the execution-scoped Provider design, delete the old Runtime Model Config and Catalog conversion.
4. **New Registry compiles to the existing AI SDK Execution Registry (about 448 lines).**
   `provider-registry-model-runtime.ts` compiles the Provider Registry into `AiSdkModelRegistryConfig` and creates M1
   `Model` through `AiSdkModelAdapter` (Provider Registry -> AI SDK Runtime Registry -> `AiSdkModelAdapter`). It is
   a runtime projection, not a second fact source (model existence, Properties, Option Specs, Selection are decided by
   the Registry), but the Adapter keeps another Provider representation and reasoning parameters are converted to the
   old `providerOptions` shape. Evolves with the Adapter/Reasoning topic; does not block M2.
5. **Account identity narrow compatibility (about 50-100 lines).** Parsing and first-import for old account-unscoped
   `accessId` and old Coding Plan Keys. New Account Source produces only scoped accessId; request-phase compatibility
   only identifies existing old Model/Session during migration. Exit: end of the compatibility window for old
   Sessions and Credential Store. New code must not produce unscoped Account Access IDs.

## One-time Migration Code (about 0.7k-0.9k lines)

`legacy-cli-personal-provider-config-importer.ts`, `legacyPersonalProviderConfigImporter.ts`,
`legacyAccountProviderApiKeyLoader.ts`, and the `importLegacy` boundaries of the Personal Config and Model Selection
Repositories. Lifecycle: new config missing or too old -> read old physical format -> generate and validate versioned
new Config -> backup, atomic write -> afterwards read only the new Config. They contain old Catalog, Provider Model,
reasoning patch and compatible defaults, but the steady-state Registry path does not call them. Delete them as a
whole after the migration window so they do not become a long-term format compatibility layer.

## Complex but Target-Design Code

Account Provider connection parsing, Personal/Team Key, request-phase auth and Account Source are complex because of
accounts, entitlements and dynamic credentials themselves: account/entitlement facts -> Account Config; request
credentials -> Request Auth Service; static Provider -> Registry. They are not compatibility debt as long as they do
not regenerate Provider static facts or backfill the Registry from the old Provider Store.

## Gate and Cleanup Order

Pre-release gate: production entries must assemble the new Registry; the old Store may only serve one-time
migration; Turn Overlay must not expand to steady-state Providers. `createZCodeApp()` requiring the Registry is now a
mechanical constraint and test Harnesses must assemble one too.

Recommended post-release order:

1. Replace `turnRuntimeModel` and the old Overlay in the execution-scoped Provider phase.
2. Converge the AI SDK Runtime Registry projection in the Adapter/Reasoning phase so the business layer no longer
   understands `providerOptions`.
3. Delete old Personal Config, Account Key and unscoped accessId migration code after the compatibility window.

"The fact source is unified" is established; "all old types and execution mechanisms are deleted" is not, and
requires the three steps above.
