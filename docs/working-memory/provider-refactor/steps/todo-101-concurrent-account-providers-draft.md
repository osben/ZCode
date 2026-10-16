# Todo 101 Draft: Multiple Specific Account Providers Coexisting

> Status: Draft / Postponed implementation; 2026-09-09.
> User decision: Proceed with existing architecture for current launch; this item only records future direction; not implemented in current delivery.
> This document is not a current running contract; does not automatically override current spec, migration rules, Todo99, or Todo102 decisions.

## I. Confirmed Future Product Direction

1. Personal plans, Team A, and Team B simultaneously connectable and usable; no longer mutually exclusive through a single global current connection.
2. Settings page switching between personal/team only switches display pages; does not change global execution state.
3. Each explicit ModelSelection must point to specific personal/team Provider; delete logic automatically mapping to another Provider based on current connection.
4. Old ModelSelection Provider migration must be redesigned; cannot continue "uniformly migrate to personal, then runtime maps to current plan."
5. Model selector adds drawer-style interface placing multiple Account Providers at top. Drawer specifics pending confirmation.
6. Only one account can be logged in simultaneously; multiple personal/team plan coexisting does not equal multiple login accounts coexisting. Off-peak Providers determined by that logged-in account; no additional personal/Team A/Team B off-peak quota selections added.

```text
Multiple Account Providers coexisting under single logged-in account
├─ Personal plan
├─ Team A
├─ Team B
└─ Start Plan (specific coexistence/connection boundaries to be refined)

Session A   -> Team A / Model / Reasoning
Session B   -> Personal / Model / Reasoning
Scheduled task -> Team B / Model / Reasoning

Settings page viewing which plan does not affect above execution identities
```

## II. Current Delivery and Future Transformation Boundaries

- Current launch continues using existing single-connection architecture; do not preemptively delete current gates; do not preemptively stop current effective selection mapping; do not preemptively change Provider IDs.
- Do not preemptively change Settings / Selection persistence formats, account authentication ownership, template rules, or selector layouts.
- Todo100-confirmed sync completeness, real confirmation, dispatch parameter loss issues, etc., must still be decided item-by-item according to current launch requirements; cannot mark existing bugs as "no need to handle" because current will be removed later.
- Existing suspended experiments remain suspended; this document does not authorize resuming Todo99, pushing, or deploying.
- This document's status cannot be marked as "implemented", "current launch scope", or "current design replaced".

### Guidance for Current Fix Direction

1. Fix temporary sync correctness only; do not build irretrievable new platforms. Worker lifecycle coordination specifics still decided separately under current discussions.
2. Retain public applied snapshots, integrity validation, original intent protection, and exact ModelFactory; these capabilities still needed in future.
3. If current needs fixing personal/Team automatic mapping, reuse existing public rules; do not add more business special cases; future deletion boundaries clear.
4. Do not permanently entrench "automatically switching Provider based on global connection" into Model.bind or bottom-layer Factory. Future still needs exact creation; not worth expanding public APIs around semantics about to be淘汰 (eliminated).
5. Do not delete current normal functions under future architecture reasoning; do not pre-introduce dual account identity/migration paths for future.

## III. Code Investigation-Confirmed Structural Limitations

Investigation baseline: `86bbe157c88e8e599694afb53c39f6dac125ac08`. Below are design basis, not what this item has implemented.

| Current Structure                                            | Why Future Must Adjust                                                                                         | Code Entry                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| One fixed Team Provider ID per domain                        | Team A/B share ID; cannot independently specify simultaneously in Selection                                    | `packages/shared/src/model-provider-types.ts`                                                                    |
| Each Family saves one connection selection                   | Expresses mutually exclusive current connection, not multiple account instances                                | `packages/shared/src/provider-family-connection-selection.ts`                                                    |
| Settings navigation writes connection selection              | Browsing pages changes execution-side facts                                                                    | `packages/ui/src/settings/ModelProviderSection.tsx`'s `persistProviderFamilyModeForNavItem`                      |
| Account Resolver limits execution scope by current           | Not needed after multiple specific Providers coexist                                                           | `packages/provider/src/resolver.ts`, `packages/services/src/model-provider/accountProviderConnectionResolver.ts` |
| Request auth reads current-compatible connections            | Even if UI selects Team A, cannot switch to Team B credentials at request time                                 | `accountProviderConnectionResolver.ts`'s `resolveCurrentAccountAccess`                                           |
| Old Coding Plan uniformly maps to Individual                 | Correctness depends on subsequent automatic mapping; deleting mapping requires rescheduling migration strategy | `packages/shared/src/legacy-model-provider-identity.ts`                                                          |
| Account selector generates group labels by fixed Family/Plan | Dynamic team instances need unique keys, accurate labels, and same-name model source distinction               | `packages/ui/src/lib/modelSelectionGroups.ts`, `packages/ui/src/ModelConfigSelect.tsx`                           |

