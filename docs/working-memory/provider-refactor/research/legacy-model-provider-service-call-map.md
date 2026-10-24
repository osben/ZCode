# Old IModelProviderService Call Surface

> Investigation Date: 2026-08-17
>
> Scope: M2 Host Settings / Selection RPC Migration
>
> Document identity: Historical call surface evidence before and after M2 migration. The main text preserves the "current" state at the time of investigation; primary consumers have already migrated, and old DTOs, Snapshots, interfaces, and fallbacks not yet physically retired are uniformly tracked by [`../steps/02-provider-config-and-registry-cleanup.md`](../steps/02-provider-config-and-registry-cleanup.md).

## Conclusion

`IModelProviderService` is not a domain service replaceable as a whole: it simultaneously carries configuration settings, model selection, account plans, connectivity tools, and the Host→Worker migration bridge. The new chain exits old methods by purpose:

| Old Method                                          | Current Primary Usage                                                   | Target Ownership                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAll` / `getAllCached`                           | Settings page, model selection, usage UI, old execution sync            | Settings View or Selection View; no longer distinguishing "trigger remote sync" and "read-only cache"                                                               |
| `save` / `delete`                                   | Settings page and API Key login form write Provider                     | `ProviderSettingsService` writes Personal Config                                                                                                                    |
| `getDisplayOrder` / `saveDisplayOrder`              | Settings page and selector sorting                                      | ProviderConfig / ModelConfig itself has ordered Overlay; old independent Preference exits                                                                           |
| `resolveWorkspaceModelSelection`                    | Old Provider, Workspace Preference, and config file mixed parsing       | Deleted; unified ZCode Agent echo uses only prepare response, App Recent, and Model Selection View                                                                   |
| `getEndpointSuggestions` / `getModelsByEndpoint`    | Old Add Provider form's Endpoint suggestions and remote model discovery | Settings form now uses explicit Provider Config filling; both old interfaces with no production callers and the `client/configs` query implementation deleted       |
| `getCatalogProviders`                               | Settings page reads old Catalog                                         | Exits after Official Config replaces Catalog                                                                                                                         |
| `testModelConnectivity`                             | Settings page explicit connectivity test                                | Independent Connectivity Service, results do not enter Registry                                                                                                     |
| `refreshPresetProviders`                            | Sync remote Builtin/Preset and rewrite old Store                        | Exits after Official Config Source / Account Access Source each refresh                                                                                             |
| `refreshCodingPlanApiKey` / `clearCodingPlanApiKey` | Login, reconnect, and plan switching                                    | Account Request Auth / Account Access Service                                                                                                                       |
| `setProviderRuntimeHeaders`                         | Start Plan one-time security verification header and temporary headers  | Deleted; one-time headers passed only through request-level Runtime Header responses                                                                                |
| `getProviderRegistrySnapshot`                       | Connectivity testing and a few old compatible calls                     | Local startup gate and model selection read Selection View; full Snapshot retained only for remaining execution compatibility, final exit                           |
| `applyToProvider`                                   | Sync old selection and complete Provider config to Agent                | Deleted; Submission carries Selection, Worker builds its own Registry                                                                                                |

Old Preset sync network failure fallbacks no longer create Start Plans. API Key Provider compatibility fallbacks are temporarily retained; Account Providers must be formed from account connections and entitlement facts into Account Overlays, not inferred from local model whitelists.

## New Host Service Surface

The new Runtime first exposes two independent RPC services:

```text
ProviderSettingsService
├─ getView
├─ save / delete Personal Provider
├─ save / delete Personal Model Config
└─ reorder Personal Provider / Model

