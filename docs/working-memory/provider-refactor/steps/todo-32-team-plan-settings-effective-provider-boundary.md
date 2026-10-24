# Todo 32: Team Plan Settings Page and Effective Provider Boundary Consolidation

> Status: Completed
>
> Date: 2026-08-27
>
> Source: Team Plan settings page real-device experience and Provider Refactor boundary review
>
> Related tasks: [`Todo 27`](./todo-27-provider-settings-dogfood-closeout.md),
> [`Todo 17`](./todo-17-provider-registry-settings-authority-boundary-closure.md)

## 1. Problem

The Team Plan settings page squeezed navigation identity, Effective Provider, account connection, plan entitlement,
quota query and error display into one `ModelProviderNavItem`, and the detail page used plan `status` to decide
whether to render the whole Provider config area (gate `dedicatedProvider !== null && status === "purchased"`). Quota
loading, request failure, project Key unavailable or server-confirmed unassigned all made the existing Effective
Provider, model list and Personal Model Config editing entry disappear. "Team plan unassigned" was reverse-deduced via
`statusLabelId`, merging server-confirmed unassigned, Project Key unavailable, quota request failed/unknown and quota
loading into `unavailable` / `teamUnavailable`. The status card display thereby became wrongly authoritative for
whether Provider config exists, and temporary unknown was misreported as unassigned.

## 2. Authority Boundaries

### 2.1 `ProviderSettingsView`

`ProviderSettingsView` is not a new config layer or second authority; it is a read-only projection of the same formal
Resolver result:

```text
Built-in -> Account -> Personal -> Effective Provider Config
                                     +--> ProviderSettingsView (complete settings projection)
                                     `--> Provider Registry (complete & executable members only)