## IV. Suggested Architecture Direction (Not Yet Frozen Implementation)

### 4.1 Specific Provider Identity and Instantiation

```text
Built-in: public definition/plan-type model rules
                    |
Account: personal, Team A, Team B specific identities and entitlements
                    |
                    v
             Specific Provider instances
                    |
Personal: specific instance config overrides, model enable/disable, and ordering
                    |
                    v
             Complete Registry / View
```

- Specific instances have stable Provider IDs; do not use team names, list indices, Tokens, etc., as identities.
- ModelSelection can continue retaining `providerId/modelId/options` structure; team identities provided by account instance facts corresponding to Provider; credentials not stuffed into Selection.
- Which fields among organization, project, product participate in stable identities requires verifying server-side entity semantics; needing a field for requests does not mean the field necessarily suitable as long-term IDs.
- Built-in and Account responsibilities shift from "fixed one Team Provider + current team" to "public type definitions + specific instances." Evaluate reusing existing Template capabilities; do not disguise account instances as ordinary user-自建 (self-built) Providers.
- Whether login subjects included in instance identities, how to handle same-domain account logout and re-login, must be clear; cannot let old selections silently bind to another person's plan.

### 4.2 Precise Selection, Precise Authentication

```text
Selection points to specific Team A Provider
                |
                v
Verify Provider / Model / Reasoning within same complete snapshot
                |
                v
ModelFactory exact creation
                |
                v
Obtain or refresh credentials by Team A identity
```

- Delete automatic mappings personal → Team, Team A → Team B at runtime.
- Can retain public input-style Selection View and validity results, but cannot change input providerId; Provider/Model unavailable retains original intent; execution clearly fails or UI temporarily leaves blank per established rules.
- Dynamic refresh Token/Key does not equal dynamically changing request ownership. Team A failure cannot continue executing with Team B credentials.
- Implicit Subagents still inherit parent Active Model; explicit selections use specific Providers; fixed execution, retry, and internal overrides maintain established boundaries.
- Account availability/entitlement still useful; normal account current no longer functions as execution gate. Settings page current browsing items only belong to UI state.

### 4.3 Multi-Entry UI

- Display status, entitlements, and models for personal, each Team, Start respectively displayed; page navigation does not modify execution state.
- Selector places Account Providers at top; expanding Providers and selecting models are different actions; merely expanding does not modify draft selection.
- Same-name models must be distinguishable by personal/Team A/Team B source; internal IDs not directly used as user-facing copy.
- Composer, Automation, Bot, Wiki, Subagents share candidates and grouping rules; each maintains own drafts, submissions, and save boundaries.
- Desktop and mobile share selection semantics; drawer form, search, keyboard navigation, themes, bilingual support, and long team names determined together in formal design.

## V. Migration Special: Must Be Re-discussed

### 5.1 No Longer Relying on Runtime Automatic Mapping

| Original Data Evidence                                   | Suggested Handling Direction                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Ordinary custom/API Providers explicit identities        | Retain original identities; normal format migration                                                            |
| Explicit personal or complete team identities            | Migrate to corresponding specific Providers; no requirement they currently have entitlements/models executable |
| Only old general Coding Plan IDs, no specific ownership  | Cannot magically recover historical teams; must decide one-time ownership strategy                             |
| Personal model overrides/sorting under old Team Provider | Must decide which instance to assign; cannot default-copy to all teams                                         |

