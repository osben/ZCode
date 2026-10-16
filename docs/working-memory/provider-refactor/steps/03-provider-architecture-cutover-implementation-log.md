# M3 Implementation Log

> Status: Current baseline implementation completed, pending integration decision and release gate
>
> Last updated: 2026-08-21
>
> Phase goal: [`03-provider-architecture-cutover.md`](./03-provider-architecture-cutover.md)

This document records engineering decisions made during M3 implementation that exceed the established plan but can be completed autonomously based on existing design principles. Normal code changes and command output are not listed item by item; issues that change product semantics, public abstractions, or phase boundaries still need to enter Human in the Loop.

## 1. Current Working Tree as Implementation Baseline

M3 begins implementation from `7f413be9de` of this working tree. This commit is the local reconstruction result of M2 on a newer staging; the current local `origin/staging` has undergone historical reconstruction again and is bidirectionally forked from this working tree. The user has explicitly requested temporarily not handling the remote branch, so this round does not merge, rebase, or restore old staging implementations, and does not mistakenly record M3.0 as completed.

M3 first advances atomic Submission, Selection, Session Model, old state retirement, and Settings convergence on the current M2 baseline according to the Design. Final release verification still retains the staging topology decision and integration gate; pre-decision implementation commits maintain single responsibilities, facilitating subsequent audit-style replay.

## 2. Spec and Tests First

The formal behavior of atomic Submission is first written to the Conversation Protocol Declaration and Conversation Product State Space. The corresponding Shared, Core, Bootstrap, and UI tests are migrated before production implementation, used to lock the following invariants:

- prompt, attachments, mode, and ModelSelection are atomically received;
- The Queue freezes the Selection at enqueue time;
- The Guide switches at the Model Step boundary;
- Edit, Retry, and Goal retain or inherit explicit Submission intent;
- The Composer Selection no longer pre-writes the current Runtime model.

## 3. Wire and Domain Type Layering

Shared V4 defines the serializable Submission wire schema, with field semantics aligned to the Provider's `ModelSelection`; CLI admission converts to domain values used by Contracts/Core at the boundary. Shared does not reverse-depend on the Provider Registry or Model behavior, avoiding pressing Provider domain dependencies into all protocol consumers.

## 4. Guide Switches at the Core Step Boundary

The Queue and Guide save the complete Submission intent. When the Guide actually drains, Core creates a new Model using the ModelFactory, and simultaneously updates the current Loop and Session Selection; the Bootstrap does not add a long-term model switching callback from Core to Bootstrap. Currently sent Requests continue using the old Model; the next Model Step uses the new Model.

## 5. Selection for Goal, Edit, and Retry

The Goal's first round uses the Selection frozen in the user's Submission; automatic continuation rounds do not save another continuation model, but instead read the Session Selection at start time. Edit and Retry inherit the original Submission's Selection and mode from the canonical source input, without reading the current Composer or later-changed Session state.

## 6. The Renderer Only Maintains the Next Submission Intent

The Composer's model, reasoning, and mode selections no longer send `switchModelConfig` or `switchCollaborationMode` in advance. The Renderer forms a complete Submission through `resolveComposerSubmissionConfig()` at send time; App Recent still updates after the Submission is accepted. This way, the selection control no longer serves as a mutable projection of the Active Model or Session Selection.

## 7. Current Slice Verification Boundary

The root workspace TypeScript build passes; 64 Shared/UI atomic Submission special tests pass; 7 Core Model lifecycle and Guide special tests pass. All 138 assertions across five Bootstrap related files pass, but three unhandled rejections from existing fake-timer timeout cases cause the Vitest process to exit 1; such errors do not serve as green proof for this slice, and the full verification subsequently continues to retain this baseline risk. CLI dependency build to Bootstrap has only two existing type errors from the legacy personal provider importer remaining.

## 8. Session Selection Uses Structured Persistent Format

