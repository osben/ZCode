# M2 Merge Request Static Review

> Status: Pre-release issues have been resolved item by item; fixed items are confirmed by table status, body, and implementation log
>
> Date: 2026-08-20
>
> Review baseline: Initial issues discovered at `origin/staging` `cf009a3b199c`; final status based on M2 Cleanup and Implementation Log
>
> Phase goal: [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)

This document records issues found during the full static review of the M2 Merge Request, already confirmed fixes, and boundary items still needing subsequent discussion. It does not modify Design; items involving new product semantics or architecture boundaries still need item-by-item discussion.

Initial issues came from the full static review; subsequent fixes all added corresponding failing tests and targeted regressions. The final full verification and baseline failure evidence are recorded in item 251 of the Implementation Log.

## Current Assessment

| ID | Issue | Current Understanding | Status |
| --- | --- | --- | --- |
| R1 | Settings page once bidirectionally converted through old `ModelProviderConfig` | Renderer edit state now uses the same Source View as the formal Config; old Store fields and reverse conversion exit settings page | Resolved |
| R2 | Creating a new custom Provider required an existing Settings View | New creation allows missing inheritance View and saves directly from the complete form Draft; editing an existing Provider continues to reuse the View | Fixed |
| R3 | Account Access could enter Personal Config | Personal projection ignores the dynamic `accessId` injected by Account Overlay, maintaining the Official, Personal, Account three-layer fact boundary | Fixed |
| R4 | `reasoningMapping` difference conflicts with the overall Overlay semantics | Save complete fields when Mapping changes, consistent with the full-coverage rule for normal value fields | Fixed |
| R5 | Request auth refresh re-enters Registry | `Model` creation captures a static Provider execution snapshot at creation time; request auth only covers the API Key and Header for that snapshot | Fixed |
| R6 | Logout and re-login could reuse an old Coding Plan Key | Capture account identity before OAuth cleanup and delete account-scoped Key; force refresh based on new Token on re-login | Fixed |
| R7 | Settings save could overwrite concurrent Personal Config modifications | Effective save has moved into Repository's atomic `update()`, only modifying the target Provider and corresponding exact model rules within the lock | Fixed |
| R8 | Account refresh failure could leave unconsumed pending reasons | Failed rounds release in-flight and will automatically continue consuming events that arrived during the wait; the previous successful snapshot remains | Fixed |
| R9 | Connectivity test still calls old Probe parameters | Production "test connection" continues to be preserved; dedicated tests have migrated to the formal Provider/Model Config request shape | Fixed |
| R10 | Remote Workspace once mixed remote model facts with local account service | Remote Host/Worker now use their own Config, Credential, Account Source, and Registry; Desktop no longer pushes Provider/Secret | Resolved; Provisioning Sync belongs to M7 |

## Settings Edit Chain

The settings page completes one edit session through the Renderer's private edit state. The edit state directly uses the field structure of the formal Config:

```text
ProviderSettingsView
        |
        v
ProviderSettingsFormProvider
├─ providerId + Registry projection state
├─ config: ProviderConfigObject
└─ models: { modelId, config: ModelConfigObject }[]
        |
        |  User edits
        v
ProviderConfigObject / ModelConfigObject
        |
        v
Relative to Official Config projects Personal Config
```

Related code is concentrated in:

- `packages/ui/src/lib/providerSettingsFormProjection.ts`;
- `packages/ui/src/lib/providerPersonalSave.ts`;
- `packages/ui/src/hooks/useModelProviders.ts`.

The edit state only expresses the current editable interaction state of the settings page, not serving as the physical storage, Registry, or model execution contract. The field structure is the same source as the formal Config; the Renderer no longer maintains old Store semantics such as endpoints, kind, modalities, and ProviderOptionsPatch. After saving the complete Effective Config, the Facade/Repository is still responsible for calculating the sparse Personal Overlay relative to the Official Config.

The immediate blocking for creating new Providers has been independently fixed. A new `providerId` has not yet entered the Registry, so there is naturally no corresponding item in the current Settings View; saving and connectivity testing construct the Effective Config directly from the complete Provider/Model Draft of the new form. When editing an existing Provider, the Renderer copies the complete Effective Config from the Settings View; user-visible controls only modify the corresponding fields, and unexposed fields remain unchanged as-is. Account dynamic Access's Personal projection has also been isolated at the domain layer.

If it becomes necessary in the future to distinguish inherited values from explicit Personal values in controls, upgrade the edit state to a Personal Draft:

```text
ProviderSettingsView
├─ effectiveConfig: render the final effect
├─ personalConfig: user's explicit Overlay
└─ inherited/default: inheritance hint for input controls
        |
        v
Personal Provider Draft
        |
        v
Personal Config write for the target Provider
```

This belongs to a subsequent enhancement of the settings interaction and does not affect the deletion of old field dual-track in this round. The current edit state does not read physical configuration, does not construct a Registry, does not determine model selectability, and does not create Models.

## Model Config Projection

The settings page currently only directly edits the Model ID, Context Window, and Max Output Tokens, with no new Reasoning Mapping edit controls. The edit state retains the complete `ModelConfigObject`, so users can modify other fields without converting the Reasoning Mapping to the old Patch and then restoring:

```text
ModelConfigObject.reasoningMapping
        |
        |  Other fields edited in place
        v
ModelConfigObject.reasoningMapping
```

