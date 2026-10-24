# Provider Refactoring Working Memory

> Status: Main implementation wrapped up, entering overall verification
>
> Last updated: 2026-09-09
>
> Current phase: Core architecture and settings boundaries are in place; consolidating Design V2 and release verification

This directory stores the target design, phased implementation, and current code study for the Provider Refactoring. It is the persistent memory for this macro-level effort.

## Document Entry Points

- [Built-in Provider Template and Model Daily Maintenance](../../builtin-provider-maintenance/README.md): organized 2026-10-14; scope, rationale, production/test configs, current inventory, official-source tracking, manual key verification, and delivery flow. Refactor history stays here; day-to-day maintenance happens from the new entry point.

```text
provider-refactor/
├─ provider-refactor.md      Current status and main entry point
├─ design/design.md          Hierarchical design tree through historical evolution
├─ design-v2/
│  ├─ design.md              Current core design single entry point
│  └─ evidence-and-contradictions.md  Historical contradictions, evidence, and rulings
├─ steps/steps.md            Migration roadmap, implementation goals, results, and issues
├─ plan/plan.md              Release-phase plan for merge, automation gates, real verification, and final wrap-up
└─ research/research.md      Specialized research on current code and protocol
```

- [`design-v2/design.md`](./design-v2/design.md) is the single entry point for current core design.
- [`design-v2/evidence-and-contradictions.md`](./design-v2/evidence-and-contradictions.md) explains how legacy materials are superseded, the current factual basis, and remaining incomplete items.
- [`design/design.md`](./design/design.md) preserves the hierarchical design through evolution; conflicts are no longer overridden by Design V2.
- [`steps/steps.md`](./steps/steps.md) holds the migration roadmap, M1-M3 implementation records, and M4 phase design and results.
- [`plan/plan.md`](./plan/plan.md) locks the four-phase release wrap-up direction for Provider refactoring before Release Candidate.
- [`research/research.md`](./research/research.md) introduces specialized research on current code and protocol, referencing each factual document.

## Current Phase

- [Todo156: Start Independent Provider Follow-up Fixes and Final Page Decisions](./steps/todo-156-start-plan-followup-final-decisions.md): implemented and self-reviewed; user requested commit push; baseline failure records retained. Maintains Start's permanent presence, state reuse, connection dependency fixes, claim flow, team dropdown, plan badges, sidebar-first recommendation, and the final scope of recommended balance sharing / on-demand refresh / 60-second validity; team data construction governance deferred, multi-instance quota cards hold baseline; evidence and uncovered items in the ticket's §14.
- [Todo155: Start Connection Dependency Cleanup and Model-switching Plan Badge](./steps/todo-155-start-plan-selection-dependency-cleanup.md): initial investigation archived; final decisions are covered under Todo156.
- [Todo138: Empty Model Draft and Model Layer Reasoning Fallback](./steps/todo-138-reasoning-level-ui-and-api-defaults.md): completed. Empty UI drafts do not pre-fill levels; Model uses universal fallback disabled/enabled; three API universal maps convert enabled to high. Levels and dedicated rules retained. Source revision 23, merged version 24; verification in the ticket body and merge notes.
- [Todo137: Start Plan GLM-5.3 Hidden Visual Badge](./steps/todo-137-start-plan-glm53-vision-badge.md): implemented and passed display regression. Only expands shared display scope; image capability and Flash badges retained.

M1 unified all production model call `Model` / `ModelRequest` boundaries. M2 unified the source of ordinary long-lived Models:

```text
ProviderConfigService
├─ ZCode Built-in Provider Config
├─ Account Provider Config
└─ Personal Provider Config ────────────────┐
                                            ├─> Effective Provider Config
ZCode Built-in Model Config Rules ──────────┤
Personal Model Config Rules ────────────────┘
                             |
                             v
            ProviderRegistryService
                     ├─ Provider[] / { modelId, config: ModelConfig }[]
                     └─ createModel(selection)
                                  |
                                  v
                             ModelFactory
                                  |
                                  v
                                Model
                                  |
                                  v
                           ModelRequest -> Adapter -> API
```

Config Overlay, Registry View, Settings/Selection Facade, ModelFactory, and Account Provider request-time authentication are in the production pipeline. Account Config uses a separate process protocol for synchronization to local Workers; it no longer extracts from Workspace Registry Snapshot. The old Provider Store only serves as one-time Personal/Account migration input.

