# Todo128: Provider Start Contract and Off-Peak Eligibility Refresh Fix

> Status: **local implementation and review pass; on-device acceptance pending the whole batch.** On 2026-09-11 the
> start/read contract and the off-peak eligibility refresh were unified; browser verification with controlled services is
> not the same as Air's real plan acceptance.
>
> Scope: the Provider lifecycle interface, its return-value consumers, and the refresh and concurrency control of the
> off-peak task eligibility check.
>
> Related: [Todo11 Runtime composition boundary draft](./todo-11-provider-runtime-composition-boundary-cleanup.md),
> [Todo127 online release](./todo-127-builtin-online-release.md). This Todo does not enable the undecided shell
> deletion / renaming / owner reorganization of Todo11 and does not implement Todo127's online download and
> Account/Built-in alignment.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-128-provider-start-contract-and-offpeak-eligibility.md`

## 1. Background and Review Evidence

User report: Air already has a Team Plan, but the automations page "create off-peak task" is still disabled with the
message "coding plan users only". A read-only 2026-09-11 check of Air's settings, logs and installed package found: the
current selection is BigModel Team Plan (no account, organization, project IDs or credentials are stored in the document);
the Air log `~/.zcode/v2/logs/2026-09-11.log` recorded at 23:01:21 (raw log time) BigModel Team Plan as
`availability: available / entitled: true / current: true` and the BigModel off-peak Provider also `entitled: true`; the
installed Host code matches the repository: the off-peak `resolveAccountProvider()` filters the Coding Plan Provider from
the return value of `await providerRuntime.start()`, while that Runtime caches the first start Promise and first snapshot.
Air was not restarted, its account config not changed, no real off-peak task created and the full in-memory state not read;
the log proves the account update and the defective implementation, and this survey is not a fixed end-to-end acceptance.

The wording first appeared in `90b2cf83ceb9f25af7fd32315a390729d83f22a8` ("refactor(provider): unify provider config and
registry", authored 2026-08-20 18:43:17 +08:00, committed 2026-08-21 11:17:22 +08:00), whose `start()` already cached the
first return value. `bec05c983c1159126c10fbfcf578da73f85248a2` (2026-08-31) only lifted the resolution closure outward for
the off-peak service and Host dispatch to share and must not be blamed as the introduction.

Local isolated verification with the real classes and Store (temporary directory, no real network):

```text
ProviderRuntime first start: account-old; Account updated and Registry.refresh awaited: account-new
  second runtime.start(): still account-old, === the first return;  registryService.getSnapshot() / start(): account-new
NodeProviderConfigRuntime: after the Personal update start() still returns the first object; configService.read() returns the new Personal revision
off-peak Store: old request A pending -> new request B returns Team Plan supported=true -> A returns supported=false -> Store overwritten back to false
```

These are fault-isolation evidence, not regression cases in the repository; formal tests come first at implementation.

## 2. Confirmed Rulings and Scope

1. The four Provider `start()` methods become `Promise<void>`: start and wait for the first readiness only.
2. Business data is read explicitly from Config/Registry, not retained by a start Promise as a first state.
3. Off-peak eligibility is rechecked after the Registry completes the related update, and a manual page refresh includes
   the complete eligibility check.
4. Page initialization, connection change and manual refresh share one check-coordination logic; stale results and stale
   errors never overwrite the current state.
5. Existing plan, credential, quota and model-executability rules are kept; eligibility is not relaxed to fix this.
6. **Composer is not changed.** The previous round's Session vs Composer draft discussion for scheduled tasks was
   explicitly "not now" and must not be sneaked in.
7. No persisted schema change, new config file or table, change of account connection selection structure, request
   authentication protocol or existing model selection.

## 3. Interface and Read Boundary

### 3.1 Lifecycle Interface

| Object                                | Previous repeat-call result             | Confirmed result |
| ------------------------------------- | --------------------------------------- | ---------------- |
| `ProviderRuntime.start()`             | the cached first Registry snapshot      | `Promise<void>`  |
| `NodeProviderConfigRuntime.start()`   | the cached first Config snapshot        | `Promise<void>`  |
| `ProviderRegistryService.start()`     | the current completed Registry snapshot | `Promise<void>`  |
| `NodeProviderRegistryRuntime.start()` | forwarded underlying Registry snapshot  | `Promise<void>`  |

Services' `ProviderConfigRuntime.start()` is a forwarding wrapper of the Node Config Runtime and changes to
`Promise<void>` as well. Start dedup, existing failure retry, first-load order, change subscription and complete resource
release are kept; `start()` is not made to return new data by re-initializing, re-registering listeners or triggering
network refresh. Facade ready callback types express "wait for readiness only" instead of loosening to `Promise<unknown>`.

### 3.2 Data Reading and Refresh

```text
await start() waits for first readiness only
  -> configService.read() reads the current config;  registryService.getSnapshot() reads the current completed derived snapshot
