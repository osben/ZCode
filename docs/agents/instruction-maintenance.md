# Agent Instruction Maintenance and Acceptance

## Goals and Scope

This specification defines the organization and acceptance criteria for the repository AGENTS.md, Claude entry points, and related skills. The priority is to reduce rework, missed verifications, and manual corrections, then unnecessary confirmations, readings, and repeated tests. File length is only a context-overhead observation, not proof of improved effectiveness.

Confirmed behavioral requirements (2026-09-15):

- Consultation, diagnosis, and review are read-only by default. Implementation, fix requests within authorized scope, local refactoring, modifications, and verification are completed autonomously.
- Changes to product semantics, compatibility, data formats, or core architecture beyond confirmed requirements first propose specific plans and communicate; confirmed plans proceed directly.
- New features and behavior changes first update existing specs. Bugfixes that restore defined behavior leave a regression test as the trace. When the behavior is undefined, update the spec first.
- Verify according to change type; stop after the necessary checks pass; expand verification only for new changes, failures, or unexplained risks.
- Implementation tasks are committed locally once verification passes. When necessary verification blocks, leave workspace changes and explain. Push and MR happen on user request.

Daily development rules follow the [root AGENTS.md](../../AGENTS.md). This document records acceptance goals; rule changes must update the corresponding acceptance scenarios.

## File Responsibilities

| Location                               | Responsible Content                                                                                     | Read Condition                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Root AGENTS.md                         | Task boundaries, specs, key engineering constraints, verification and completion criteria, entry points | All repository tasks                                               |
| packages/ui/AGENTS.md                  | UI service access, state, platform adaptation, logging                                                  | UI component, page, style, or hooks changes                        |
| packages/services/AGENTS.md            | Service logging and service-layer considerations                                                        | Service implementation changes                                     |
| apps/zcode-cli/AGENTS.md               | CLI-specific contracts, toolchain, and verification                                                     | CLI code changes                                                   |
| docs/agents/runtime-boundaries.md      | Processes, workspace identity, desktop/mobile state boundaries                                          | process, workspace state, remote control or real-time link changes |
| .claude/CLAUDE.md and CLI entry points | Import shared AGENTS.md                                                                                 | Claude loads project instructions                                  |
| Existing domain documents, skills      | Domain facts, specialized tools, and workflows                                                          | Root file or task matches corresponding trigger                    |

The root file must say "when to read which file" so tasks starting from the repository root can find subdirectory rules. Do not assume every host automatically loads a newly nested AGENTS.md on each file edit. Claude entry points use import paths relative to the entry file, not copies of the project rules.

The executable architecture policy is `architecture-policy.yaml`; gates guarantee only the modules they cover. Uncovered semantics and modules still need manual or agent checks. When repository facts conflict with documentation, verify the implementation and target contract first; an existing non-compliant implementation is not automatically a new architectural specification.

## Scenario Acceptance

Whenever task boundaries, read conditions, or completion criteria change, check that the following requests reach consistent conclusions from the applicable instructions. The table states expectations, not that these tasks were run.

| Representative Request                                                             | What to Read/Execute                                                                                       | How to Conclude                                                                                         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| "Find the cause of duplicate messages after phone reconnection, do not modify yet" | Remote control fact document, related implementation, and runtime evidence                                 | Provide evidence, root cause, or hypotheses pending verification; do not modify business code or commit |
| "Fix commands in the development documentation"                                    | Actual command definitions, referenced documents; check links and consistency                              | Local commit after documentation check passes; do not additionally run application E2E                  |
| "Fix a parsing error defined by an existing spec"                                  | Existing spec, affected tests; reproduce before fixing                                                     | Regression test and code gates pass; do not duplicate newly added feature docs                          |
| "Adjust interaction triggered by a button"                                         | UI instructions, DESIGN, related feature spec, and E2E workflows                                           | Update spec/tests, verify affected desktop and mobile paths, then commit                                |
| "Fix remote workspace task routing"                                                | Runtime boundaries, CLI instructions (if touching CLI), related contracts; draw state or sequence diagrams | Verify identity, owner, continuous/replayable boundaries; root unit tests cannot replace CLI/E2E        |
| "Implement a confirmed interaction, but necessary E2E environment is unavailable"  | Complete executable implementation and verification, record failure reasons and unverified items           | Leave changes, do not auto-commit, do not claim verification completed                                  |

