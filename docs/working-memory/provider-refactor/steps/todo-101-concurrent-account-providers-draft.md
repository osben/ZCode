# Todo 101 Draft: Multiple Specific Account Providers Coexisting

> Status: Draft / implementation postponed (2026-09-09). User decision: the current launch proceeds with the existing
> single-connection architecture; this item only records future direction. It is not a running contract and does not
> override the current spec, migration rules, Todo99 or Todo102 decisions. It must not be marked implemented, current
> launch scope, or "current design replaced".
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-101-concurrent-account-providers-draft.md`

## I. Future Product Direction

1. Personal plans, Team A and Team B are connectable and usable simultaneously; no single global current connection.
2. Settings navigation between personal/team only switches the displayed page, not global execution state.
3. Every explicit ModelSelection points to a specific personal/team Provider; the logic that maps a selection to another
   Provider by current connection is deleted.
4. Old ModelSelection Provider migration must be redesigned; "migrate everything to personal, then map at runtime to the
   current plan" cannot continue.
5. The model selector gets a drawer-style interface with Account Providers at the top (specifics pending).
6. Only one account can be logged in at a time; coexisting plans are not coexisting login accounts. Off-peak Providers
   follow that logged-in account; no extra personal/Team A/Team B off-peak quota selection is added.

```text
Single logged-in account: Personal plan, Team A, Team B, Start Plan (coexistence boundaries to be refined)
Session A -> Team A / Model / Reasoning;  Session B -> Personal / ...;  Scheduled task -> Team B / ...
The plan being viewed in Settings does not affect these execution identities.
```

## II. Current Delivery vs Future Transformation

- The current launch keeps the single-connection architecture: no preemptive removal of current gates, effective
  selection mapping, Provider ID changes, Settings/Selection persistence format, account authentication ownership,
  template rules or selector layout changes.
- Todo100-confirmed issues (sync completeness, real confirmation, dispatch parameter loss) are still decided item by
  item for the current launch; they are not "no need to handle" because the model will be removed later.
- Suspended experiments stay suspended; this document does not authorize resuming Todo99, pushing or deploying.

Guidance for current fixes:

1. Fix temporary sync correctness only; build no irretrievable new platforms.
2. Keep public applied snapshots, integrity validation, original-intent protection and exact ModelFactory; they are
   needed in future.
3. If personal/Team automatic mapping needs a fix, reuse existing public rules without more business special cases.
4. Do not entrench "switch Provider by global connection" into Model.bind or the bottom-layer Factory.
5. Do not delete current functions on future-architecture reasoning or pre-introduce dual account identity/migration paths.

## III. Structural Limitations Confirmed in Code (baseline `86bbe157`)

| Current structure                                            | Why future must adjust                                                             | Code entry                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| One fixed Team Provider ID per domain                        | Team A/B share an ID; Selection cannot specify them independently                 | `packages/shared/src/model-provider-types.ts`                                                                    |
| Each Family saves one connection selection                   | Expresses a mutually exclusive current connection, not multiple instances          | `packages/shared/src/provider-family-connection-selection.ts`                                                    |
| Settings navigation writes connection selection              | Browsing pages changes execution-side facts                                        | `packages/ui/src/settings/ModelProviderSection.tsx` `persistProviderFamilyModeForNavItem`                        |
| Account Resolver limits execution scope by current           | Not needed once multiple specific Providers coexist                                | `packages/provider/src/resolver.ts`, `packages/services/src/model-provider/accountProviderConnectionResolver.ts` |
| Request auth reads current-compatible connections            | UI selecting Team A cannot switch to Team B credentials at request time            | `accountProviderConnectionResolver.ts` `resolveCurrentAccountAccess`                                             |
| Old Coding Plan uniformly maps to Individual                 | Correctness depends on later automatic mapping; removing it needs a new migration  | `packages/shared/src/legacy-model-provider-identity.ts`                                                          |
| Account selector builds group labels by fixed Family/Plan    | Dynamic team instances need unique keys, accurate labels, same-name model sources  | `packages/ui/src/lib/modelSelectionGroups.ts`, `packages/ui/src/ModelConfigSelect.tsx`                           |

## IV. Suggested Architecture Direction (Not Frozen)

### 4.1 Specific Provider Identity and Instantiation

```text
Built-in: public definition / plan-type model rules
Account: personal, Team A, Team B specific identities and entitlements -> specific Provider instances
Personal: instance config overrides, model enable/disable, ordering -> complete Registry / View
```

- Instances have stable Provider IDs; team names, list indices and Tokens are not identities.
- `ModelSelection` keeps `providerId/modelId/options`; team identity comes from the account instance facts of the
  Provider; credentials never go into Selection.
- Which of organization/project/product fields form a stable identity needs server-side entity verification; a field
  needed for requests is not necessarily a good long-term ID.
- Built-in/Account shift from "one fixed Team Provider + current team" to "public type definitions + specific
  instances"; evaluate reusing Template capabilities, but do not disguise account instances as user-built Providers.
- Whether login subject is part of instance identity, and how same-domain logout/re-login behaves, must be defined so old
  selections never silently bind to another person's plan.

### 4.2 Precise Selection, Precise Authentication

```text
Selection -> specific Team A Provider -> verify Provider/Model/Reasoning in one complete snapshot
  -> ModelFactory exact creation -> credentials obtained/refreshed by Team A identity