Candidate approach: prioritize using records' own/verifiable old association information; when insufficient, use pre-upgrade saved old connection as one-time migration default. This default does not represent historical true execution ownership; not yet confirmed by users. How to preserve original records and prompt users when still undetermined, decided separately.

### 5.2 Current Launch Changes Future Compatibility Scope

- "Incompatible with this branch's not-yet-shipped intermediate formats" principle cannot be used to ignore **real data truly written after this formal release**.
- Before future implementation, must confirm migration sources by actual published versions, including personally/fixed Team Provider IDs and old connection information saved at that time.
- If old general selections already migrated to personal, and original ownership evidence no longer exists, future cannot infer which team it originally belonged to based on personal ID alone; must acknowledge insufficient information, clear user confirmation, or one-time mapping strategies.
- No pre-modification of data or addition of migration fields due to this; re-audit data evidence and compatibility scope before formal implementation; cannot blindly copy current Draft assumptions.
- Migration phase identifies old fields; formal running does not continuously re-read old connections to determine Providers; network/Registry temporarily unavailable does not constitute reasons to delete persisted selections.

## VI. Off-Peak, Sync, and Isolation Boundaries

- Decided: single logged-in account determines using BigModel or Z.ai corresponding existing off-peak Provider. Ordinary personal/team Providers can coexist; no additional "off-peak task selection personal/team quota connection" product operations added.
- Settings page browsing items, normal model selections do not participate in off-peak Provider selection; what deleted is global mutual-exclusion selection of ordinary plans, not login account identities.
- Obtained Tickets maintain established bindings; switching login accounts does not automatically rebind existing Tickets. Qualifications, credentials, and Tickets still obtained per existing off-peak protocols; verify old code dependencies on ordinary current connections when implementing future; do not convert to new user selection items.
- Sync must transmit complete account instance facts; old current fields will exit; but complete receiving, correct application, Worker lifecycle, and failure recovery still valuable.
- Retain target Host authority, workspaceIdentity isolation, mobile shared-host attachments, and desktop continuous / web replayable boundaries.
- This round does not extend independent CLI account capabilities; multiple login accounts online simultaneously explicitly out of scope.

```text
Single logged-in account
    ├─ That account's personal / Team A / Team B -> respective independent ordinary Providers
    `─ Account's system BigModel / Z.ai   -> corresponding off-peak Provider -> Tickets
```

## VII. Pending Decisions

1. Auto-discover/open all qualified plans after login, or users explicitly connecting one by one? Viewing pages must not imply connection/creating Keys and other side effects.
2. Single-account constraint decided; after logout and re-login, how to isolate, preserve, and restore original specific Provider identities and persisted selections must be clarified in identity design.
3. Stable identity granularity of Team instances: what roles do organization, project, product respectively play? How to maintain selection stability on renaming, renewal, re-login?
4. Migration defaults for old general selections, handling when information insufficient, and ownership of old Personal Team overrides.
5. Whether "drawer-style" means expanding Providers within selector, or complete side/bottom panel? Do closing and canceling only affect viewing state?

Off-peak ownership issues decided; no longer listed as selectable schemes: determined by single logged-in account; retain existing Ticket bindings.

## VIII. Future Implementation Order and Acceptance Direction

Re-investigate real code and data after launch before supplementing formal specs and tests; below only suggested order:

1. Stable instance identities, connection lifecycles, and configuration instantiation.
2. Query entitlements by specific instances; obtain credentials; delete request-period global connection dependencies.
3. Clear migration sources and one-time migration rules; personal override ownership.
4. Delete current and cross-Provider automatic mapping from Registry / Selection.
5. Settings page purely navigation, public selector drawer, and accurate source labels.
6. Multi-entry dispatch, background tasks, Tickets, sync, attribution, desktop/mobile/SSH verification.

Key acceptance: Team A/B parallel requests each correctly billed; viewing another page does not affect any selection; A failure does not redirect to B; same-name models identifiable; restart/renaming does not lose instances; personal overrides do not cross teams; undetermined migrations do not destroy original data; fixed execution and Tickets not replaced.

Completing this Draft's records does not mean starting implementation. User must restart this item and complete pending decision boundaries before updating formal running contracts.