The Contracts provide protocol-independent `ModelSelection` parsing and functions to project Selection from the actual Model. Session entries directly save `providerId`, `modelId`, and common options, so the reasoning level and max output tokens are preserved with Session recovery. The old entry's top-level `thoughtLevel` is only compatibly handled at cold-read boundaries; new writes no longer produce this field.

## 9. ModelFactory Directly Receives Selection

`RuntimeModelFactoryInput` is changed to directly receive structured `ModelSelection`. The Provider, Model, reasoning level, and max output tokens all enter the Registry ModelFactory through the same input, without the Factory reassembling from `ModelRef.variant` and an independent max-output field. Unmigrated Adapters only obtain the temporary ModelRef projection at the final assembly boundary; the call purpose continues to be expressed by operation and execution context.

## 10. Session Selection Becomes the Runtime Model Fact

The Agent Runtime only holds `sessionModelSelection`, reading and writing the current Session selection through `getSessionModelSelection()` / `setSessionModelSelection()`; the construction phase only performs a single one-way conversion of the yet-unmigrated old config `modelRef`, and no longer saves `defaultModelRef` or another mutable model state. Persistence, fork, compact, title, subagent, hooks, and turn loops all read the same Selection. The still-required old `ModelRef` Adapter temporarily projects through `getModelRef()` immediately; subsequent M3.5 will delete it together with the old config write entry.

This slice locks Session Selection, Guide step switching, persistence, and derivation flows with nine Core test files; 17 tests failed before migration, and all 190 pass after implementation.

## 11. Bootstrap Switch and Restore Write to Selection

The Registry's `setModel`, reasoning level modification, and cold recovery in the Bootstrap uniformly call `setSessionModelSelection()`, without rewriting Session model facts through `updateConfig({ modelRef })`. The Session entry reads and saves the complete Selection from the Runtime, so the reasoning level and default or explicit max output tokens are restored together. The execution-period compatibility configuration left by the Turn Overlay is temporarily retained, to be grouped into the subsequent M3.5 Adapter cleanup.

Test fixtures first migrate away from the old `updateConfig({ modelRef })` API; since these fixtures directly call Core, both old and new implementations remain green, 4 files with 240 tests pass. The Bootstrap's model config, cold recovery, and off-peak overlay 3 files with 67 tests pass. Of 8 tests for the Provider Registry App Runtime, 1 passes and 7 are blocked by missing Browser Use seed build products before entering assertions; the Bootstrap build continues to report only the two existing type errors from the legacy personal provider importer.

## 12. Delete the ModelRef Write Entry from Runtime Config

A global reference audit confirmed that after production callers have exited `updateConfig({ modelRef })`, the Core deletes this field from the public type and implementation of `updateConfig`. Runtime parameter updates and Session Selection writes thus form a mechanical boundary: context window, max output tokens, and other runtime parameter updates cannot implicitly rewrite Selection; model intent can only enter through `setSessionModelSelection()` or Submission admission.

16 new boundary tests and model lifecycle tests pass; the Core TypeScript build passes. `dep:refs` currently cannot load the nested `apps/zcode-cli` package into the root project; the deletion audit therefore uses both full knip and scope-less text call graphs, and cannot mistakenly record the tool failure as a zero-reference proof.

## 13. New Runtime Directly Receives ModelSelection

`AgentRuntimeConfig` adds a structured `modelSelection`; the Bootstrap Registry initialization, Workflow child, Script Workflow child, and Subagent child all directly pass the Selection; the Registry's parsing result simultaneously carries the normalized Selection, without requiring the App to first construct a Session `ModelRef`. The Core constructor temporarily retains the one-way reading of the old `modelRef`, serving only unmigrated tests, protocol Entries, and compatibility configs; production child runtimes have exited this field.

Two preemptive tests fail as expected under the old implementation, and 37 tests pass across Core and Bootstrap after implementation. The Core and dependent build pass; the Bootstrap continues to report only the two existing errors from the legacy personal provider importer.

## 14. Protocol Session Entry Parsed as Selection

