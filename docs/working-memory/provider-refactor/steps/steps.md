# Provider Migration Implementation

> Status: Continuously maintained
>
> Last updated: 2026-09-09

## Current Execution Entry Points

- [Todo159: Connectivity Test Output Budget Uniformly Adjusted to 512 Tokens](todo-159-connectivity-512-token-budget.md): Awaiting execution, target value confirmed. Air's OpenCode Go Luna rejects `max_output_tokens=1`; server requires at least 16; only changing to 16's counter-request succeeded. Uniformly adjusting connectivity test budget to 512, superseding Todo144's 1 Token ruling, retaining lowest reasoning level, Prompt, stream-end, and error contracts; this round only records the Todo, 512 and modified App acceptance awaiting execution.

- [Todo158: Permission Dialog Full Access and Queued Mode Permission Sync](todo-158-permission-dialog-full-access-and-queued-mode.md): Implemented; acceptance not fully wrapped up. Only dialog syncs current task, Composer, and fixed queued mode as yolo; respective Plans retained; includes transactions, idempotency, and projection recovery. Baseline failures for necessary verification and cross-platform unverified items per Todo section 9.

- [Todo157: Vendor Plan Entry, Go Model Completion, and Manual Key Access Wrap-up](todo-157-provider-plan-catalog-and-manual-access-cleanup.md): Awaiting execution, new vendor retains candidate status. Completing existing plan entries and three missing items for Go directories; removing special Access for manual plans, canceling their proxy domain security verification admission, changing visual badges to template-identity recognition. This round only organizes Todos and indexes, no product code or config modified.

- [Todo156: Start Independent Provider Follow-up Fixes and Final Page Decisions](todo-156-start-plan-followup-final-decisions.md): **Implemented and self-reviewed; user requested commit push; baseline failure records retained**. Start permanent and reuses original page state styles; cleaned redundant connection gates, added balance access parameters, retained claim flow with "view plan"; paid dropdown directly matches connection selection, session hints display plan type. Added sidebar-first recommendation, unified recommended balance sharing, on-demand refresh, and 60-second validity. Team data construction special governance deferred, multi-instance quota cards hold baseline; supersedes Todo155 initial scope, Pro admin SSH E2E and comprehensive review evidence per this ticket's §14.

- [Todo155: Start Connection Dependency Cleanup and Model-switching Plan Badge](todo-155-start-plan-selection-dependency-cleanup.md): Initial issue list, investigation history retained; final scope superseded by [Todo156](todo-156-start-plan-followup-final-decisions.md), no longer an implementation entry.

- [Todo154: Start Independent Provider and Submit-time Plan Recommendation](todo-154-start-plan-independent-provider.md): **Implemented and reviewed, Pro E2E passed**. Start connection-free, retains ID/brand icons, independent current and model selection; no data migration, submit/create-time recommends quota-equipped and reasoning-compatible same-model Start. Subagents explicitly save inclusion, immediate run/Bot/background execution excluded; "do not show again" effective across entry/restart/same-host mobile. Final plan and verification per this ticket's §8; pre-implementation investigation归research, stable behavior synced to official Start spec.

- [Todo153: Thought Level Display Mapping and Config Order Alignment](todo-153-thought-level-display-mapping.md): Implemented; merged close text, "minimal" independent as "extremely low / Minimal," added "extreme / Ultra," retained extra-high/extra_high, canceled fuzzy alias forced classification, and respected config order. 192 unit tests, eight browser interaction groups, and type/lint/architecture checks passed; full native/mobile remote control not re-run, no original values or request mappings changed.

- [Todo147: Builtin Config Simplification and Default Baseline Adjustment](todo-147-builtin-config-simplification-feedback.md): Continuously collecting feedback, unimplemented; confirmed simple prefix/suffix matching, specific rules deferred, two special Model Rules deleted, universal context/output limits adjusted to 1000000/128000. This round persists only.

- [Todo143: Model Config Checkbox Color Alignment to System Components](todo-143-model-checkbox-system-colors.md): Implemented and reviewed; browsers 6/6, unit tests 51/51, type/lint/architecture checks passed. Only corrected checkbox colors; outer overlay highlights, graphics, and interactions retained; native device not re-run.

- Todo142: Official version request security verification exceptions for Start/idle requests (documents only for official versions): Implemented and locally verified/reviewed; retained JWT/Ticket authentication, 189 regression and type/lint/architecture checks passed; device not re-run.

- [Todo141: Model Editor Dialog Layout and Advanced Config UX Alignment](todo-141-model-editor-product-ux-alignment.md): **Completed**; implemented after 2026-09-12 re-authorization, item-by-item reviewed, browsers 26/26, related unit tests 51/51, type/lint/architecture checks passed; native device not re-run, Todo134 draft and validation boundaries retained.

- [Todo140: Off-Peak Model List and Visual/Search Capability Updates](todo-140-offpeak-model-catalog-and-capabilities.md): Implemented and locally verified/reviewed; two vendors retain only GLM-5.3/Flash, neither has built-in search, 5.3 no vision; revision 25 not yet online.