```

`providers[].effectiveConfig` and `models[].effectiveConfig` are the final display results.
`effectiveBuiltinConfig`, `personalConfig`, `personalExactConfig` and `issues` supplement editing source, restore
defaults, sparse save and repair information and take part in no second Overlay. The settings page cannot read the
Registry only, because disabled or incomplete Providers/Models are excluded from Registry but must stay visible and
repairable in settings.

### 2.2 Renderer does not understand Account Overlay

Account Overlay only participates in generating Effective Provider Config upstream of the Resolver. The settings page
never re-reads, applies or infers Account Overlay `enabled`, model members or Access; it reads final
`effectiveConfig`, `models`, `enabled`, `executable` and `issues`. Static account Access for Team entitlement/usage
requests comes from the selected Effective Provider's `effectiveConfig.access`; the current Team connection's
`productId / organizationId / projectId` come from navigation selection, serve only as the entitlement/quota request
context, and are not written back to Provider Config, Account Overlay, Personal Config or Registry.

### 2.3 Plan status does not own Provider config visibility

```text
ProviderSettingsView -> selected providerId: effectiveConfig, effective models, enabled/executable, Personal editing source -> Provider config area
Team Plan selection (productId, organizationId, projectId) -> entitlement / quota -> plan status card
```

The two projections combine only in the right detail layout. Plan query results can affect the status card, quota,
retry and purchase/manage operations but cannot decide the existence of Effective Provider, model list or model
editing entry.

## 3. Target Page Structure

As long as the current Team Provider exists in `ProviderSettingsView`, the right side always shows one Provider page:
title/status/connection method; Team Plan status card (organization / project / quota / error / retry); Effective
model list (toggle and edit per model).

- Team Provider model display, ordering, enable/disable and Personal Model Config editing use the unified Provider
  settings component.
- Start Plan's account-specific model members keep their existing read-only boundary (unchanged).
- Individual / Team Coding Plan pages completely hide Endpoint and API Schema (a settings page product projection;
  the fields stay in Effective Provider Config for Registry/Runtime and Renderer never copies, clears or overrides
  them). Account Access is also not an editable form field. They reuse the unified Provider editor with the
  connection fact area fixed disabled and must not re-expose Endpoint/API Schema or create a deleted-field Account
  Provider DTO.
- Provider disabled, incomplete config or plan unavailable: models still display and are editable, with executable
  facts shown accurately.
- While loading show a loading state; after loading a truly missing Provider shows a Provider config exception, not
  "unpurchased" or "unassigned".

## 4. Status Semantics

Team Plan status keeps explicit reasons and is no longer reverse-inferred from a generic `statusLabelId`:

| Status                   | Plan card behavior                                           | Provider config area                    |
| ------------------------ | ------------------------------------------------------------ | --------------------------------------- |
| checking                 | Display loading, clear previous Team quota                   | Display if Provider exists              |
| available                | Display team identity and quota                              | Display                                 |
| explicitly-not-allocated | Explicitly display "team plan unassigned"                    | Display                                 |
| credential-unavailable   | Display Project Key/credential reasons and available actions | Display                                 |
| request-failed / unknown | Display fetch failure and allow retry, not called unassigned | Display                                 |
| provider-loading         | Display Provider loading                                     | Editor not yet displayed                |
| provider-missing         | Display independent config exception                         | Do not render a fake plan purchase page |

Specific types may reuse existing upstream decisions or a page-local decision union, but only as plan card View
State; they never enter Provider Config or become a second Account/Registry state.

## 5. Implementation Requirements

- Remove the `status === "purchased"` rendering gate for the whole `InlineEditableProviderCard`; decide the config
  area only by whether the current `providerId` resolves in `ProviderSettingsView`.
- `CodingPlanStatusPanel` is always an independent `statusSection` in Provider detail.
- The model list consumes only the current Provider View's `models` and each `effectiveConfig`, not entitlement data.
- Narrow `ModelProviderNavItem` to navigation identity (key / type / label, providerId, Team productId /
  organizationId / projectId); Provider detail resolves independently from `ProviderSettingsView` by `providerId`;
  the plan card status resolves independently from the entitlement hook by Team selection. Final state: no old
  branch controls Provider detail existence by `status/statusLabelId`.
- Delete the `selectedTeamPlanUnassigned` comparison to `statusLabelId` and the logic merging
  `apiKeyStatus=unavailable` with `quota unavailable` into `teamUnavailable`. Request failure, loading and no
  matching snapshot express only unknown; "Team plan unassigned" is shown only when an authoritative response
  explicitly proves no Team allocation/quota. Status card actions (retry, reconnect, manage plan) follow explicit
  reasons, not display text.

State owners: Effective Provider/Model — Provider Config Resolver (`ProviderSettingsView`, from formal Config source);
Personal Provider/Model editing — Personal Config Repository (Settings Draft/Facade, persisted); Provider
executability — Resolver + Registry integrity (`enabled/executable/issues`, no independent field); Team current
connection identity — Family connection selection (navigation selection, existing settings); Team plan, quota and
error — Entitlement/Quota Service (`CodingPlanStatusPanel`, existing cache only); request-period credentials — Host
Account Request Auth Service (not persisted on the settings page).

## 6. Invariants and Out of Scope

- Overlay order stays Built-in -> Account -> Personal; Model Rules stay Built-in + Personal with Personal deferred.
- Renderer does not re-execute Overlay, integrity validation or Registry admission algorithms.
- Account Overlay still constrains Built-in account Providers but only through Resolver-reflected Effective results.
- Team quota/entitlement UI never directly modifies Provider `enabled`.
- Settings shows disabled/incomplete members; Registry retains only complete executable members.
- Team scope is not written back to Config; connection testing and real requests go through the formal
  Registry/ModelFactory.
- Hiding Endpoint/API Schema for Individual / Team affects only UI visibility.
- Desktop, Web and phone share settings page behavior; desktop continuous, mobile replayable, remote workspace and
  model selection lifecycle are unchanged.

Not modified: Account Overlay generation rules and priority; Team entitlement, quota and billing server contracts;
Start Plan account model whitelist semantics; Request Auth, Runtime Headers and model network protocols; Remote
Provisioning, release artifacts and real account verification.

## 7. Acceptance Matrix

| Provider View       | Team status              | Expected config area                           | Expected status card                    |
| ------------------- | ------------------------ | ---------------------------------------------- | --------------------------------------- |
| Exists and enabled  | available                | Full display, editable allowed Personal fields | Quota normal                            |
| Exists but disabled | available/unknown        | Display and accurately mark non-executable     | Corresponding status                    |
| Exists              | checking                 | Display, no model list flicker                 | Loading                                 |
| Exists              | request-failed           | Display                                        | Fetch failure + retry                   |
| Exists              | explicitly-not-allocated | Display                                        | Explicitly unassigned                   |
| Exists              | credential-unavailable   | Display                                        | Credential reasons                      |
| Loading             | any                      | Provider loading                               | Status must not disguise as unpurchased |
| Truly missing       | any                      | Config exception                               | Can retain known plan facts             |

Automation covers: Provider exists with Team quota loading / request failed / explicitly unassigned / Project Key
unavailable (model list and editing entry still render, and the card shows the real reason, never falsely
unassigned); Provider missing vs plan unavailable use different UI states; Team and Start model editing permissions
keep their differences; Individual / Team Coding Plan pages do not render Endpoint and API Schema and hiding does not
change the save payload or runtime config; Resolver-generated Effective Provider/Model passes through
`ProviderSettingsFacade` intact; Account `enabled/models/access` are not merged twice in Renderer; Personal
last-layer override still shows in Effective results and save still produces a sparse Overlay; Team status changes
re-render only the plan card without unloading the model list or losing the model editing Draft; Provider/model
ordering, toggle, editing, connection testing and save feedback do not regress; Chinese/English, light/dark, desktop
and narrow-screen layout stay usable.

## 8. Completion and Outcome

- Team / Individual Provider detail resolves precisely from `ProviderSettingsView` by `providerId` (no stale
  navigation-item Provider copy); a loaded View with the target Provider missing shows an independent config
  exception.
- The plan status card no longer gates the Provider config area: quota loading, failure, explicit unassignment and
  Project Key unavailability all still show the existing Effective Provider and model list.
- `not-allocated` and `credential-unavailable` are explicit page status reasons; quota recovery clears the old "team
  plan unassigned" status.
- Team / Individual pages reuse the unified Provider editor but fixedly hide the connection config area and API key
  area, so Endpoint and API Schema are not displayed; Effective Provider Config, Registry and ModelFactory data are
  not deleted. Start Plan keeps existing read-only models and purchase gate.
- No new second Config, Overlay, Registry, plan or Account Access authority.

Verification: Provider UI directed tests 220 passed; full unit 1470 test files / 12480 tests passed (pre-existing
skips); root `typecheck`, `lint`, changed-file format check and `git diff --check` passed. Workspace `fmt:check` is
still blocked by pre-existing Electron example HTML and GB2312 fixture.