The ZCode Protocol's `session/create` still accepts the wire-layer structured model DTO, but converts directly to `ModelSelection` before entering the App Runtime, with the reasoning variant written to `options.reasoningLevel`, without constructing the initial `ModelRef`. The Workspace generate text is still an independent model task, retaining its own old input for now, to be handled separately in subsequent model migration slices for independent tasks.

The new protocol entry test confirms the Runtime receives the complete Selection and the config does not contain `modelRef`; 1 target test passes.

## 15. Execution Purpose No Longer Encoded as ModelRole

The Title, Subagent, Registry Main, and Turn Overlay no longer write `ModelRole` to the model identity. The Title is identified by `modelCall.operation=session_title_generation`; the Subagent is identified by the child runtime/task context; the model identity only retains the Provider, Model, and yet-to-be-migrated reasoning variant. There is no longer `ModelRole.*` construction in the production Core, Bootstrap, Adapter, and Contracts source code.

The Subagent initial model event test first fails under the old implementation, and 2 tests pass (including the delete role and Title operation test); the Core, Adapter, and their dependent build pass, with the Bootstrap still stopping at the same two legacy importer baseline errors.

## 16. Model Debugging and Creation No Longer Propagate Old Source Metadata

The Adapter Registry, Core default placeholder selection, and Model IO debug no longer construct or output `ModelRefSource`; Core internal dependency barrels also stop re-exporting `ModelRole` / `ModelRefSource`. The source semantics are retained in the Submission, query source, trace context, and task context, without being disguised as a model identity field.

The Model IO debug test first confirms that the old record still contains role/source and fails; 2 tests pass after cleanup, and the Adapter TypeScript build passes. The old types and parse/schema in Contracts are still temporarily reserved for unmigrated tests and protocols; the next slice continues deletion.

## 17. Delete ModelRole and ModelRefSource from Contracts

The Contracts have deleted `ModelRole`, `ModelRefSource`, the corresponding `ModelRef` field, parse options, and JSON Schema properties; the entire workspace's TypeScript source code and tests have no references to these two symbols. Old uses can no longer re-enter the system through public types or schemas; the Lite role is also formally retired.

Contract tests first fail when the old parser still outputs the undefined metadata key; 4 tests pass after deletion; 175 tests pass across 8 migrated Core test files; 2 Adapter debug tests pass; the root workspace typecheck passes. The Bootstrap session persistence is still blocked by missing Browser Use seed build products, unrelated to this slice's assertions.

## 18. Delete the Lite Runtime Config

`AgentRuntimeConfig`, Bootstrap config assembly, the Project Memory selector, and the Subagent child have deleted `liteModelRef` / `liteModelProviderOptions`. Independent tasks default to inheriting the current Session Selection, then express the task strategy through `modelCall.operation` and the reasoning policy; the old `lite` special judgment for Subagent profiles has also been deleted, no longer converting a usage alias into a second shared model state.

A preemptive test confirms the old Bootstrap still generates two undefined Lite keys and fails; after cleanup, 103 tests pass across the Runtime Config, Subagent, Memory, and Profile; the Core and dependent build pass. The test Registry helper is simultaneously changed to collect structured `modelSelection`.

## 19. Delete AgentRuntimeConfig.modelRef

The Core Runtime configuration and Bootstrap Registry initialization have deleted the old `modelRef` input and compatibility reading; the Runtime can only be initialized by `modelSelection`. Un-migrated low-layer test/placeholder Runtimes without Selection use the explicit `zcode-unconfigured/missing-model` structured placeholder value, without generating it through an internal string parser. The Protocol, Workflow, and Subagent production entries have previously completed the Selection migration.

The 61 construction fixtures and 3 Bootstrap tests/skeletons of 12 Core test files are migrated first; 393 Core tests and 420 tests including the Runtime Config pass. The Telemetry simultaneously deletes the path projecting `modelRole` from the ModelRef; the preemptive red test turns green, 5 tests pass. The Core, Adapter, Telemetry, and their dependent build pass, and the Bootstrap returns to the two legacy importer baseline errors.

