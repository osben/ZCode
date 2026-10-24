# Todo 100: Account / Provider / Effective Selection Chain Pure Investigation

> Status: Investigation completed (2026-09-09). The fix scope was decided and closed by Todo99; verification debt was
> handed to Todo102. The facts below do not claim every defect still exists.
> Baseline: `86bbe157c88e8e599694afb53c39f6dac125ac08`, `provider-refactor-e2e-recovery`. Todo99's unsubmitted code was a
> suspended experiment, not a completed fix.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-100-account-provider-selection-architecture-investigation.md`

## Objectives

Trace the Host and Core Worker account, Provider and effective model selection chains: current problems, public
mechanisms, how each execution entry consumes them, and the long-term restructuring. Priorities: input facts and applied
snapshots are self-consistent; each entry reuses the public Effective Selection; parsed results drive execution without
corrupting original intent; temporary Account sync is complete, deduplicated and truthfully acknowledged. Excluded:
implementation fixes, repository-wide refactoring, independent CLI upgrades, persistence migrations, deployments.

## Confirmed Boundaries

1. Host may use complete config B while a Worker temporarily uses complete A; in-process mixing of A/B or a false ack
   that B is applied is not allowed.
2. Original Selection is intent; the effective selection is a temporary result and, once an execution is fixed, is not
   re-interpreted.
3. Explicit Subagent and other consumers reuse public parsing; implicit inheritance, internal execution override and bound
   Off-Peak Tickets keep original execution ownership.
4. Read, refresh and failure never overwrite persisted original intent; business submit/save boundaries are not unified.
5. No barrier forces synchronization with the latest remote config before each send; workspace isolation, desktop
   continuous and mobile replayable are unchanged.

Deliverable: [Investigation Results and Target Architecture](../research/todo100-account-provider-selection-investigation.md)
(architecture diagrams, per-entry consumption tables, issue list, target architecture, minimal-fix vs long-term boundary,
verification gaps). Method: current fact documents and code as evidence; codegraph was unavailable, so targeted call
reading was used; read-only checks and memory validations only, no real accounts.

## Investigation Items (all completed)

| ID  | Item                                                  | Outcome                                                                                                   |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| I01 | Process and service assembly (Host, Workers, CLI, SSH) | Report §2                                                                                                 |
| I02 | Account fact production and publishing                | §3, §7; async identity mixing risk listed, not claimed reproduced                                         |
| I03 | Provider applied snapshots                            | §3, P100-01/02                                                                                            |
| I04 | Temporary sync correctness                            | §6; existing queues retained; do not rebuild a sync platform first                                        |
| I05 | Session / Composer                                    | §3, §5; existing public hooks/freezing are correct                                                        |
| I06 | Automation / Bot / Wiki                               | §5; P100-04/05 record the Bot subsequent-round and attachment passing gaps                                |
| I07 | Subagent / Workflow                                   | Static chain P100-03, §5; real child network validation not executed                                      |
| I08 | Request authentication and internal model calls       | §5; dynamic auth is not model selection; Tickets are not rebound                                          |
| I09 | Evidence and test modification review                 | §10; 52 existing unit tests pass, ACK difference reproduced in memory; test modifications stay suspended  |
| I10 | Target architecture and order                         | §8/9: pure public parsing + applied snapshot + explicit new-dispatch / fixed-execution boundaries         |

## Conclusions

- Three status/consumption gaps confirmed: sync dropping states, ACK not representing a truly applied snapshot,
  explicit Subagents not reusing public parsing.
- Attachment dispatch branches miss model selection/execution context; Bot first creation gets parsing but later
  messages of an existing task do not. Both must be closed at the new-round / existing-accepted-input boundary.
- Registry/Facade/Hook already have fairly complete consistency protection and should not be rebuilt. Account upstream
  query-scope race conditions are un-run-verified risks, not globally confirmed chaos.
- Real account/real-device validation was not executed.
