# Todo128 Impact and Acceptance Boundary

> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-128-impact-and-cases.md`

## Feature Summary

Intent / capability: start only means ready; off-peak eligibility reads the current Registry and refreshes serially.
Layers: validation, option-source; planning. Seeds: ProviderRuntime, NodeProviderConfigRuntime,
NodeProviderRegistryRuntime, ProviderRegistryService, offPeakTaskStore. Docs: Todo128, `docs/off-peak-task/spec.md`. Out of
scope: Composer, persistence, account sync refactor, off-peak remote support, actual ticket-taking rules.

## UI Surface Matrix

| Scenario / entry      | Shared implementation                    | Display / draft                  | Guard                                      | Commit / authority                                          | Mode / isolation                                      |
| --------------------- | ---------------------------------------- | -------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------- |
| Automations create entry | Store + Provider Settings completion notification | Store eligibility; form draft independent | current connection supported and quota ready | getCodingPlanSupport -> getTakeNumberAvailability; Host Registry / server | existing desktop-local scope only; scheduled tasks unaffected |
| OffPeakNewTaskEntry   | same Store / refresh Hook                | banner and navigation draft      | navigation uses any plan; does not replace create validation | navigation only, no ticket taking                       | currently not mounted; the fix does not reopen the entry |

Shared: the latest completed Provider facts (no layout change; the home page and the create gate differ); unconfirmed
state does not let through, and eligibility and quota are of the same generation; no new cache or database change; actual
ticket-taking is still validated by the Host server and Ticket binding is unchanged.

## Relationships and State Owners

Must-inspect: start -> off-peak credential resolution (node.ts consumed the first Promise's stale snapshot); Registry ->
ProviderSettings.onDidChange -> off-peak recheck (Facade View notifications are based on the published snapshot); page
init / connection change / manual refresh -> Store (three concurrent paths that could splice eligibility and quota).
Should-inspect: Node start -> Protocol startup log (return value changes to void, so read a snapshot explicitly once).
Invariant-only: create / dispatch / authentication (same credential-resolution closure, eligibility not relaxed); Web
shared-host / workspace identity (no new Host, no continuous/replayable change).

| Fact                    | Owner                          | Mirror / sink                           |
| ----------------------- | ------------------------------ | --------------------------------------- |
| Current model eligibility | Registry                     | Store keeps only the masked support result |
| Take-number quota       | server                         | Store same-generation result; non-persisted |
| Startup readiness       | Runtime lifecycle `Promise<void>` | not a data cache                     |
| Connection selection    | Settings                       | UI only compares, never writes back or falls back |

Invariants: start dedup, retry after failure, dispose and background refresh unchanged; API Key and account model
eligibility not relaxed; eligibility/quota are published together only for the latest generation (old success, failure and
finally never open the gate); unknown state stays blocked; send and sync get no new wait. No Codegraph tool was available
(the `dep:refs` ProviderRegistryService reference report `/tmp/provider128-refs.log` and exact `rg` call checks were used;
depth 2: Runtime -> consuming closure -> off-peak service; Store -> two entries -> create gate; static hits are not runtime
verification). Graph drift ("Provider has no enabled", old plan model lists) belongs to its own Todos; confirmed graph
delta: lifecycle / same-generation eligibility constraints on the Provider Registry and off-peak Store nodes plus the
completion notification edge. No open product ruling (Air on-device availability is only a verification prerequisite).

## Rulings and Scope

User confirmed: four start methods return void; unified off-peak eligibility refresh; Composer, sync and eligibility rules
untouched. Domains: Provider lifecycle and off-peak validation. Key crosses: first not-ready x account arriving later;
connection switch x late old eligibility/quota/error; two entries x one notification. Excluded: all-end all-account
Cartesian product. Not run: real ticket taking, cancelling Tickets, changing real account settings; phone off-peak
creation and Composer submission are excluded.

## Accepted Cases

| ID | Setup -> action                                              | Assertions                                                                 | Evidence / E2E           |
| -- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------ |
| S1 | four Runtimes start concurrently; change Personal then start again | void; the read interface is latest; resources not duplicated        | unit test                |
| S2 | start failure / release                                      | original retry/release boundary kept                                       | existing tests + types   |
| Q1 | cold start with no plan -> Registry Team ready notification  | no page reopen needed; support and quota update once                       | Store + pending UI       |
| Q2 | old support/quota in flight -> connection change             | serial merged recheck; old success/error does not override; no intermediate ready | Store              |
| Q3 | two entries initialize at once / receive the same revision   | one shared check, no duplicate concurrent quota queries                    | Store + pending UI       |
| Q4 | manual refresh, eligibility false->true / true->false        | eligibility first then quota; failure does not open creation               | Store + pending UI       |
| Q5 | no grayscale / no eligibility / quota error                  | stays blocked; a later notification can recover                            | Store                    |

Store unit tests reuse deferred Promises (no sleep); the browser pending case reuses the shared Hook/Store with controlled
service events, in temporary directories and without Provider network (no replay provider fixture needed since this group
sends no model requests). If Air is unreachable the verification limit is stated and not used as implementation proof.