## 20. Persistence and Display Directly Read Session Selection

Session fork, message/timeline persistence, Context/Hook prompt metadata, and Workflow display no longer call `getModelRef()`. When the old persistence DTO still requires the branded provider/model fields, validate and project the Selection only at the write boundary; the reasoning is read from `options.reasoningLevel`. Production `getModelRef()` calls drop from 62 to 40; the remaining calls are concentrated in yet-unmigrated independent model tasks, old events, and Adapter inputs.

The related fake runtime is first migrated to `getSessionModelSelection()`; 25 Session Fork tests, 19 Hook admission tests, and 61 Runtime persistence tests pass; the Core and dependent build pass. The Bootstrap workflow tests are still blocked by missing Browser Use seed build products.

## 21. Session Facade Exits Runtime ModelRef Reading

The Session Facade's model display, Registry affiliation judgment, reasoning reading/switching, and pre-model-switch state all uniformly read `getSessionModelSelection()`; `ModelRef` is only temporarily projected at the yet-unmigrated model change event write boundary, and no longer obtains a second model fact from the Runtime. When the Overlay and Registry have the same name, the execution-scoped Overlay still takes priority; the current reasoning comes directly from the Selection options.

The new regression test sets `getModelRef()` to throw on call, covering model display, default/current reasoning, tier list, and reasoning switching; the old implementation fails as expected, and 3 tests pass after migration. 7 tests for the Provider Registry App are still blocked by missing Browser Use seed products before entering assertions, with 1 additional test passing; the Bootstrap build continues to report only the two existing type errors from the legacy personal provider importer.

## 22. Bootstrap Protocol Projection Exits Runtime ModelRef Reading

V4 model commands, create-session config admission, Registry fallback, V4 config seed, and old sender Submission admission all directly read the Runtime's `ModelSelection`. The yet-unmigrated `ModelSelected` event is only temporarily projected as the old event DTO at the publish boundary; cross-process config seeds and canonical Submissions all maintain structured provider/model/options, without reading the Runtime ModelRef. The Bootstrap's production source code no longer has any `getModelRef` references.

A preemptive test replaces the old getters for model commands, Registry fallback, and V4 config seed with the Selection getter; the old implementation fails 18, 1, and 2 tests respectively; after migration, 35 tests for model commands and fallback, and 32 tests for the complete cold recovery, pass.

## 23. Persistence Default Model Reads Selection

Assistant messages and Compact summaries/reminders project the old persistence DTO from the Session Selection when the caller does not pass an explicit execution model; the model request path's explicitly passed request snapshot still takes priority, avoiding Guide switching from affecting the in-flight request attribution. The default persistence no longer reads the Runtime `getModelRef()`.

Two preemptive tests lock the boundary with "calling the old getter throws"; the old implementation fails 1 test each; 5 persistence special tests, 61 Runtime persistence tests, and 68 Runtime compact tests pass after migration; the Core and dependent build pass.

## 24. Delete AgentRuntime.getModelRef

The public interface, internal interface, and prototype of `AgentRuntime` have all deleted `getModelRef()`. Normal execution, title, goal verifier, compact, project memory, MCS, embedded search, subagent, and tool assembly all uniformly read from Session Selection; positions still needing the old Adapter/execution event DTO temporarily project at the consumption boundary, without exposing a second shared Runtime getter. The remaining same-name getter in Core belongs only to the Tool Executor's own execution-scoped request context, to be migrated subsequently along with the ModelRef type retirement.

Two model lifecycle tests first assert that the Runtime no longer exposes the old getter; the old implementation fails as expected; 289 tests across 8 related test files pass after migration; the Core and dependent build pass. The Bootstrap build has only the two existing type errors from the legacy personal provider importer.

## 25. Add Atomic Identity Renaming to Settings Service

