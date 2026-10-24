# M2 Merge Request Static Review

> Status: Pre-release issues resolved item by item
>
> Date: 2026-08-20
>
> Review baseline: initial issues found at `origin/staging` `cf009a3b199c`; final status per M2 Cleanup and Implementation Log (item 251 holds final verification and baseline failure evidence)
>
> Phase goal: [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/02-provider-config-and-registry-mr-review.md`

Result of a full static review of the M2 Merge Request. Every fix added a failing test and targeted regression.

## Current Assessment

| ID  | Issue                                                         | Final state                                                                                                                                    | Status                                    |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| R1  | Settings page converted through old `ModelProviderConfig`     | Renderer edit state uses the same Source View as the formal Config; old Store fields and reverse conversion left the settings page            | Resolved                                  |
| R2  | New custom Provider required an existing Settings View        | New creation saves from the complete form Draft with no inheritance View; editing an existing Provider reuses the View                         | Fixed                                     |
| R3  | Account Access could enter Personal Config                    | Personal projection ignores the dynamic `accessId` injected by Account Overlay (Official / Personal / Account three-layer boundary)            | Fixed                                     |
| R4  | `reasoningMapping` diff conflicts with Overlay semantics      | Save complete fields when Mapping changes (full-coverage rule for normal value fields)                                                         | Fixed                                     |
| R5  | Request auth refresh re-entered Registry                      | `Model` creation captures a static Provider execution snapshot; request auth covers only API Key and Header for that snapshot                  | Fixed                                     |
| R6  | Logout and re-login could reuse an old Coding Plan Key        | Capture account identity before OAuth cleanup and delete the account-scoped Key; re-login forces refresh with the new Token                    | Fixed                                     |
| R7  | Settings save could overwrite concurrent Personal Config edits | Save moved into Repository atomic `update()`, modifying only the target Provider and its exact model rules inside the lock                    | Fixed                                     |
| R8  | Account refresh failure could strand pending reasons          | Failed rounds release in-flight and continue consuming events that arrived during the wait; the last successful snapshot remains               | Fixed                                     |
| R9  | Connectivity test still called old Probe parameters           | Production "test connection" kept; dedicated tests migrated to the formal Provider/Model Config request shape                                 | Fixed                                     |
| R10 | Remote Workspace mixed remote model facts with local account  | Remote Host/Worker use their own Config, Credential, Account Source and Registry; Desktop no longer pushes Provider/Secret                     | Resolved; Provisioning Sync belongs to M7 |

## Rules and Boundaries Established

1. **Settings edit chain.** The Renderer edit state (`ProviderSettingsFormProvider`: `providerId` + Registry
   projection state, `config: ProviderConfigObject`, `models: { modelId, config: ModelConfigObject }[]`) uses the
   same field structure as the formal Config; no old endpoints / kind / modalities / ProviderOptionsPatch semantics.
   Code: `packages/ui/src/lib/providerSettingsFormProjection.ts`, `providerPersonalSave.ts`,
   `packages/ui/src/hooks/useModelProviders.ts`. The edit state is private interaction state; it reads no physical
   config, builds no Registry, decides no selectability, creates no Models. The Facade/Repository computes the
   sparse Personal Overlay relative to Official after saving the complete Effective Config.
2. **New vs existing Provider.** A new `providerId` is not in the Registry, so saving and connectivity testing build
   the Effective Config from the complete new-form Draft. Editing copies the complete Effective Config from the
   Settings View; controls change only their fields, unexposed fields stay as-is.
3. **Possible future enhancement** (not in scope): a Personal Draft separating `effectiveConfig`, `personalConfig`
   and `inherited/default` if controls must distinguish inherited from explicit Personal values.
4. **Model Config projection.** The page directly edits only Model ID, Context Window and Max Output Tokens; the edit
   state keeps the complete `ModelConfigObject`, so other edits never round-trip `reasoningMapping` through a Patch.
   `ModelConfig.overlay()` replaces `reasoningMapping` as a normal value: unchanged Mapping writes no Personal field;
   a changed Mapping saves the complete Mapping.
5. **Model and request auth boundary.** Account Request Auth Service supplies API Key and Header at request time.
   `bindModel()` captures the Provider static execution config and Model capabilities at creation; a request attempt
   merges only dynamic API Key/Header onto that snapshot, so Registry hot updates affect only later-created Models
   (an old Model keeps its Provider Factory, Endpoint, API Format, Provider Options and static Headers but receives
   the latest request auth). Network routing, proxy and signing remain Adapter dynamic facilities on their own
   lifecycle.
6. **Account credential lifecycle.** Personal Coding Plan Keys use Access ID `coding-plan:<provider>:account:<accountIdentity>`.
   Logout used to delete only the account-unscoped `coding-plan:<provider>` key, and the OAuth Session was cleared
   before the Logout Handler ran. Now the OAuth Service reads the current Profile ID before clearing the main session
   and passes it with the Provider ID to the Handler, which deletes the exact scoped Key and still cleans unscoped
   old keys in the compatibility window. This chain covers explicit logout, unlink, expired JWT invalidation and
   logout-all; when identity cannot be obtained on credential-damage recovery, old keys are still cleaned and the
   Account Source takes the Provider offline. The `oauth-login-entitlement` event emitted after login triggers
   `forceCredentialRefresh` (skips caches, overwrites the Key with the new OAuth Token); historical `oauth-callback`
   refresh stays compatible. Longer term: a structured `forceRefreshCredentials` parameter instead of reason strings.
7. **Personal Config concurrent writes.** `PersonalProviderConfigRepository.update()` provides cross-process file
   locks and lock-internal read-modify-write. `ProviderSettingsFacade` passes the Effective Provider and exact model
   config to `ProviderConfigService`, which reads the latest Personal Config inside `update()`, computes the
   projection relative to Official and replaces only the target `providerId` and its exact model rules. Pattern rules
   and other Providers' concurrent updates are untouched. Full replacement is only for version migration and explicit
   full imports.
8. **Account refresh timing.** After the in-flight refresh ends (even by failure) the loop checks `pendingReasons`
   and starts the next round; callers of the failed round still get the failure and the previous successful snapshot
   is retained. Test: refresh A blocks, event B arrives, A fails, B publishes a new snapshot.
9. **Connectivity.** Provider Connectivity stays a product capability: the model row offers a test connection entry
   through `IProviderSettingsService.testModelConnectivity()` on the new Config and Account Request Auth chain. Three
   tests in `packages/services/test/modelProviderConnectivityProbe.test.ts` that passed old
   `endpoints/model/provider` now use the production Probe input (`baseURL/modelId/modelConfig/providerId`) and still
   cover request URL, Headers, Reasoning Mapping and body.

## Open Items

- M7 only: Provisioning Sync from local to remote and remote settings operations. The remote Registry stays the
  authority; this will not restore the Host Snapshot or change M2's Provider fact chain.
- The old form DTO inside the Renderer was deleted afterwards (Implementation Log section 281).
