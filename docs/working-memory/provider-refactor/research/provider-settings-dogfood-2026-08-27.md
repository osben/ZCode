# Provider Settings Experience Issue Log (2026-08-27)

## 1. Purpose

This document records issues discovered during the first round of macOS real-package experience after the Provider Refactor. Handling principles:

- Issues that do not change existing Provider/Model Config, Overlay, or Registry abstractions are directly fixed and pinned by tests;
- Issues involving Account Overlays, plan entitlements, or model availability fact sources only record runtime evidence and code boundaries, awaiting rulings;
- Do not cover domain issues with UI fallbacks, forced enabling, or bypassing Resolvers.

## 2. Directly Fixed

| Issue                                                        | Root Cause                                                                                                                                                    | Post-Fix Contract                                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical Provider duplicate names blocking unrelated saves | Uniqueness gates re-executed on the entire Effective Provider set during save; migration-legacy duplicate names block any Provider                            | Only prevent new duplicates from this name change; existing historical duplicates do not block other saves                                                    |
| Empty Base URL cannot save draft Provider                    | Renderer serializes empty input as `baseURL: ""`, rejected by URL Schema before Resolver judges completeness                                                  | Null values do not write `baseURL`; Providers can save but cannot execute, non-empty illegal URLs still rejected                                              |
| Provider/Model entire rows cannot be dragged                 | Providers depend on independent grips; Model's custom Pointer Sensor misjudges the `useSortable` auto-added row-level `role=button` as an interactive control | Provider and Model names, icons, and non-interactive blanks can all initiate entire-row dragging, except real controls; text selection prohibited during drag |
| Model dialogs can penetrate and drag background models       | Radix Dialogs render through Portals, but React events still bubble up the component tree to the model row's DnD activator                                    | Dialog content, overlays, and explicit `data-no-model-drag` areas cannot initiate background sorting                                                          |
| Model row info and switch arrangement chaotic                | Summaries and operations lack stable layout boundaries                                                                                                        | Context follows Model ID; switches fixed to the far right of model rows; model rows provide no single-field "restore default"                                 |
| Provider enable/disable duplicates display                   | Status labels and operation buttons each occupy space                                                                                                         | One button simultaneously expresses current state and executes the toggle                                                                                     |
| Model editor disguises inherited values as Personal input    | Drafts initialize with Effective Config; JSON additionally redundantly displays read-only values                                                              | When Personal input is empty, inherited values only serve as placeholders; delete redundant read-only JSON area                                               |
| Model editor hierarchy too deep and nearly full-screen       | Common fields mixed in "Advanced" collapsible, dialog max height nearly the entire viewport                                                                   | Remove "Advanced"; desktop uses centered medium max height, scrolling only the content area                                                                   |
| Model editor field order does not match usage frequency      | Max Output, input/output formats ranked after capabilities and complex JSON                                                                                   | `Model ID/Enable -> Context -> Max Output -> Input -> Output -> Capabilities -> Complex Config`                                                               |
| Can only restore inherited values field by field             | Lacks a model-level clear Personal Overlay entry                                                                                                              | Footer provides "restore all defaults", clearing that model's Personal Model Config Overlay before users save                                                 |
| Domestic Providers ranked late in new menu                   | Menus directly use Built-in configuration order; old order placed overseas Providers first                                                                    | Unified Built-in configurations and new menus list domestic Providers first, then overseas Providers                                                          |

## 3. Personal Config Sources and Official Name Verification

The pre-migration backup and pre-cleanup backup retained on Pro machines prove:

```text
Old ~/.zcode/v2/config.json.provider
        |
        | Provider V1 importer
        v
New config.json.providers + modelConfigRules
```

The pre-cleanup Personal Config is not the new Official Config content itself, but the result of the migration projector projecting old configs into new Personal Overlays,
which simultaneously contains:

- Editable `builtin:*` Provider configurations from old versions;
- User-created custom Providers;
- User's Personal overrides to standard Provider order, model members, and model properties.

Therefore the old Coding Plan duplicate names in screenshots are migration-legacy, not the current Official Config creating another same-name Provider. Current
`config/provider/zcode-builtin.json`'s Provider labels have been verified as unique; Z.ai/BigModel's APIs, Individual, Team, Start, and
Idle Plans use different names. Personal Config cleanups executed for continued experience retained timestamped backups for recovery.

## 4. Pending Rulings: Team Plan Valid but Account Provider/Entitlement Display Unavailable

### 4.1 Runtime Facts

Pro's `~/.zcode/v2/logs/2026-08-27.log` shows the following simultaneously after the same Team Plan selection:

- Settings has persisted `bigmodel -> team-coding-plan`, including product, organization, project;
- Team Plan project validation hits the selected project, organization list is non-empty;
- Team Plan quota API returns business success with quota data;
- But Usage entitlement for `account:bigmodel-team-coding-plan` records `organizationId/projectId` as `null`, subsequently reporting no available entitlements found;
- The Registry has only published one Personal Provider at this point, without observing Team Account Providers entering the executable set.

This proves that "account truly has a Team Plan" and "page displays failure to obtain" are not the same upstream request's true/false conflict, but a breakage in plan selection facts when entering different consumers.

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

`createAccountProviderConnectionResolver()` itself directly reads Family selections and creates team-scoped
`ZhipuAccountAccessConfig` only after availability. Meanwhile, Renderer's `resolveAccountProviderAccess()` only accepts results already appearing in
`ProviderSettingsView.effectiveConfig.access` and passing the full Account Access Schema. In other words, the entitlement UI
reuses the Account Overlay output as its own access input; once the Overlay fails to publish complete access, the page cannot use
the already-existing Team selection in `setting.json` to explain failure reasons.

### 4.3 Fixes Not Directly Applicable

- Cannot force-Flag Providers as enabled in the Renderer just because Team quota requests succeed; this bypasses Account Overlays.
- Cannot let Usage UIs construct a new `accessId` or Account Config; this produces second sets of Account Access facts.
- Cannot fall back to fixed Provider IDs or default models when the Registry is empty; this breaks Provider/Model identity boundaries.

### 4.4 Issues to Align Subsequently

1. Which exact step loses complete access between Team selection and Account Overlay publishing; observable evidence and reproducibility testing need to be added to Connection Results/Overlay publishing.
2. Whether Usage entitlement continues to consume Effective Account Access, or should consume account connection-domain selection facts; the responsibilities of the two need to be unified, not independently assembled.
3. How Settings Views should simultaneously present "plan valid" and "Provider not executable" diagnostics when Account Providers have been verified available but have not entered the Registry, rather than uniformly displaying "acquisition failed."

Before these issues are ruled, this round does not modify Account Overlays, accessIds, plan model member constraints, or Registry integrity semantics.