The Provider Config Service, Settings Facade, and cross-process Service contract add `renamePersonalProvider` and `renamePersonalModel`. The Provider rename maintains the ordered position within a single Personal Repository update and migrates all precise Model Config; the Model rename simultaneously replaces the Provider's model list item and precise rules. Both reject overwriting Official or existing Personal identities; Official Providers/Models cannot be renamed through Personal settings.

Three preemptive tests fail due to missing methods under the old implementation; after implementation, 115 Provider tests pass, as well as the Provider build and root workspace typecheck. The UI has not yet integrated these two operations; the next slice continues to remove the label/delete-and-rebuild-style identity editing.

## 26. Adding a Provider Becomes an Atomic Creation

"Add Provider" no longer enters a secondary save form holding the UUID, name, endpoint, key, and model in the Renderer. The Provider Config Service simultaneously checks Official and Personal identities in a single atomic Personal Repository update, sequentially assigning `new-provider`, `new-provider-2`, `new-provider-3`, and writes a default-enabled but incomplete Personal Provider; the Settings Facade returns `{ providerId, view }` after waiting for the Registry refresh. The Renderer directly calls this Service after clicking the left-side add item, and immediately selects the new identity to enter the existing detail editing.

The old `AddProviderCard`, UUID draft generator, and its entire creation form test have been deleted, avoiding retaining a second "first assemble the complete Provider in the UI, then save" prior-era path. A preemptive test fails due to the Config Service, Facade, and navigation action all lacking atomic creation capability under the old implementation; after implementation, 116 Provider tests, 8 Settings Runtime tests, 199 Settings UI tests, and the root workspace typecheck all pass.

## 27. Settings UI Integrates Atomic Identity Renaming

The settings page name for Personal-only Providers now directly reads `providerId`; name submission calls `renamePersonalProvider(oldId, newId)`; after success, the current navigation selection is forward-migrated to the new identity; a second name fact is no longer created through `config.label`. The Config Service proactively clears the historical `label` during Personal-only Effective save and atomic rename, so old configurations naturally converge during the next edit or rename. Official Providers continue to retain the read-only label from the Official Config.

The model editing's modification to the Model ID first calls `renamePersonalModel(providerId, oldId, newId)`; after waiting for the ordered model list and precise Model Config atomic migration to complete, it then saves the Properties / Option Specs in the same editing action. A preemptive test locks the rename-before-save order and Personal label clearing; 117 Provider tests, 233 Settings/UI/Runtime related tests, and the root workspace typecheck pass. The revision status of the save feedback still awaits integration by the next slice.

## 28. Connectivity Testing Changes to the Target Environment's Formal Model

The settings page "test model" no longer manually assembles Anthropic/OpenAI HTTP URLs, authentication headers, reasoning bodies, and one-time requests in the Host based on the draft. The UI first calls `saveEffectiveProvider` with the complete Effective Draft, and only confirms in the returned Settings View that the Provider is selectable and the Model exists; the cross-Service/Agent protocol then only passes the target workspace and `ModelSelection`. The CLI creates a formal `Model` from the Registry of that Environment, sends a minimal request, and fully consumes `streamText` to finish. The API Client, Account Config, dynamic Runtime Headers, Start Plan official version security verification, Provider Adapter, and error semantics thus share the same chain with normal execution.

The remote settings page now resolves the target Service Collection through `workspacePath + workspaceIdentity + remoteSessionId/remoteTarget`; `useModelProviders` reads the current `ServiceProvider` and subscribes to that Environment's Settings View, avoiding saving the remote draft to the local Host. The Host still only handles the account Overlay sync and protocol forwarding, without holding another Provider execution config.

