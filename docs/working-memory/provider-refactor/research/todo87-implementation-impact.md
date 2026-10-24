# Todo87 Implementation Impact Record

> Intent: restore same-model experiences after D02 account switching, retaining the post-refactoring original-selection / execution-selection boundaries. Capabilities and decisions are in Todo87; this record is the implementation handoff. Change layers: option-source, validation, recovery, commit-effect; no schema changes. Seeds: ModelSelectionFacade, useDraftConfigControl, dispatchCronRun. Exclusions: pre-send synchronizations, Off-Peak cross-account ticket swapping, history/fixed request re-interpretations.
> Full history: `git show 8d54b233:docs/working-memory/provider-refactor/research/todo87-implementation-impact.md`

## UI Surface Matrix

| Scenario/Entry                            | Shared Implementation                         | Original Intent Owners/Initialization                                                       | Gates, Submissions, And Persistence Boundaries                                                               | Isolation                                                   |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Compositions / SessionPane                | Selection Services + common hooks with inputs | Scope drafts; Sessions only seed first time, new drafts use Recent/Configured Defaults       | View derived; accepted using valid values only, editing during ACKs not overwriting                          | workspaceIdentity, Session; continuous/replayable unchanged |
| Scheduled Task edits / AutomationEditView | Same Services/hooks                           | Form original selections; existing following Workspace modes retained                       | Only actively saved changes become long-term configs; resolving and fixing runs before first background dispatches | Forms and runs do not cross-write                           |
| Bots / Wikis                              | Same Services                                 | Own domains' selections                                                                      | Resolving when preparing new executions; fixed executions excepted                                           | Plain chat intents unchanged                                |
| Explicit Subagents                        | Retain existing Agent validations            | Profile explicit selections                                                                 | Account correspondences not connected in this round; protocol connections decided separately later           | Unspecified models continue inheriting Parents              |
| Off-Peak lists/executions                 | Original identities read-only validations    | Task original selections + claimed Tickets                                                  | Non-terminal execution checks retained; reading does not clear libraries                                      | No cross-account Z.AI/BigModel Provider/Ticket swapping     |

## Shared And Divergent Behavior

Public: candidate sources, same-ID matching, invalid tier clearing, input/Host generation isolation. Divergent: each domain's submission and save boundaries. UIs do not share effectiveSelection for any consumer; plain menus still filter hidden; Off-Peak uses original hidden Providers only in restricted paths. Fresh selection initializations do not repair existing intents.

## Feature Relationships

| Priority       | Relations                                                                       | Conditions And Evidence                                                                                                              |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| must-inspect   | Accounts/Configs → Registry Snapshots → Facades → Services/hooks → Compositions | Same-snapshot account states; `providerRuntime.ts`, `facades.ts`                                                                     |
| must-inspect   | schedulers → Hosts → runs fixing → dispatches                                   | Hosts first-dispatch parsing then fixing; schedulers/manual claims do not freeze early, existing runs not re-corresponded            |
| must-inspect   | OffPeak lists/get/sync → repairLegacyModelSelections                            | New selections only derive diagnostics, no longer triggered by reads; real old-structure migrations retained                          |
| should-inspect | Bot/Wiki preparations → Services                                                | Not merely modifying settings controls                                                                                               |
| conditional    | Explicit Subagent overrides                                                     | No overrides inherit Parents; not affected by current account re-calculations                                                        |

## State Owners And Commit Sinks

| States                          | Authoritative Owners            | Write Boundaries                                                               |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| Accounts/Registries             | Target Hosts' applied snapshots | Source refreshing, not callers' persistences                                   |
| Composition original intents    | Renderer scope drafts           | User editing; accepted callbacks matching original intents; Root promotions    |
| Effective selections            | Single-read/consumers           | Not directly persisted, not broadcast as global selections                     |
| Scheduled runs                  | AutomationRepos                 | First fixing; existing run retries not re-corresponding                        |
| Active Models/Submissions       | CLIs / current submissions      | After fixing only validated by Registries, never silently swapping models      |

## Must-Preserve Invariants

No persistence migrations; empty original intents are not supplemented with defaults; temporary failures are not disguised as empty; no Provider same-name guessing; no pre-send synchronizations introduced; each end still shares Hosts, delivery profiles unchanged. Validation corresponds to SR87-01~14; results recorded in Todo85 audit tables; unexecuted E2E does not count as passed.

## Unresolved Questions (resolution)

Explicit Subagents were confirmed to lack Host account facts; the user decision retained current-round validations, and the connection was completed later by Todo99. No protocol expansion, no half-implementations for settings-page-only automatic correspondences.

## Wiki New Generations And Supplement Boundaries

New generations (including task_completing-triggered rounds) resolve generation-settings' original selections at start, fixing this round's configs; subsequent page requests reuse these configs. Supplementing the same Wiki's failing pages continues using historical generation selections — not re-corresponding by current accounts. Reads/displays do not modify Wikis, chats, or Recents. ModelClients separately provide new-generation config parsing and existing fixed-config reading, both sharing target Host reads and config projections; no separate account-matching rules.