`ModelConfig.overlay()` treats `reasoningMapping` as a normal value to be fully replaced. The Personal Config projection continues to follow the same rule: when the Mapping does not change, no Personal field is written; when it changes, save the complete Mapping.

## Model and Request Auth Boundary

The Account Request Auth Service is responsible for obtaining the API Key and Header during the request phase. The static review discovered that the Adapter, after obtaining `ModelRequestAuth`, would again call the complete `resolve()` of the current AI SDK Registry:

```text
Bound Model
        |
        |  Refresh auth before request
        v
Account Request Auth Service
        |
        v
ModelRequestAuth
        |
        v
Current Registry complete resolve(providerId, modelId)
```

This would cause the Registry's updated same Loop to obtain the Endpoint, API Format, Provider Factory, Headers, or Provider Options again. After the fix, `bindModel()` captures the Provider static execution config and Model capabilities at Model creation time; the request attempt only merges the dynamic API Key/Header onto this snapshot, then creates the current SDK Model. The Registry's subsequent hot update only affects Models created subsequently.

Physical network routing, proxy, and signing infrastructure still belong to the Adapter's dynamic request facility; they can update according to their own lifecycle, but they will not change the Model's fixed Provider identity, protocol, Endpoint, Provider Options, or static Headers. Tests cover the sequence where old Models continue using the original Provider Factory and static Headers after Registry hot-replacement, while receiving the latest request auth materials.

## Account Credential Lifecycle

New Personal Coding Plan Keys use Access IDs with account identity:

```text
coding-plan:<provider>:account:<accountIdentity>
```

Old logout handling only deletes account-unscoped keys:

```text
coding-plan:<provider>
```

The OAuth Session is also cleared before the Logout Handler executes, so the Handler cannot obtain the exiting account's identity. After the fix, the OAuth Service reads the current Profile ID before clearing the main session, and passes it along with the Provider ID to the Logout Handler. The Handler deletes the exact account-scoped Key, and continues to clean up account-unscoped old keys during the compatibility window. Explicit logout, unlink, expired JWT invalidation, and logout-all all follow this identity passing chain; when credential damage recovery cannot reliably obtain identity, it still at least cleans up old keys, and the Account Source takes offline the Provider.

The correctness of re-login has been independently fixed: the `oauth-login-entitlement` that the Renderer actually emits after login completion now triggers `forceCredentialRefresh`; logging in with the same account again skips old caches, obtains, and overwrites the Coding Plan Key using the new OAuth Token. Historical `oauth-callback` refresh remains compatible.

The forced refresh on re-login and the precise deletion on logout together close the old Coding Plan Key reuse window. In the longer term, structured refresh parameters expressing `forceRefreshCredentials` could be used to exit interpretation of reason strings; this belongs to interface cleanliness and no longer affects the current credential lifecycle correctness.

## Personal Config Concurrent Writes

`PersonalProviderConfigRepository.update()` now provides cross-process file locks and lock-internal read-modify-write. The problem was that ordinary settings save calculated the entire Personal Config from the old Registry snapshot, then ignored the latest content read within the lock through `replacePersonalConfig()`.

The normal save now retains the existing lock and completes the target update within the lock:

```text
Obtain file lock
        |
        v
Read latest Personal Config
        |
        v
Only modify target providerId and corresponding exact models
        |
        v
Atomic write back and release lock
```

`ProviderSettingsFacade` passes the Effective Provider and exact model config to `ProviderConfigService`; the Service reads the latest Personal Config within Repository `update()`, calculates the projection relative to Official, and only replaces the target `providerId` and its exact model rules. Pattern rules and concurrent updates of other Providers remain unchanged. Full replacement is only used for version migration and explicit full imports.

## Account Refresh Timing

The current refresh loop throws an error and exits when a single parse fails. If a new refresh event arrives during the parse wait, it stays in `pendingReasons`, but `finishRefresh()` only clears the in-flight marker and does not start the next round:

```text
Refresh A in progress
        |
        +-- New event B enters pending
        |
        v
A fails and exits loop
        |
        v
B has no executor
```

The implementation now checks pending after the current in-flight ends; if there are still events, it automatically starts the next round. A's callers still receive failure, and the previous successful snapshot continues to be retained. Dedicated tests cover the complete sequence of "refresh A blocks, event B arrives, A fails, B continues publishing new snapshots".

## Connectivity

Provider Connectivity remains an actual product capability. The model row on the settings page provides a test connection entry, calling the new Config and Account Request Auth chain through `IProviderSettingsService.testModelConnectivity()`.

Outdated are the three direct calls in `packages/services/test/modelProviderConnectivityProbe.test.ts`, which still pass the old `endpoints/model/provider`, while the production Probe receives `baseURL/modelId/modelConfig/providerId`. These tests have now migrated to the formal inputs, continuing to cover the request URL, Headers, Reasoning Mapping, and protocol request body. The Connectivity product capability and production implementation did not change in this round.

## Boundaries After Review

The execution correctness and release-blocking items discovered by this review have been resolved. The settings page has since been changed to directly use the formal Config/View, and the old form DTO inside the Renderer has been deleted, as documented in Implementation Log section 281.

The remaining work is only M7's independent product capabilities: Provisioning Sync from local to remote and remote settings operations. The remote Registry's fact authority remains at the remote end; this capability will not restore the Host Snapshot or change M2's Provider fact chain.