The old `modelProviderConnectivityProbe`, HTTP helpers, request body builder, logging wrapper, and two sets of direct-connectivity probe tests have all been deleted, net removing approximately 1,200 lines of prior-era implementation. A preemptive test covers the formal Model stream consumption, protocol active/temporary app, Agent workspace identity routing, save-then-test sequence, and error normalization; 8 Core tests, 2 Bootstrap tests, and 33 Services/UI tests pass, and the root workspace typecheck passes. Lint is 0 error, 38 pre-existing warnings unrelated to this slice; the Bootstrap build continues to report only the two existing type errors from the legacy personal provider importer.

## 29. Settings UI Displays Auto-Save Feedback by Draft Revision

The Provider detail now maintains a monotonically increasing revision for the local Draft, and displays the `dirty -> saving -> success/failure` state. The save only takes effect when the response corresponds to the current revision; when edits occur after an in-flight request, the old response cannot override the new dirty state or incorrectly display success. The success checkmark fades out after briefly retaining; failures retain the icon, accessible error text, and retry entry. The parent save no longer swallows exceptions, so real failure results can be obtained near the field.

The Base URL, API Key, and Provider name continue to submit on blur, with Enter submission added; the API Format, Enabled, model changes, and drag continue to save immediately after the operation completes; model drag failures continue to restore the original order. Tests cover the revision gate, dirty/saving/success, failure retry, and Enter submission; 221 related UI tests pass, and the root workspace typecheck passes.

## 30. The workspace Independent Generation Chain Exits the ModelRef Protocol

The cross-process parameters, results, Bootstrap App, Core Runtime, and Services consumers for `workspace/generateText` are uniformly changed to the structured `ModelSelection`. The Git commit message and Repo Wiki directly pass `options.reasoningLevel`; Core creates a formal `Model` using the Selection, and projects the Selection from the actual result. The old `modelRef.variant` is only locally projected at the yet-unmigrated Adapter, authentication, and event boundaries, without serving as the input fact for this protocol and independent tasks.

The Git, Repo Wiki, protocol, and Runtime tests are simultaneously migrated, and an assertion from the protocol to the App is added, confirming the input retains `selection` and no longer dispatches `modelRef`. 15 Core related tests, 6 Bootstrap protocol/connectivity tests, 73 Services tests, and the root workspace typecheck pass.

## 31. The Title Generation Config Exits ModelRef

The model override for `AgentRuntimeConfig.titleGeneration` is changed to `modelSelection`; the empty override continues to read the current Session Selection at real execution time, and the explicit override fully preserves the reasoning options. The title sidecar directly creates a formal `Model` using the Selection, and returns the Selection projected from the actual Model. When the old title event and dynamic Runtime Headers Port still require the old DTO, the temporary projection is only at the corresponding write/call boundary, without exposing the `ModelRef` back to the title config or sidecar result.

The semantically empty `titleGenerationModelRef` and single-caller `session-title-runtime-headers.ts` have been deleted, and test fixtures no longer construct nested `modelRef`. A preemptive test locks the override behavior with a title Selection different from the Session; 88 Core title/persistence tests, 12 Bootstrap title/protocol tests, and the root workspace typecheck pass. The Bootstrap build has no new errors beyond the two existing errors from the legacy personal provider importer.

## 32. Goal Completion Verification Directly Consumes Session Selection

The Goal completion verifier no longer projects the Session Selection as `ModelRef`, appends the output budget, and then reversely converts to Selection. The verifier directly freezes a Selection at the start, and creates a formal `Model` by merging the request budget with the `options.maxOutputTokens` on that copy; the request, retry, and usage all still share this frozen snapshot. The identity needed for the old ModelRequest event and dynamic Header Port is only locally projected from the actual model at the execution boundary.

4 tests for the Goal completion / post-turn verification and the Core build pass.

## 33. Project Memory Sidecar Directly Freezes Selection

The Project Memory extraction, dream, and recall no longer project `ModelRef` from the Session Selection and then reversely construct Selection. The Selection is frozen at scheduling time, and a formal `Model` is created by merging the output budget on the copy; the Agent Context across the asynchronous boundary simultaneously saves this Selection, and the Provider message builder reads it directly. The old Tool Executor getter and the dynamic Header Port still only use the local ModelRef projection at their compatibility boundary.