Account / Config change -> Registry recomputes and publishes a new snapshot -> existing change notification -> consumers read current state
```

"Current snapshot" means the most recent **completed** Registry update; it does not promise to wait for an in-progress
account network request, and `start()` completing does not mean a later Account refresh completed (flows that must wait for
a refresh to be applied keep using the explicit refresh-completion / notification boundary). Current Config/Registry stay
the single fact source with no second "latest Provider state" cache; `refresh()`'s explicit refresh role is not merged into
`start()`.

### 3.3 All Return-Value Consumers

| Call site                                                                        | Previous use                                                                               | Requirement                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/services/src/node.ts` off-peak `resolveAccountProvider()`              | repeatedly filtered plan Providers from the `start()` snapshot                             | wait for start then read the current Registry; keep the unique current connection, entitlement, model and authentication constraints |
| same-file startup log                                                            | logs startup config version and Provider count                                             | read the Registry explicitly after start                                                                                             |
| `packages/provider-node/src/provider-registry-runtime.ts`                        | builds a default unavailable snapshot from Config when the Account Source is uninitialized | wait for Config start then read the needed config from `configService.read()`                                                        |
| `packages/services/src/model-provider/providerRuntime.ts`                        | cached and returned the Registry start result                                              | cache the readiness Promise, no longer return a business snapshot                                                                    |
| `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts` | kept the Node Registry Runtime start result as an outer `snapshot`                         | read the startup snapshot explicitly for the needed one-time log, not as a continuous state read                                     |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`             | wrote the startup log from that `snapshot`                                                 | adapted together; runtime still uses the Registry service                                                                            |
| tests and wrapper layers                                                         | returned/asserted the start snapshot                                                       | assert through the read interface after start; sync return types                                                                     |

Checked and found to use independent services or only await readiness (not mistaken as having the stale-snapshot bug):
Provider settings, model selection, official MCP, Bot, Wiki, Git commit message generation, Agent startup preparation and
config distribution. The CLI Prompt/TUI execution surface uses the Registry service; the only production consumer of the
outer startup `snapshot` is the Protocol startup log. Rerun reference checks before implementing to catch later new callers.

## 4. Off-Peak Eligibility Refresh Chain

### 4.1 Triggers

`AutomationsSection` initialized on page open and rechecked when Settings' family/connection selection changed, but did not
recheck when an Account update had been applied to the Registry; manual refresh only refreshed the task list and take-number
quota and missed the plan eligibility.

```text
switch account connection -> old eligibility invalid, create entry waits for confirmation
  -> Account refresh done -> Registry update done and notified -> recheck the current plan and request credential
  -> eligible: query take-number quota -> commit one valid same-generation result to the page;  not eligible / failed: existing block-creation rule
