# Agent Instruction Maintenance and Acceptance

## Goals and Scope

This specification describes the organization and acceptance criteria for the repository AGENTS.md, Claude entry points, and related skills. The priority is to reduce rework, missed verifications, and manual corrections, followed by reducing unnecessary confirmations, readings, and repeated tests. File length is used only to observe context overhead and is not proof of improved effectiveness.

Behavioral requirements confirmed on 2026-09-15:

- Consultation, diagnosis, and review are read-only by default; implementation, fix requests within authorized scope, local refactoring, modifications, and verification are completed autonomously.
- Product semantics, compatibility, data formats, or core architecture changes beyond confirmed requirements should first propose specific plans and communicate; confirmed plans proceed directly.
- New features and behavior changes first update existing specs; bugfixes that restore defined behavior leave traces via regression tests; when the behavior is undefined, update the spec first.
- Verify according to the change type; stop after passing necessary checks, and only expand verification for new changes, failures, or unexplained risks.
- Implementation tasks are automatically committed locally upon passing verification; when necessary verification blocks, leave workspace changes and provide explanations. Push and MR are triggered by user request.

The execution rules for daily development follow the [root AGENTS.md](../../AGENTS.md). This section records the acceptance goals for this refactoring; subsequent rule changes must synchronize corresponding acceptance scenarios.

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

The root file must specify "when to read which file" so that tasks starting from the repository root can find subdirectory rules. Do not assume that all hosts automatically load a newly nested AGENTS.md on every file edit. Claude entry points use import paths relative to the entry file, not copies of the entire project rules.

The executable architecture policy follows `architecture-policy.yaml`; gates only provide guarantees for the modules they actually cover. Uncovered semantics and modules still require manual or agent checks. When repository facts conflict with documentation, first verify the implementation and target contract; existing non-compliant implementations cannot be automatically treated as new architectural specifications.

## Scenario Acceptance

Whenever task boundaries, read conditions, or completion criteria change, check whether the following requests can reach consistent conclusions from the applicable instructions. The table shows acceptance expectations and does not represent that these development tasks have been run.

| Representative Request                                                             | What to Read/Execute                                                                                       | How to Conclude                                                                                         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| "Find the cause of duplicate messages after phone reconnection, do not modify yet" | Remote control fact document, related implementation, and runtime evidence                                 | Provide evidence, root cause, or hypotheses pending verification; do not modify business code or commit |
| "Fix commands in the development documentation"                                    | Actual command definitions, referenced documents; check links and consistency                              | Local commit after documentation check passes; do not additionally run application E2E                  |
| "Fix a parsing error defined by an existing spec"                                  | Existing spec, affected tests; reproduce before fixing                                                     | Regression test and code gates pass; do not duplicate newly added feature docs                          |
| "Adjust interaction triggered by a button"                                         | UI instructions, DESIGN, related feature spec, and E2E workflows                                           | Update spec/tests, verify affected desktop and mobile paths, then commit                                |
| "Fix remote workspace task routing"                                                | Runtime boundaries, CLI instructions (if touching CLI), related contracts; draw state or sequence diagrams | Verify identity, owner, continuous/replayable boundaries; root unit tests cannot replace CLI/E2E        |
| "Implement a confirmed interaction, but necessary E2E environment is unavailable"  | Complete executable implementation and verification, record failure reasons and unverified items           | Leave changes, do not auto-commit, do not claim verification completed                                  |

Supplementary acceptance for unit test scope rules (2026-10-13):

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

Two cross-scenario branches must also be checked: pure visual changes verify desktop/mobile and light/dark themes; refactors without behavior changes should优先 reuse existing tests, adding new ones only when coverage gaps exist.

Supplementary acceptance for MR description rules (2026-10-16):

| Request/condition                                               | Expected                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing or updating an MR description                           | Organize into five sections: TL;DR, goal, change scope, verification, risk and rollback; capability maps, module classification, and impact scans are not required                                                                                                                                             |
| New feature, behavior adjustment, or pure refactor              | The goal explains background, original behavior, design intent, and expected behavior; if there is no existing defect, say so and do not fabricate a bug root cause                                                                                                                                            |
| MR includes a bugfix (including mixed changes)                  | Each independent issue states the trigger scenario, expected/actual behavior, root cause, evidence, and fix mechanism, with matching regression cases; link an existing ticket directly where possible, keep an ID only when it can be confirmed, and state when there is no ticket without fabricating a link |
| Root cause, feedback link, or introducing commit lacks evidence | Mark as pending confirmation or not located; same module or close timing may only be a lead, not written as a confirmed cause                                                                                                                                                                                  |
| Calling the helper with a five-section description              | The full body can be read and passed through; old seven-section descriptions remain readable; an empty file or a missing any of the five sections is still rejected                                                                                                                                            |

## Actual Effect Observations

Subsequent real tasks retain task links, change types, models/hosts, instruction versions used, and actual occurrences of rework, missed verifications, manual corrections, and unnecessary pauses. Prioritize comparing同类 tasks; different models, dependencies, or environments affect results, so note them together. Only report development effect improvements when behavioral improvements are observed; this document check validates only rule completeness and consistency.

When the same error reappears, update the original rule responsible for that decision and add a representative scenario. Avoid appending remediation requirements to the root file, subdirectory files, and skills separately. Outdated interface names, version numbers, paths, and script summaries should be deleted or updated to point to the current authoritative entry.

## This Acceptance Record (2026-09-15)

- All six categories of requests and pure visual, pure refactor branches were statically checked item by item: root rules can locate specialized entries, and specs, verification, blocking, and commit criteria are consistent across CLI, architecture skill, E2E skill, and commit specifications. These product development tasks were not run, nor were model A/B experiments conducted.
- Local Markdown links, Claude import targets, root/CLI script definitions, and whether referenced files are included in Git were verified; check format and diff whitespace.
- architecture-governance passed the general validation via skill-creator. The E2E skill's original `disable-model-invocation` field is not supported by this validator, producing the same error before and after modification; the original invocation strategy is retained, and additional YAML and field differences and workflow semantics are cross-checked. This is a pre-existing compatibility limitation and is not reported as general validation passed.
- This change only modifies instructions, documents, and skill display metadata, accepted under pure document rules. Application typecheck, lint, UT, or E2E were not run. Real development effects remain to be observed through subsequent同类 tasks.