94 tests for the Memory agent / extraction / dream / permission, 13 tests for the Memory recall, and the Core build pass.

## 34. Selection Output Budget Merging Converges to a Pure Function

The Core adds `withModelSelectionMaxOutputTokens`, which overrides the Selection's output budget without modifying the source object; the Goal verifier, Project Memory, and Compact normal Session branches all uniformly use it. The Compact directly obtains the Selection from the actual Model when it already holds the formal `Model`; only the explicit `turnExecutionModel` continues to enter the M4 execution-scoped overlay through `runtimeModelSelectionFromRef`. This old reverse conversion helper is thus no longer called by any normal Session or sidecar path.

A preemptive unit test covers options merging and no-override cloning; 12 Selection tests, 72 Compact tests, 107 Memory tests, and the Core build pass.

## 35. Delete the Invalid Draft Model Switching Protection Window and Dead Exports

Two sets of the old protection window based on the TTL Map in the UI have been deleted: both mark entries of `draftModelConfigSwitchGuard` have zero calls in production code, and the only remaining preserve call always faces an empty Map, returning as-is; `thoughtLevelConfigUpdateGuard` is only referenced by its own tests. Continuously retaining these state machines would mislead readers into thinking the Renderer still maintains a submitted model state, and masks the fact that the Submission already carries Selection atomically. After deletion, `setConfigOptions` only executes normalization and equivalence deduplication, without printing per-production-configuration logs.

The same round of reference audits also narrows the public surface of Provider save and Composer model display helpers, deleting three zero-reference exports, and correcting the outdated comment in the cold recovery that still refers to `defaultModelRef`. `dep:refs` is used to verify the root workspace UI export references; it has missing reports for alias imports, so the deletion candidates are simultaneously verified item by item with the full workspace text call graph, without treating the tool's missing reports as zero-reference proofs.

After deletion, 98 tests across 6 files (the draft config, Session Store, Composer recovery, global model seed, model preference confirmation, and Provider settings) pass; the root workspace typecheck passes, and the lint is 0 error, retaining only pre-existing warnings unrelated to this slice.

## 36. Full Verification Backwards-Migrates Omitted Test Fixtures

The `test:unit:affected` automatically degrades to a full workspace test run because the relative remote baseline includes deleted files. This run catches two types of old fixtures directly related to M3: the SessionPane continuity snapshot does not have the complete provider/model/mode, causing the atomic Submission to correctly reject it; the SettingsPage's workspace service mock does not implement the newly-added target Environment resolution result. Both are completed according to the formal contract, without relaxing production validation.

The Bootstrap special tests continue to find cold recovery assertions and two fake apps still initialized from `runtimeConfig.modelRef`. The test base has been changed to read `runtimeConfig.modelSelection` (containing the reasoning option), and the cold recovery simultaneously asserts the old field does not exist; the Guide fake runtime no longer constructs the deleted shared `modelRef` config. After migration, 11 tests across 2 UI files, 33+1 tests for the Bootstrap cold recovery and protocol behavior, and 1 Core Guide test pass.

## 37. Fix the Type Truth Source at the Old CLI Import Boundary

The Desktop E2E build exposes two type errors long obscured by the Bootstrap: the normal `ZCodeConfigFileSchema` intentionally leaves the old `provider` as passthrough unknown, but the one-time importer first parses it, then assumes this unknown is already the old Provider type. The dedicated `parseLegacyCliModelConfig` already performs the complete old-format validation; now it directly projects and returns the validated `provider`, and the importer only consumes this single truth source; the normal Runtime Config does not own the Provider field.

The Adapter preemptive test confirms the dedicated projection includes the complete Provider/Model definition; after implementation, 9 Bootstrap importer tests, the Adapter/Bootstrap build, all pass, and the two baseline errors that previously blocked the Desktop E2E are reduced to zero.

## 38. E2E Settings Migration to Atomic Provider Lifecycle

