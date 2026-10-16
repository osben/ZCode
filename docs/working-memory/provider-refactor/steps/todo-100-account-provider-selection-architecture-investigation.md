# Todo 100: Account / Provider / Effective Selection Chain Pure Investigation

> Status: Investigation completed; 2026-09-09. Subsequent fix scope decided and closed by Todo99; this investigation no longer waits for implementation decisions. Facts recorded below not representative of whether these defects still all exist; verification debt handed off to Todo102.
> Baseline: `86bbe157c88e8e599694afb53c39f6dac125ac08`, `provider-refactor-e2e-recovery`. Todo99's unsubmitted code is a suspended experiment; not counted as completed fixes; this item does not modify or rollback that code.

## Objectives and Priorities

Thoroughly trace Host and Core Worker's account, Provider, and effective model selection chains: current problems, how much public mechanism exists, how each execution entry consumes, what long-term restructuring should look like.

1. Priority: Input facts and applied snapshots self-consistent; each entry point reuses public Effective Selection; parsed results correctly used for execution without corrupting original intent.
2. Must check: Whether temporary Account sync complete, deduplication and application confirmation real, Worker lifecycle gaps. Sync mechanism may be deleted later; current goal is correctness and reliability, not thorough beautification.
3. Excluded: Implementation fixes, full repository refactoring, independent terminal CLI feature upgrades, persistence migrations, push deployments. Independent CLI only records architecture differences.

## Confirmed Boundaries

- Host allowed to use complete B; Worker temporarily using complete A; in-process mixing A/B or false confirmation of B applied not allowed.
- Original Selection is intent; effective selection is temporary result; fixed current execution can no longer be re-interpreted.
- Explicit Subagent and other consumers should reuse public parsing; implicit inheritance, internal execution override, bound Off-Peak Tickets maintain original execution ownership.
- Read, refresh, failure do not overwrite persisted original intent; each business submission and save boundaries not forced unified.
- No new barrier added forcing synchronization with latest remote config before each send; no change to workspace isolation, desktop continuous, or mobile replayable.

## Investigation Method and Deliverables

Using current fact documents and code as evidence, prioritize retrieving existing feature graphs' ProviderRegistryService, AccountProviderService, ModelSelectionFacade, and execution entries; when codegraph unavailable, explicitly use targeted calls reading, not pretending to have completed graph scans. Read-only checks and memory validations without real accounts executable; do not access or modify real user state.

Each entry recorded: expected, actual chain, baseline code location, evidence strength, user impact, suggested ownership, whether unsubmitted experiments covered, pending verification/decisions. Conclusions distinguish confirmed issues, conditional risks, correct mechanisms, pending decisions; do not equate reachability with actual bugs.

Execution report: [Investigation Results and Target Architecture](../research/todo100-account-provider-selection-investigation.md). Report must include architecture diagrams, per-entry consumption tables, issue lists, target architecture, boundary between minimal fixes and long-term refactoring, and verification gaps.

| ID  | Investigation Item                                    | Completion Standard                                                                                            | Status                                                                                                            |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| I01 | Process and service assembly                          | Distinguish Host, managed Workers, independent CLI, SSH environments; list shared/branched implementations     | Completed: report §2                                                                                              |
| I02 | Account fact production and publishing                | Check config/connection/identity changes, refresh serialization, expired results and last-known-good           | Completed: §3, §7; async identity mixing risk listed; not falsely claimed reproduced                              |
| I03 | Provider applied snapshots                            | Check source version matching, status/model consistency, notifications and snapshot consumption                | Completed: §3, P100-01/02                                                                                         |
| I04 | Temporary sync correctness                            | First-time/event/on-demand triggers, field completeness, ack, dedup/order/failure, different Worker lifecycles | Completed: §6; existing queues retained; do not recommend rebuilding sync platform first                          |
| I05 | Session / Composer                                    | Original intent → public parsing → submission → final Model, caches and save boundaries                        | Completed: §3, §5; existing public hooks/freezing correct                                                         |
| I06 | Automation / Bot / Wiki                               | Each target Host, parsing/dispatch points, freezing and config save boundaries                                 | Completed: §5; P100-04/05 separately record Bot subsequent round and attachment passing gaps                      |
| I07 | Subagent / Workflow                                   | Explicit/implicit/override/nested and actual requests; cannot only check settings page                         | Completed static chain: P100-03, §5; real child network validation not yet executed                               |
| I08 | Request authentication and other internal model calls | Exact execution, account binding, auxiliary models, inheritance, and Ticket exceptions                         | Completed: §5; do not misconvert dynamic auth to model selection, nor rebind Tickets                              |
| I09 | Evidence and test modification review                 | Verify confirmed issues; distinguish baselines from suspended experiments; list unverified scopes              | Completed: §10; 52 existing unit tests pass, ACK difference memory-reproduced; test modifications still suspended |
| I10 | Target architecture and suggested order               | Public service boundaries, temporary sync removability, minimal fixes and pending decisions                    | Completed: §8/9; pure public parsing + applied snapshot + explicit new dispatch/fixed execution boundaries        |

Completion conditions: all investigation items have results and evidence; cannot replace conclusions with "need to continue checking"; real account/real-device validation not executed must be explicitly listed. Investigation completion does not mean product issues fixed; does not automatically authorize continuing Todo99.

## Execution Conclusions

- Confirmed three status/consumption gaps: sync dropping states, ACK not representing truly applied snapshots, explicit Subagents not reusing public parsing.
- Additionally confirmed: attachment dispatch branches miss passing model selection/execution context; Bot first creation received parsing, but existing task subsequent messages not received; must be closed by new round/existing-accepted-input boundaries.
- Registry/Facade/Hook already have fairly complete consistency protection; not recommended to rebuild from scratch; Account upstream query scope race conditions remain un-run-verified risks, cannot exaggerate to globally confirmed chaos.
- This item only changes investigation Todos, indices, suspension notes, and results report. Product test modifications not continued, unsubmitted, unpushed.
