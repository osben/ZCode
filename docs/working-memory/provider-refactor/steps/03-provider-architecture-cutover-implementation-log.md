# M3 Implementation Log

> Status: Current baseline implementation completed, pending integration decision and release gate
>
> Last updated: 2026-08-21
>
> Phase goal: [`03-provider-architecture-cutover.md`](./03-provider-architecture-cutover.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/03-provider-architecture-cutover-implementation-log.md`

Engineering decisions made during M3 implementation beyond the established plan, completed autonomously from existing
design principles. Issues changing product semantics, public abstractions or phase boundaries go to Human in the Loop.
Section numbers below are stable (§1-§40).

## 1. Baseline

Implementation started from `7f413be9de` (the local M2 reconstruction on a newer staging). The local `origin/staging`
was historically reconstructed again and forks bidirectionally from this working tree. By user request the remote
branch is left alone: no merge, rebase or restoring of old staging implementations, and M3.0 is not recorded as done.
Implementation commits keep single responsibilities for later audit-style replay; the staging topology decision and
integration gate remain before final release.

## 2. Spec and tests first

Atomic Submission was first written into the Conversation Protocol Declaration and Product State Space, and Shared,
Core, Bootstrap and UI tests were migrated before production code, locking: prompt, attachments, mode and
ModelSelection are received atomically; the Queue freezes Selection at enqueue time; the Guide switches at the Model
Step boundary; Edit, Retry and Goal keep or inherit explicit Submission intent; Composer Selection no longer pre-writes
the Runtime model.

## 3. Wire vs domain types

Shared V4 defines the serializable Submission wire schema with fields aligned to Provider `ModelSelection`; CLI
admission converts to the Contracts/Core domain values at the boundary. Shared must not depend on the Provider
Registry or Model behavior.

## 4. Guide at the Core Step boundary

Queue and Guide store the complete Submission intent. When the Guide drains, Core creates the new Model through
ModelFactory and updates the current Loop and Session Selection (no long-term Core -> Bootstrap model-switch
callback). The Request in flight keeps the old Model; the next Model Step uses the new one.

## 5. Goal, Edit, Retry

The Goal's first round uses the Selection frozen in the user's Submission; automatic continuation rounds store no
continuation model and read the Session Selection at start. Edit and Retry inherit the original Submission's
Selection and mode from the canonical source input, never the current Composer or later Session state.

## 6. Renderer maintains only next-Submission intent

Composer model, reasoning and mode selections no longer send `switchModelConfig` / `switchCollaborationMode`
beforehand. The Renderer builds the complete Submission with `resolveComposerSubmissionConfig()` at send time; App
Recent still updates after acceptance. The selection control is no longer a mutable projection of Active Model or
Session Selection.

## 7. Verification boundary of the first slice

Root TypeScript build passed; 64 Shared/UI atomic Submission tests and 7 Core Model lifecycle / Guide tests passed;
138 assertions across five Bootstrap files passed but three unhandled rejections from existing fake-timer timeout
cases made Vitest exit 1 (not green proof; baseline risk kept). CLI build to Bootstrap had only two existing type
errors from the legacy personal provider importer (fixed in §37).

## 8. Session Selection persisted structurally

Contracts provide protocol-independent `ModelSelection` parsing and projection from the actual Model. Session entries
save `providerId`, `modelId` and common options, so reasoning level and max output tokens survive Session recovery.
The old top-level `thoughtLevel` is read compatibly only at cold-read boundaries; new writes no longer produce it.

## 9. ModelFactory takes Selection

`RuntimeModelFactoryInput` takes structured `ModelSelection` (Provider, Model, reasoning level, max output tokens in
one input; no reassembly from `ModelRef.variant` and a separate max-output field). Unmigrated Adapters get a temporary
ModelRef projection only at the final assembly boundary; call purpose is expressed by operation and execution context.

## 10. Session Selection is the Runtime model fact

The Agent Runtime holds only `sessionModelSelection` (`getSessionModelSelection()` / `setSessionModelSelection()`);
construction does a single one-way conversion of the yet-unmigrated old `modelRef`; no `defaultModelRef` or other
mutable model state. Persistence, fork, compact, title, subagent, hooks and turn loops read the same Selection.
(Nine Core test files: 17 failed before migration, 190 pass after.)

## 11. Bootstrap switch and restore write Selection

Registry `setModel`, reasoning level change and cold recovery call `setSessionModelSelection()` (no
`updateConfig({ modelRef })`), so reasoning level and default/explicit max output tokens restore together. The
execution-period compatibility configuration left by the Turn Overlay stays for M3.5 Adapter cleanup. Provider
Registry App Runtime tests (7 of 8) were blocked by missing Browser Use seed build products, not by assertions.

## 12. `ModelRef` write entry removed from Runtime config

Core's public `updateConfig` type and implementation no longer accept `modelRef`: runtime parameter updates (context
window, max output tokens) cannot implicitly rewrite Selection; model intent enters only through
`setSessionModelSelection()` or Submission admission. `dep:refs` cannot load nested `apps/zcode-cli` into the root
project, so deletion audits use full knip plus scope-less text call graphs and tool failures are not treated as
zero-reference proof.

## 13. New Runtime takes `ModelSelection`

`AgentRuntimeConfig` gains a structured `modelSelection`; Bootstrap Registry initialization, Workflow child, Script
Workflow child and Subagent child pass it directly; the Registry's parse result carries the normalized Selection. The
Core constructor temporarily kept a one-way read of old `modelRef` (removed in §19).

## 14. Protocol `session/create`

`session/create` still accepts the wire structured model DTO but converts directly to `ModelSelection` before the App
Runtime (reasoning variant -> `options.reasoningLevel`). Workspace generate-text stayed on its old input until §30.

## 15-17. Role and source metadata removed

Title, Subagent, Registry Main and Turn Overlay no longer write `ModelRole`: Title is identified by
`modelCall.operation=session_title_generation`, Subagent by child runtime/task context; model identity keeps only
Provider, Model and the yet-to-be-migrated reasoning variant. The Adapter Registry, Core default placeholder selection
and Model IO debug no longer build or output `ModelRefSource` (source semantics live in Submission, query source,
trace context and task context). Contracts deleted `ModelRole`, `ModelRefSource`, the `ModelRef` fields, parse options
and JSON Schema properties; the Lite role is formally retired.

## 18. Lite runtime config removed

`liteModelRef` / `liteModelProviderOptions` are gone from `AgentRuntimeConfig`, Bootstrap config assembly, Project
Memory selector and Subagent child. Independent tasks inherit the current Session Selection by default and express
task strategy through `modelCall.operation` and reasoning policy; the Subagent profile `lite` special case is gone.

## 19. `AgentRuntimeConfig.modelRef` removed

The Runtime can be initialized only by `modelSelection`. Low-layer test/placeholder Runtimes without a Selection use
the explicit structured placeholder `zcode-unconfigured/missing-model` (not produced by an internal string parser).
Telemetry no longer projects `modelRole` from ModelRef.

## 20-24. Runtime `getModelRef()` retired

Session fork, message/timeline persistence, Context/Hook prompt metadata, Workflow display, Session Facade (model
display, Registry affiliation, reasoning read/switch), Bootstrap protocol projection (V4 model commands, create-session
admission, Registry fallback, V4 config seed, old sender Submission admission) and persistence defaults (assistant
messages, Compact summaries/reminders) read `getSessionModelSelection()`. `ModelRef` is projected only at yet-unmigrated
write boundaries (old persistence DTO, `ModelSelected` event DTO, old Adapter/auth events). An explicit request
snapshot on the model request path still takes priority, so Guide switching cannot change in-flight attribution. When
the Overlay and Registry share a name, the execution-scoped Overlay still wins. Finally `AgentRuntime.getModelRef()` was
removed from the public interface, internal interface and prototype; the one remaining same-name getter belongs to the
Tool Executor's own execution-scoped request context and goes with the `ModelRef` type retirement.

## 25. Atomic identity rename in the Settings Service

Provider Config Service, Settings Facade and the cross-process contract add `renamePersonalProvider` and
`renamePersonalModel`. Provider rename keeps the ordered position and migrates all precise Model Config inside one
Personal Repository update; Model rename replaces the model list item and precise rules together. Both reject
overwriting Official or existing Personal identities; Official Providers/Models cannot be renamed via Personal
settings.

## 26. Add Provider is atomic creation

"Add Provider" no longer opens a secondary save form with UUID, name, endpoint, key and model in the Renderer. The
Config Service checks Official and Personal identities in one atomic Personal Repository update, assigns `new-provider`,
`new-provider-2`, `new-provider-3`..., and writes a default-enabled but incomplete Personal Provider; the Facade
returns `{ providerId, view }` after the Registry refresh. The Renderer calls this on clicking the left-side add item and
selects the new identity. `AddProviderCard`, the UUID draft generator and the creation-form test were deleted.

## 27. Settings UI uses atomic rename

Personal-only Provider name reads `providerId`; name submission calls `renamePersonalProvider(oldId, newId)` and the
navigation selection migrates to the new identity; there is no second name fact via `config.label` (the Config Service
clears historical `label` on Personal-only Effective save and atomic rename). Official Providers keep the read-only
label. Editing a Model ID first calls `renamePersonalModel(providerId, oldId, newId)` (ordered model list and precise
Model Config migrate atomically), then saves Properties / Option Specs in the same editing action.

## 28. Connectivity test uses the target Environment's formal Model

The Host no longer hand-assembles Anthropic/OpenAI URLs, auth headers, reasoning bodies or one-shot requests. The UI
first calls `saveEffectiveProvider` with the complete Effective Draft and confirms in the returned Settings View that
the Provider is selectable and the Model exists; the cross-Service/Agent protocol then passes only target workspace
and `ModelSelection`. The CLI creates a formal `Model` from that Environment's Registry, sends a minimal request and
fully consumes `streamText`. API Client, Account Config, dynamic Runtime Headers, Start Plan official-version
security verification, Provider Adapter and error semantics share the normal execution chain. The remote settings
page resolves the target Service Collection through `workspacePath + workspaceIdentity + remoteSessionId/remoteTarget`;
`useModelProviders` subscribes to that Environment's Settings View (a remote draft is never saved to the local Host).
The old `modelProviderConnectivityProbe`, HTTP helpers, body builder, logging wrapper and two direct-probe test sets
were deleted (about 1,200 lines).

## 29. Auto-save feedback by Draft revision

Provider detail keeps a monotonically increasing local Draft revision and shows `dirty -> saving -> success/failure`.
A response applies only if it matches the current revision (an old response cannot override newer dirty state or
falsely show success). The success check fades out; failure keeps the icon, accessible error text and a retry entry.
The parent save no longer swallows exceptions. Base URL, API Key and Provider name submit on blur and now also Enter;
API Format, Enabled, model changes and drag save immediately; model drag failure restores the original order.

## 30. Workspace generation chain uses `ModelSelection`

`workspace/generateText` parameters, results, Bootstrap App, Core Runtime and Services consumers use structured
`ModelSelection`. Git commit message and Repo Wiki pass `options.reasoningLevel`; Core creates a formal `Model` from the
Selection and projects the Selection from the actual result. Old `modelRef.variant` is projected only locally at
unmigrated Adapter, auth and event boundaries.

## 31. Title generation config

`AgentRuntimeConfig.titleGeneration` overrides with `modelSelection`; an empty override reads the current Session
Selection at execution time, an explicit override preserves reasoning options. The title sidecar creates a formal
`Model` from the Selection and returns the Selection projected from the actual Model. The empty `titleGenerationModelRef`
and single-caller `session-title-runtime-headers.ts` were deleted.

## 32-34. Sidecars freeze Selection

The Goal completion verifier, Project Memory (extraction, dream, recall) and normal-Session Compact freeze a Selection
at start/scheduling and create a formal `Model` by merging the request output budget on that copy (request, retry and
usage share the frozen snapshot; the Agent Context across the async boundary stores it and the Provider message
builder reads it). The pure function `withModelSelectionMaxOutputTokens` (Core) overrides the output budget without
mutating the source. Compact takes the Selection from the actual Model when it already holds one; only an explicit
`turnExecutionModel` goes into the M4 execution-scoped overlay through `runtimeModelSelectionFromRef`, which no
normal Session or sidecar path calls anymore. The Tool Executor getter and dynamic Header Port keep a local ModelRef
projection at their compatibility boundary.

## 35. Dead Draft model-switch guards deleted

The UI TTL-Map protection windows `draftModelConfigSwitchGuard` (zero production marking calls; the only preserve call
faced an empty Map) and `thoughtLevelConfigUpdateGuard` (referenced only by its own tests) were deleted: they implied
the Renderer maintains a submitted model state although Submission carries Selection atomically. `setConfigOptions`
now only normalizes and deduplicates equivalents. Three zero-reference exports of Provider save and Composer display
helpers were removed and an outdated `defaultModelRef` comment in cold recovery corrected. `dep:refs` misses alias
imports, so candidates are also verified against the full-workspace text call graph.

## 36. Fixtures migrated to the contract

A full workspace run (affected tests degrade to full when the remote baseline includes deleted files) caught old
fixtures: the SessionPane continuity snapshot lacking complete provider/model/mode (atomic Submission rightly rejects
it) and the SettingsPage workspace service mock lacking target-Environment resolution. Both were completed to the
formal contract without relaxing validation. Bootstrap cold-recovery assertions and two fake apps now read
`runtimeConfig.modelSelection` (with the reasoning option) and assert the old field does not exist; the Guide fake
runtime no longer builds the deleted shared `modelRef`.

## 37. Old CLI import type truth source

`ZCodeConfigFileSchema` intentionally leaves old `provider` as passthrough unknown, but the one-time importer treated
it as the old Provider type. `parseLegacyCliModelConfig` already validates the old format completely and now returns
the validated `provider`; the importer consumes only this source and normal Runtime Config does not own a Provider
field. This cleared the two baseline errors that blocked the Desktop E2E build.

## 38. E2E settings use the atomic Provider lifecycle

E2E cases and helpers still operated on the deleted `AddProviderCard`. They now share one atomic settings helper:
click `custom:add`, wait for the published normal detail card, rename identity, then auto-save Base URL, API Key (blur)
and API Format select; the model metadata popup save completes configuration. Names, Base URL and API Format have
unified test IDs locked by UI unit tests; duplicate DOM setter/select/save helpers were removed (about 1,000 lines);
Settings UI MP-UI-01 asserts atomic creation shows normal detail fields immediately and no old footer. No references
to `model-provider-add-custom-*` or `clickAddProviderAction` remain. Open: the formal local playback could not enter
business assertions (no `xvfb-run`; a temporary Xvfb made Chrome WebDriver exit before the page loaded; no `docker`),
so this stays "awaiting supplementary verification", not green and not failed.

## 39. Memory E2E fixtures

The Memory runtime E2E still built the App with `modelRef + liteModelRef` and passed old `modelConfig` to the Adapter
(failing with `createModelAdapter requires registryConfig`). It now assembles the Adapter through
`createAiSdkModelRegistryConfig` and passes structured `modelSelection`. Trajectory evidence accepts exactly two legal
results of the `latest pending` Scheduler semantics: 6 calls if the first no-op Extraction already started, 5 if the
next user submission arrives first and merges the old snapshot; the explicit Extraction's three-step tool trajectory,
next-session no-op, cancel-then-close and file results are still asserted independently. `pnpm --dir apps/zcode-cli
test:e2e:memory` passes.

## 40. Final verification status of the current baseline

M3.1-M3.9 are consolidated. The production old-symbol audit confirms `defaultModelRef`, `liteModelRef`,
`liteModelProviderOptions`, `ModelRole`, `ModelRefSource` and the independent Connectivity Probe have exited;
`runtimeModelSelectionFromRef` remains only for the explicit M4 `turnExecutionModel` overlay. Root `pnpm typecheck`
passed; `pnpm lint` 0 errors (38 pre-existing warnings); targeted format check of changed files passed.

Open: remaining full-run failures are CUA/platform dependencies, missing Browser Use seeds, packaging attestations and
existing fake-timer rejections; full `fmt:check` is blocked by pre-existing invalid HTML and GB2312 fixtures in the
Electron docs; the Desktop atomic-settings first-launch E2E gained no admission (no Docker; WebDriver exits before page
load); the remote staging topology stays with the user. This records "current baseline implementation completed", not
completion of the M3 phase or release gate.