The formal first-launch case, settings UI case, two shared Provider helpers, and four pending reasoning cases still operate on the already-deleted `AddProviderCard`: first fill in the Renderer draft, then click the second "add Provider" button. This path conflicts with the atomic creation and per-field auto-save contract of M3.6, and will also produce false failures when recovering pending cases in the future.

The E2E now shares a single atomic settings helper: after clicking `custom:add`, wait for the published normal detail card, call the identity rename, then automatically save the Base URL, API Key blur, and API Format select respectively; the model metadata popup save immediately completes the configuration, without searching for a second submit button. The names, Base URL, and API Format receive unified test IDs, and are locked by UI unit tests in the red-then-green pattern; the expired duplicate DOM setter/select/save helpers are deleted together, net removing approximately one thousand lines of test code. The Settings UI's MP-UI-01 is also changed to assert the atomic creation immediately shows normal detail fields and the old footer does not exist.

The related UI unit tests (23 tests) and Desktop E2E TypeScript full check pass; the full workspace has no references to `model-provider-add-custom-*` or `clickAddProviderAction`. The local formal playback first completes the Desktop, CLI, Adapter, and Bootstrap builds; the host initially lacks `xvfb-run`, subsequently starts a real X Server using a temporarily unpacked Xvfb and Electron dynamic library, but the Chrome WebDriver session exits before the business page loads. Attempting Docker single-spec verification per the replay-isolated specification, the environment also lacks the `docker` command. Neither path enters business assertions, so they cannot be recorded as case failures or green admissions; the M3 final verification retains this item as an environment awaiting supplementary verification.

## 39. Memory E2E Fixtures Exit the Lite ModelRef

The final old symbol audit discovers that the Memory runtime E2E still constructs the App with `modelRef + liteModelRef` and passes the old `modelConfig` to the Adapter, which only accepts Registry Config. The complete command fails before migration at the scenario launch with `createModelAdapter requires registryConfig`; the fixture is changed to assemble the Adapter through the formal `createAiSdkModelRegistryConfig`, and only passes the structured `modelSelection` to the Runtime.

After the first migration run, the existing trajectory assertion's concurrency assumption is exposed: if the first no-op Extraction has already started, the complete trajectory is 6 times; if the next user submission arrives first, the Scheduler merges the old snapshot according to the established `latest pending` semantics, and the trajectory is 5 times. The evidence check now accepts only these two legal results; the explicit Extraction's three-step tool trajectory, next-session no-op, cancel-then-close, and file results are still independently asserted. The corresponding evidence tests (4 tests) and the full `pnpm --dir apps/zcode-cli test:e2e:memory` build, run, and artifact verification all pass.

## 40. Current Baseline Final Verification Status

The current baseline implementation of M3.1 through M3.9 has been consolidated. The production source code's old symbol audit confirms that `defaultModelRef`, `liteModelRef`, `liteModelProviderOptions`, `ModelRole`, `ModelRefSource`, and the independent Connectivity Probe have all exited; `runtimeModelSelectionFromRef` only remains the explicitly retained `turnExecutionModel` execution-scoped overlay of M4. The root `pnpm typecheck` passes; `pnpm lint` is 0 error, 38 pre-existing warnings unrelated to this phase, and the changed files' targeted format check passes.

The full affected unit tests once degraded to a full workspace run; the old fixtures directly related to M3 have all been fixed; the remaining failures concentrate on CUA/platform dependencies, missing Browser Use seeds, packaging attestations, and existing fake-timer rejections. The full workspace `fmt:check` is still blocked by the existing illegal HTML and GB2312 fixtures in the repository's Electron documentation. The formal Desktop atomic settings first-launch E2E does not gain admission due to the current environment's lack of Docker and the host's WebDriver session exiting before the page loads. The remote staging topology continues to be left for decision as per the user's request. Therefore, this records "the current baseline implementation is completed," without mistakenly recording the entire M3 phase or the release gate as complete.