ModelSelectionService
├─ getView
└─ validate(ModelSelection)
```

They share the same `ProviderRegistryService`, obtaining model data by reading the latest View. The old global Registry change events have exited; the Renderer reads no files, Catalogs, or Account Access, and executes no Overlays.

## Four Types of Responsibilities Currently in the Settings Page

`ModelProviderSection` and `useModelProviders` arrange four types of work in the same page and Hook; separate them by responsibility during migration rather than replacing one component file at a time.

| Responsibility                  | Current Entry Point                                           | Target Boundary                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Provider / Model config editing | `getAll`, `save`, `delete`, independent display order         | `ProviderSettingsService`                                                                                                          |
| Account and plan connections    | OAuth, Credential, Subscription, Coding Plan key refresh      | Account Access / Request Auth; does not enter Settings Config                                                                      |
| Connectivity testing            | connectivity test                                             | Independent settings auxiliary service; results do not enter Registry; old Endpoint suggestions and remote model discovery deleted |
| Runtime sync                    | Push complete Registry Snapshot to open Workspaces after save | Deleted after Workers build their own Registry                                                                                     |

The Settings page's Config section can be rewritten first to the new View while account cards and connectivity operations keep calling their existing services. During migration, account status must not be written back to Personal Provider Config, and old `save/getAll` must not remain a fact source for the sake of retaining connectivity testing.

## Old Field to New Config Ownership

The old `ModelProviderConfig` mixes configuration, Catalog markers, account status, and runtime data. Fields that truly enter the new Provider Config:

| Old Field                                                        | New Field or Ownership                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                                                             | Outer `providerId` key                                                                                     |
| `name`                                                           | Optional `label`; fallback display `providerId`                                                            |
| `logoUrl`                                                        | `logoUrl`                                                                                                  |
| `apiFormat`                                                      | `apiFormat`                                                                                                |
| `endpoints.baseURL`                                              | `baseURL`                                                                                                  |
| `apiKey`                                                         | `apiKey` for API Providers                                                                                 |
| `apiKeyUrl`                                                      | `apiKeyManagementUrl` for API Providers                                                                    |
| `headers`                                                        | Static `headers`; current settings page provides no editing, but Official / Account Providers can use      |
| `models` members and order                                       | Provider Config's `models`                                                                                 |
| Model properties/options/reasoning                               | Precise Personal `ModelConfig` or Official `ModelConfigRules`                                              |
| `source`, `modified/deleted`, `systemDisabledReason`, timestamps | Do not enter new Config; expressed by config layer, member results, Account Access, or runtime state       |

Old `endpoints.paths` are not migrated to the new public Config. The settings page allows selecting one `apiFormat`; the save boundary cleans up historical multi-protocol paths and keeps the user-entered full address in `baseURL`; the runtime derives the default operation path from `apiFormat`. Saving paths in the new Config would re-create the deprecated endpoint dual-track.

Only backend channels exist currently; the UI has not yet switched to new types. The settings-page switch must complete these steps in one migration sequence:

```text
Freeze old save/delete write entries
        |
        v
Execute the final old Config -> Personal Config import
        |
        v
ProviderSettingsService becomes the only write entry
        |
        v
Delete old UI writes and independent display-order writes
```

Old writes must not continue after the new Personal file is generated.

## Consumers Still Needing Separate Handling

`getAll/getAllCached` were still called by Usage, official version security checks, Provider Family migration, and Bot compatibility branches. Local Bot candidates, status display, and startup migration switched to Selection View; local Repo Wiki display and preheating exited the old Snapshot. Session create/resume/set/send, V4 draft preheating, replayable/Bot V4 create, and Automation model switching no longer derive ordinary runtimeModel from the old Snapshot; local V4 model switching failures no longer recover via the old Snapshot. Old reads remain only for entries not yet equipped with new services, desktop-attached remotes, and explicit compatible calls. Remaining calls need different data:

- Display or model selection → Selection View.
- Editing explicit configs → Settings View.
- Plan identity or credentials → Account Service.
- Execution models → create through the Registry.
- Host→Worker sync only → deleted with the migration bridge.

UI switching therefore cannot "convert the new View back to `ModelProviderConfig[]`"; that would keep the old complete structure as an implicit fact source with the same mixed semantics.

## Client Proxy Migration Semantics

`RemoteServiceAccess` creates proxies directly from channel names; a proxy object existing does not mean the peer registered the channel. Optional fields on `IServiceAccessor` are only TypeScript assembly compatibility during migration and cannot use `service !== undefined` as remote capability negotiation. The settings page reads Provider Settings from the window's own Local Host; when the remote Environment's new Registry is not yet connected, continue through the old Remote service chain. After all entries register new channels, delete the optional markers; if cross-version Host capability probing is needed later, add explicit protocol capabilities rather than inferring from proxy existence.
