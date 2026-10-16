# Todo87 Implementation Impact Record

## Feature Summary

Intent: restoring same-model experiences after D02 account switching, retaining post-refactoring's original selection/execution-selection boundaries. Capabilities, decisions, and pruning see Todo87; currently implementation-handoff. Change layers: option-source, validation, recovery, commit-effect; not changing schemas. Seeds: ModelSelectionFacade, useDraftConfigControl, dispatchCronRun. Exclusions: pre-send synchronizations, Off-Peak cross-account ticket swapping, history/fixed request re-interpretations.

## UI Surface Matrix

| Scenario/Entry                            | Shared Implementation                         | Original Intent Owners/Initialization                                                       | Gates, Submissions, And Persistence Boundaries                                                               | Isolation                                                   |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Compositions / SessionPane                | Selection Services + common hooks with inputs | Scope drafts; Sessions only seeding first time, new drafts using Recent/Configured Defaults | View derived; accepted using valid values only, editing during ACKs not overwriting                          | workspaceIdentity, Session; continuous/replayable unchanged |
| Scheduled Task edits / AutomationEditView | Same Services/hooks                           | Form original selections; existing following Workspace modes retained                       | Only actively saving changes long-term configs; resolving and fixing runs before first background dispatches | Forms and runs not cross-writing                            |
| Bots / Wikis                              | Same Services                                 | Own domains' selections                                                                     | Resolving when preparing new executions; fixed executions excepted                                           | Not changing plain chat intents                             |
| Explicit Subagents                        | Retaining existing Agent validations          | Profile explicit selections                                                                 | Not connecting account correspondences this round; users deciding subsequent protocol connections separately | Unspecified models continuing inheriting Parents            |
| Off-Peak lists/executions                 | Original identities read-only validations     | Task original selections + claimed Tickets                                                  | Non-terminal execution checks retained; reading not clearing libraries                                       | Not cross-account Z.AI/BigModel Provider/Ticket swapping    |

## Shared And Divergent Behavior

Public: candidate sources, same-ID matching, invalid tier clearing, input/Host generation isolation; divergent: each domain's submission and save boundaries. UIs not sharing effectiveSelection for any consumers; plain menus still filtering hidden, Off-Peak only using original hidden Providers in restricted paths. Existing fresh selection initializations not equal to existing intentions repaired.

## Feature Relationships

| Priority       | Relations                                                                       | Conditions And Evidence                                                                                                              |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| must-inspect   | Accounts/Configs → Registry Snapshots → Facades → Services/hooks → Compositions | Same-snapshot account states; `providerRuntime.ts`, `facades.ts`                                                                     |
| must-inspect   | schedulers → Hosts → runs fixing → dispatches                                   | Changed to Hosts first-dispatch parsing then fixing; schedulers/manual claims not freezing early, existing runs not re-corresponding |
| must-inspect   | OffPeak lists/get/sync → repairLegacyModelSelections                            | New selections only deriving diagnostics, no longer triggered by reads; real old-structure migrations retained                       |
| should-inspect | Bot/Wiki preparations → Services                                                | Not merely modifying settings controls                                                                                               |
| conditional    | Explicit Subagent overrides                                                     | No overrides inheriting Parents, not affected by current account re-calculations                                                     |

## State Owners And Commit Sinks

| States                          | Authoritative Owners            | Write Boundaries                                                               |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| Accounts/Registries             | Target Hosts' applied snapshots | Source refreshing, not callers' persistences                                   |
| Composition original intentions | Renderer scope drafts           | User editing; accepted callbacks matching original intentions; Root promotions |
| Effective selections            | Single-read/consumers           | Not directly persisting, not broadcasting as global selections                 |
| Scheduled runs                  | AutomationRepos                 | First fixing; existing run retried not re-corresponding                        |
| Active Models/Submissions       | CLIs / current submissions      | After fixing only validated by Registries, not silently swapping models        |

## Must-Preserve Invariants

Not adding persistence migrations; original intentions empty not supplementing defaults; temporary failures not disguising as empty; no Provider same-name guessing; not introducing pre-send synchronizations; each end still sharing Hosts, delivery profiles unchanged. Validating corresponding SR87-01~14; actual results recorded in Todo85 audit tables, unexecuted E2E not counting as passes.

## Codegraph Evidence

codegraph tools unavailable this time, already tracked 1~2 hops via rg/read along above seeds. Services' direct callers are UI hooks, Bots, Host automations; Composition all original selection writing unified by useDraftConfigControl. This table not claiming graph query results.

## Graph Drift Candidates / Graph Delta

Unified effective selections already marked as implemented with exact code seeds in Feature Graphs; Compositions, Automations, Bots, Wikis connected, Off-Peak read-only protected; explicit Subagents excluded per user decisions. codegraph unavailable, verifying YAMLs, file/symbol seeds, not falsely claiming completed index queries.

## Unresolved Questions

Explicit Subagents confirmed missing Host account facts; user decisions retaining current-round validations, subsequent connections separately. Not expanding protocols, not implementing half-implementations for settings-page-only automatic correspondences.

## Planning Handoff

Specs: selection-state.md already appended implementation contracts; catalogs/corvertages: SR87 already updated by real evidences; E2E already run through Air, new candidates remaining pendants awaiting human promotions; decisions, submissions, and reports see Todo85 audit tables. Not all boundaries requiring Electron full permutations.

## Wiki New Generations And Supplement Boundaries (2026-09-07)

New generations (including新一轮 triggered by task_completing) resolving generation-settings' original selections at start, fixing this round's configs; subsequent page requests reusing these configs. Supplementing same Wikis' failing pages continuing using historical generation selections, not re-corresponding by current accounts. Reads/displays not modifying Wikis, chats, or Recents. ModelClients separately providing new-generation config parsing and existing fixed-config reading, both sharing target Host reads and config projections, not building separate account matching rules.
