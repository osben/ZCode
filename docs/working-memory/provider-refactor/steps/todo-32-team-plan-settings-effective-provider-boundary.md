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

Team Plan settings page currently squeezes navigation identity, Effective Provider, account connection, plan entitlement, quota query, and error display into same
`ModelProviderNavItem`. Detail page then uses plan `status` to decide whether to render entire Provider config area:

```text
Provider config facts
Account connection status
Plan purchase status
Team quota query
Team Project API Key status
Page navigation info
        |
        v
ModelProviderNavItem.status
        |
        +-- purchased -> plan card + Provider/model config
        `-- other states -> plan card only, hide Provider/model config
```

Actual gate requires `dedicatedProvider !== null && status === "purchased"`. Therefore quota loading, request failure, project Key
unavailable, or server-confirmed unassigned all cause existing Effective Provider, model list, and Personal Model Config editing entry to
disappear simultaneously.

Current implementation also reverse-deduces "team plan unassigned" via `statusLabelId`, merging multiple causes into `unavailable`:

```text
server-confirmed unassigned ───────────────┐
Team Project Key unavailable ──────────────┤
quota request failed / status unknown ───────┼─> unavailable / teamUnavailable
quota loading with no snapshot ────────────┘
```

This makes "what plan status card displays" erroneously authoritative for "whether Provider config exists," and misreports temporary unknown as server-confirmed
unassigned.

## 2. Decided Authority Boundaries

### 2.1 ProviderSettingsView Meaning

`ProviderSettingsView` is not a new config layer or second config authority. It is the same formal Resolver result read-only projection for settings page:

```text
ZCode Built-in Provider Config
             |
             v
Account Provider Config
             |
             v
Personal Provider Config
             |
             v
Effective Provider Config
             |
             +-------------------------+
             |                         |
             v                         v
ProviderSettingsView              Provider Registry
complete settings projection      complete & executable members only
```

`ProviderSettingsView.providers[].effectiveConfig` and `models[].effectiveConfig` are settings page display Provider/Model final
results. `effectiveBuiltinConfig`, `personalConfig`, `personalExactConfig`, and `issues` only supplement editing source, restore defaults,
sparse save, and incomplete config repair information, participating in no second Overlay.

Settings page cannot read-only Registry, because disabled or incomplete Provider/Model excluded by Registry, but must still remain in settings page for user
view and repair.

### 2.2 Renderer Does Not Understand Account Overlay

Account Provider Config only participates in generating Effective Provider Config upstream of Resolver:

```text
Built-in -> Account -> Personal -> Effective
```

Provider settings page must not re-read, apply, or infer Account Overlay `enabled`, model members, or Access. Page uniformly reads
final `effectiveConfig`, `models`, `enabled`, `executable`, and `issues` from `ProviderSettingsView`.

Team entitlement/usage requests' static account Access also obtained from selected Effective Provider's `effectiveConfig.access`;
current Team connection's `productId / organizationId / projectId` from navigation selection, only serves as this entitlement/quota request context, not written back to
Provider Config, Account Overlay, Personal Config, or Registry.

### 2.3 Plan Status Does Not Own Provider Config Visibility

Team Plan page fixed composed of two independent projections:

```text
ProviderSettingsView
└─ selected providerId
   ├─ effectiveConfig
   ├─ effective models
   ├─ enabled / executable
   └─ Personal editing source
             |
             v
      Provider config area

Team Plan selection
├─ productId
├─ organizationId
└─ projectId
             |
             v
      entitlement / quota
             |
             v
         plan status card