M3 completed model selection, atomic Submission, Guide/Immediate, Provider Settings page, and Model I/O format consolidation on this foundation, and removed the superseded ModelRef, shared mutable Runtime model state, media capability map, and connectivity bypass.

M4 implemented as designed: hidden Providers remain full Providers in the Registry; visibility only filters settings page and model selector. Zhipu Account Providers declare static access via `zhipu-account + family + mode` and acquire dynamic auth at request time. Idle tasks use the same Registry, ModelFactory, and Model, without modifying or restoring Session Selection. Phase details in [`steps/04-model-execution-cutover.md`](./steps/04-model-execution-cutover.md); the intermediate `request-auth` terminology was superseded by Todo 26; the current contract is Design V2.

## Current Progress

| Phase             | Topic                                                        | Status                                               |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| M0                | Macro architecture and current-state map                     | First round completed                                |
| M1                | Model and ModelRequest                                       | Completed; MR !2006 merged to staging                |
| M2                | Provider config, Registry, and Model creation                | Completed, serves as basis for M3                    |
| M3                | Provider architecture cutover and Model format consolidation | Completed                                            |
| M4                | Model execution chain, idle tasks, and Subagent              | Completed                                            |
| Follow-up         | Config publishing, Account and Settings boundaries           | Main part implemented; remaining items see Design V2 |
| Independent topic | Environment config and Provisioning                          | Not part of this Provider Refactor                   |

## Next Steps

[Todo154: Start Independent Provider and Submit-time Plan Recommendation](./steps/todo-154-start-plan-independent-provider.md): implemented and reviewed, Pro E2E passed. Retains two IDs with unified name and brand icon; Start is connection-free and coexists with paid plans; no selection data is migrated; submit/create-time recommendations add quota and reasoning-compatible models; unified persistent "do not show again". Subagent inclusion, immediate run/Bot/background execution exclusion, and paid plan expiry notifications are clearly scoped; details in the ticket's §8. Pre-implementation facts are in research; final behavior is synced to the official Start spec; Todo101 is not started.

[Todo117](./steps/todo-117-preserve-account-domain-on-provider-save.md) / [Todo118: Preserve Legacy Provider Enabled](./steps/todo-118-preserve-legacy-provider-enabled.md): latest ruling confirmed, awaiting implementation. Built-in account providers cannot be disabled; existing false values no longer take effect; old account disables are not migrated. Manual Key providers retain enable/disable. Public connections, entitlements, credentials, and model executability judgments remain unchanged; no longer waiting for built-in disable source rulings.

[Todo132: Model Option Color Feedback and Provider Name Edit Fix](./steps/todo-132-model-option-feedback-and-provider-name-edit.md): awaiting execution, plan confirmed. Block options only strengthen selected color; text/icons and overlay borders unchanged. Name input saves on Enter/blur, cancels on Esc; other field saves cannot include unconfirmed names. Local boundaries and verification listed; this round persists only.

[Todo131: Model Settings Page Smart Config Placement and "Restore" Button](./steps/todo-131-model-settings-smart-config-placement-and-restore.md): awaiting execution, plan confirmed. Smart config moved to the right of the model ID container; "restore" added at the bottom left. Only modifies drafts, effective after save; empty ID is usable and only disabled during saving. Related to Todo125/130; includes responsive layout, async protection, and R121 verification; this round persists only.

[Todo130: Smart Config Toggle and Manual Config Field Boundary Correction](./steps/todo-130-manual-model-config-editable-field-boundary.md): awaiting execution, plan confirmed. Toggle only disabled during saving; manual only locks editable fields; internal mapping/capability continues resolved by current system rules. Schema fix, synthesis, and save rollback. Treated as not yet officially released for compatibility; no hidden field editor; this round persists only.

[Todo129: Provider Telemetry Adaptation and Team Plan Classification Fix](./steps/todo-129-provider-telemetry-compatibility-and-team-classification.md): awaiting execution, direction confirmed. Reports unchanged; telemetry side makes best-effort recovery of old IDs. Verified against old version per-event facts; determinable items are implemented directly; a few irrecoverable items keep real IDs as evidence without blocking the whole. Fixes two team classifications, home page idle block, BigModel funnel, and success tags. Does not touch real Provider identities, requests, storage, or old parsers; this round persists only.