Unit test scope rules (2026-10-13):

| Request/condition                                                         | Expected                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Workspace already has changes                                             | Record the task starting point; all existing uncommitted changes are included and preserved    |
| Source deleted, dependency changed, or association unresolved             | Follow Vitest's official selection; do not add baseline consumers or source-based compensation |
| Push target is not HEAD / no baseline / dirty workspace                   | Non-zero exit; block the push                                                                  |
| Files brought in by an integration merge                                  | Participate in official selection normally; do not filter by source                            |
| Configuration, shared setup, or shared dependency selects the whole suite | Explain and skip UT, exit 0; does not block Push                                               |
| No tests selected                                                         | Explain, exit 0; do not claim all changes are verified                                         |
| Targeted test failure                                                     | Fix and re-verify the corresponding scope; do not switch to a full retry                       |
| Full run explicitly requested                                             | Use `pnpm test` / `pnpm test:unit`                                                             |
| Task spans multiple commits                                               | Use the task starting-point SHA at the end; the push range is used only for push verification  |

Two cross-scenario branches: pure visual changes verify desktop/mobile and light/dark themes; refactors without behavior changes reuse existing tests first and add new ones only for coverage gaps.

MR description rules (2026-10-16):

| Request/condition                                               | Expected                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing or updating an MR description                           | Five sections: TL;DR, goal, change scope, verification, risk and rollback; capability maps, module classification, and impact scans are not required                                                                                                                                                           |
| New feature, behavior adjustment, or pure refactor              | The goal explains background, original behavior, design intent, and expected behavior; if there is no existing defect, say so and do not fabricate a bug root cause                                                                                                                                            |
| MR includes a bugfix (including mixed changes)                  | Each independent issue states the trigger scenario, expected/actual behavior, root cause, evidence, and fix mechanism, with matching regression cases; link an existing ticket directly where possible, keep an ID only when it can be confirmed, and state when there is no ticket without fabricating a link |
| Root cause, feedback link, or introducing commit lacks evidence | Mark as pending confirmation or not located; same module or close timing may only be a lead, not written as a confirmed cause                                                                                                                                                                                  |
| Calling the helper with a five-section description              | The full body can be read and passed through; old seven-section descriptions remain readable; an empty file or one missing any of the five sections is still rejected                                                                                                                                          |

## Actual Effect Observations

Real tasks should retain task links, change types, models/hosts, instruction versions used, and actual occurrences of rework, missed verifications, manual corrections, and unnecessary pauses. Compare similar tasks first; different models, dependencies, or environments affect results, so note them. Report development effect improvements only when behavioral improvements are observed; document checks validate only rule completeness and consistency.

When the same error reappears, update the original rule responsible for that decision and add a representative scenario. Do not append remediation requirements separately to the root file, subdirectory files, and skills. Delete or update outdated interface names, version numbers, paths, and script summaries to point to the current authoritative entry.

## Acceptance Record (2026-09-15)

- All six request categories and the pure visual and pure refactor branches were statically checked: root rules locate specialized entries, and specs, verification, blocking, and commit criteria are consistent across CLI, architecture skill, E2E skill, and commit specifications. The development tasks were not run and no model A/B experiments were done.
- Local Markdown links, Claude import targets, root/CLI script definitions, and whether referenced files are tracked in Git were verified; format and diff whitespace were checked.
- architecture-governance passed the general validation via skill-creator. The E2E skill's `disable-model-invocation` field is not supported by that validator and produced the same error before and after the change; the original invocation strategy is kept. This is a pre-existing compatibility limitation, not a passed validation.
- The change touched only instructions, documents, and skill display metadata and was accepted under pure-document rules. Application typecheck, lint, UT, and E2E were not run. Real development effects remain to be observed through later similar tasks.