```

- Runtime automatic mapping personal -> Team and Team A -> Team B is deleted.
- Selection View and validity results stay public but never change the input providerId; unavailable Provider/Model
  keeps original intent, with explicit execution failure or temporary UI blank per established rules.
- Dynamic Token/Key refresh does not change request ownership; Team A failure never continues with Team B credentials.
- Implicit Subagents inherit the parent Active Model; explicit selections use specific Providers; fixed execution, retry
  and internal overrides keep established boundaries.
- Account availability/entitlement stays useful; the normal current account stops being an execution gate; the Settings
  browsing item is UI state only.

### 4.3 Multi-Entry UI

- Personal, each Team and Start show status, entitlements and models separately; navigation does not modify execution state.
- Selector: Account Providers on top; expanding a Provider differs from selecting a model and does not modify the draft.
- Same-name models are distinguishable by personal/Team A/Team B source; internal IDs are not user-facing copy.
- Composer, Automation, Bot, Wiki and Subagents share candidates and grouping rules and keep their own drafts, submission
  and save boundaries. Desktop and mobile share selection semantics; drawer form, search, keyboard navigation, themes,
  bilingual copy and long team names are decided in formal design.

## V. Migration (Must Be Re-discussed)

### 5.1 No Runtime Automatic Mapping

| Original data evidence                                  | Suggested handling                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ordinary custom/API Providers with explicit identities  | Keep identities; normal format migration                                                   |
| Explicit personal or complete team identities           | Migrate to the specific Provider; no requirement that entitlements/models are executable now |
| Only old general Coding Plan IDs, no specific ownership | Historical teams cannot be recovered; a one-time ownership strategy must be decided        |
| Personal model overrides/sorting under old Team Provider| Must decide which instance receives them; never default-copy to all teams                  |

Candidate approach: use records' own verifiable old association; when insufficient, use the pre-upgrade saved old
connection as a one-time default (this does not represent historical true ownership and is not yet user-confirmed). How
to preserve originals and prompt users while undetermined is decided separately.

### 5.2 Compatibility Scope Changed by Launch

- "Incompatible with this branch's unshipped intermediate formats" does not excuse real data written after the formal
  release. Before implementing, confirm migration sources against actually published versions (personal/fixed Team
  Provider IDs and saved old connection info).
- If old general selections already migrated to personal and ownership evidence is gone, the original team cannot be
  inferred from the personal ID; acknowledge insufficient information, ask for user confirmation, or use a one-time mapping.
- No data pre-modification or migration fields are added now. Migration identifies old fields; formal running does not
  re-read old connections to decide Providers; temporary network/Registry unavailability never deletes persisted selections.

## VI. Off-Peak, Sync, and Isolation Boundaries

- Decided: the single logged-in account determines the BigModel or Z.ai existing off-peak Provider. No "off-peak task
  selects personal/team quota connection" operation is added. Settings browsing and normal model selections do not
  participate in off-peak Provider selection; what is deleted is the global mutual exclusion of ordinary plans, not login
  identity.
- Obtained Tickets keep their bindings; switching login accounts does not rebind them. Qualification, credentials and
  Tickets follow existing off-peak protocols; verify old-code dependence on ordinary current connections when implementing.
- Sync must carry complete account instance facts; old current fields exit; complete receiving, correct application,
  Worker lifecycle and failure recovery remain valuable.
- Keep target Host authority, workspaceIdentity isolation, mobile shared-host attachments and desktop continuous / web
  replayable boundaries. Independent CLI account capabilities are not extended; multiple simultaneous login accounts are out of scope.

## VII. Pending Decisions

1. Auto-discover/open all qualified plans after login, or explicit per-plan connection? Viewing pages must not imply
   connection or Key creation side effects.
2. After logout and re-login, how original specific Provider identities and persisted selections are isolated, preserved
   and restored (single-account constraint is decided).
3. Stable identity granularity of Team instances (organization/project/product roles; stability across renaming, renewal,
   re-login).
4. Migration defaults for old general selections, handling of insufficient information, ownership of old Personal Team overrides.
5. Whether "drawer-style" means expanding Providers inside the selector or a full side/bottom panel; whether closing and
   canceling only affect viewing state.

Off-peak ownership is decided (single logged-in account; existing Ticket bindings kept).

## VIII. Future Implementation Order and Acceptance Direction

Re-investigate real code and data after launch before formal specs and tests. Suggested order:

1. Stable instance identities, connection lifecycles, configuration instantiation.
2. Entitlement queries and credentials per specific instance; remove request-period global connection dependence.
3. Migration sources and one-time rules; personal override ownership.
4. Remove current and cross-Provider automatic mapping from Registry / Selection.
5. Settings as pure navigation, public selector drawer, accurate source labels.
6. Multi-entry dispatch, background tasks, Tickets, sync, attribution, desktop/mobile/SSH verification.

Key acceptance: Team A/B parallel requests are each billed correctly; viewing another page affects no selection; A
failure does not redirect to B; same-name models are identifiable; restart/renaming keeps instances; personal overrides
do not cross teams; undetermined migrations do not destroy original data; fixed execution and Tickets are not replaced.

Implementation requires the user to restart this item and settle the pending decisions before formal contracts change.