```

- Page open still performs one complete check. The existing Provider change notification is reused to confirm the related
  Registry update completed before triggering the eligibility check (a Settings change is not equal to account resolution
  done). Manual refresh order: eligibility check, quota check if needed; the task list refresh may be independent.
- Other off-peak entries sharing the Store (including `OffPeakNewTaskEntry`) are checked against the same coordination
  boundary so repeated mounts do not create a second check. No polling timer or arbitrary delay to wait for Account state,
  no new Agent/Host for the eligibility check, and the page is not the owner of account facts.

### 4.2 Concurrency and Stale Results

The single-flight dedup of `initialize()` did not cover `refreshCodingPlanSupport()` and the quota request. Unified
coordination: (1) a new connection/Provider change during a check marks the old one stale and records a recheck, avoiding
concurrent duplicate eligibility/quota requests; (2) the latest pending state is processed after the in-flight check ends,
and merged changes must not drop the last recheck; (3) old success, old failure and old cleanup never rewrite a newer
generation's Store state; (4) plan eligibility and take-number quota belong to the same valid check and never splice results
of different connections or checks; (5) the existing guard "the current selection agrees with the returned support snapshot"
is kept, and creation is not restored by clearing the user's connection selection or falling back to the personal plan.

## 5. Implementation Order and Verification

1. Update the related current specs and add formal unit/E2E tests (this Todo is the implementation basis; Design V2 facts
   follow the code).
2. Four lifecycle interfaces and forwarding wrappers return `void`; adapt read points, logs and tests.
3. Off-peak resolution reads the current Registry; add the update-completion notification and manual refresh.
4. Unified eligibility/quota coordination with stale success and failure protection.
5. Targeted verification and architecture / typecheck / lint gates, then Air's actual Team Plan scenario, recorded and committed.

| Scenario                                 | Must prove                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start interface                          | four interfaces and wrappers return `Promise<void>`; concurrent first access does not duplicate resources; failure and dispose do not regress                                       |
| Account / Personal updated after start   | explicit reads return the updated state; no process restart needed                                                                                                                  |
| no plan -> BigModel Team Plan            | the entry recovers automatically after the Registry update completes, without leaving and re-entering the page                                                                      |
| cold start with an existing Team Plan    | a slow first account resolution still converges to the correct eligibility after the update completes                                                                               |
| Team Plan switched away / logout         | old eligibility invalidated and not re-opened by an old success result                                                                                                              |
| rapid connection switching               | with deliberately inverted request completion order, old success and old failure never overwrite the new state                                                                      |
| manual refresh                           | re-resolves plan and credential; queries quota only when eligible                                                                                                                   |
| several off-peak entries mounted at once | the check is deduplicated, later changes still trigger the needed recheck, and repeated requests do not interfere on the quota interface                                            |
| execution and other consumers            | off-peak eligibility, take-number and dispatch keep sharing the current connection's authentication; model selection, Provider settings, config distribution and Agent startup work |

App interaction fixes need matching E2E, covering at least BigModel Team Plan and the existing Z.ai/personal-plan rules in
layered cases, plus a runtime check on Air with a real account (real creation/execution actions and evidence follow the
implementation-time user authorization and E2E rules; pure mock results are not written as real-service success).
Cross-end: Host/Worker Registries, remote workspace identity isolation and account distribution unchanged; the phone reuses
shared-host without changing the desktop continuous / mobile replayable message flow or widening the original remote scope
of off-peak tasks. A baseline freshness check runs before work starts (at review time local staging was 5 commits behind
origin/staging with the reviewed implementation identical to that remote ref, which does not replace the later check);
architecture, typecheck, lint and related unit/E2E run per repository rules with unverified parts left on record.

## 6. Delivery and Remaining Work

- Done: four start methods and the forwarding layer unified to void, consumers read Config/Registry explicitly, Facade ready
  types tightened, CLI startup log adapted.
- Done: the Store unifies serial eligibility/quota checks committed in the same generation, discarding stale success/errors;
  both entries share one Hook driven by ProviderSettings completed revisions, connection changes and manual actions, with
  duplicate keys deduplicated. No new polling, cache fact source or Composer change.
- Spec / impact matrix: [todo-128-impact-and-cases.md](./todo-128-impact-and-cases.md); Design V2 and the off-peak spec synced.
- Red then green: the start return-value case and 4 Store race cases failed on the old implementation; after the fix 7 files
  / 70 items pass, Bootstrap 10 items pass; covers retry/dedup/dispose after a start failure, explicit reads after
  Personal/Account updates, late old eligibility/quota and errors, two entries, manual refresh.
- Browser pending: real Snapshot + Hook + Store + create gate with a controlled Host RPC, 1 item passes: cold-start
  not-ready -> Team notification recovery, exit disables, silent backend recovery then manual recheck, current error
  disables and notification recovers; each entry makes only one eligibility/quota call pair. Not an installed-package or
  real-backend acceptance.
- Gates: root typecheck, Bootstrap typecheck, root lint (0 errors), architecture (0 violations) pass; CLI target-file lint
  has no error. Graph integrity had 4 pre-existing dangling edges and this change adds 0; modified seeds exist; Codegraph
  was unavailable and dep:refs / exact references were used.
- Review: no change to account selection, validity rules, Ticket authentication/binding or data formats. Two stale test
  preconditions from Todo124/130 (unauthorized test Provider, manual-mode hidden field source) were fixed without relaxing
  product validation.
- Pending whole-batch acceptance: Air's SSH was available but this code was not installed/run to recheck the real Team
  button; this stays untested and no real account change, Ticket creation or old-package behavior counts as passing.