- [Todo139: Share Import Reuses Ordinary New Task's Model and Mode Initialization](todo-139-share-import-new-task-selection.md): Implemented; local unit tests/browsers and review complete; complete share server→native first RPC joint acceptance still pending, not claiming full acceptance complete.

- Todo136: Official version request security verification admission adjustment (documents only for official versions): Implemented; Start/idle JWT missed testing and erroneous admission corrected by Todo142.

- [Todo135: Restore Model Request Default Headers and OpenRouter Attribution](todo-135-model-default-headers-and-openrouter-attribution.md): Implementation and local verification complete; real cross-platform verification limits per body.

- [Todo138: Empty Model Draft and Model Layer Reasoning Fallback](./todo-138-reasoning-level-ui-and-api-defaults.md): Completed. Empty UI drafts do not pre-fill levels; Model uses universal fallback disabled/enabled; three API universal maps convert enabled to high. Levels and dedicated rules retained. Source revision 23, merged version 24.

- [Todo137: Start Plan GLM-5.3 Hidden Visual Badge](./todo-137-start-plan-glm53-vision-badge.md): Implemented and passed display regression. Only expands shared display scope; image capability and Flash badges retained.

- [Todo117: Preserve Account Domain, Supplement Plan Selection, and Cancel Account Disable](todo-117-preserve-account-domain-on-provider-save.md) / [Todo118: Preserve Legacy Provider Enabled on First Migration](todo-118-preserve-legacy-provider-enabled.md): Latest rulings wrapped up, awaiting implementation. Built-in account providers cannot be disabled; existing false values no longer take effect; old account disables not imported; template-created manual Key instances can still enable/disable. Current connections, entitlements, credentials, and model eligibility not relaxed, no batch changes to real user data.

- [Todo132: Model Option Color Feedback and Provider Name Edit Fix](todo-132-model-option-feedback-and-provider-name-edit.md): **Awaiting execution, plan confirmed**. Only enhances block option color contrast; retains text icons and overlay borders; name saves on Enter/blur, cancels on Esc, isolates shared auto-save, address/API Key timing preserved. Two items combined verification, this round persists only.

- [Todo131: Model Settings Page Smart Config Placement and "Restore" Button](todo-131-model-settings-smart-config-placement-and-restore.md): **Awaiting execution, plan confirmed**. Shorten ID input field; smart config and question mark moved to same container right; bottom "restore" clears overrides and enables smart mode, only modifies drafts, empty ID not disabled, only disabled during save. Reuses Todo130 field boundaries, Todo125 description unchanged; this round persists only.

- [Todo130: Smart Config Toggle and Manual Config Field Boundary Correction](todo-130-manual-model-config-editable-field-boundary.md): **Awaiting execution, plan confirmed**. Unified editable field contract, modified manual schema, system field synthesis, draft save, and toggle conditions; excludes old model fallback, does not let hidden fields prevent form save. Estimated not yet officially released, no complex migration preset; M120 verification plan listed, this round persists only.

- [Todo129: Provider Telemetry Adaptation and Team Plan Classification Fix](todo-129-provider-telemetry-compatibility-and-team-classification.md): **Awaiting execution, direction confirmed**. Reports side unchanged; telemetry output boundaries best-effort recovery of old IDs/old caliber; Team verified against old version per-event facts, determinable items directly proceed, irrecoverable minority items keep real IDs as evidence. Includes two-team classification, home page idle block, and BigModel classification fixes; does not change real requests, storage, or old parsers, not mixed with Todo128 timing fixes. This round persists only.

- [Todo128: Provider Start Contract and Idle Eligibility Refresh Fix](todo-128-provider-start-contract-and-offpeak-eligibility.md): **Awaiting execution, plan confirmed**. Four `start()` and wrappers uniformly return `void`; business explicitly reads current snapshots; supplements Registry update after/manual refresh eligibility checks, unifies concurrency and expiry result protection. Retains plan rules, does not change Composer, persistence schema, or Runtime composition boundaries. This round persists only.

- [Todo127: Built-in Config Online Publishing and Update Chain Fix](todo-127-builtin-online-release.md): **Awaiting execution, detailed plan confirmed**. Versioned CDN URLs; two-phase download totaling 20s, body 10MB; every-minute checks, normal hourly downloads; Account serial rebuild and misaligned recovery share same check entry. Listed implementation order and acceptance, this round persists only, no new client business integrity gates.

- [Todo113: Recent New Model Catalog and Smart Config Update](todo-113-new-model-catalog-refresh.md): **Second round awaiting execution**. Supplement GPT-5.4 basic/Pro/Mini/Nano smart config, aggregated DeepSeek V4.1 Flash, Qwen Omni/3.7/3.6 config, Kimi high-speed version; verify and remove offline built-in members; all new models must verify aggregated support, confirmed items still require deep study. First-round results retained; this round persists only.

- [Todo126: GLM Vision Badge Display, Flash PDF, and Coding Plan API Turbo Defaults](todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md): Plan confirmed, awaiting implementation. Flash PDF moved to general model rules, two plan API templates' Turbo defaults off; settings page and model selector hide Coding Plan GLM-5.3 vision badges; bridge image capability unchanged, Flash retains visual badge. Account defaults and personal explicit overrides unchanged, this round persists only.

- [Todo125: Model Settings Page Question Mark Instructions and Final Copy](todo-125-model-settings-help-copy.md): Ruling confirmed, awaiting implementation. This round only persists; subsequent strictly follow verbatim copy and interaction requirements, no self-modified layout, config behavior, or expanded scope.

- Todo95C, Todo97, Todo98 completed per their final scopes; residual cross-platform verification归Todo102, not listed as development items again.
- [Todo102: Residual Verification Unified Wrap-up](todo-102-verification-debt-closeout.md) is the sole scheduling entry for residual under-tested, pre-existing failures, and pending manual escalations; old verification Todo52/57/64/78 closed and transferred; historical pass/fail evidence not deleted or rewritten as passing.
- Todo96's explicit Subagent gap completed by Todo99; Todo87/88 related deferred text only historical rulings. Todo99 this round implementation wrapped up; Todo100 investigation complete; cross-platform deferred remains in Todo102.
- Old specialties Todo11/22/45/80/86 etc. continue deferred; Todo101 still future draft; no re-opening abandoned Todo15/19. m2's Schema Todo99 merged as Todo104, no renaming existing Todo99/100.

- [Todo104: Pre-release Persistence Schema Review and Refinement](todo-104-pre-release-schema-review.md): User authorized implementation on 2026-09-10. Subject to final rulings, grouped verification; "discussion only/unauthorized" in original is historical state. Independent implementation branches do not change Todo103 staging candidate acceptance conclusions.

Directory tree and implementation order below preserve historical processes; principles not superseded by new rulings remain valid; latest status read from this section, each Todo top, and subsequent implementation evidence.

Completed: [Todo 85: Staging Revert and Post-Manual-Conflict Handling Feature Restoration](./todo-85-staging-revert-behavior-restoration.md), including approved Todo87 alternative implementation. Process, rulings, commits, and verification uniformly recorded in [Restoration Audit](../plan/staging-conflict-restoration-audit.md); new E2E retained pending manual ratification.

This directory records how Provider architecture enters code in phases. Current target structure uniformly at
[`../design-v2/design.md`](../design-v2/design.md), historical contradiction rulings at
[`../design-v2/evidence-and-contradictions.md`](../design-v2/evidence-and-contradictions.md). This directory only answers implementation questions: what this phase changes, how to split, what actually completed, what deviations appeared during implementation, and what remains.

```text
steps/
├─ steps.md
│  └─ Implementation document responsibilities and maintenance rules
├─ migration-roadmap.md
│  └─ M0 to M6 overall migration order and independent follow-up specialties
├─ 01-model-and-request.md
│  └─ M1 implementation goals, results, and residuals
├─ 01-model-and-request-implementation-log.md
│  └─ M1 self-directed decisions and retained evidence beyond original scope
├─ 01-model-and-request-review.md
│  └─ Comprehensive post-merge review of M1
├─ 02-provider-config-and-registry.md
│  └─ M2 implementation goals, slices, current status, and remaining retirement boundaries
├─ 02-provider-config-and-registry-human-in-the-loop.md
│  └─ M2 architecture, product, and public contract rulings requiring human confirmation
├─ 02-provider-config-and-registry-impact.md
│  └─ M2 first pure-domain-slice startup historical impact and test contracts
├─ 02-provider-config-and-registry-cleanup.md
│  └─ M2 retirement audit, residual chains, and final completion gates
├─ 02-provider-config-and-registry-review.md
│  └─ M2 new code scale, transition boundaries, and subsequent exit condition reviews
├─ 02-provider-config-and-registry-mr-review.md
│  └─ M2 Merge Request static review unresolved issues and preliminary directions
├─ 02-provider-config-and-registry-implementation-log.md
│  └─ M2 self-directed decisions and audit evidence in chronological order
├─ 03-provider-architecture-cutover.md
│  └─ M3 integration implementation plan, deletion gates, and acceptance matrix for current large Merge Request
├─ 03-provider-architecture-cutover-implementation-log.md
│  └─ M3 self-directed engineering decisions, current baseline, and verification trajectory
├─ 03-staging-integration.md
│  └─ M3.0 staging semantic migration plan and pending Rebase gates
├─ 04-model-execution-cutover.md
│  └─ M4 idle tasks, Subagents, and unified Model creation chain phase design and implementation results
├─ todo-01-core-model-adapter-boundary-cleanup.md
│  └─ Completed cleanup: Core to ModelFactory/Model single-chain closure
├─ todo-02-ai-sdk-execution-registry-retirement.md
│  └─ Completed retirement: Old AI SDK execution Registry within Adapters
├─ todo-03-provider-model-ownership-and-property-totality.md
│  └─ Historical model member ownership and Properties completeness implementation; enable/disable, duplicate members, and settings interactions superseded by Todo 21
├─ todo-04-core-model-connection-port-retirement.md
│  └─ Completed cleanup: Core Model Connection Port retirement
├─ todo-05-model-ref-retirement.md
│  └─ Completed cleanup: ModelRef retirement by consumer semantics
├─ todo-06-config-storage-envelope-repository-privatization.md
│  └─ Config storage envelopes and migrations returned to Repository private implementation
├─ todo-07-account-connection-selection-and-access-context-cutover.md
│  └─ Account connection structured selection, Provider Account Access, and request auth closure
├─ todo-08-legacy-model-catalog-retirement.md
│  └─ Legacy Model Catalog, overrides, and Reasoning State retirement
├─ todo-09-off-peak-model-selection-legacy-projection-retirement.md
│  └─ Off-Peak old model projection retirement and unified scoped Selection View
├─ todo-10-zcode-builtin-provider-config-naming-cutover.md
│  └─ One-time Provider Config `official` name cutover to ZCode Built-in
├─ todo-11-provider-runtime-composition-boundary-cleanup.md
│  └─ Provider Runtime composition boundary, resource owners, and process composition root cleanup draft awaiting ruling
├─ todo-11a-provider-runtime-disposal-functional-fix.md
│  └─ Independent functional fix for complete Provider Runtime release
├─ todo-12-model-selection-validation-boundary-cutover.md
│  └─ Delete user Facade execution validation and restore authoritative validation to ModelFactory
├─ todo-13-target-host-model-selection-authority.md
│  └─ Target Host model selection authority and old preparation chain retirement
├─ todo-14-post-refactor-mechanical-zero.md
│  └─ Provider Refactoring completed first-round mechanical zeroing
├─ todo-16-unplanned-model-abstraction-residue-cleanup.md
│  └─ Unplanned Model abstraction residue zeroing
├─ todo-17-provider-registry-settings-authority-boundary-closure.md
│  └─ Resolver, Registry, and Settings authority boundary closure
├─ todo-18-zcode-builtin-client-config-sync-and-lkg.md
│  └─ ZCode Built-in Release remote sync, Environment Active Cache, and refresh debouncing
├─ todo-20-account-overlay-atomicity-and-review-closeout.md
│  └─ Account Overlay atomic publishing and Endpoint Active isolation; enabled old semantics superseded by Todo 50
├─ todo-21-zcode-builtin-config-ownership-and-model-activation-order.md
│  └─ Built-in config responsibilities, Model Config enable/disable, Provider/Model ordering, settings page, and ZCode V4 Access positioning
├─ todo-22-additional-builtin-providers-and-cloud-access.md
│  └─ Independent access drafts for OpenRouter, OpenCode Zen, Azure, Volcano Ark, and AWS Bedrock
├─ todo-23-provider-refactor-decision-gap-closure.md
│  └─ Post-completion reverse review findings: Account Access, ModelSelection, and Settings transaction gap closure
├─ todo-24 (documents only for official versions)
│  └─ Access slice replacing Todo 23, closing account dynamic auth, Access Type, and request security verification single source of fact
├─ todo-25-zapi-product-entry-retirement.md
│  └─ Delete ZAPI product entry, exclusive intranet Gate, old config migration, and current identity residuals
├─ todo-26-zhipu-access-mode-contract-cutover.md
│  └─ Replace pseudo-generic protocol field with two-layer Access Type/Mode; Account API old slice superseded by Todo 49
├─ todo-27-provider-settings-dogfood-closeout.md
│  └─ Close model Overlay interactions, window-level success feedback, Team state machine, and Runtime Headers Schema drift
├─ todo-28-model-rule-precedence-and-order-canonicalization.md
│  └─ Close Personal Rule precise priority and Provider/Model three-segment ordering read-write consistency
├─ todo-29-model-config-resolution-and-idle-trigger-closure.md
│  └─ Close model default config resolution naming, load feedback, and Provider/Model idle triggering
├─ todo-30-provider-settings-scroll-affordance.md
│  └─ Add conditional boundary hints to Provider settings left/right independent scroll areas
├─ todo-31-model-metadata-editor-input-consistency.md
│  └─ Close model JSON input boxes, technical input attributes, and Chinese IME Enter behavior
├─ todo-32-team-plan-settings-effective-provider-boundary.md
│  └─ Separate Team plan status cards from Effective Provider settings projection, prohibit plan status hiding model config
├─ todo-33-personal-provider-config-file-cutover.md
│  └─ Switch Personal Provider/Model Config to provider_config.json, retire old Store and old Coding Plan Key migration
├─ todo-34-model-selection-async-state-and-repo-wiki-draft.md
│  └─ Explicit Model Selection async state, use ModelSelection to close Repo Wiki Draft, Fallback, and submission admission
├─ todo-43-models-api-evidence-and-minimax-m3-correction.md
│  └─ Position Models API as release evidence, correct MiniMax M3 official members, capabilities, and default enable status
├─ todo-45-models-api-publisher-evidence-tool.md
│  └─ Awaiting execution: Use execution-period access material to collect Models API real-time catalogs and generate Built-in difference reports; comprehensive real-time correction blocked by vendor credentials
├─ todo-46-model-reorder-visual-continuity.md
│  └─ Close Model reordering pending visual continuity and list single-layer borders
├─ todo-47-provider-connectivity-save-and-result-cleanup.md
│  └─ Connectivity tests reuse formal Model, wait for Provider draft save, delete duplicate error classification and old result projection
├─ todo-48-account-api-and-manual-api-key-boundary-cleanup.md
│  └─ Account API hallucination investigation records; formal rulings and implementation by Todo 49
├─ todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md
│  └─ Delete pseudo Account API, return Z.ai/BigModel pay-per-use API to real API Key Providers
├─ todo-50-provider-enabled-and-account-entitlement-separation.md
│  └─ Separate Provider config participation switches from Account Access entitlement facts
├─ todo-51-provider-access-consumer-and-offpeak-auth-closeout.md
│  └─ Close Provider Access consumer semantics, Welcome API Key Overlay, and Off-Peak auth sources
├─ todo-52-provider-e2e-regression-closeout.md
│  └─ Completed: Delete outdated Family Case, migrate formal input Fixtures, and close Registry polling barriers
├─ todo-55-provider-template-inheritance-cutover.md
│  └─ Completed: Pay-per-use API and ordinary suppliers migrated to Templates, Z.ai/BigModel Family narrowed to Account-only
├─ todo-56-remote-provider-provisioning-environment-sync.md
│  └─ Completed: Merged remote Provisioning baselines, closed automatic sync via Application-level Environment Coordinator
├─ todo-57-provider-e2e-runtime-verification-closeout.md
│  └─ Implemented: 45 macOS Provider E2Es passed; 1 real SSH Remote Case skipped due to missing credentials
├─ todo-69-provider-refactor-practical-rollback-compatibility.md
│  └─ No multi-domain continuous dual-write; only isolate Bot v3 files, retain old files, and verify actual staging read boundaries
├─ todo-70-session-model-selection-migration-and-unbound-recovery.md
│  └─ Limit old Session migration to storage boundaries; invalid selections empty, no prompts, no blocking history
├─ todo-71-persistent-composer-draft-and-submission-state.md
│  └─ Persist Composer mode/ModelSelection; empty invalid, no prompts, close submission and Queue freeze semantics
├─ todo-72-legacy-builtin-provider-and-model-selection-migration.md
│  └─ Correct old built-in config classification, migrate only Built-in API Key, and convert old Coding Plan selections by current account connections
├─ bugfix-01-builtin-provider-overlay-recreation.md
│  └─ Lifecycle fix: Same Host cannot re-add after deleting ordinary Built-in Personal Overlay
├─ bugfix-02-provider-reorder-drop-flicker.md
│  └─ Optimistic sorting fix: Provider drag-drop reverts to old position first, then jumps to target
├─ bugfix-03-provider-review-boundary-closeout.md
│  └─ Close Provider Review findings: settings boundaries and model config semantics
├─ bugfix-04-model-json-editor-fixed-height.md
│  └─ Model JSON editor fixed height with internal scrolling
├─ bugfix-05-personal-config-worker-refresh.md
│  └─ Delete Personal Config fs.watch, use content-revision polling and connection test proactive refresh to fix Worker Registry staleness
└─ bugfix-06-readonly-provider-field-affordance.md
   └─ Unify Built-in Provider read-only Endpoint and API Schema frozen display semantics
```

Sub-documents organized by implementation order:

- [`migration-roadmap.md`](./migration-roadmap.md) gives overall migration order M0-M6, cross-phase constraints, and independent follow-up topics not part of this refactoring.
- [`01-model-and-request.md`](./01-model-and-request.md) summarizes M1 implementation goals, actual delivery, and residuals.
- [`01-model-and-request-implementation-log.md`](./01-model-and-request-implementation-log.md) saves M1 self-directed decisions beyond original scope, with attached verification evidence.
- [`01-model-and-request-review.md`](./01-model-and-request-review.md) saves M1 post-merge integrity review and risk classification.
- [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md) records M2 implementation goals, slices, current status, and remaining retirement boundaries.
- [`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md) records M2 architecture, product, and public contract rulings requiring human confirmation, and their impact on current implementation.
- [`02-provider-config-and-registry-impact.md`](./02-provider-config-and-registry-impact.md) saves M2 first pure-domain-slice startup impact, invariants, and test handoffs; its scope and unresolved items are historical implementation evidence.
- [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md) records M2 retirement cleanup results, narrowly retained compatible boundaries, and release verification evidence.
- [`02-provider-config-and-registry-review.md`](./02-provider-config-and-registry-review.md) quantifies M2 new code, distinguishing target implementation, one-time migrations, and still-running transition boundaries.
- [`02-provider-config-and-registry-mr-review.md`](./02-provider-config-and-registry-mr-review.md) records M2 Merge Request full static review findings not yet forming final rulings; it does not rewrite Design or phase completion status.
- [`02-provider-config-and-registry-implementation-log.md`](./02-provider-config-and-registry-implementation-log.md) saves M2 self-directed decisions and audit evidence chronologically; current conclusions per Design, M2 main document, and Human in the Loop.
- [`03-provider-architecture-cutover.md`](./03-provider-architecture-cutover.md) defines current Merge Request as M3 architecture cutover: one atomic operation completing atomic Submission, model selection state, settings page, and old chain retirement on completed Config/Registry foundation.
- [`03-provider-architecture-cutover-implementation-log.md`](./03-provider-architecture-cutover-implementation-log.md) saves M3 current implementation baseline, out-of-plan self-directed decisions, and verification trajectory.
- [`03-staging-integration.md`](./03-staging-integration.md) records how M3 step one absorbs staging's Video Input, modal settings, and ox-alpha reasoning, distinguishing product semantics to retain from temporary Provider implementations to overturn.
- [`04-model-execution-cutover.md`](./04-model-execution-cutover.md) records how M4 uses general Provider visibility, request-time Access, standard Registry/ModelFactory, and Active Model to close idle tasks and Subagents, deleting old Runtime Overlay.
- [`todo-01-core-model-adapter-boundary-cleanup.md`](./todo-01-core-model-adapter-boundary-cleanup.md) records Core deleting Adapter bypasses, uniformly using ModelFactory/Model completed work.
- [`todo-02-ai-sdk-execution-registry-retirement.md`](./todo-02-ai-sdk-execution-registry-retirement.md) records old AI SDK execution Registry retirement within Adapters.
- [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md) records completed `builtinModelIds`/`modelIds` and Effective Properties complete type boundaries; Model visibility, conflict DTOs, and old settings interactions are historical implementation facts, superseded by Todo 21.
- [`todo-04-core-model-connection-port-retirement.md`](./todo-04-core-model-connection-port-retirement.md) records outstanding Core Model Connection Port retirement plans.
- [`todo-05-model-ref-retirement.md`](./todo-05-model-ref-retirement.md) records gradual ModelRef retirement by real consumer semantics.
- [`todo-06-config-storage-envelope-repository-privatization.md`](./todo-06-config-storage-envelope-repository-privatization.md) Returns Config Documents, version envelopes, and migrations to Repository private implementation.
- [`todo-07-account-connection-selection-and-access-context-cutover.md`](./todo-07-account-connection-selection-and-access-context-cutover.md) Records account connection structured selection, Account Built-in Provider Access, Request Auth, Off-Peak, and Official MCP unified closure.
- [`todo-08-legacy-model-catalog-retirement.md`](./todo-08-legacy-model-catalog-retirement.md) Deletes Legacy Model Catalog, overrides, and Reasoning State, keeping request projections driven by Config.
- [`todo-09-off-peak-model-selection-legacy-projection-retirement.md`](./todo-09-off-peak-model-selection-legacy-projection-retirement.md) Deletes Off-Peak old model DTO projections, uniformly uses scoped Registry Selection View.
- [`todo-10-zcode-builtin-provider-config-naming-cutover.md`](./todo-10-zcode-builtin-provider-config-naming-cutover.md) One-time cutover Provider Config's `official` domain, code, and physical naming to ZCode Built-in, no compatibility entries retained.
- [`todo-11-provider-runtime-composition-boundary-cleanup.md`](./todo-11-provider-runtime-composition-boundary-cleanup.md) Saves Provider Runtime multi-layer wrapping, Node Config resource boundaries, and Host/Agent two composition root current-state evidence and candidate plans; currently an unimplementable draft awaiting ruling.
- [`todo-11a-provider-runtime-disposal-functional-fix.md`](./todo-11a-provider-runtime-disposal-functional-fix.md) Independent fix for Provider Runtime release not penetrating Protocol Agent lifecycle, not waiting for Todo 11 architecture ruling.
- [`todo-12-model-selection-validation-boundary-cutover.md`](./todo-12-model-selection-validation-boundary-cutover.md) Deletes user Model Selection Facade's internal execution validation entry, restores authoritative validation to Registry/ModelFactory, retains Off-Peak narrow advance checks.
- [`todo-13-target-host-model-selection-authority.md`](./todo-13-target-host-model-selection-authority.md) Unifies model candidates, defaults, and execution validation to target Environment Host.
- [`todo-14-post-refactor-mechanical-zero.md`](./todo-14-post-refactor-mechanical-zero.md) Records completed Factory, MCS, Legacy DTO, and dead-code first-round mechanical zeroing.
- Todo 15 marked abandoned, no longer an independent release-verification Todo; subsequent release verification per final Release Checklist separately wrapped up.
- [`todo-16-unplanned-model-abstraction-residue-cleanup.md`](./todo-16-unplanned-model-abstraction-residue-cleanup.md) Deletes Runtime, Protocol, Legacy Config, and documentation abstraction residuals existing outside first-round planning.
- [`todo-17-provider-registry-settings-authority-boundary-closure.md`](./todo-17-provider-registry-settings-authority-boundary-closure.md) Closes Resolver complete types, Settings three-layer Views, fine-grained saves, write timing, and connectivity; Provider/Model lifecycle, source, and ordering old rulings superseded by Todo 21.
- [`todo-18-zcode-builtin-client-config-sync-and-lkg.md`](./todo-18-zcode-builtin-client-config-sync-and-lkg.md) Records completed two-layer Release, Bundled/Active/LKG selection, Environment owner, remote sync, and persisted lease.
- Todo 19 marked abandoned, no longer an independent release-gate Todo; if release gates truly needed in future, establish new task based on then-release processes.
- [`todo-20-account-overlay-atomicity-and-review-closeout.md`](./todo-20-account-overlay-atomicity-and-review-closeout.md) Records Account Overlay atomic publishing, Built-in source revision barrier, Endpoint Active/LKG isolation, and CLI, dependencies, and orphan ZIP closure; Account `enabled` old semantics superseded by Todo 50.
- [`todo-21-zcode-builtin-config-ownership-and-model-activation-order.md`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md`) Completed Built-in Provider/Model config responsibility closure: Providers manage model members and ordering, Model Config `enabled` manages model execution gates, Personal exclusive Rules carry single-model-override on settings page, Registry/Selection unify executable/selectable semantics, and official version request security verification config moved from Model Config to Provider Access.
- [`todo-22-additional-builtin-providers-and-cloud-access.md`](./todo-22-additional-builtin-providers-and-cloud-access.md`) Independent design for OpenRouter, OpenCode Zen, Azure, Volcano Ark, and AWS Bedrock Built-in templates, Access, and real request verification; does not block Todo 21.
- [`todo-23-provider-refactor-decision-gap-closure.md`](./todo-23-provider-refactor-decision-gap-closure.md`) Closed same-shape ModelRef, Selection strings, and Settings atomic transactions; its Access slice by Todo 24.
- Todo 24 (documents only for official versions) replaces Todo 23's Access slice: deletes account-creation-time binding, narrows Account Overlay, strictly switches Access Type, and closes official version request security verification's only static admission facts.
- [`todo-25-zapi-product-entry-retirement.md`](./todo-25-zapi-product-entry-retirement.md`) Deletes exited-product ZAPI Provider identities, settings entries, exclusive intranet gates, and Legacy migration exceptions, while retaining general intranet detection and dependency download capabilities.
- [`todo-26-zhipu-access-mode-contract-cutover.md`](./todo-26-zhipu-access-mode-contract-cutover.md`) Replaces Todo 24's Access structure: keeps only ordinary `api-key` and `zhipu-account`, drives Start, Individual, Team, Off-Peak, official version security verification, and request-time auth via Built-in `family + mode`, deletes pseudo-generic protocol fields; pseudo Account API deleted by Todo 49.
- [`todo-27-provider-settings-dogfood-closeout.md`](./todo-27-provider-settings-dogfood-closeout.md`) Closes post-real-device-experience residuals: unified model Boolean Overlay styles and model-level restore defaults, anchors success feedback to window bottom, differentiates Team unknown/failure/explicitly unavailable, and makes Runtime Headers strictly reuse formal Registry Access Schema.
- [`todo-28-model-rule-precedence-and-order-canonicalization.md`](./todo-28-model-rule-precedence-and-order-canonicalization.md`) Corrects two mechanical deviations after Todo 21/23 completion: unifies `Built-in + Personal Match + Personal provider-model` Rule priority, and makes Resolvers and all write boundaries reuse same Provider/Model three-segment ordering normalization.
- [`todo-33-personal-provider-config-file-cutover.md`](./todo-33-personal-provider-config-file-cutover.md`) Independents Personal Provider/Model Config to `provider_config.json`, unidirectional import only from released old `config.json`, deletes `model-providers.json`, old Coding Plan Keys, and migration backup chains.
- [`todo-34-model-selection-async-state-and-repo-wiki-draft.md`](./todo-34-model-selection-async-state-and-repo-wiki-draft.md`) Explicitly sets Model Selection loading, unavailable, error, and ready states; uses `ModelSelection` to replace Repo Widget control strings; deletes Renderer's second fallback.
- [`todo-45-models-api-publisher-evidence-tool.md`](./todo-45-models-api-publisher-evidence-tool.md`) Plans Built-in publishers' Models API real-time catalog evidence tool; tool implementation can advance with Fixtures first, but all vendors' real-time correction blocked by corresponding access materials, does not automatically rewrite release configs.
- [`todo-47-provider-connectivity-save-and-result-cleanup.md`](./todo-47-provider-connectivity-save-and-result-cleanup.md`) Makes connectivity tests reuse Provider draft unique submission timing, deletes old Model Config write entries, duplicate error classifications, and multi-Endpoint UI residuals.
- [`todo-48-account-api-and-manual-api-key-boundary-cleanup.md`](./todo-48-account-api-and-manual-api-key-boundary-cleanup.md`) Is staging behavior, credential sources, and Account API phantom research/ruling records, no longer an independent implementation Todo.
- [`todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md`](./todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md`) Records completed phased cutover: deleted two duplicate Account API Providers and `zhipu-account/api-key`, strictly narrowed automatic project keys to Coding Plan request auth; `zai-api` / `bigmodel-api` fixed occupying Family "pay-per-use API" slot conclusions by Todo 55 continue replaced by Provider Templates.
- [`todo-50-provider-enabled-and-account-entitlement-separation.md`](./todo-50-provider-enabled-and-account-entitlement-separation.md`) Retains Provider `enabled` as "joined current config" single fact, contracts account plan eligibility to `zhipu-account access.entitled`, deletes Account Overlay reuse of top-level `enabled`.
- [`todo-51-provider-access-consumer-and-offpeak-auth-closeout.md`](./todo-51-provider-access-consumer-and-offpeak-auth-closeout.md`) Closes consumption-layer drift after Todo 47/49/50: thoroughly separates `enabled`, `entitled`, and `executable`; consolidates Off-Peak account materials and per-request auth to single Host-private source; deletes old Family mode, error interface naming, and documentation residuals; Welcome saves fixed Family API Provider Overlay phase conclusions by Todo 55 changed to create Provider Template instances.
- [`todo-52-provider-e2e-regression-closeout.md`](./todo-52-provider-e2e-regression-closeout.md`) Records completed Provider E2E regression closure: unified formal input Fixtures, Bot Selection, Subagent structured selection, and Personal Config polling barriers; deleted Product-object-less Family Cases, restored still-valid Account, Runtime, recovery, and Upgrade behavior proofs.
- [`todo-55-provider-template-inheritance-cutover.md`](./todo-55-provider-template-inheritance-cutover.md`) Replaces all non-Account Built-in Concrete Providers with Provider Templates reusing existing Provider Config value structures; Z.ai API / BigModel APIs and other templates support multi-instance; Family deletes pay-per-use API slot and narrows to Account-only; additionally adds `template-model`, atomic Built-in Release, and retires Provider placement enabled and addable Built-in lifecycles.
- [`todo-56-remote-provider-provisioning-environment-sync.md`](./todo-56-remote-provider-provisioning-environment-sync.md`) First absorbs remote Provisioning Source/Target/transaction baselines, then deletes manual and only-if-missing semantics; Desktop Main schedules by Remote Environment at application-level single-flight; fully covers remote execution images after config, default models, accounts, credentials, and release events.
- [`todo-57-provider-e2e-runtime-verification-closeout.md`](./todo-57-provider-e2e-runtime-verification-closeout.md`) After Todo 56 stabilizes, truly starts Electron/WDIO, reproduces and fixes Todo 52's Provider regression and new Remote Provisioning Cases group by group, strictly distinguishing static pre-checks from real E2E passed evidence.
- [`todo-60-required-reasoning-option-and-mapping-editor.md`](./todo-60-required-reasoning-option-and-mapping-editor.md`) Closes Reasoning Options as required facts for each Effective Model Config, retires fixed thinking budgets, and opens ordered levels and Mapping placeholder editing.
- [`todo-65-provider-settings-dogfood-and-template-ux-closeout.md`](./todo-65-provider-settings-dogfood-and-template-ux-closeout.md`) Closes MacBook Air real-device findings: Account connection test Reasoning missing, Provider Template visual regression, empty group horizontal bars, and error feedback loss of control; Air current HEAD real-device acceptance as completion criteria.
- [`todo-66-option-map-variable-naming-and-display-formatting.md`](./todo-66-option-map-variable-naming-and-display-formatting.md`) Changes Option Map's generic `value` variable to its owning Option name; organizes Built-in Map line breaks and indentation for settings-page readability.
- [`todo-67-complete-model-selection-before-formal-model-creation.md`](./todo-67-complete-model-selection-before-formal-model-creation.md`) Fixes connectivity test entering strict ModelFactory before lowest reasoning level binding timing errors; audits whether all formal model creation entries pass complete Selection.
- [`todo-68-active-model-context-single-source.md`](./todo-68-active-model-context-single-source.md`) Fixes context lagging one step after switching models; unifies context, tools, and requests for ordinary Turns, Guide, Off-Peak, and Subagents to read same Active Model.
- [`todo-69-provider-refactor-practical-rollback-compatibility.md`](./todo-69-provider-refactor-practical-rollback-compatibility.md`) Uses frozen staging Reader's actual failure scope to裁定 practical rollback: Providers, Sessions, idle, automation, Settings, Subagents, and Wikis do not continuous dual-write; only v3-file isolation for Bot Config/State with strict same-file conflicts; old files retain pre-upgrade state.
- [`todo-70-session-model-selection-migration-and-unbound-recovery.md`](./todo-70-session-model-selection-migration-and-unbound-recovery.md`) Limits true old Session conversions to single storage Decoder; opens history with unbound Selection when Reasoning, Provider, or Model missing/invalid; continues execution after user re-selection.
- [`todo-71-persistent-composer-draft-and-submission-state.md`](./todo-71-persistent-composer-draft-and-submission-state.md`) Merges Composer mode and ModelSelection into existing persisted Draft; deletes Renderer's continuous read of Agent Session Snapshot; closes Submission freeze, success cleanup, Registry invalidation, and Queue boundaries.
- [`todo-72-legacy-builtin-provider-and-model-selection-migration.md`](./todo-72-legacy-builtin-provider-and-model-selection-migration.md`) Identifies incorrectly-marked old built-in Providers as custom; migrates only Built-in API Key; converts old Coding Plan selections by current personal/Team connections at migration time; checks each persistence entry item-by-item, no restoring continuous dual-write.
- [`todo-76-builtin-provider-config-layering-and-site-rules.md`](./todo-76-builtin-provider-config-layering-and-site-rules.md`) Completed: Without changing order overlay, organizes Model, API Schema, Provider Site/Base URL, Template, and Provider Instance Built-in Config responsibilities.
- [`todo-74-model-capability-layer-and-media-output-contract.md`](./todo-74-model-capability-layer-and-media-output-contract.md`) Completed (streaming JSON Schema still handled by Todo 80 separately): Closes GLM-5.3-Flash's Anthropic-only PDF, built-in tool call capabilities, and JSON Schema field semantics.
- [`todo-79-openrouter-opencode-provider-integration-boundary.md`](./todo-79-openrouter-opencode-provider-integration-boundary.md`) Completed first-round Built-in template integration: Takes Todo 22's OpenRouter/OpenCode Zen integration boundaries, Model ID semantics, and existing attribution/runtime foundation.
- [`todo-80-streaming-json-schema-output.md`](./todo-80-streaming-json-schema-output.md`) Draft: Independently studies streaming request-passing JSON Schema Runtime/Adapter contracts, does not change current non-streaming behavior.
- [`todo-81-selection-migration-notice-scope-cleanup.md`](./todo-81-selection-migration-notice-scope-cleanup.md`) Completed: Ordinary session Composer invalid selections do not prompt; ended idle tasks do not display fix errors; still-executable idle tasks and scheduled tasks continue retaining prompts and protections.
- [`todo-82-model-config-follow-recommended-draft.md`](./todo-82-model-config-follow-recommended-draft.md`) Completed: Deleted model editor dialog duplicate enable entries; replaced "restore all defaults" with Draft-only "follow recommended config" toggle; atomically materializes or clears Personal Model Config Overlay on save.
- [`todo-83-account-provider-availability-and-claim-flow.md`](./todo-83-account-provider-availability-and-claim-flow.md`) Implemented (first round closure): Unified Account Provider entitlement status, Start Plan claim post-effect/redirect, and model executability; maintained existing Family selection and Provider config boundaries.

Todos 68–72 jointly executed: 68 wrap → 72 identity transformation foundation → 69 Bot file isolation and correct first import → 70 Session → 71 Composer → 72 remaining persistence entries and joint verification. Detailed division per Todo 72. Unified ruling: Existing models/Reasoning missing or invalid empties, no auto-switch to default models, no empty prompts; true first new tasks still initialized per established rules. Incorrectly migrated Provider configs only manually fixable, no auto-correction code added.

- [`bugfix-01-builtin-provider-overlay-recreation.md`](./bugfix-01-builtin-provider-overlay-recreation.md`) Fixes inability to re-add same Provider after deleting Personal Overlay of ordinary Built-in Provider, permanently blocked by old process-retirement gate on same Host.
- [`bugfix-02-provider-reorder-drop-flicker.md`](./bugfix-02-provider-reorder-drop-flicker.md`) Fixes Provider drag-drop flicker: after dropping, temporary displacement clears first, then reverts to old position, then jumps to target; Models retain existing form optimistic sorting.
- [`bugfix-03-provider-review-boundary-closeout.md`](./bugfix-03-provider-review-boundary-closeout.md`) Closes settings boundaries and model config slot issues found by Provider Review.
- [`bugfix-04-model-json-editor-fixed-height.md`](./bugfix-04-model-json-editor-fixed-height.md`) Keeps Model JSON input as fixed-height text box; long values or Effective placeholders scroll only within the control.
- [`bugfix-05-personal-config-worker-refresh.md`](./bugfix-05-personal-config-worker-refresh.md`) Deletes Personal Config's `fs.watch` sole notification chain, switches to asynchronous content-revision polling, and makes connection tests proactively refresh Worker Registry before finding models.

## Document Relationships

- [`todo-98-builtin-option-map-formatting-regression.md`](./todo-98-builtin-option-map-formatting-regression.md`) Awaiting implementation: Restore Built-in Map object structure line breaks and indentation, simple ternary on same line; only fix layout, preserve current logic, independent of Todo95C level renaming.
- [`todo-99-worker-account-selection-repair.md`](./todo-99-worker-account-selection-repair.md`) Ruling scope this round complete: Full states, receive confirm/failure refresh, explicit Subagent, attachments, Bot Session authority, two partial races, and per-entry review closed; Pro requests, cold recovery, sync lag failures/recovery passed; W99-E05 mobile/SSH joint real-device explicitly deferred by user, not claimed as full-platform passed. No lifecycle restructuring, new send barriers, migrations, or Todo101 changes; see full review ledger and test records.
- [`todo-100-account-provider-selection-architecture-investigation.md`](./todo-100-account-provider-selection-architecture-investigation.md`) Pure investigation complete: Records states loss, false applied ACK, explicit Subagent, Bot subsequent rounds, and attachment dispatch gaps. Subsequent implementation plans wrapped to Todo99; investigation complete does not mean products fixed.
- [`todo-101-concurrent-account-providers-draft.md`](./todo-101-concurrent-account-providers-draft.md`) Draft / Deferred: Personal and multiple Team concrete Providers coexist, settings page pure navigation, cross-Provider auto-correspondance撤销; instance identity, migration, drawer awaiting ruling. Still logs only one account; login account determines idle domain; Tickets not re-bound. This round goes live under current architecture, no premature code or persistence format changes.

- [`todo-87-selection-view-unified-resolution.md`](./todo-87-selection-view-unified-resolution.md`) Implemented: After account and Personal/Built-in updates, uniformly resolves original intent, covers Composer, scheduled background, Bot, Wiki; idle read-only protected, no cross-account ticket switching. Explicit Subagent this round keeps original validation per ruling. Takes Todo85 D02; no pre-send synchronization or storage migration, separated from Todo86 upstream refresh responsibilities.

```text
design-v2/
└─ How the final system works, and how historical materials are resolved
        |
        v
steps/
└─ How to migrate from current code to this design
        |
        v
research/
└─ Current-state evidence supporting design and implementation judgments
```

Research is not target design. When new facts discovered during implementation, first record evidence, then judge whether it affects design-v2 or current step.

## Maintenance Rules

Update to-do: [Todo113: Recent New Model Catalog and Smart Config Update](./todo-113-new-model-catalog-refresh.md). First round complete; 2026-09-11 second round catalog gaps, smart config deep study, aggregated support verification, and offline cleanup are awaiting execution; current scope per this document's section 0, does not change user historical selections or account architecture.

New to-do: [Todo112: Official GLM Real Model ID Case Unification](./todo-112-official-glm-model-id-normalization.md). Official template lists/precise rules and Start dynamic model lists unified naming; existing selection migration supplements official GLM case unification, coordinates with Todo111, does not involve third parties, quota cards, or historical statistics, does not expand personal overlay migration. All uncertain items wrapped up; official endpoints accept target case confirmed by user, awaiting implementation.

- [Todo114](./todo-114-account-status-sync-and-key-retry.md): Upstream original Todo105, renumbered during merge to avoid conflict with this branch's model name refinement. Implemented personal plan reason protocol supplements, two-vendor missing Key classification, and unified retry interaction; upstream 280 targeted tests, four component browser suites passed, complete App / mobile chain remaining verification归Todo102.

Phase documents must at minimum allow readers to confirm four things: phase goals, current status, actual delivery, and remaining issues. Specific structure determined by phase content; uniform template application not required.

Define goals and compatibility boundaries clearly before each phase. Self-directed decisions made during implementation to continue推进 go into implementation logs; decisions changing target abstractions, product semantics, or public contracts go into Human in the Loop, ruled by humans and synced back to design. Normal commit lists and command outputs need not be recorded item-by-item. Systemic problems found post-merge go into reviews.

One slice can merge independently, but phases cannot retain two long-term business semantics upon completion. Migration-period compatibility logic must have clear positions and exit conditions.