```

Two projections combined only in right detail layout. Plan query results can affect status card, quota, retry, and purchase/manage operations, but cannot decide Effective
Provider, model list, or model editing entry existence.

## 3. Target Page Structure

As long as current Team Provider exists in `ProviderSettingsView`, right side always maintains same Provider page:

```text
┌─────────────────────────────────────┐
│ Provider title, status, and connection method       │
├─────────────────────────────────────┤
│ Team Plan status card                    │
│ Organization / project / quota / error / retry    │
├─────────────────────────────────────┤
│ Effective model list                   │
│ Model A                  [toggle][edit]│
│ Model B                  [toggle][edit]│
└─────────────────────────────────────┘
```

- Team Provider model display, ordering, enable/disable, and Personal Model Config editing continue using unified Provider settings component;
- Start Plan's account-specific model members keep existing read-only boundaries, this Todo does not change;
- Individual / Team Coding Plan pages completely hide Endpoint and API Schema. This is settings page product projection: fields continue in
  Effective Provider Config for Registry/Runtime use, Renderer does not copy, clear, or override;
- Account Access also not displayed as editable form field;
- Provider disabled, incomplete config, or plan unavailable: models still display and editable, but executable facts must accurately displayed;
- Provider loading state displayed while loading; after loading completes, truly missing shows Provider config exception, cannot disguise as unpurchased or unassigned.

## 4. Status Semantics

Team Plan status must retain explicit reasons, no longer reverse-inferred by generic `statusLabelId`:

| Status                     | Plan card behavior                           | Provider config area    |
| ------------------------ | ------------------------------------ | -------------------- |
| checking                 | Display loading, clear previous Team quota       | Display if Provider exists  |
| available                | Display team identity and quota                   | Display                 |
| explicitly-not-allocated | Explicitly display "team plan unassigned"             | Display                 |
| credential-unavailable   | Display Project Key/credential reasons and available actions  | Display                 |
| request-failed / unknown | Display fetch failure and allow retry, not called unassigned | Display                 |
| provider-loading         | Display Provider loading                   | Editor not yet displayed       |
| provider-missing         | Display independent config exception                     | Do not render fake plan purchase page   |

Specific types can reuse existing upstream decision results or establish page-local decision union, but only as plan card View State, not entering Provider Config
or becoming second Account/Registry state.

## 5. Implementation Plan

### 5.1 Write Failing Tests First

1. Provider exists and Team quota loading: still render model list;
2. Provider exists and quota request failed: still render model list and editing entry;
3. Provider exists and server explicitly unassigned: display unassigned hint but still render model list;
4. Project Key unavailable: display real reason, do not falsely claim quota unassigned, Provider config still exists;
5. Provider missing and plan unavailable use different UI states;
6. Team and Start model editing permissions keep differences, not unified by shared component.
7. Individual / Team Coding Plan pages do not render Endpoint and API Schema; hiding cannot change save payload or runtime config.

### 5.2 Remove Error Gate

- Delete `status === "purchased"` rendering gate for entire `InlineEditableProviderCard`;
- Only decide config area by whether current `providerId` can resolve Provider in `ProviderSettingsView`;
- `CodingPlanStatusPanel` always independent `statusSection` in Provider detail;
- Model list only consumes current Provider View's `models` and each item's `effectiveConfig`, does not construct model members from entitlement data.
- Individual / Team Coding Plan reuse unified Provider editor with connection fact area fixed disabled; must not re-expose
  Endpoint, API Schema for model list display, or create deleted-field Account Provider DTO.

### 5.3 Separate Navigation Identity and Page Facts

Narrow `ModelProviderNavItem` responsibility to primarily express navigation and connection selection:

```text
Navigation identity
├─ key / type / label
├─ providerId
└─ Team productId / organizationId / projectId
```

Provider detail resolved independently from `ProviderSettingsView` by `providerId`; plan card status resolved independently from entitlement hook by Team selection
must not continue letting one navigation DTO simultaneously carry and override Provider, quota, purchase status, and error status.

If one-time type narrowing expands unrelated Family page changes, can first build one-way page projection and migrate callers; final must delete old branch
controlling Provider detail existence by `status/statusLabelId`.

### 5.4 Clean Up Status Reverse-Deduction

- Delete `selectedTeamPlanUnassigned` comparison to `statusLabelId`;
- Delete logic merging `apiKeyStatus=unavailable` with `quota unavailable` then uniformly generating `teamUnavailable`;
- Request failure, loading, and no matching snapshot can only express unknown, not express authoritative unassigned;
- "Team plan unassigned" displayed only when authoritative response explicitly proves no Team allocation/quota;
- Status card operation buttons decide retry, reconnect, or manage plan based on explicit reasons, not reverse-deduced from display text.

## 6. State Owner and Submission Boundaries

| Fact                         | Authoritative Owner                        | Page Projection                    | Persisted?         |
| ---------------------------- | --------------------------------- | --------------------------- | ------------------ |
| Effective Provider/Model     | Provider Config Resolver          | `ProviderSettingsView`      | From formal Config source |
| Personal Provider/Model editing | Personal Config Repository        | Settings Draft/Facade       | Yes                 |
| Provider executability            | Resolver + Registry integrity        | `enabled/executable/issues` | Not independent field       |
| Team current connection identity            | Family connection selection       | Navigation selection                    | Existing settings           |
| Team plan, quota, and error        | Entitlement/Quota Service         | `CodingPlanStatusPanel`     | Only existing cache          |
| Request-period credentials                   | Host Account Request Auth Service | Not persistently on settings page              | No                 |

## 7. Invariants and Out-of-Scope

Must maintain:

- Overlay order still Built-in -> Account -> Personal;
- Model Rules still Built-in + Personal, Personal deferred;
- Renderer does not re-execute Overlay, integrity validation, or Registry admission algorithms;
- Account Overlay can still constrain Built-in account Providers, but only through Resolver reflected in Effective results;
- Team quota/entitlement UI does not directly modify Provider `enabled`;
- Settings page disabled/incomplete members visible, Registry only retains complete executable members;
- Team scope not written back to Config; connection testing and real requests continue through formal Registry/ModelFactory;
- Individual / Team pages hiding Endpoint/API Schema only affects UI visibility, Effective Config and ModelFactory assembly unchanged;
- Desktop, Web, and phone share settings page behavior; not changing desktop continuous, mobile replayable, remote workspace, or model selection lifecycle.

This Todo does not modify:

- Account Overlay business generation rules and priority;
- Team entitlement, quota, billing server-side interface contracts;
- Start Plan account model whitelist semantics;
- Request Auth, Runtime Headers, and model network protocols;
- Remote Provisioning, release artifacts, or real account verification.

## 8. Verification Matrix

| Provider View   | Team status                | Expected config area                           | Expected status card           |
| --------------- | ------------------------ | ------------------------------------ | -------------------- |
| Exists and enabled  | available                | Full display, editable allowed Personal fields | Quota normal             |
| Exists but disabled | available/unknown        | Display and accurately mark non-executable               | Corresponding status             |
| Exists            | checking                 | Display, no model list flicker                 | Loading                 |
| Exists            | request-failed           | Display                                 | Fetch failure + retry      |
| Exists            | explicitly-not-allocated | Display                                 | Explicitly unassigned           |
| Exists            | credential-unavailable   | Display                                 | Credential reasons             |
| Loading          | any                     | Provider loading                     | Status must not disguise as unpurchased   |
| Truly missing        | any                     | Config exception                     | Can retain known plan facts   |

Automation must at minimum cover:

- Resolver-generated Effective Provider/Model passes through `ProviderSettingsFacade` intact into settings page;
- Account `enabled/models/access` not merged twice in Renderer;
- Personal last-layer override still reflected by Effective results, save still generates sparse Overlay;
- Team status changes only re-render plan card, do not unload model list or lose model editing Draft;
- Provider/model ordering, toggle, editing, connection testing, and save feedback do not regress;
- Chinese/English, light/dark themes, desktop, and narrow-screen layout usable;
- Provider UI directed unit tests, `pnpm typecheck`, `pnpm lint`, this round's file format check, and `git diff --check` pass.

## 9. Completion Criteria

- Team Plan any plan query status no longer controls Effective Provider config area existence;
- Settings page consumes final Effective Provider/Model only through `ProviderSettingsView`, does not understand Account Overlay;
- Navigation identity, Provider settings facts, and plan status form at least three independent links in page projection;
- "Team plan unassigned" only produced by authoritative unassigned facts, no longer reverse-deduced from errors, loading, credential issues, or i18n labels;
- Model list always visible when Provider exists, supporting ordering, enable/disable, and Personal Model Config editing by existing permissions;
- Individual / Team Coding Plan pages completely do not display Endpoint and API Schema, but runtime still uses Effective Provider Config;
- No new second Config, Overlay, Registry, plan, or Account Access authority.

## 10. Implementation Results

- Team / Individual Provider detail changed to precise parsing from `ProviderSettingsView` by `providerId`, no longer using potentially stale
  Provider copy from navigation item as page fact; View loaded but target Provider missing displays independent config exception.
- Plan status card and Provider config area rendering gate removed. Team quota loading, failure, explicit unassignment, and Project Key unavailability,
  existing Effective Provider and model lists still displayed.
- `not-allocated` and `credential-unavailable` become explicit page status reasons; status card no longer reverse-deduces business behavior from i18n labels,
  quota recovery simultaneously clears old "team plan unassigned" status.
- Team / Individual pages continue reusing unified Provider editor, but fixedly hide connection config area and API Key area, therefore Endpoint and
  API Schema not displayed on page; Effective Provider Config, Registry, and ModelFactory data not deleted.
- Start Plan retains existing read-only models and purchase gate, no account model whitelist semantics changed this round.

Verification results: Provider UI directed tests 220 passed; full unit 1470 test files, 12480 tests passed (with repository pre-existing skip items);
root `typecheck`, `lint`, this round's file format check, and `git diff --check` passed. Workspace `fmt:check` still blocked by repository pre-existing
Electron example HTML syntax and GB2312 fixture, this round's modified files independently passed format check.
