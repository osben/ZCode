# Provider Settings Experience Issue Log (2026-08-27)

## 1. Purpose

Issues from the first round of macOS real-package experience after the Provider Refactor. Handling principles:

- Issues not changing Provider/Model Config, Overlay, or Registry abstractions are directly fixed and pinned by tests;
- Issues involving Account Overlays, plan entitlements, or model availability fact sources record runtime evidence and code boundaries only, awaiting rulings;
- Do not cover domain issues with UI fallbacks, forced enabling, or bypassing Resolvers.

## 2. Directly Fixed

| Issue                                                        | Root Cause                                                                                                                                                    | Post-Fix Contract                                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical Provider duplicate names blocking unrelated saves | Uniqueness gates re-executed on the entire Effective Provider set during save; migration-legacy duplicate names block any Provider                            | Only prevent new duplicates from this name change; existing historical duplicates do not block other saves                                                    |
| Empty Base URL cannot save draft Provider                    | Renderer serializes empty input as `baseURL: ""`, rejected by URL Schema before Resolver judges completeness                                                  | Null values do not write `baseURL`; Providers can save but cannot execute; non-empty illegal URLs still rejected                                              |
| Provider/Model entire rows cannot be dragged                 | Providers depend on independent grips; Model's custom Pointer Sensor misjudges the `useSortable` auto-added row-level `role=button` as an interactive control | Provider and Model names, icons, and non-interactive blanks can all initiate entire-row dragging, except real controls; text selection prohibited during drag |
| Model dialogs can penetrate and drag background models       | Radix Dialogs render through Portals, but React events still bubble up the component tree to the model row's DnD activator                                    | Dialog content, overlays, and explicit `data-no-model-drag` areas cannot initiate background sorting                                                          |
| Model row info and switch arrangement chaotic                | Summaries and operations lack stable layout boundaries                                                                                                        | Context follows Model ID; switches fixed to the far right of model rows; model rows provide no single-field "restore default"                                 |
| Provider enable/disable duplicates display                   | Status labels and operation buttons each occupy space                                                                                                         | One button simultaneously expresses current state and executes the toggle                                                                                     |
| Model editor disguises inherited values as Personal input    | Drafts initialize with Effective Config; JSON additionally redundantly displays read-only values                                                              | When Personal input is empty, inherited values serve only as placeholders; delete the redundant read-only JSON area                                           |
| Model editor hierarchy too deep and nearly full-screen       | Common fields mixed in "Advanced" collapsible; dialog max height nearly the entire viewport                                                                   | Remove "Advanced"; desktop uses centered medium max height, scrolling only the content area                                                                   |
| Model editor field order does not match usage frequency      | Max Output, input/output formats ranked after capabilities and complex JSON                                                                                   | `Model ID/Enable -> Context -> Max Output -> Input -> Output -> Capabilities -> Complex Config`                                                               |
| Can only restore inherited values field by field             | Lacks a model-level clear Personal Overlay entry                                                                                                              | Footer provides "restore all defaults", clearing that model's Personal Model Config Overlay before users save                                                 |
| Domestic Providers ranked late in new menu                   | Menus directly use Built-in configuration order; old order placed overseas Providers first                                                                    | Unified Built-in configurations and new menus list domestic Providers first, then overseas Providers                                                          |

## 3. Personal Config Sources and Official Name Verification

Pre-migration and pre-cleanup backups on Pro machines prove the chain: old `~/.zcode/v2/config.json.provider` → Provider V1 importer → new `config.json.providers` + `modelConfigRules`. The pre-cleanup Personal Config is not the new Official Config content itself but the migration projector's result, containing: editable `builtin:*` Provider configurations from old versions; user-created custom Providers; and Personal overrides to standard Provider order, model members, and model properties. The old Coding Plan duplicate names in screenshots are migration-legacy, not the current Official Config creating same-name Providers. Current `config/provider/zcode-builtin.json` Provider labels are verified unique; Z.ai/BigModel's APIs, Individual, Team, Start, and Idle Plans use different names. Personal Config cleanups kept timestamped backups for recovery.

## 4. Pending Rulings: Team Plan Valid But Account Provider/Entitlement Display Unavailable

### 4.1 Runtime Facts

Pro's `~/.zcode/v2/logs/2026-08-27.log`, after the same Team Plan selection, shows simultaneously:

- Settings has persisted `bigmodel -> team-coding-plan`, including product, organization, project;
- Team Plan project validation hits the selected project; organization list is non-empty;
- Team Plan quota API returns business success with quota data;
- But Usage entitlement for `account:bigmodel-team-coding-plan` records `organizationId/projectId` as `null`, then reports no available entitlements found;
- The Registry has published only one Personal Provider; no Team Account Provider entered the executable set.

"Account truly has a Team Plan" and "page displays failure to obtain" are not a true/false conflict of one upstream request but a breakage in plan selection facts entering different consumers.

### 4.2 Current Chain

```text
setting.json
providerFamilyConnectionSelections.bigmodel
{ kind: team, organizationId, projectId, productId }
          |
          +-------------------------------+
          |                               |
          v                               v
Account Provider Resolver          Settings Usage entitlement
  -> Family availability             -> Reverse-lookup Account Access from
  -> Team project/quota success          ProviderSettingsView
  -> Generate Account Overlay         -> Reality test returns null org/project
          |                               |
          v                               v
Effective Provider / Registry       "Temporarily unable to confirm Coding Plan entitlement"
```

`createAccountProviderConnectionResolver()` reads Family selections directly and creates team-scoped `ZhipuAccountAccessConfig` only after availability. The Renderer's `resolveAccountProviderAccess()` accepts only results already in `ProviderSettingsView.effectiveConfig.access` passing the full Account Access Schema — the entitlement UI reuses the Account Overlay output as its own access input, so once the Overlay fails to publish complete access, the page cannot use the already-persisted Team selection in `setting.json` to explain the failure.

### 4.3 Fixes Not Directly Applicable

- Cannot force-Flag Providers as enabled in the Renderer because Team quota requests succeed; this bypasses Account Overlays.
- Cannot let Usage UIs construct a new `accessId` or Account Config; this produces second sets of Account Access facts.
- Cannot fall back to fixed Provider IDs or default models when the Registry is empty; this breaks Provider/Model identity boundaries.

### 4.4 Issues to Align Subsequently

1. Which exact step loses complete access between Team selection and Account Overlay publishing; add observable evidence and reproducibility testing to Connection Results/Overlay publishing.
2. Whether Usage entitlement continues to consume Effective Account Access or should consume account connection-domain selection facts; the two responsibilities need unifying, not independent assembly.
3. How Settings Views present "plan valid" and "Provider not executable" diagnostics when Account Providers are verified available but have not entered the Registry, instead of uniformly displaying "acquisition failed."

Before these are ruled, this round does not modify Account Overlays, accessIds, plan model member constraints, or Registry integrity semantics.