[Todo128: Provider Start Contract and Idle Eligibility Refresh Fix](./steps/todo-128-provider-start-contract-and-offpeak-eligibility.md): awaiting execution, plan confirmed. Unified start only waits for ready, explicitly reads the current snapshot. Fixes idle eligibility update notifications, manual refresh, and out-of-order overrides. Includes Air evidence, all return-value consumption points, and verification requirements. Does not expand Todo11 shell refactoring; does not change Composer; this round persists only.

[Todo127: Built-in Config Online Publishing and Update Chain Fix](./steps/todo-127-builtin-online-release.md): awaiting execution, detailed plan confirmed. Persists 20s / 10MB download, every-minute expiry check, hourly normal download, Account alignment, and same-check-entry-driven recovery. Implementation order and tests listed; this round persists only, without new client business integrity gates.

[Todo113: Recent New Model Catalog and Smart Config Update](./steps/todo-113-new-model-catalog-refresh.md): second round awaiting execution. Lists per-template catalog and config changes, offline cleanup, and aggregated support must-check. Confirmed models still require deep study; uncertain details verified during implementation. First-round historical results retained, not mixed with this round's acceptance.

[Todo126: GLM Vision Badge Display, Flash PDF, and Coding Plan API Turbo Defaults](./steps/todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md): confirmed and persisted, awaiting implementation. Adjusts Flash's universal PDF declaration and two plan API templates' Turbo defaults. Adds settings page and model selector hidden Coding Plan GLM-5.3 vision badge display exception; bridges image capability; Flash visual badge preserved.

[Todo125: Model Settings Page Question Mark Instructions and Final Copy](./steps/todo-125-model-settings-help-copy.md): product ruling confirmed and persisted, awaiting implementation. Fixed Chinese final copy, title question mark, and cross-platform interaction. No unauthorized polish, expanded prompts, or changed config behavior.

[Todo114](./steps/todo-114-account-status-sync-and-key-retry.md) (upstream original Todo105): merged with Account reason sync, unified Z.ai/BigModel missing Key classification, and personal plan fetch retry. Upstream 280 targeted tests and four component browser suites passed; the remaining complete App / mobile chain verification belongs to Todo102; specific evidence in Todo114.

Pre-release Schema special ruling per [Todo104](./steps/todo-104-pre-release-schema-review.md) (M2 original Todo99): core plan and default selection merged and maintained; Session adds modelSelection while preserving old values. Off-Peak / Wiki save partial fixes await implementation. 6.19 tightened to 13 supporting items confirmed and approved. Subagent Markdown original field migration is Todo97's confirmed readability trade-off, not reopened in this Todo. User authorized implementation on 2026-09-10; completion status per implementation ledger.

M2/M3 unified ordinary Provider config, display, selection, and execution to use Built-in → Account → Personal three-layer Config, Built-in + Personal Model Rules, and a process-level Registry. Completion per [`steps/02-provider-config-and-registry-cleanup.md`](./steps/02-provider-config-and-registry-cleanup.md) and [`steps/03-provider-architecture-cutover-implementation-log.md`](./steps/03-provider-architecture-cutover-implementation-log.md).

Core architecture and completed Todos form the current release wrap-up baseline; Todo 32 completed Team/Individual settings page and Effective Provider boundary. Unfinished, deferred, and draft items for Todos 11, 11A, 15, 19, 22 etc. are unified at [`design-v2/design.md`](./design-v2/design.md#11-unfinished-work-not-changing-design); do not infer current status from old phase numbers.

This release wrap-up does not expand to Remote Provisioning, model selection lifecycle, ordinary Queue, `modelContextBudget.strategy`, or account product refactoring.

## Maintenance Principles

```text
design-v2 describes how the final system works, and how historical contradictions are resolved
design    Historical hierarchical design and topical details
steps    How to migrate, and what actually happened
plan     How completed main implementation enters release-ready state
research Factual evidence on current code and protocol
```

Stable conclusions go into design-v2; implementation details and deviations go into steps; factual evidence goes into research. Legacy materials are not silently rewritten to pretend to be final design; conflicts are uniformly recorded in Design V2's evidence documents.

Design, implementation records, research, and historical materials for the Provider architecture evolution are saved in this Working Memory, not copied to official `docs` prematurely. Only after each phase completes implementation and verification are formal documents distilled for long-term maintainers; formal documents describe the landed system, while Working Memory preserves the evolution process and decision basis.
