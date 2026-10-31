# Tool Change Chain Spec

Full history: `git show 37b98ff8:apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`.

## Memory Agent Dream Journal Path Protection (2026-10-30)

The Night Learning Dream run journal (`.fork_dream-journal/` under the memory root) is runtime-owned: the
Memory agent must not create, modify or delete anything inside it, or a journaled run would point at
snapshots the runtime no longer controls. Two permission surfaces changed together:

- Write/Edit: `packages/core/src/memory/memory-file-path.ts` adds the journal directory to
  `SENSITIVE_MEMORY_PATH_SEGMENTS` (segments compare case-insensitively, so upper-case variants are
  covered), so `resolveSafeMemoryFilePath` refuses every path inside it and the contained-markdown
  auto-authorization no longer applies.
- Bash: `packages/core/src/memory/memory-agent-loop.ts` auto-allows exactly one Bash shape, a single plain
  `rm` of absolute contained `.md` paths (`isContainedMarkdownBashRemoval`). That allowlist now rejects
  journal-relative paths, so removing a snapshot falls back to the standard Memory agent Bash denial
  (`denyMemoryAgentBash`); read-only Bash and ordinary memory `.md` removal are unchanged.

The directory's public name stays owned by the journal module (`DREAM_JOURNAL_DIRECTORY_NAME` in
`packages/core/src/memory/dream-journal/journal.ts`); the policy file keeps a pinned literal so a renamed
directory cannot silently drop the protection. The runtime writes journal rows and snapshots itself
(atomic temp-file + rename, serialized per project) and never goes through the agent tool policy, so this
change must not be read as granting Write/Edit anywhere. Read is unchanged: journal listing is exposed by
the runtime adapter, not by a Memory-agent Read exception.

Spec: `specs/night-learning.md` (journal ownership and event order). Regression:
`packages/core/tests/memory-agent-loop.test.ts` (Write/Edit/`rm` denied inside the journal directory,
including an upper-case variant, while ordinary memory `.md` removal stays allowed),
`packages/core/tests/memory-dream-journal.test.ts`, `packages/core/tests/runtime-memory-dream.test.ts`.

## Failed Tool Results Carry Provider Terminal Facts (2026-10-24)

When a foreground Agent's child hits a terminal provider failure (such as `405` / provider code `3012`), the
parent model must see the fact, not only the error body. `packages/core/src/tool/executor/errors.ts`
assembles it generically (no branching on tool name):

- `ToolExecutionResult.error.attribution` keeps only the safe subset `source`, `providerErrorCode`,
  `statusCode`, `retryable`; no credentials, URLs, request/trace ids, provider/model ids.
- Only when `isTerminalProviderFailure` holds (`source === "provider"`, `retryable === false`, and a status or
  provider code exists) is `modelContent` = original message + blank line +
  `Provider failure: status=... provider_error_code=... retryable=false`. Retryable 429/5xx, non-provider
  errors, handler failures, validation errors, permission denials and plan/workflow feedback keep the
  original text.
- The `attribution` of a `tool.updated` error uses the existing strict `errorAttributionSchema`; the v4
  projection still takes only `type`/`message`; `error.message` (UI hover, logs) is unchanged.
- When `call-runner` appends PreToolUse/PostToolUseFailure hook context it keeps this `modelContent` by the
  same structured check `isTerminalProviderFailure(result.error.attribution)`, never by matching text.
- The fact line lives in `modelContent`, is written to `metadata.modelContent` by settlement, and cold resume
  replays the same text.
- No text matching, cooldown or retry-strategy change; background Agent failures (task notification) are out
  of scope.

Spec: `specs/tool-error-provider-attribution.md`. Regression:
`packages/core/tests/tool-executor-error.test.ts`, `packages/core/tests/tool-hook-context.test.ts`,
`packages/core/tests/subagent-selection-error-runner.test.ts`.

## Model-Visible Tool Definitions Are English Only (2026-10-23)

Descriptions and schema field notes of Agent, CreateWorkflow, CronCreate and OffPeakCreate, and the repeated
routing text in the `dynamic-workflows` skill, must be language-neutral English ("in any language"), with no
Chinese trigger words or examples (such as `使用 workflow`, `8分钟后`, `闲时任务`, `每20分钟提醒我喝水`), because
they appear on the trajectory Schema page and in provider requests. Descriptions are in
`packages/core/src/tool/handlers/{agent,create-workflow-description,cron,off-peak}.ts`, field notes in
`packages/contracts/src/tools/{automation,off-peak}.ts`. Only model-visible copy is constrained; schema shape,
permission, execution, protocol and UI/V4 projection are unchanged. User input (prompt, title) is kept as is,
and the `、` used as a recipient separator in the ReplyToChannel description is a functional character.
Spec: `specs/english-tool-descriptions.md`. Regression:
`packages/core/tests/tool-definitions-english-only.test.ts` (no built-in tool definition contains CJK) and
`packages/core/tests/workflow-routing-hints.test.ts` (routing wording still present).

## Bash Temporary Output Path Isolation

The main app and workflow child runtimes assemble a tmp parent directory -> the execution adapter prepares the
named output file -> when unavailable, reuse the original storageRoot file preparation -> a unique output path
-> the existing foreground/background execution, progress, result and file entry. Model schema and App
protocol are unchanged; stdout/stderr still write directly to the fd. Covered: degradation, cancel/close and
preparation races, foreground/background path consistency, Windows native search self-reference, keeping
named files after a crash. Historical outputs are not migrated; storage statistics stay limited to the
existing data root. Full contract: `04-bash.md` and root `docs/tmpdir-storage-paths-spec.md`.

## Edit's Notebook Rejection No Longer Points to NotebookEdit (2026-10-17)

The repo has no NotebookEdit tool. Edit still rejects `.ipynb` with error code `5`, and the model-visible text
says there is no notebook edit tool and, if needed, to read and rewrite the notebook JSON with Write. Schema,
permission, execution and UI/V4 projection are unchanged. Regression: `packages/core/tests/edit-tool-contract.test.ts`.

## Read-Only Bash Joins Streaming Early Execution (2026-10-17)

Early execution during streaming is decided per input. When a closed `tool_call` enters the coordinator, its
capability is resolved with the same `resolveRuntimePermissionCapability` / `resolveToolSchedulingFlags` used
by `scheduleTools` and the permission check. Required: readOnly, concurrentSafe, non-destructive,
`needsApproval: false`, `sideEffectScope: "none"`, and no requiresUserInteraction, alwaysAsk or Guarded
`userApprovalRule`; Bash additionally must not be `run_in_background`. So a read-only Bash without
`cd`/`pushd`/`popd` can start while the model is still outputting; mutating Bash, directory changes and
Guarded dangerous commands run after the stream ends.

- Prefix barrier: within one stream attempt, once a non-early-eligible call appears, later calls (including
  Read) are no longer run early. The early set is always the first parallel group of `scheduleTools`.
- Each early call is its own executor batch and `maxConcurrency` applies only within a batch, so the
  coordinator caps early calls per stream attempt at `toolConcurrency.maxConcurrency` (default 10); the
  excess runs in the post-stream scheduling.
- The capability context comes from `resolveRuntimeToolCapabilityContext` (mode, bashShellSelection) and is
  shared by scheduling, early execution and the ledger; flags in the ledger are observability only.
- Early execution is a timing gate, not authorization: hook, permission decision and the recheck after hook
  rewrite stay with the executor; a matching project ask rule may still be raised serially through the broker.
- On a retryable stream failure, accepted calls are aborted and commit exactly one result (real, cancelled or
  synthetic); the retry continues from those results and nothing re-runs.
- The Bash prompt hints that independent read-only commands can be issued as multiple Bash calls in one
  message, while dependent steps, `cd` and writes run serially.

See `docs/design/v2/model/streaming-tool-execution-and-recovery.md` "Early Execution Eligibility". Tests:
`packages/core/tests/runtime-streaming-bash-early-execution.test.ts`.

## Read-Only Bash Scheduled Concurrently by Input (2026-10-17)

`scheduleTools` reads each call's `readOnly`, `destructive`, `concurrentSafe`, `sideEffectScope` through the
same `resolvePermissionCapability(input, context)` as the permission check (context: mode, runtimeScope,
workingDirectory, workspaceRoot). Priority: runtime capability > `entry.permission` > `entry.metadata`; tools
without a runtime resolver schedule as before.

- Bash declares `concurrentSafe: true` when the command passes readonly validation and has no
  `cd`/`pushd`/`popd`; it then joins the parallel group of adjacent concurrency-safe calls, bounded by the
  scheduler/executor `maxConcurrency`. A read-only command with a directory change stays serial because the
  captured cwd is written back to the session and parallel write-back order is unpredictable.
- Scheduling is based on the model's input; an input rewritten by a PreToolUse hook re-runs the permission
  check but is not re-scheduled. So the Bash cwd write-back is compare-and-set: it writes only if the session
  cwd still equals the cwd at command start. If another command in the group already changed the session cwd,
  this command does not write back; if this command itself changed directory, a not-persisted notice is
  appended to stderr. Serial execution is unaffected.
- `canRunParallel` / `parallelGroupIndex` of `tool_call_scheduled` reflect the new grouping. The cwd capture
  file is named randomly per call and background tasks register by taskId, so there is no session-level
  single-slot state.

Tests: `packages/core/tests/bash-permission.test.ts` and `packages/core/tests/runtime-bash-concurrent-schedule.test.ts`.

## Custom Agent Memory Tool Projection (2026-10-15)

The runtime derives effective tools from the current parent-turn Agent definitions snapshot; startup config,
the injected reader and the profiles the Host loads each turn must go through the same projection. When Memory
is enabled and allowed, a profile that declares a memory scope and explicit tools gets Write/Edit added;
undeclared tools stay inherited; disallowedTools and permission filtering still apply. The Host's snapshot is
not modified and tools are not cached across turns. Regression covers three config sources, consecutive
parent turns, Memory off and disabled tools; Desktop MEM08 verifies a custom agent really writes the Memory
file.

Module boundaries for tool-result settlement, channel reply and hole-fill entries are registered; original
contracts and public paths are reused. Upstream's FillWorkflowHole and ReplyToChannel follow the deferred
classification of non-resident built-in tools.

ToolSearch notes (contracts in [19-tool-search.md](19-tool-search.md)):

- The Local description states the post-search call form `DeferredToolCall {name,input}` with one short
  TodoWrite example; resident tools are called directly. Native copy, result format and execution protocol
  are unchanged. Contract: [model-visible copy](19-tool-search.md#模型可见文案).
- Local per-item feedback and compact promotion: reference projection dedups by definitions visible before
  the model call batch; a result with newly expanded schemas gives call guidance inside the tool_result, a
  purely repeated result an already-loaded reminder. Discovery also reads the effective compact checkpoint;
  exposure, search, announcement and wrapper admission share the promoted classification, and after a
  successful compact discovered tools return as ordinary tools. Acceptance:
  [ToolSearch spec](19-tool-search.md#local-逐项反馈与-compact-后提升). The already-loaded guidance uses the
  public `<system-reminder>` wrapper inside the tool_result (no attachment; the MCS switch does not change its
  position or role). A first-expanded deferred definition gets a merged Loaded call guidance stating
  top-level name/input (`Call it now` for one tool, `Call them now` for several). It strengthens model
  guidance only and does not promise definitions valid forever. Local derives no success hint outside the
  result; Native keeps its hint. Requests and Continue/compact records share one projection marker.
- Native: valid search results derive a success hint after the whole tool_result batch; an
  undiscovered-deferred parameter error keeps the full corrective paragraph (unloaded definition vs degraded
  parameter types, exact select, current schema; only Local appends the wrapper call note); the announcement
  is a strict-source attachment that participates in MCS and keeps incremental metadata; MCP select accepts
  raw/normalized short names. Historical definition snapshots and unavailable schema stay deferred.
- Removal/restore announcements describe only current availability and never infer MCP connection state or
  the cause. Exact-copy tests cover built-in restore, MCP grouping, 30/31 removed names and mixed add/remove.
  The 30-removed-names threshold, MCP server grouping and ambient hint are kept.
- App Settings ToolSearch mode: config schema/patch -> local or remote Host preference response -> Bootstrap
  runtime-materialization -> `runtimeConfig.toolSearch`. Read only on new/cold-resume; hot resume and
  existing drafts do not update; fork/child Agents inherit. Default Off; the settings row shows the
  experimental note and the usage risk of providers with insufficient native-mode cache support (zh/en
  consistent) without overriding a saved mode. Verified by a real E2E from Settings UI save to the final
  provider wire.
- Local extension: `--toolsearch-mode` replaces the old enable flag; Local merges consecutive references in the
  result into functions text, tools between two compacts do not grow with discovery, and after a successful
  compact checkpoint tools become ordinary tools. `DeferredToolCall` forwards only currently allowed deferred
  targets and is normalized to an ordinary target call at the public admission; history and persistence add
  only the `modelCallWrapper` literal, the request exit restores the original wrapper, and the duplicated
  modelToolCall input is not stored. V4 scheduled finalizes the target identity; for a stream break before
  scheduling, an existing tool_call_closed only fills the wrapper row's target name and input. The display
  layer does not infer an admitted target from half-built wrapper arguments. No schema snapshot, schema
  reminder, DB migration or test-only production interface. Reference filtering and Local expansion share one
  history projection per request; only changed tool results are copied and one definition is encoded once.
- Default-off, explicit mode override, structured references and cold resume: see
  [19-tool-search.md](19-tool-search.md). Discovery state derives only from real results and the effective
  compact checkpoint; turning off changes only the request projection. Public tool metadata accepts both the
  string modelContent and the ToolSearch structured array, so a failed MCP tool keeps its display on V4 cold
  resume; ToolSearch writes and discovery recovery still validate the array strictly.
- Request assembly runs ToolSearch preparation once through `prepareRuntimeProviderRequest`; main/child Agent,
  Goal, Memory and Compact each provide their complete tool catalog, and message projection no longer guesses
  the enabled state. The announcement is committed by the original history owner in the normal reminder
  stage before the request snapshot; a pure max-token Continue neither checks nor generates it; Compact
  rebuilds it from the retained history and the continued execution's tool scope; request preparation only
  projects existing announcements. Body and incremental metadata persist with hidden synthetic history;
  fork/resume/rewind restore in place, with no session-level cache. Retry truncates by canonical original
  input ID; announcements and hidden reminders such as Todo cannot be a retry boundary.
- Announcement metadata records only `addedNames`/`removedNames`/`readdedNames`; the announced set and the set
  of names once fully listed derive from the retained history in order. Removal is judged against the
  full-scope tool pool, so a compact-retained incremental tail does not miss names and a
  deferred-to-alwaysLoad change is not reported as removed. Built-in deferred tools get a `searchHint`. Only
  Agent/AskUserQuestion/Bash/Edit/Glob/Grep/Read/ReportFindings/Skill/ToolSearch/Write keep resident
  eligibility; other built-ins declare `shouldDefer` in their own metadata, with no classification mapping
  layer. ReportFindings is not implemented yet; the Task compatibility entry stays hidden from the provider.
- The Native ToolSearch provider schema marks both query/max_results `required`; the execution chain still
  fills the default 5 through the runtime schema.
- ToolSearch reference blocks do not take part in ordinary text truncation; the initial result and the budget
  projection after Hook appends keep references and block order, limiting only text. Display content and byte
  statistics derive from the final blocks (covered: searches over 100 KB, batch select, Hook, SQLite recovery).
- Compact uses the new policy only when the candidate tools support actually enabling ToolSearch; when off it
  keeps the ordinary tool-count threshold.
- Plugin MCP `.mcp.json`/manifest and the App MCP config to protocol DTO must preserve the boolean
  `alwaysLoad` (stdio/HTTP/SSE); an unset or invalid value generates no field.
- Test rules (2026-09-18): PTY force/resume/continue use real terminal input; dynamic directory and tail
  consecutive compact use independent Runtime/HTTP integration fixtures (streaming on/off, raw history
  checked). macOS/Windows native process evidence and the mobile pending-verification boundary are in the
  root coverage matrix. E2E/unit tests must not change production implementation or add test-only entries.

## Skill Generic Name Telemetry (2026-10-14)

Every `agent_step` with `tool_name=Skill` gets `skill_name`. The requested name from the scheduling input is
not used; the Skill handler provides the real `metadata.name` through the existing metadata callback, passed
along `ToolCallResult/Error -> tool.lifecycle.skillName -> agent_step.skill_name`. Failure/denial/stop before
loading, an unresolved name, or a name violating the telemetry naming rule uses `unknown`. The CLI fact, UI
compat metadata and final `/report` share one name validation; arbitrary request arguments must not enter
telemetry (acceptance covers path, URL, newline, simulated credential and over-long strings in the final HTTP
body). Model input/output, permission and execution are unchanged. Fields, compatibility and acceptance: root
`docs/monitoring/skill-agent-step-telemetry.md`.

## TaskStop Lookup-Failure Message

When an exact `TaskStop` lookup misses, it returns this model-visible error; no prefix matching or ID format
validation is added:

```text
Invalid task ID "<id>". This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.
```

Chain: `background_task_not_found -> handler error (code: 1) -> executor success: false -> model isError: true`.
Stop behavior after a full-ID hit, other errors, schema, permission, protocol and App interaction are
unchanged. Regression covers the failure text and model error flag for a short ID and an unknown full ID, and
keeps the assertions for successful stop and other failure branches.

## Off-Peak Background Execution (in progress)

Implemented per root `docs/off-peak-task/background-lifecycle-plan.md`: Agent explicit, profile default and
timeout-to-background; SendMessage running-delivery / terminal recovery; and ordinary-turn Bash explicit/timeout
background reusing the ordinary tool chain.

- Bash in an off-peak turn (`offPeakTurn === true`) is a fork-retained divergence
  (`specs/upstream-sync-cli-divergences.md`): explicit `run_in_background` is rejected before command
  telemetry starts with a recoverable ToolExecutionFailed, a timeout does not auto-background, and foreground
  behavior is unchanged. Upstream sync must not restore reuse of the ordinary background lifecycle.
- The ticket lifecycle is independent of tool execution: 3102 makes later model requests wait for a new ticket
  while local Bash keeps saving output; ticket renewal retries only model requests whose result is not
  committed, never replaying tools or the original prompt. After the main turn ends, existing notifications
  are still received.
- After real user input takes over, the new background turn reads the Session Selection; an already running
  child turn keeps this turn's model.
- Input schema, permission, result budget, notification wrapper, child-turn Bash cleanup and the
  desktop/mobile delivery boundary are unchanged. Workflow, recursive off-peak/scheduled task and automatic
  memory extraction restrictions stay; a restart does not restore background processes or notifications.
- Verification covers ticket-renewal concurrency, a late old ticket, user takeover, stop and task
  cancellation, the arrival boundary of background notifications, and both-end interaction.

## Cold-Open History Shows First (2026-10-09)

Persisted tool summaries are shown by the existing V4 reducer before runtime initialization; tool details,
attachment reads, App interaction and execution entries wait for runtime ready. On init failure the history is
kept, and an explicit retry reuses the full resume hook. State and transport boundaries: root
`docs/v4-refactor/17-cold-resume-runtime-activation.md`; desktop continuous and mobile replayable reuse the
same publisher, each keeping its sequence-recovery semantics.

## Session Attribution of Tool-Internal Model Requests (2026-09-30)

The internal model requests of WebSearch, WebFetch processing and ReadSessionContext inherit the host session
type of the initiating tool; the runtime model handle binds it uniformly (no call-site
`modelRequestSessionType: "other"`). `querySource` still expresses the tool purpose, and ReadSessionContext
does not attribute by the target session being read. Chain: runtime model handle -> tool handler call context
-> adapter -> provider HTTP header. Only observation classification is affected. Contract: root Agent model
request attribution Header spec.

## Agent Listing Attachment (2026-09-14)

The directory in the Agent description lives in a persisted `agent_listing_delta` attachment; the description
only directs the model to consult the conversation. The runtime shares one delta collector between normal
requests and compact recovery, dedups by effective history, and reserves future add/remove through a no-I/O
definitions read entry. The final role/order is decided by the existing generic attachment reorder, MCS and
position validation; no source special case and no relaxing of the generic anchor. Contract and layered
coverage: root `docs/subagent-listing-attachment.md` (I21/SA keep four profile classes, MCS is accepted with
one representative scenario, delta/recovery/failure paths by focused tests).

- The description is lean baseline copy: SendMessage resume by agent ID and the source of model/reasoning/
  tools definitions (`.zcode/agents/*.md` frontmatter); the concurrency hint repeating the first listing is
  dropped.
- User/project custom agent scanning by Host, Settings and standalone CLI covers direct files of the agents
  root only (depth:0, as the watch does); plugin recursive discovery is unchanged. Deeper files enter neither
  the listing nor execution definitions.
- Listing metadata is validated and copied at recovery and at the history write/replace boundary; request
  collection reads only the valid delta's name adds/removes, with no cache. The add/remove computation
  iterates the notified set directly and sorts only after a change; auto-compaction reads the listing tool
  set only after the threshold and rapid-refill checks pass. Normal requests still read the current tools
  independently after MCP initialization.

## Guarded and Bash Recognition Notes (2026-09)

- 2026-09-29 staging merge: the Guarded unified approval lifecycle is kept; after approval and rule
  authorization it reuses the workflow's `applyInputAdjustments` and passes the actual adjustment to the
  handler/result. The workflow confirm dialog's model/concurrency adjustment takes effect in both build and
  guarded; the dangerous-Bash user-once, Hook re-judgement, cancel and persisted-denial contracts are
  unchanged.
- 2026-09-24 autonomous-mode bulk delete: the Guarded matcher additionally recognizes rm recursive or
  explicit bulk, Git clean with effective force, CMD rd/rmdir /s, del/erase, POSIX/Git Bash find -delete, and
  CMD/Git Bash Robocopy /MIR or /PURGE. Genuine dry-run/standalone help exemptions and dialect boundaries
  hold; find does not analyze exec payloads, Robocopy does not read JOB, wrappers remain only env/time/sudo.
  A per-word internal unquoted-glob fact is added without changing the dynamic semantics of other rules. It
  reuses Bash capability -> PermissionService -> executor/broker -> provider tool_result, with no new
  approval branch, schema, state or UI. Acceptance is in the root Guarded spec and DCA-V1-19..25.
- Recognition details: CMD builtin delete accepts glued switches (`rd/s/q target`, `rd target/s/q`); Robocopy
  under Git Bash distinguishes `/c/...` drive paths from switches; rm dangerous-option presence and potential
  delete targets are scanned separately (BSD stops option parsing after the first target, so `rm first --help`
  is a bulk delete); BSD find `-d/-x` leading options keep the start-path stage so `-delete` is not missed.
  Known limitation: Robocopy bare-glob file-filter arguments are not covered.
- Background Bash details: a read-only `v4/conversation/backgroundBashOutput` tail-reads a fixed 8 KiB through
  runtime authorization and the execution port; it does not call TaskOutput and does not change the model
  tool, execution or notification contract. On-demand polling, pause-follow and terminal retention: root
  `docs/background-bash-output-details.md`. After child-session cold resume, the output query locates the
  execution record by workId along existing session/ancestor adapters, continuing only on unavailable;
  ownership is always validated with the original sessionId, read errors and unsupported are returned as is,
  and no runtime is created and no task migrated. The query returns only status, output and file-entry
  fields; the task record keeps only a Bash type mark. The encoding is resolved once by `run()` and passed
  into the task record (no repeated Windows code-page probe).
- 2026-09-08 Bash shutdown: an active stop after direct write still settles first; adapter close references
  the registered cleanup handle and waits for SIGKILL escalation and the actual tree kill (see
  `docs/bash-background-parity.md`).
- 2026-09-08 Bash progress scheduling: Node-process/internal polling cycles share one interval, tasks
  subscribe and tail-read independently, and the last subscription exit releases it; the per-task 5 GiB
  watchdog is kept.
- 2026-09-08 Desktop: Bash terminal state passes a bounded head, truncation flag and retained file path
  through the strict `bash_output` display; the UI shows a partial-output hint and file entry and hides
  line/byte counts while running. Provider content and TUI are unchanged (`docs/bash-background-parity.md`).

## Bash Full File and Live Preview (2026-09-07)

Contract: root `docs/bash-background-parity.md`. Large ordinary Bash output keeps the full file and returns a
head summary and the path; every second a 5/100-line preview and a line-count estimate are produced from a
4 KiB tail window. `ExecutionEvent -> ToolCallProgress -> legacy schema / V4 ToolCallRow.outputPreview` must
pass the bounded preview intact. Terminal/background cleanup clears the preview, late events are rejected, and
the parent session's subagent mirror tools are not materialized. Desktop continuous and web replayable keep
their delivery boundaries; the Desktop shared Execute renderer keeps rendering and the TUI is unchanged.

## Feishu Topic Source Lookup

`ReadSessionContext` has a read-only `topic` strategy with a paging cursor. It forces the target to be the
current session, reads archived topic messages only from trusted input metadata, returns source text and
coverage gaps by message ID or keyword, calls no extraction model, and does not treat user text as identity.
The existing relevant/handoff stay compatible; output goes through the unified budget, trace, tool result
persistence and UI projection. Tests cover cross-session denial, source dedup, paging and gaps; synthetic
results do not replace real Feishu verification.

SaveWorkflow provenance field (2026-09-22): the input has an optional `run_id` (which run this definition was
distilled from). It is **not a third body source**: the body comes only from `script` or `script_path`, and
persistence, permission, confirm dialog, result and budget are unaffected; the handler does not read it. Its
only effect is to let the GUI link "this run has been saved" back to the completion card
(`docs/dynamic-workflow/transcript-and-notifications.md` "Which workflow a run is saved as"). The
provider-visible JSON Schema gains one optional string; old clients and CLIs simply omit it. The GUI protocol
methods `workflows/save` / `workflows/forRun` do not go through the model tool surface.

CreateWorkflow phase streams (2026-09-28): the display `causalityGraph` has optional `phaseStreams`
(`{from, to}[]`, at most 128), derived by the bounds layer from `data` edges in the causality-graph phase
quotient whose two ends are mutually `alongside` (future phases chained by a channel), entering and leaving
together with `phases` / `phaseEdges` / `exits`. Display projection only. The three strict schemas (contracts,
protocol v3, v4 display) change together; a GUI older than 2026-09-21 reading the new key still fails the whole
frame, later ones drop only this card's graph. Contract: root `docs/dynamic-workflow/presentation.md` "Streams".

## Feishu Topic Auto-Interrupt Attribution

The runtime projection's activeWorks optionally carries sourceCommandId, taken from the normalized input fact
of the same TurnStarted, not inferred by the App from message order. Together with foregroundExecutionId it
associates the original input of an automatic stop, is kept through the existing snapshot/delta schema and
replay, and old events without it stay compatible. Tests verify the new-turn attribution and schema round trip,
then the App's interrupt marker.

## Tool Result Settlement Completeness (2026-09-24)

Once the whole batch has real `ToolExecutionResult`s, the CLI first writes the canonical and turn request
history synchronously in declared order, and only then runs the async tail work (usage, media, ToolPart,
checkpoint). A storage failure still throws the original exception and ends the turn, but must not leave a
current-session history with only tool calls and must not re-run executed tools. Stop keeps cancelling
unfinished tools; media saving of already successful results no longer uses that turn's cancel signal. Only
successfully persisted results may publish `tool_result_committed` and a recovery anchor. No database lock,
protocol or schema change and no backfill queue; after a process exit, unpersisted results follow the existing
interrupted cold resume and the original output is not guaranteed. Full order:
[streaming recovery](../model/streaming-tool-execution-and-recovery.md#tool-result-settlement). Regression
covers image Stop, a real SQLite lock, a mid-batch save failure, media and usage failures, cold resume and
checkpoint cancellation.

## Purpose

Changing a tool is not changing one handler or schema. A tool is the core boundary of NL->Code. Any
addition, removal, rename, field change, execution-semantics change, permission change, output change,
provider-native conversion, backgrounding or UI display change must be checked along the same end-to-end
chain.

This spec is the entry checklist before changing a tool. The capability and fields of a specific tool stay
in its own spec in this directory, for example `01-read.md`, `04-bash.md`, `13-websearch.md`. If the two
conflict, update this spec or the tool spec first, then change code.

## When This Document Must Be Read

All of these count as a tool change:

- Adding, removing or renaming a tool.
- Changing a tool's input/output schema, defaults, field compatibility, strictness or error codes.
- Changing whether a tool is read-only, destructive, concurrency-safe, its sideEffectScope, approval need
  or permission match source.
- Changing a tool handler, adapter I/O, timeout, cancel, retry, result budget, artifact or model-visible
  result.
- Changing how a tool appears in the system prompt, model request tools or a provider adapter.
- Changing provider-native/server-side tool mapping, such as WebSearch.
- Changing any tool-related projection in TUI, ZCode app-server, debug, session replay, compact, resume or
  rewind.
- Changing dynamic or indirect tool access: MCP, plugin, subagent, background task.

The Skill tool's telemetry increment follows the standalone spec
[Skill `agent_step` telemetry](../../../../../../docs/monitoring/skill-agent-step-telemetry.md): resolved
skill metadata may propagate only as telemetry-only fields along the session event, V4 fact and existing
`agent_step` closing chain; no skill description step is added and the SKILL.md body must not enter
high-frequency telemetry. A non-`Skill` tool step must not inherit `skill_*` fields.

### Todo103 G13: Background Subagent Statistics Re-hookup

Only the existing tool mirror and body-less telemetry fact are extended: mark the background source,
distinguish child tools from the child Agent summary, and record the composition of results actually
consumed by the main turn. Agent parameters, permission, scheduling, cancel or output are unchanged and no
second task state is created; an explicit model keeps using the public effective-selection resolution of
Todo99, an implicit subtask inherits the parent execution. The model identity is still the flat
providerId/modelId of the current request; the old ModelRef is not restored. Execution spec and test
boundary: root `docs/monitoring/agent-step-model-token-attribution.md`; desktop continuous live statistics
cannot be backfilled through mobile replayable recovery.

## General Principles

The offline prompt-trajectory conversion only affects debugging artifacts: it fills in thinking missing
from the response summary using adjacent real requests and detects a trailing user block append. By default
it keeps segments of real history rewrites; the explicit `--ignore-tool-search-changes` ignores, only in
offline comparison, ToolSearch references, placeholder text, catalog announcements and the matching
`Tool loaded.` hint after a successful reference-result batch (ordinary text of the same name still takes
part in the comparison); announcement recognition covers the current Native/Local copy and keeps
compatibility with the old log format. Output still keeps the last real request and marks the synthesized
mode. No production tool descriptor, execution, cache, permission or UI chain changes; contract:
[Model-IO trajectory](../../../plan/trajectory/model-io-to-anthropic-trajectory-tool.md).

CR-01 (source-hint wrapping): the bodies produced by SendMessage, RespondToCoordinator and background
tasks reuse the source sanitizer to neutralize nested `system-reminder` tags only when wrapped as a
provider user reminder. Canonical payloads, tool input/output, permission approval and main/child Agent
identity are unchanged; a legal MCS keeps the original text. A formal main/child dual-capability
trajectory must carry a tag-injection payload and verify that degradation, compact and cold resume use the
same wrapping boundary.

New-turn background task notification (2026-09-12): the shared provider projection reuses the wrapping
boundary above for `task_notification`, adding one `<system-reminder>` around the full prefix and the whole
batch body. Agent/Bash/Workflow raw results, notification batching, main/child tool permission,
persistence and UI visibility are unchanged; BG25/BG36 verify the user wrapping in MCS and non-MCS
requests.

Send immediately while running: after a plain-text human input actually preempts Core's foreground
execution, it reuses the provider projection of `user_steer`; tool cancel, result pairing, approval, queue
promotion and the execution-turn boundary are unchanged. The legal MCS position and user wrapping are still
decided by the shared projection and a system role is not forced in for a new turn. Details:
[turn steering](../loop/turn-steering.md#human-hint-for-running-send-now-2026-09-12).

### Browser Use for Dynamic-Workflow Subagents

2026-09-30: the `mcp__node_repl__js` of a dwf subagent can drive the built-in browser. Tool definition,
schema, permission and the node_repl MCP process are unchanged; what changes is the host-side browser port
assembly: the actor runtime gets a child port derived from the parent session port via
`BrowserControlPort.forChildSession`, the protocol broker resolves the child session's workspace /
clientMode to the parent by registration, while the `sessionId` sent down is still the child's own
(desktop tab ownership); on run dispose `closeSession({ closeTabs: true })` closes all of the subagent's
tabs and revokes the registration. The protocol broker's connection memory and child-session registrations
are shared per server context (the process-level node_repl instance and each app's instance used to keep
separate copies, so the lifecycle never reached the desktop). The subagent's skill port adds the plugin
skill root (`control-browser`), excluding the bundled `dynamic-workflows`. The core `Agent` subagent was
then still blocked by the node_repl broker with `runtimeScope: "subagent"` (lifted on 2026-10-09, next
section); a legacy `Workflow` child gets no port. Contract: `packages/dynamic-workflow/docs/execution-engine.md`
"Subagent sessions" and root `docs/zcode-protocol-model-backed-control-requests.md` contract 4.

### Browser Use for Agent Subagents

2026-10-09: the "subagent cannot use Browser Use" restriction is removed. Tool definition, schema,
permission and the node_repl MCP process are unchanged; the browser bridge of node-repl-host and the
bootstrap node_repl broker no longer reject by `runtime_scope: "subagent"` (the error
`Browser is not available in subagent` is deleted), and node-repl-host goes to 0.6.1 (package, manifest,
official seed definition, SEA manifest, serverInfo version in sync). The core `Agent` subagent gets a child
port derived by the parent runtime with
`forChildSession({ childSessionId, parentSessionId, tabOwner: "parent" })`: the protocol broker swaps the
`sessionId` of child-session requests for the parent's (the desktop decides tab ownership and panel
expansion by it), the subagent shares tabs with the current conversation, the child port's turnEnded /
closeSession are not sent to the desktop, and subagent end only revokes the registration without closing
tabs; the dwf subagent keeps the default `tabOwner: "child"`. The Computer Use subagent restriction is
unchanged. Contract: root `docs/browser-use/2026-07-16-subagent-browser-unavailable-spec.md`.

### Guarded Dangerous Command Single Confirmation

Guarded is an independent permission mode; only this mode adds a user single confirmation for clearly
dangerous Bash commands, leaving the original modes unchanged. It replaces Edit in the mode menu (the old edit
protocol/config/policy are kept; YOLO and the full-auto/full_auto aliases are unchanged). Contract, directory,
failure semantics and tests: root `docs/dangerous-command-approval-v1-plan.md` and the root Guarded spec
(exemptions of the nine rules, unknown options, trailing redirects, missing Shell selection).

- Lifecycle: an explicit approvalMode=user-once runs through broker/event/projection. If confirmation is still
  needed after a Hook input-modification re-judgement, a new requestId is used, and approval and execution
  reuse the mode/input/cwd snapshot. The Shell selection is fixed by the existing session shell owner; matcher
  and handler reuse the same selection (no per-call clone/freeze, no assumed switching between Git Bash/CMD
  while running). The executor request lifecycle is unified: no separate user-once pipeline, no recursive Hook
  re-run. A rewrite is normalized and schema-checked uniformly; tool semantic pre-check runs only on the first
  model input before PreToolUse; the Hook-modified permission judgement is kept (the old ID closes first and a
  new ID is created for the new input if needed).
- A trusted broker allow/modify + `modifiedInput` in Guarded means the final input is approved: it is
  validated and frozen, then executed without re-judgement or a new approval; the source comes only from the
  responder race, never a self-reported payload. Illegal input, cancel and a user-once persisted response are
  still refused. Registration precedes interaction publication and the terminal state is once; cancel/timeout/
  error keep a structured type. Guarded automation with nobody online keeps the approval pending, and a CLI
  restart follows the existing hydrate-interrupt closing; if strict-mode commit fails, firstInput is not
  executed.
- For a `userInteraction` request, the answer the broker returns through `modifiedInput` completes only this
  Q&A and does not re-judge permission; the purpose comes from the original permission decision and the answer
  source from the responder race. A Hook rewrite still re-judges and the answer is still validated by the
  original schema/handler.
- Inheritance: ordinary/Explore subagents inherit the protection; workflow/script child stays YOLO but must
  not lower the guarded parent task's mode. Approval logs keep evaluated(debug), denied(warn), resolved(info),
  hook_race_forfeited(warn) with trace/tool/request correlation fields and only the bounded structural input
  summary.
- Recognition layer (2026-09-15 to 09-18; approval/protocol/UI unchanged): the Shell AST does not carry
  program argv semantics; option scanning is a two-dimensional declaration `ordering x unknown` (wrapper and
  Git leading arguments `stop-at-operand + abort`, rm/rsync/Git subcommands `interspersed + continue`), an
  unknown option does not erase already recognized recursive+force / `--delete` / `--force` evidence ("a hit
  beats unsupported"), and rm recursive + force is not exempted by help/version. The option table adds only
  Git leading arguments (`-c`, `-p`, `--exec-path`, ...). CMD trailing redirect targets (`2>nul`,
  `> out.txt`) are not a missing target and do not take part in REM comment recognition (so `>rem git reset
  --hard` is not missed). Bash capability without `bashShellSelection` matches by POSIX grammar like the
  readonly check instead of silently falling back to YOLO. A git push refspec containing a glob still
  recognizes force push by the `+` prefix. The child-task broker forwards `registered`; the Hook-rewrite
  re-judgement reuses the `preparedContext` of the first judgement. The core's isolated native-command oracle
  and the Desktop denial loop are accepted separately.
- 2026-09-23: a dynamic-workflow subagent inherits the full permission mode of the initiating session
  (build/edit/yolo/guarded/auto; plan is not carried in, an old `plan` value is recorded as build);
  `run-launched.subagentPermissionMode` records any mode, an absent or unknown value still runs as YOLO, and
  resume reads it back from events instead of the session's current mode. A dangerous hit follows the
  existing executor -> parent-runtime-derived broker (`createChildClientPorts`) -> user-once, with origin
  subagent and `description` `<persona name> (<siteId>@<ordinal>)`, which the permission-window badge names.
  The confirm dialog is generated only from the parent-session projection, so the actor's
  PermissionRequested/Resolved/Denied are mirrored to the parent via
  `notifyExternalChildSessionEvent({ interactionOrigin })` (notify only, no append; interaction only, not tool
  activity). `AskUserQuestion` is given back to the subagent (it already reaches the confirm dialog through the
  same mirror); EnterPlanMode/ExitPlanMode stay removed. The legacy `/workflow` subagent is still YOLO. See
  `docs/dynamic-workflow/launch.md` "Permissions inside a run".

1. Write the spec first, then implement. The spec states at least capability, input, output, permission,
   side effects, failure paths, result budget, events, UI/ZCode app-server projection, test coverage and
   migration strategy.
2. Add the contract first, then wire the implementation. Data crossing LLM, provider, tool executor,
   session store, ZCode app-server, MCP or plugin boundaries must have a runtime schema or a verifiable
   JSON Schema.
3. External I/O goes only through adapters/ports. core/tool handlers do not call `fs`, `fetch`, `http`,
   `child_process`, `process.env`, the system clipboard or the database directly.
4. Permission, scheduling and approval read the tool declaration, not an ad hoc guess at the call site.
5. Large results do not flow straight back into model context; they go through `resultBudget`, summary,
   preview or artifact/storage.
6. Every tool call must propagate `traceId` and keep carrying `sessionId`, `turnId`, `toolCallId`,
   `spanId` / `parentSpanId`.
7. After changing a tool, tests must prove the new contract and cover the key failure paths.
8. WebFetch does no external domain-safety-service pre-check. The network safety boundary is carried
   jointly by the URL runtime schema, user/project permission rules, the unified `HttpClientPort`, the safe
   redirect policy, proxy/certificate config and audit events; a tool handler must not depend on a
   third-party domain_info service to decide whether to fetch before the target request.

### Capability-Conditioned Tool Shape

When a tool field is open only to some model capabilities, the provider-visible contract and the
executor's actual validation must come from the same current-turn capability snapshot:

```text
current turn model capability
          |
          +--> provider tool descriptor / JSON Schema
          |
          +--> executor resolved ToolEntry / JSON Schema
          |
          +--> handler capability branch / timeout budget
```

- Never change only the descriptor returned by `getTools()` while the executor keeps the static registry
  schema; that yields a "model can generate it, runtime always rejects it" gap.
- A `false` / `undefined` capability value must not fall back to the old session model; a synchronous
  subagent borrowing the turn-private model especially must keep snapshot semantics.
- Dynamic schema resolution may only change the provider/validation contract and must not duplicate the
  handler, permission, Hook, trace or result serialization lifecycle.
- Read PDF is the current instance: with `supportsPdf=true`, `description` and `pages` appear together;
  otherwise the original Read shape is kept. The `pages` branch also checks `supportsImages` separately,
  because native PDF and page images are two capabilities.
- runtime, subagent, project-memory agent and workflow child must inherit the same external I/O port; no
  execution environment may expose a field without the adapter.
- `submit_result` is the second instance (2026-09-13): a dynamic-workflow subagent gets a **different**
  `inputSchema` by the compile-time submit profile: the tool declaration of a `mono` subagent is
  `{ result: <that ask's schema> }`, while a `generic` subagent stays arbitrary JSON. Both share the same
  handler, the same `workflow.submitResult` permission and the same `stopTurnOnSuccess`; engine-side
  validation is consistent for both. `strict: true` on the contract is only a **qualification**; the adapter
  decides per provider/model whether to actually send it and folds constraints the strict subset cannot
  express into the description instead of dropping them
  (`packages/dynamic-workflow/docs/execution-engine.md` "Typed `submit_result`").
- Structured media results must be verified through the real provider projection and cold-resume chain; a
  test calling the handler/adapter directly is no substitute for end-to-end evidence.

### Windows CUA Development Runtime Hookup (confirmed)

What the Windows local-source development environment adds is only the Host backend's admission /
execution route to the Windows Computer Use Helper. On `win32` it explicitly validates the package, Helper
entry and native addon of `ZCODE_CUA_DEV_ROOT`, and starts the Helper with `process.execPath` plus
`ELECTRON_RUN_AS_NODE=1`; this stage must not inject a broker token.

The names, input/output schemas, side-effect annotations, permissions and delivery-state semantics of the
existing 30 CUA MCP tools are unchanged: no tool is added, removed or renamed; the provider-visible
surface, session event, replay, compact, resume and UI/ZCode app-server projection are unchanged.
Non-Windows, remote, an invalid dev root or missing artifacts all fail closed and must never fall back to
the macOS Helper. Tests cover the platform gate, stable failure reasons, async filesystem checks and
minimal diagnostics.

An explicitly disabled tool must fail closed. The session-level `toolDenylist` (ZCode Protocol
`session/create`) is not only an execution-time permission rule; it must also remove the tool from the
provider-visible built-in tool and MCP tool registration. Tests must cover both the model-visible tool
surface and the execution-time permission path, to avoid the false-safe "disabled but the model can still
see/call it".

The CLI `--disallowed-tools` / `--disallowedTools` removes the whole tool from the visible and executable
set through this runtime's `toolDisallowlist`, without rewriting permission config. `Bash(git *)` filters
only by tool name `Bash` and gives no command-content matching; help uses tool-name examples such as
`"Bash Edit"`. The CLI prompt entry is `-p, --prompt <text>`; the unimplemented `--print`, `--settings`,
`--permission-mode`, `--max-turns`, `--allowed-tools`, `--allow-main-worktree-yolo` must not be shown as
available. Full semantics: [CLI tool visibility denylist](./18-cli-tool-visibility-denylist.md).

The ZCode Protocol `session/create` is on the same chain: if an App or evaluation harness needs a
session-level tool surface constraint, it passes `toolAllowlist` / `toolDenylist` as protocol parameters,
and creating the runtime projects them to `runtimeConfig.toolAllowlist` / `runtimeConfig.toolDenylist`.
Do not rely on prompt text telling the model "do not use certain tools", because the provider-visible tool
surface is the actual callable boundary.

Structured-media tool-result projection is selected by `apiFormat` first. Anthropic Messages and OpenAI
Responses (`providerKind=openai`) keep structured tool-result content. OpenAI Chat Completions
(`apiFormat=openai-chat-completions`) has no reliable structured-media tool-result channel through the AI
SDK chat converter: `tool-result` content is serialized into provider-visible text. When `apiFormat` is
absent, only the known Chat-compatible provider kinds (`openai-compatible`, `gateway`) use that fallback;
`providerKind=openai` remains the Responses path. Chat provider adapters must therefore keep the actual
tool result as short text and, when the target model supports the media type, append supported media as a
synthetic user content message after the contiguous tool-result block. This preserves assistant tool-call /
tool-result ordering while preventing base64 media from being tokenized as plain text.

Extra checks for MCP dynamic tools:

- Tool advertisement and live execution permission must be separate. For a trusted official HTTP MCP,
  `server/discover`, `initialize`, notification, `ping`, `tools/list`, GET probe and `tools/call` must each
  obtain and inject the current identity header per request; the server still authorizes execution only at
  `tools/call`, and a catalog, connected status, cached descriptor or past success must not serve as
  execution authorization. A trusted official stdio MCP must likewise inject the current identity payload
  in `params._meta["com.zcode/official-mcp-auth"]` of `server/discover`, `initialize`, notification,
  `ping`, `tools/list` and `tools/call`; credentials must not be put in the process env. With no identity or
  entitlement at call time, return a structured tool error; it must not flip the server to failed or
  remove the advertised tools. Ordinary HTTP/stdio MCP must not get the official credential channel.
- Server-level execution policy such as `timeoutMs` must be preserved at registration. A long-task MCP
  server must not be cut by a hard-coded short timeout in the core bridge; the bridge projects the
  descriptor's timeout to `ToolEntry.metadata.timeoutMs`, `timeout.defaultMs` and the actual
  `McpPort.callTool` options.
- An MCP tool call's `timeoutMs` is an end-to-end caller budget and must cover waiting for an existing
  connection, the first `tools/call`, shared OAuth recovery, Phase 1 reconnect and at most one safe retry.
  Each stage consumes only the remaining budget; reconnect or retry must not get a fresh full timeout.
- MCP OAuth authorization/reconnect is a shared recovery task held by the adapter, owned by no single tool
  caller. A caller's timeout or AbortSignal ends only that waiter and must not close the callback listener,
  release the shared authorization lease or cancel a recovery other callers are reusing; only explicit
  disconnect, adapter/session shutdown or a connection-generation change may cancel the shared recovery.
- MCP connection and authorization state must converge to `connected`, `failed` or `disconnected` on every
  success, failure, cancel and external-I/O-exception path. `record.connecting` must not stay in the record
  as a rejected Promise with `status: connecting`; a single server's OAuth orchestration failure must first
  converge its own state and must not let a bare exception abort the whole batch server snapshot.
- The version probe of an explicit modern protocol pin is the only negotiation path and must inherit the
  server's full connection `timeoutMs`; only an `auto` mode that allows legacy fallback may use a bounded
  short probe. A pin-probe timeout must not masquerade as a legacy server or silently drop tools.
- A call timeout the MCP server enforces itself must stay consistent with the `tools/list` description,
  input schema and the concrete tool spec; when changing the default, one named constant must drive both
  execution and model copy, with a contract test preventing drift.
- The provider-visible description of an optional timeout field must not only state the field type; it
  must give the model an executable decision rule: when the value must be passed explicitly, how to reserve
  overhead for expected execution time, and to split calls beyond the cap.
- An MCP server may declare the namespaced `zcode/errorPresentation: "message-only"` in result `_meta`,
  asking the generic bridge to project content directly when `isError: true`, without adding the
  `MCP tool returned an error:` wrapper. This only controls model-visible copy and must not be taken as the
  failure state itself; the failure fact is still the standard MCP `isError`. The `node_repl` production
  side must not declare `message-only`: it writes the redacted structured `run.error.message` directly into
  content and lets the generic bridge project the stable `MCP tool returned an error:` prefix, so analysis
  chains that do not read private `_meta` can tell success from failure. An error result must not mix in
  the error type, `at ...` stack frames or REPL logs from before the failure. The generic bridge must not
  branch on `serverName` or parse a specific error body. This adjustment does not change
  `ToolResultPayload`, session event, persistence, UI or the desktop continuous / web remote replayable
  chain. A dev-mode desktop agent build must rebuild the `@zcode/browser-use-plugin` runtime so the plugin
  cache hash notices such producer-side changes.
- A standard media result must not be degraded unconditionally to a text placeholder. An `image` block
  should enter provider-neutral `ModelMessageContent`, so screenshot/visual-inspection MCP capabilities are
  consistent with the built-in `Read` image path; unsupported media returns a short placeholder bounded by
  the result budget.
- The final raster of official CUA is part of coordinate input, not ordinary optimizable media. Only an
  official `zcode-cua` descriptor that passes Host authority validation may enable this path; each image
  must be immediately followed by an exact-shape `image_ref {frame_id,width,height,actionable}`, and the
  bridge must validate canonical base64, PNG/JPEG file header, MIME, actual size, the 200 KiB cap and
  per-result `frame_id` uniqueness, keeping bytes and block order unchanged. A `PostToolUse` hook may only
  append bounded text after the protected media pair and must not replace or reorder it. On any validation
  failure, all CUA image/image_ref of this result must be removed atomically and an error returned; never
  leave only a reference, only an image, or fall back to an artifact/text placeholder. A third-party MCP of
  the same name still goes through the generic result budget and gets no exemption.
- The official CUA structured result is represented in the Host only by
  `modelContentProtection=official_cua_frame_v1`; do not add or restore a parallel preserve boolean.
  `returnedBytes` is the single aggregate of text and real media payload; a hook append adds only the new
  text bytes and must not depend on a second `mediaBytes` mirror state.
- The CUA SDK inside the shared `node_repl` must not hand the producer's legacy MCP text envelope to the
  model unchanged. A successful plain-text action/metadata result is normalized into SDK fields only in the
  Worker; if app-display `_meta` or action-state must still reach the Host, the structured sink must use a
  sideband projection with empty `content`. Only an error or a protected image/`image_ref` result may carry
  model-visible `content`. Thus `nodeRepl.write(state.text)` at the end of the same cell is the sole AX
  text source and does not stack with an action receipt or a `content`/`text`/`message` mirror.
- Before the official CUA plugin-host restores a broker token it validates only real authoritative facts:
  the bundled official plugin id, the captured authority/token, and a socket exactly equal to the captured
  value. `--permission-mode product` / `--backend broker` never took part in producer runtime decisions and
  must not be injected again or treated as a security credential; when injecting the canonical socket, old
  labels before the `--` terminator must be cleared, so a mixed-version config cannot keep passing a
  pseudo-safe state to the producer. Any missing or drifted real credential must still fail closed before
  import.
- The target-app icon of official CUA must not depend on the model repeating `bundle_id`, nor be looked up
  by PID in the Renderer / Desktop main. The producer must resolve the authoritative identity inside the
  unified tool invocation from the session `state_id`, the frame registry `frame_id`, the Helper
  `application_info` or the capture result, and output a display locator only through the namespaced result
  `_meta`. Core projects it into the versioned tool-result display only after the official authority gate;
  live, persisted, desktop continuous and web-remote replayable must consume the same field, and the UI must
  not reverse-parse ordinary result text. Contract:
  [CUA target-app display metadata Spec](../../../../../../docs/cua/2026-08-19-cua-target-app-display-metadata-spec.md).

Extra checks for plugin-compatible dynamic tools:

- Claude/ZCode plugins enter the runtime only through the existing skill, custom command and MCP
  projections; core does not read plugin manifests or plugin directories directly.
- The variable expansion, server-name normalization, timeout, trust gate and permission declaration of a
  plugin MCP server must finish before MCP tool registration, so the provider-visible tool name and the
  actual server config do not drift.
- The MCP tool surface of an official built-in plugin is declared by each plugin's own MCP server schema,
  for example `ios-simulator` and `android-emulator`. Adding an official plugin must update together
  `.zcode-plugin/plugin.json`, the cache seed, the SEA asset manifest, skill/command copy and
  bootstrap/plugin tests, so the `mcp__<normalized-server>__<tool>` names the model sees match the server
  actually started from the cache.
- Target-class tools of the official Android plugin must cover both USB real devices and emulators.
  `serial` denotes a connected Android target and must not be treated as an emulator-only field; without
  `serial`, a target-class tool may choose a ready target and falls back to starting a GUI emulator only
  when no target is ready; `android_start_emulator` only starts a new GUI emulator and does not reuse an
  existing target; to reuse an existing real device or emulator, later target-class tools should pass the
  known `serial` directly.

## Large Content Fallback Requirements

A large-content tool must first limit the result at its own semantic layer, with the executor's
`resultBudget` as the last safeguard.

- `Read` text default rule: without an explicit `limit`, if the file exceeds `256KB` return a stable error
  hinting at `offset` / `limit`; with an explicit `limit`, read by the real line range of the whole file
  rather than truncating the head first and slicing.
- When a user-submitted text attachment enters model context through a synthetic `Read` call/result, the
  reminder bodies generated for the same attachment are joined by a single newline and different
  attachments still by a double newline; beyond the default `2000`-line cap the model-visible hint must
  state "first 2000 lines" and suggest continuing to read that file as needed.
- Selected `Read` text also passes a `25_000`-token output budget check; beyond it, return a stable error
  so the model narrows `offset` / `limit`.
- `Read`'s `offset` is a model-visible line-number semantic: `0` and `1` both mean from line 1; the adapter
  uses a zero-based line offset internally to avoid cross-layer ambiguity.
- `Read` images default to a multi-stage media protection chain with a longest-edge cap of `2000px`: first
  judge empty file, format and size from the real image bytes and magic bytes, then complete in
  `ImageProcessorPort` the 5MB base64 API cap, the 3.75MB raw target, the 2000px size cap and optional token
  budget compression. An image result must flow back to the model only as a provider-neutral media block,
  with no size note text and never base64 as plain text; original size, display size and coordinate ratio
  stay in the structured output for UI, debug and later internal capabilities.
- Images, PDFs, other binaries and videos share a `40MiB` aggregate budget in the final provider request
  projection, measured by the full data URL byte count; a single video's `30MiB` raw-file cap is still
  validated at the input/Read layer. The budget changes only the request copy and must not delete the
  session transcript, tool result or artifact, and no single tool may add a dedicated exemption. The 5MB API
  cap of a single image and the aggregate budget are two independent boundaries.
- `Read` video supports only registered formats, with a default input cap of `30MiB`; no transcoding or
  compression, and it flows back as a provider-neutral video block. Over the cap returns a stable error, and
  model-I/O must not record the full base64.
- Tools naturally prone to large output such as `Bash` and `WebFetch` should return a summary, tail/head
  preview or artifact reference; full stdout, HTML, JSON, binary or base64 must not be stuffed back into
  model context.
- A provider-neutral tool result message must carry `isError` semantics, and the adapter maps it to an
  error-result form the provider understands, such as AI SDK `error-text` / Anthropic `is_error`; do not
  express failure only by mixing `{ "error": ... }` into the text content.
- The model-visible error of `js` serializes `name + message` only once; if the stack is kept, append only
  the stack frames and never output the same `name + message` of the stack's first line again. A browser
  error should carry a bounded recovery hint under the original stable error code and must not require the
  model to parse duplicated text or depend on error strings for structured state.
- Compact/runtime may apply a provider-visible microcompact projection to old tool results in history
  before a request, but may only replace the model-visible content with a stable placeholder or artifact
  reference; it must not delete the original tool part, session transcript, artifact or checkpoint, nor
  break the pairing of assistant tool call and tool result. The projection must have a structured event,
  traceId, pre/post token estimate and test coverage, and resume must not mistake a microcompact event for
  a full compact boundary.
- `Bash` model-visible result default rule: return stdout/stderr text, a necessary interrupt marker, stale
  read hint and artifact preview; do not JSON-ify structured `BashOutput` fields such as `status`,
  `exitCode`, bytes, path to the model; those serve structured output, events, UI/ZCode app-server and
  debug only. Bash `isError` semantics only mean the command was interrupted/cancelled; a non-zero exit
  code is still exposed through text output and the structured `status`.
- The model-visible content of a successful `Edit` / `Write` stays a short confirmation; full content,
  diff and patch may enter only structured output, events, UI projection or artifact.
- A newly added large-content capability must state in its tool spec: raw size cap, model-visible cap,
  error vs truncation, artifact strategy, error codes, UI/ZCode app-server projection and test cases.

## File Mutation Tool Alignment Requirements

`Read`, `Write` and `Edit` are one controlled file-mutation chain and must not be treated as independent
thin handler changes. Any behavior change affecting one of the three must check the following together:

- Model-visible tool description: does it clearly express the `Read -> Edit/Write` read-before-write
  constraint, `old_string` matching rules, line-number prefix stripping, indentation fidelity, uniqueness,
  `replace_all` semantics, preferring to edit existing files, and that emoji are added only when the user
  explicitly asks.
- Edit compatibility chain: when the model-visible line-number format of `Read` changes, check `Edit`'s
  line-prefix compatibility, model hints, history log replay, test snapshots and error messages together;
  never change one end only.
- Manual-patch chain: a structured file-mutation tool such as `ApplyPatch` must share with `Edit` / `Write`
  the edit permission, diff projection, no-side-effect-on-failure semantics and the `FileSystemPort` I/O
  boundary.
- Runtime state: whether `Read` records the full read cache, and whether `Edit` / `Write` consume the read
  cache, mtime/revision and partial-read state.
- File fidelity: does `Edit` keep the original encoding and line-ending style, does `Write` write the full
  content, and all file I/O goes through `FileSystemPort`.
- File content contract: the text content `FileSystemPort.readTextFile` returns to core is LF-normalized
  Unicode logical content and exposes the original `encoding` and `lineEndings` via metadata; for faithful
  write-back, `Edit` / `Write` / `ApplyPatch` must pass this metadata back to the adapter instead of
  touching raw bytes in the handler.
- Text encoding boundary: the filesystem adapter owns detection, decoding and write-back of BOM, UTF-8,
  UTF-16LE and common Chinese legacy encodings (GB2312 / GBK / GB18030). Model-visible tool descriptions
  only say "copy the logical text of Read" and must not ask the model to guess or pass an encoding
  parameter. A new encoding capability must cover read, range read, edit, full write, structured patch,
  unencodable character failure and binary misjudgment protection.
- Large-text sampling boundary: a UTF-8 candidate at the tail of the `4096`-byte sample is read further by
  the number of missing bytes and then strictly validated; an incomplete state cannot confirm UTF-8
  directly, and an illegal continuation byte enters the original legacy detection. The body keeps sharing
  the streaming decoder. Per [Read large text file budget](01-read.md#文本大文件预算), cover short reads,
  EOF, a GB character after an ASCII prefix and the final provider request of attachments; bounded
  sampling is not an encoding guarantee for the whole file.
- Error contract: unread, partial read, stale file, match failure, multiple matches, notebook, permission
  denial and file too large must have stable error codes; flow control must not depend on English error
  text.
- Model result serialization: a successful file mutation returns only a short confirmation text; full
  content, diff and patch stay in internal output, events, UI projection or artifact.
- Read model-visible serialization: a text read result must use the dedicated `formatModelContent` to output
  cat-n style line-numbered text and must not fall back to JSON stringification, otherwise tabs, newlines,
  etc. get escaped and pollute the exact match of the later `Edit.old_string`.
- Path boundary policy: the current version only resolves relative paths against the session cwd and
  normalizes them to absolute paths; the core `path-policy` layer does not hard-reject paths outside the
  workspace; read/write approval, deny/ask rules and the adapter capability boundary will later converge in
  a filesystem permission adapter.
- The Memory file exception must go through the same final permission boundary: project Memory and
  custom-agent Memory auto-authorize only strictly lowercase `.md` Write/Edit inside their own root that
  contains no existing sensitive path segment, and keep the existing explicit tool/path deny, project ask
  and hook ask. This must not add Read, change ordinary Bash permission, or let a child runtime inherit
  Main's Recall/Extraction/Dream state. The Dream run journal directory (`.fork_dream-journal`,
  compared case-insensitively) is part of that sensitive-segment rule, and the Memory agent's single Bash
  `rm` auto-allow refuses journal-relative paths the same way
  (see [Memory Agent Dream Journal Path Protection (2026-10-30)](#memory-agent-dream-journal-path-protection-2026-10-30)).
- UI/ZCode app-server/Debug projection: diff preview, permission request, tool result, trace and logs
  consume structured output and do not reverse-parse model-visible text.
- The TUI `Edit` file-diff projection keeps audit information compact: the lifecycle title is action name
  plus file path; the path shows relative inside the current workspace and absolute outside; the input
  fields `file_path` / `replace_all`, the diff title line and hunk headers are not repeated as default
  result lines; the body diff consumes structured hunks and the TUI renders unified or split by terminal
  width. Syntax highlighting uses Shiki tokenization converted to OpenTUI `StyledText`, language inferred
  from the file path; if Shiki does not support it, fails to load, or exceeds the local budget it must
  degrade to a plain-text diff without affecting tool result display.
- The TUI sidebar's current-session modified-file statistics may only consume the safe diff summary in
  `tool_call_result.payload.result.display`; they must not reverse-parse model-visible tool result text,
  read git/the filesystem, or depend on a handler's internal structure.
- The diff display of a file-mutation tool must also enter the persisted tool part metadata. Live
  TUI/ZCode app-server may consume `tool_call_result.payload.result.display`; resume / session load must
  rebuild the same bounded UI projection from `part.data.state.metadata.display`, must not depend on
  in-memory event replay, and must not reverse-parse the model-visible short confirmation in
  `completed.output`. A tool part in an old session without metadata is shown by legacy output and does not
  forge a historical diff that cannot be restored reliably.
- Tool performance observation fields must enter structured output / result metadata, such as `perf`, and
  must not be put into model-visible tool result text or require the UI to parse text. The `perf` of Bash /
  Write / Edit may contain only duration, size, exit code, low-cardinality category and redacted hash, never
  the raw command, file path, file content or diff content. Permission wait happens at the executor layer,
  so the executor merges it into the tool result perf rather than the handler guessing.
- The runtime's `ToolExecutionTelemetry` uses a nested `detail` discriminated by `kind`, while V4
  `tool.lifecycle.performance` keeps the existing flat allowlist. The CLI fact normalizer must map field by
  field and must not spread/pass through `perf`, `detail.command` or `detail.filesystem`; the local-diagnostic
  `command.hash` must not enter the V4 fact. A strict schema failure drops the whole tool terminal fact, so
  the Renderer can only close the tool step as a fallback at the turn terminal, polluting the duration,
  status and failure attribution of `/event/report agent_step`. Regression tests must cover both the real
  Gateway command/filesystem/patch mapping and the exit timing in which the supervisor closes `agent_step`
  right at the real tool terminal and only then reports `message_completion`.

This chain currently advances in phases: first spec, model guidance and short result serialization; then
read cache, stale guard, match validation, file fidelity, permission safety and diff UI.

## Browser Automation Tool Alignment Requirements

Although Browser Use is driven by the `js` REPL, its capability manifest, model docs, backend lifecycle and
error text together form the model-visible tool contract. Changing any layer must check the following
together:

- The model-visible identity of Node REPL must come from the real `node_repl` MCP server, with the single
  tool name `mcp__node_repl__js`. It is the host entry shared by Browser Use and Computer Use, not
  browser-specific: each of the two plugins carries only skills, docs, client scripts and a native
  dependency root, and the host artifact comes from the `node-repl-host` seed unit; a bare core `js*` tool
  must not again disguise the MCP boundary.
- `js_reset` and `js_add_node_module_dir` were removed entirely on 2026-09-18 (tool surface + handler +
  schema + moduleDirs execution chain) and must not be re-added "for compatibility". Measured call volume
  of both was 0. `js_reset` has been a no-op since the fresh-kernel change (every `js` is already a new
  kernel) yet occupied tool-definition tokens every turn, and because it "never fails" it led weak models
  into consecutive repeated calls (ticket ZCT-2100503886992535552: 155 consecutive calls, 48.37M input
  tokens); the `Tool not found` failure when the tool does not exist is the signal the model needs to change
  strategy. `js_add_node_module_dir` pushed a host duty onto the model: the model cannot know which
  `node_modules` to pass, only skill docs can tell it, and any path the docs know the host can inject
  itself. If an official skill later needs third-party packages, use host injection; do not give the model a
  configuration tool again.
- Model code imports therefore support only `node:*` built-in modules and absolute `file://` URLs based on
  the skill root; bare package names do not resolve. The bootstrap of both official SDKs already has this
  shape.
- Deletion applies only to the executable path. History replay rendering still depends on the name mapping
  in `packages/shared/src/tool-identity.ts` and `packages/ui/src/lib/nodeReplToolDisplay.ts`: those two read
  only the toolName in the historical transcript, independent of the current `tools/list`, and deleting them
  would degrade call blocks of old sessions to the unknown fallback renderer. The replay contract and the
  model-visible surface are two things; do not delete them together.
- The Node REPL MCP server reuses the execution engine through `@zcode/core/repl`, and the browser client
  connects through `@zcode/core/browser-client`; pulling the Agent, Bash registry and workflow compiler in
  through the core root entry is forbidden. App, ordinary CLI and SEA keep the existing plugin-host
  adaptation and tool contract; the build dependency graph and a real bundle handshake/execution jointly
  verify this boundary, see root `docs/browser-use/browser-use-plugin-runtime-boundary.md`.
- plugin-host dispatches in CLI main before the generic Agent runner and Provider module imports; it keeps
  environment cleanup, SEA tool preparation, broker authentication, argv and the exit contract, and plugin
  parameters must not be treated as Agent config parameters.
- The MCP server's JS schema, result metadata and browser broker protocol are imported through their own
  public sub-entries without evaluating the contracts/shared root entries; the original schema and protocol
  implementation are kept and no lightweight duplicate validator is made.
- An MCP tool call must put session/turn/trace into the request `_meta`; the browser bridge must return to
  `BrowserControlPort` via the current session's authenticated local IPC broker. The MCP child must not
  reference desktop/main/runtime concrete implementations directly, and must not guess session identity by
  cwd/workspacePath.
- The official plugin host restores the CUA Helper's socket/token only briefly while calling the plugin
  `main()`; the server factory of `serveStdio` is deferred until MCP initialize. So `node_repl` must capture
  and construct the shared-host CUA runtime before `main()` returns; the factory may only reuse that runtime
  and must not read `process.env` again. The Worker receives only the second-hop bridge socket/token created
  by the runtime and must never get the Helper's original credentials:

  ```text
  plugin host restores Helper env
              |
              v
      node_repl main() -- capture --> shared-host CUA runtime
              |
              +-- return --> plugin host clears Helper env
              |
      MCP initialize --> deferred server factory --> captured runtime
  ```

- `tabs.list()` returns `TabInfo[]`; to resume control you must then get a `Tab` with `tabs.get(info.id)`.
  An empty controlled list does not mean the backend is disconnected; to keep controlling the page visible
  to the user, check `browser.user.openTabs()` and claim explicitly, and only last allow creating a new tab,
  to avoid duplicate pages.
- Turn end cancels only that turn's pending browser requests and must not close tabs implicitly. Current IAB
  and CLI managed CDP both keep controlled tabs across turns within the same process/session;
  `tabs.finalize()` / handoff / deliverable express state only when the backend really supports it and give
  no deletion semantics to omission. IAB `closeSession` releases visible tabs to the user; CLI managed CDP
  `closeSession` closes that session's context/page because it has no user-visible surface, and reclaims the
  Chromium it launched when no context remains. The difference must be trimmed accurately by descriptor
  capability/override.
- CLI headless Browser Use can only be enabled by an explicit `--browser-use=headless`; the descriptor must
  return `type: "cdp"` after a real Chromium launch + CDP handshake; `headless` is a launch mode, not a
  fourth backend. When the browser-use plugin is disabled, the executable is missing, or the handshake
  fails, no stub may be returned and there must be no silent degradation after start. `--prompt`/TUI may
  inject a managed port; ZCode app-server, Desktop and mobile shared-host chains must not start an
  independent browser runtime because of it.
- A stale/missing tab, locator strict violation and locator timeout must keep stable error codes and give
  the recovery path in the message. A strict violation requires a fresh `domSnapshot()`, `count()` and a
  narrower snapshot-proven locator, and `first/last/nth` must not be used as a disambiguation shortcut; a
  timeout requires refreshing the DOM and checking count/visibility, and must not retry unchanged or guess a
  role/name/selector absent from the snapshot.
- `playwright.domSnapshot()` is the default fact source for page understanding, element discovery and
  locator construction. As long as the latest snapshot is still valid and already contains the target, the
  model must directly reuse role/name/text facts from it and must not scan `input` with
  `playwright.evaluate()`, dump HTML, traverse the DOM or guess a CSS selector to "look at relevant
  elements". When the snapshot is incomplete or may be stale after an interaction, refresh the snapshot
  first; only when neither the snapshot nor locator reads can answer a bounded, read-only question may
  `evaluate()` be used as a last resort.
- The `TextMatcher` contract of a Playwright locator accepts both strings and `RegExp`. `node_repl` runs
  model code in a separate VM Realm, so matcher type recognition must not depend on `instanceof RegExp` of
  the current Realm; it must accept cross-Realm regexes and keep their source/flags serialization. This
  compatibility fix does not change Browser Use permission, side effects, events or output contract, and
  must be covered by a regression test with a regex created by a real VM.
- Request correlation of the Node REPL Browser broker is also part of the tool failure contract: once a
  valid UUID has been received, the error reply must still carry that request UUID even if the later strict
  schema validation fails. Generating an unrelated placeholder id on the parse/schema error path is
  forbidden, otherwise the client overwrites the real parameter error with `response id mismatch`.
- `playwright.evaluate()` / `locator.evaluate()` execute the passed JavaScript in the page context and can
  be used for page computation or state change; use them when the high-level locator/action API cannot
  express the intent, and keep the script focused and its result observable. That error only means the
  current browser command failed, not that IAB/tab crashed.
- Ordinary browser side effects do not auto-screenshot; DOM-first observation, explicit screenshots and tool
  panel preview metadata are three independent channels. This stage still generates no screenshot metadata
  only for tool panel preview.
- Before submitting a new round of real user input, the App should read, read-only, the summary of IAB tabs
  visible to the current window/workspace and pass it to the runtime through the independent
  `browserAmbientContext` protocol field. Core generates
  `<in-app-browser-context source="ambient-ui-state">` only in the provider-visible user content of this
  turn, while persistence/UI keep the user's original input. This context is only an environment fact: it
  cannot imply that the user explicitly chose IAB and cannot change the routing boundary of desktop
  continuous and web remote replayable; a read failure must degrade side-effect-free to no ambient context,
  and logs must not record the full URL.
- The success/failure of `goto()` must follow the page's final state. If Electron `loadURL()` returns
  `ERR_ABORTED` but the same navigation was redirected by the site or taken over by an SPA and the current
  document has committed to a URL equivalent to the target, return success; if the current document is not
  committed, still on the old page, or a real network failure occurred, still return a structured error and
  do not swallow errors uniformly.
- During App/Agent rolling upgrade, newly added provider-only browser fields must enter the session/send
  degradable field set. Compatible parsing accepts both `Invalid params` and `Invalid params — ...` with a
  summary, and decides to retry with the field omitted only by structured `unrecognized_keys` issues. The
  desktop `dev:local-cli` must rebuild the CLI bundle before start, so the resolver does not hit an old
  `dist/zcode.cjs` first and create a fake regression of "new App protocol, old Agent protocol".
- Model docs, skills and the `js` tool description must use a consistent browser selection and recovery
  order: use `getForUrl(url)` for a target URL, `getDefault()` only without a target; across turns, reuse the
  browser binding first, then recover in the order controlled tabs -> user tabs -> new tab. After one direct
  URL attempt fails, do not loop guessing URLs, paths or resource IDs; use the latest DOM, in-site search or
  a purpose-specific connector/API/CLI to find a verifiable target.
- Changes must cover IAB turn/session lifecycle, locator error, JS model serialization, snapshot-first /
  read-only evaluate model guidance, and tests of selecting docs by manifest conditions; adding a
  provider-only ambient context only extends the strict schema of `session/send` and runtime request
  assembly, adds no session event, and writes no ambient state into the user-visible transcript.

## End-to-End Chain

### 1. Design Document

Location: `docs/design/v2/tool/`

For every tool change, first confirm:

- Whether a concrete tool spec must be added or updated.
- A prompt-only single-sentence wording adjustment must also record the provider-visible semantics in the
  concrete tool spec and be locked by a contract test; do not bind internal subtypes the tool contract does
  not guarantee into the copy.
- A background orchestration tool like Workflow must also check [`15-workflow.md`](15-workflow.md) and
  [`../workflow-script.md`](../workflow-script.md), because it spans the provider-visible tool schema,
  workflow runtime, session store, child-session links and the workflow state projection (the `/workflows`
  command was removed on 2026-08-22; the projection itself remains).
- Whether it affects the public lifecycle, permission, result budget or dynamic tool access, requiring an
  update of `README.md` or this document.
- Whether old fields, handlers, adapters, prompts or tests must be deleted or migrated.
- Whether it changes user-visible behavior; compatibility and the migration path must be written in the spec.

### 2. Contracts Layer

Common locations:

- `packages/contracts/src/tools/*.ts`
- `packages/contracts/src/tools/contract.ts`
- `packages/contracts/src/model/index.ts`
- `packages/contracts/src/events/session.events.ts`
- `packages/contracts/src/interfaces/*.port.ts`

Checks:

- The Zod runtime schema is the single schema source of a built-in tool; JSON Schema is derived through the
  unified helper.
- `inputSchema`, `outputSchema`, TypeScript types and export entries stay in sync.
- For new cross-boundary data, prefer a runtime schema or a stable interface over a TypeScript type alone.
- A provider-native tool must express its execution mode in the model/tool contract, such as
  `executionMode`, `providerNative`, `providerExecuted`.
- New fields consumed by usage, event payload, session store, ZCode app-server or compact must be declared
  starting from the contracts layer.

### 3. Core Tool Declaration

Common locations:

- `packages/core/src/tool/types.ts`
- `packages/core/src/tool/handlers/<tool>.ts`
- `packages/core/src/tool/handlers/index.ts`
- `packages/core/src/tool/registry.ts`

The `ToolEntry` of every built-in tool must check:

- `metadata.name`, `description`, optional `modelInstructions`.
- `capability`.
- `inputSchema`, `outputSchema`, `runtimeInputSchema`, `runtimeOutputSchema`.
- `readOnly`, `destructive`, `concurrentSafe`, `requiresUserInteraction`, optional `allowedInPlanMode`.
- `sideEffectScope`, `riskLevel`, `needsApproval`.
- `permission`, `resultBudget`, `timeout`, `cancellation`, `trace`.
- `handler` and optional `formatModelContent`.
- Whether registry `toContracts()` projects the fields needed by the model, runtime or provider adapter.

Do not only register a handler; the tool declaration is the contract jointly consumed by permission,
scheduling, prompt, adapter, executor, UI and tests.

### 4. System Prompt and Model-Visible Tool Description

Common locations:

- `packages/core/src/tool/registry.ts`
- `packages/core/src/tool/handlers/*`
- `packages/core/src/runtime/methods/context-usage.ts`
- `packages/adapters/src/model/*`

Checks:

- Whether the tool needs dedicated usage rules, e.g. when to use, when not to, how to cite results, whether
  to read a file first, whether a source is mandatory.
- Whether the tool belongs to a specific agent tool pool. `Glob` / `Grep` were designed as Explore-only
  built-in tools; the current default embedded search branch hides them in the main agent and the `Explore`
  child runtime, and only the non-embedded/direct fallback branch puts them in the provider `tools` array.
  When adjusting the branch gate, update the registry filtering, the toolAllowlist intersection semantics
  and related tests together.
- Tool-specific rules belong by default to that tool's provider-visible description. ZCode's
  `modelInstructions` is a structured supplement to the tool prompt, spliced into
  `ModelToolContract.description` by `ToolRegistry.toContracts()` rather than stuffed into the system prompt
  as long text.
- ZCode does not mirror the ordinary tool list, runtime metadata or tool usage rules in the system prompt;
  this information must enter the provider with the `tools` array of the model request. debug/usage may show
  tool prompt occupancy, but must not become a second model-visible description.
- A tool description should be explicit enough for the model to choose the tool; complex behavior goes in
  `modelInstructions` but still enters the provider tool description with the tool contract.
- Changing only the provider-visible prompt also requires returning to the concrete tool spec to state the
  source and adaptation point, plus a contract test proving `ToolRegistry.toContracts()` projects the new
  description; when adjusting a prompt, check this project's actual tool pool so unavailable tools or flows
  are not written into the model-visible description.
- If the boundary statement of a prompt does not fully match current runtime behavior, the concrete tool
  spec must state ZCode's adaptation difference; the model must not see a tool promise the code cannot keep.
- The native `bfs` / `ugrep` / `rg` used by Bash embedded search are part of the tool runtime contract.
  Adjusting their version, build parameters, static dependencies or distribution path must update
  [`embedded-search-native-build.md`](../../../../../../docs/runtime-tools/embedded-search-native-build.md),
  and enter the execution adapter from the handler of a real Bash tool entry, covering with real-artifact E2E
  fixed leading arguments, stdin, exit codes, early pipe close, matcher override, special-argument bypass and
  compressed/archive search. The default Bash prelude must execute the native program directly, fall back to
  system `find` / `grep` when `bfs` / `ugrep` is missing, and supplement the bundled implementation for `rg`
  only when the shell lacks an executable command; a mock or a forwarding layer from Node / WASM to system
  commands cannot prove availability. The `grep` special-argument bypass must maintain both the shell glob of
  the Bash prelude and the regex contract of the internal CLI; `-[Zz]*`, `-[!-]*[Zz]*`, `--null`,
  `--null-data` keep GNU grep null-data semantics and bypass back to the system command, and ugrep
  compressed search uses the unambiguous `--decompress`.
- The usage boundary, option organization and forbidden-abuse scenarios of user-interaction tools (e.g.
  `AskUserQuestion`) must enter `modelInstructions`, otherwise the model sees only a dry short description
  and tends to ask too little, ask wrongly, or treat a clarifying question as an ordinary approval.
- Whether context such as current date, workspace, skills and user instructions is correctly referenced by
  the tool prompt.
- Whether context usage / debug can see the tool prompt occupancy.

### 5. Model Request and Provider Adapter

Common locations:

- `packages/adapters/src/model/transform.ts`
- `packages/adapters/src/model/runner.ts`
- `packages/adapters/src/model/registry.ts`
- `packages/adapters/src/model/catalog*.ts`
- `apps/zcode-cli/packages/bootstrap/src/model-factory.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/types.ts`

Checks:

- Whether `ModelToolContract` contains all fields the provider needs.
- Whether an ordinary client-side tool maps correctly to an AI SDK / provider function tool.
- Whether a provider-native/server-side tool maps by provider kind and model capability, failing closed or
  not projecting when unsupported.
- Anthropic-compatible is not Anthropic-native; WebSearch may only separately allowlist Anthropic baseURL
  hosts confirmed to support server-side search.
- Whether schema keywords, field names and blocked/allowed rules a provider does not support are normalized
  or rejected at the adapter layer.
- An Anthropic-compatible JSON response may return a `thinking` block missing `signature` /
  `redactedData`. Reason for the fix: the AI SDK validates thinking completeness against the Anthropic
  native schema, and a missing signature makes an internal non-streaming `generateText` call such as
  WebFetch fail as a whole; the adapter must delete such unverifiable thinking blocks, keep text, usage and
  stop reason, and never forge an empty signature.
- Whether tool input stringification, provider tool call id, providerExecuted, server tool result,
  citations and usage are normalized.
- Streaming function-call parameters must be assembled at the adapter layer by `toolCallId`:
  `tool_input_delta` is only staged as a retry-safe prelude; once the JSON parameters are complete the
  adapter generates a single provider-neutral `tool_call` and dedups the provider's trailing duplicate
  `tool-call`. ZCode Protocol / app-server should not expose every high-frequency parameter delta directly
  to the UI, but show stable state through the later `tool.updated` lifecycle event.
- Whether compatibility layers such as openai-compatible, anthropic-compatible, gateway and local provider
  need a separate gate.

### 6. Permission, Hook, Mode and Scheduling

Common locations:

- `packages/core/src/permission/*`
- `packages/core/src/tool/scheduler.ts`
- `packages/core/src/runtime/methods/tools.ts`
- `packages/core/src/tool/executor.ts`
- `packages/contracts/src/hooks/*`

Checks:

- Whether permission `patternSources` covers path, command, domain, toolName, input or custom sources.
- Whether allow/deny/ask, mode, allowedTools, disallowedTools and plan/read-only restrictions are still
  correct.
- Whether the hooks `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` need to see
  new fields, and whether input modified by a hook is normalized again.
- The `PermissionRequest` hook and the interactive broker race concurrently (`../permission-responder-race.md`):
  the broker answer channel must be established as soon as the confirm dialog is visible; a hook that hangs
  or fails only withdraws from the race, must not block the user's answer, and must not turn into deny. Do
  not re-serialize the two when changing the ask path.
- Whether the runtime lifecycle hooks `SessionStart` / `UserPromptSubmit` / `Stop` still inject additional
  context correctly before and after tool execution, without bypassing permission, mode, scheduler or the
  tool contract.
- Whether a `Stop` hook asking to continue a turn has a continuation cap, so hook feedback cannot cause an
  infinite turn loop.
- Whether the scheduler runs concurrently or serially correctly by sideEffectScope, concurrentSafe,
  requiresUserInteraction, destructive and session state.
- A provider-native tool must not enter the client-side executor; a mistaken execution must fail closed.

### 7. Executor and Handler

Common locations:

- `packages/core/src/tool/executor.ts`
- `packages/core/src/tool/executor/*`
- `packages/core/src/tool/input-normalization.ts`
- `packages/core/src/tool/handlers/<tool>.ts`
- `packages/core/src/tool/handlers/<tool>-*.ts`

Checks:

- Input first goes through the adapter's generic normalization, then the executor's tool-aware runtime
  schema.
- A handler expresses only business intent; external I/O goes through ports/adapters.
- When a handler finds an expected tool-specific failure during existing execution, it returns a stable
  `errorCode + message`; the executor assembles the structured error and the provider-visible
  `<tool_use_error>` generically and must not branch on a concrete tool name. Successful output and the
  normal execution order do not change because of it.
- State races, I/O faults and cancellation still take the exception path; do not disguise unexpected faults
  as business rejections just to eliminate every `throw`.
- timeout, abort signal, user cancel, permission denial and hook denial must all reach the correct error
  path.
- Whether outer lifecycle events such as app/session shutdown, CLI exit, TUI session switch or app-server
  closeSession also reach the corresponding tool's cancel/cleanup path; not only "single-call timeout or
  user cancel".
- CLI process-level shutdown signals (`SIGINT`, `SIGTERM`, and POSIX `SIGHUP`) must first enter the unified
  cleanup and then exit the process; an adapter holding detached child processes, process groups,
  background tasks or long connections must not rely only on a single command's abort signal.
- Errors keep the cause and a stable error code; flow control must not depend on error text.
- Dynamic read-only or dynamic risk needs an explicit function and tests, not just the tool name.
- Handler output must pass runtime/output schema validation.

The Executor is the controlled execution entry of client-side tools. `packages/core/src/tool/executor.ts`
keeps only the public facade and is split internally along these boundaries:

- Single tool-call orchestration only chains normalization, schema validation, hook, permission, handler,
  result serialization, events and background task tracking.
- The permission flow only handles the permission service, project rules, broker request, PermissionRequest
  hook and permission update persistence; it must not execute a handler directly.
- The hook flow only builds hook input, interprets hook output and additional context; after a hook modifies
  input it must return to the executor main flow for re-normalization and validation.
- Result serialization only handles `resultBudget`, artifact writes, model-visible content and byte
  truncation; UI diff display, event projection and logs must not reverse-parse model-visible text.
- The background task tracker only handles task polling and background task session events; it must not
  affect the success/failure of the current tool call.
- batch/schedule only handles parallel groups, blocking failure and skipped tool result synthesis; it must
  not bypass a single tool call's permission, hook, timeout and trace propagation.

When splitting the executor, the external export paths of `createToolExecutor`, `ToolExecutor` and
`ToolExecutorImpl` must stay compatible, and it must be shown that trace, permission, hook additional
context, resultBudget/artifact, skipped result and background task events have no behavior change.

Tool Agent Trace is established uniformly outside the single-call Executor; handlers add no tracing of
their own:

- Span names use the canonical tool name resolved by the Registry; an alias creates no second metric
  dimension.
- The parent is fixed to the current Step, falling back to the current Turn if no Step exists; business code
  must not pass OTel `traceId` / `spanId` / `parentSpanId`.
- The scope must cover the whole chain of validation, hook, permission, handler, serialization and result
  budget; no Span for streaming progress, background polling or a single output chunk.
- Success, permission denial, cancel and failure map to controlled Tool Outcomes; errors pass only the raw
  `unknown`, and the Telemetry Sanitizer uniformly extracts the code, redacted message and fingerprint.
- `outputBytes` / `outputTruncated` read only the structured serialization metadata the Executor already
  produced, never reading or uploading tool input, full output, file paths or commands.
- The Telemetry Port is optional and defaults to Noop; an export failure must not change tool result,
  permission, timeout, cancel or background task semantics.

Execution trace main spec:
[`../../../../../../docs/trace/cli-agent-telemetry.md`](../../../../../../docs/trace/cli-agent-telemetry.md).

### 8. I/O Adapter and Cross-Platform Boundary

Common locations:

- `packages/adapters/src/fs/*`
- `packages/adapters/src/exec/*`
- `packages/adapters/src/http/*`
- `packages/adapters/src/storage/*`
- `packages/adapters/src/mcp/*`
- `packages/adapters/src/skills/*`

Checks:

- File paths use Node `path` / `url` / the workspace resolver, no hand-written separators.
- Child processes use argument arrays, avoiding shell string concatenation; consider Windows `.cmd` / `.exe`
  and paths with spaces.
- An adapter holding external processes, connections or background tasks must expose explicit shutdown/close
  semantics so that closing the host app reclaims the resources it started, instead of scattering cleanup
  duty across handlers or UI.
- An adapter using independent process groups, detached spawn, PTY, a background runner or an exec-server
  must also define the cleanup entry for when the host process receives a shutdown signal; otherwise an
  abnormal parent exit bypasses the session finally and leaves a runnable child process tree.
- The process cleanup policy must distinguish explicit stop from the pipe drain after the root exits
  naturally, and keep the boundary between tool-specific and generic execution; fixing cross-process-group
  cleanup for one shell must not spread the same capability to the natural completion path or other command
  modes.
- Network goes through the unified HTTP adapter, keeping proxy, certificate, ordinary-request total timeout,
  retry, audit and error normalization; long-connection protocols such as SSE must define a separate
  inter-event idle timeout and must not reuse the ordinary HTTP total timeout.
- storage/session/artifact writes need atomicity, concurrency control and trace.
- Adapter output errors must be structured; core does not parse provider or system error text.

### 9. Result Serialization, Budget and Artifact

Common locations:

- `packages/core/src/tool/executor.ts`
- `packages/contracts/src/tools/*`
- `packages/contracts/src/interfaces/tool-artifact-store.port.ts`
- `packages/adapters/src/storage/*`

Checks:

- Whether `outputSchema` covers successful output.
- Whether `formatModelContent` outputs only the summary the model needs, without leaking large content or
  sensitive information.
- Whether the inline, model, preview and artifact strategies of `resultBudget` are reasonable.
- After a large output is written to an artifact, whether the tool result event contains uri/path, original
  size, returned size, truncated and budgetStrategy.
- Whether binary/image/PDF/structured blocks have independent content blocks or artifacts and are not
  squashed into unreadable strings.
- If a tool result must return media such as images/PDFs to the model, the provider-visible tool result must
  keep a structured content block, e.g. AI SDK
  `output: { type: "content", value: [{ type: "image-data", data, mediaType }] }`. UI, events, DB and debug
  may use a text summary or artifact reference, but a media result must not be squashed into a JSON string
  before being sent to the model, and base64 must not be persisted as ordinary tool output text.

### 10. Session Event, Message History and Persistence

Common locations:

- `packages/contracts/src/events/session.events.ts`
- `packages/contracts/src/events/event-reducer.ts`
- `packages/core/src/agent/message-history.ts`
- `packages/core/src/runtime/methods/message-persistence.ts`
- `packages/core/src/runtime/methods/compact-*.ts`
- `packages/core/src/runtime/methods/resume.ts`
- `packages/adapters/src/storage/*`

Checks:

- Whether events such as scheduled, started, progress, result, error, batch, model streaming and server tool
  use must be added or extended.
- Whether toolCallId is stable across provider, assistant message, tool result, replay and UI.
- When storage / provider wire uses a fixed non-empty placeholder name for an illegal tool call, the
  placeholder string must not double as the illegality discriminator: live must judge by the original
  illegal field, and resume by explicitly persisted metadata; a same-named tool / alias / MCP call without
  metadata is still executed and displayed as an ordinary tool. An illegal lifecycle event that cannot satisfy
  the public protocol schema must stop in the internal recovery chain and must not project the placeholder
  name to the product layer as an ordinary `tool_call_scheduled`.
- Whether message history saves the tool result, provider metadata, server tool blocks, citations or
  encrypted content the model needs next turn.
- Whether session persistence, resume, compact, rewind and fork keep or rebuild enough context.
- The bounded projection of tool result display must be written both to the live `tool_call_result` and to
  the versioned metadata of the completed tool part; resume, app-server load and the TUI initial transcript
  must consume the persisted metadata. The metadata JSON needs runtime schema validation, and old data with
  missing fields stays readable and degrades to legacy output.
- The currently registered non-file display variants must keep this contract:
  - `local_agent_message` contains only `status` and optional `error` / `message`, the two text fields each
    limited to 4 KiB UTF-8.
  - `task_stop` contains only `taskId`, `taskType`, `message`, optional `command` / `truncated`; `command`
    and `message` are each limited to 16 KiB UTF-8.
- **TODO(TUI display parity)**: the TUI live `ToolCallResult` and the persisted transcript adapter still
  materialize only `file_diff`. When TUI maintenance resumes, both paths must reuse the same exhaustive
  display adapter to generate bounded semantic output for `local_agent_message` / `task_stop`; once a
  structured display is recognized, the legacy raw output must not be rendered again, and live-event and
  restored-transcript tests must be added respectively.
- When a file-mutation tool generates a checkpoint, the event must keep both the user-message anchor and the
  tool/assistant-message anchor; compact, resume, rewind and fork may rebuild the active chain and workspace
  snapshot relation only through these stable anchors, not by reverse-parsing tool text or transient runtime
  state.
- Whether the event reducer and usage summary consume new fields without double counting.
- The source of a user-visible one-time hint carried by a persisted event must be projected as a stable fact,
  but may be triggered only when the client first observes it in a live `online` frame; `initial`,
  `recovery`, historical snapshot and repeated delta only restore state and must not pop the hint again.
  Desktop `desktop-continuous` and mobile `web-remote-replayable` each enforce this rule at their own
  delivery boundary, and relay/main do not store hint state.

### 11. TUI, ZCode app-server, Debug and Observability

Common locations:

- `packages/tui/src/app-events.ts`
- `packages/tui/src/app-tool-transcript.ts`
- `packages/tui/src/app-copy.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/*`
- `packages/debug/*`
- `docs/design/v2/debug-*.md`

Checks:

- Whether the TUI can show tool start/progress/result/error, approval, diff, network, todo, background or
  server-side tool states.
- TUI tool display should preferably consume the structured projection of `tool_call_scheduled.payload.input`
  and `tool_call_result.payload.result.display`; pending/running/result/error of the same `toolCallId`
  should update the same transcript part; streaming text and tool parts must keep their original order
  within one assistant step via `assistantMessageId` / `toolCallId`, rather than reverse-parsing
  model-visible results or appending mutually disconnected status lines.
- A TUI tool transcript part should not add a whole left gutter; the title aligns with adjacent assistant
  content, and detail, diff and output use only the local indentation their own semantics need.
- The TUI title of a file tool must prefer the structured `file_path` to generate an audit-friendly short
  path. A path inside the current workspace shows the workspace-relative path; a path outside shows the full
  path. The error description is shown as error-style text under the tool part, and lifecycle text like
  `Tool <name> failed` is not the only visible information.
- For command-class input the TUI approval prompt should prefer `input.description` as the human-readable
  explanation; the panel does not show policy metadata such as `riskLevel`/`mode`, and the command preview
  shows only the value of `input.command`, so the full JSON input or the permission policy reason is not
  mixed into the confirmation content.
- Whether the ZCode app-server can forward tool call update, permission request, usage update, background
  task and prompt result usage.
- V4 cold hydration may speed up turn terminal closing with a derived index maintained from tool row deltas,
  but the snapshot remains the authoritative state; the index must update with terminal/background/rewind and
  keep isolation and terminal equivalence under clone/adopt, strict replay and batch hydration, without
  changing timeline delta order.
- ZCode app-server permission request options must stay consistent with the current client contract: an
  ordinary tool projects at least `Allow once`, `Always allow in this project` and `Deny`, and the project
  allow must return project-level `permissionUpdates` and must not degrade into a one-time allow.
- A user Deny of an ordinary interactive permission must align the provider-visible `tool_result.content` to
  the stable denial text:
  `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
  Policy or hook denials keep their own reasons.
- V4 permission may declare a `freeText` input capability. A non-empty feedback submitted at Deny must enter
  the denial `tool_result.content` through the same `resolveInteraction` answer, formatted as the stable
  denial text followed by one space, `To tell you how to proceed, the user said:`, then a newline and
  `<trimmed feedback>`; no new user message, steer or custom permission decision. Desktop stays
  `desktop-continuous`, Web/mobile remote stay `web-remote-replayable`, and legacy/TUI/bot keep the ordinary
  Deny compatibility path.
- Whether Debug can observe model request, tool call, I/O, permission, retry, artifact, queue, usage and
  trace.
- Whether the copy registry needs new copy, so UI text is not scattered.
- Whether sensitive input, secrets, full user content and large output are controlled by logging/trace/
  redaction.

### 12. Config, Capability, Extension and Compatibility

Checks:

- New config goes first through config/session/project/CLI parameters; a spec must be written before adding
  a `ZCODE_` environment variable.
- Whether model capability, provider kind, MCP capability, plugin namespace and subagent tool pool affect
  tool visibility.
- When deleting an old implementation, whether export entries, tests, docs, migration and legacy aliases are
  handled in sync.
- A dynamic tool / MCP tool must pass capability declaration, schema normalization, namespace isolation and
  permission convergence.

## Special Tool Type Supplements

### Client-side tool

Ordinary built-in tools are executed by the ZCode executor. Focus on handler, adapter I/O, permission,
scheduler, resultBudget, artifact, events and UI.

If a client-side tool may execute early while the model SSE is still open, also check the ledger, recovery
anchor, provider-safe transcript builder, cancellation semantics and stream-break recovery test matrix
defined in `docs/design/v2/model/streaming-tool-execution-and-recovery.md`. It is not enough to call the
executor early; it must be shown that there is no duplicate tool execution, orphan tool result or
provider-visible dangling tool call.

After an early-execution exception, the stream-end fallback or synthetic recovery keeps creating a new
ToolPart, reusing the callID and declaration order. Reusing the old partID would keep the first insertion
position and let a later-completed fallback Read snapshot be overwritten by an older Read. Model hydration
picks, within the same assistant, the last-created part per callID and restores calls/results by the full
declaration order; without an order it keeps the selected records' original order, and the latest unfinished
record is still restored as an interrupted result. UI and file-read state keep consuming the original parts.
Tests must cover fallback success, failure, a second write failure, a late batch start after recovery, and
the fallback / cold-resume / rewind / Edit chain with several Reads of the same file. This fix does not
change permission, execution timing, error content, database structure, or the desktop continuous / mobile
replayable delivery boundary.

When an execution-scoped model (e.g. Highspeed) fails mid-SSE and switches to the session model, it must
likewise go through the provider-safe settle above, not just abort the handle and record `tool_abandoned`.
A complete `tool_call` has created a provider-visible obligation: a finished result is committed as is, a
running one preferably commits a cancellation result, an unknown state commits a synthetic interrupted
result, and the assistant tool call and tool result are written in pairs to live history and the durable
ToolPart; after the switch nothing re-runs, and cold resume must show no `pending`/`running` or extra
fabricated interrupted result. Input that has not formed a complete `tool_call` is still discarded
directly. Tests must cover both "tool already returned" and "tool execution interrupted by the stream
break", comparing the live request before the switch with the cold-resume history.

### Provider-native / server-side tool

A provider-native / server-side tool can be exposed directly in the main model request or serve only as an
internal side-request capability of some client-side tool. WebSearch currently uses the side-request form:
the main loop registers an ordinary `WebSearch` client-side tool; the `web_search` provider-native contract
appears only in the internal request of the `WebSearch` handler. The outer `WebSearch` must go fully through
ToolExecutor, permission, hook, scheduler, events, resultBudget and tool result history. Focus on:

- The contract has a provider-native execution mode.
- The model adapter splices it into the provider tool schemas, not as an ordinary function tool.
- A compatible endpoint must be confirmed to support the provider-native schema; currently only an Anthropic
  provider kind whose baseURL host is `bigmodel.cn`, `z.ai`, `deepseek.com` or a subdomain may project
  `web_search_20260209`.
- If a provider-native tool enters the main model request directly, the runtime does not call ToolExecutor
  to execute it; WebSearch does not use this path.
- If a provider-native tool serves only a side request, the outer client-side tool must still go fully
  through ToolExecutor, permission, hook, scheduler, events and resultBudget.
- When restoring or adding a directly exposed provider-native tool, confirm it is not registered by the
  built-in registry as a same-named client-side tool, otherwise `ToolRegistry.toContracts()` generates an
  ordinary function tool first and the adapter never enters the provider-native helper branch.
- providerExecuted / server tool use / citations / usage enter events, history, persistence and display.
- The provider tool description still holds the model usage rules; the system prompt no longer mirrors them.

### User-interaction tool

For example AskUserQuestion. Focus on:

- `requiresUserInteraction`, permission broker, TUI/ZCode app-server request-response, pending/resume, and
  degradation in non-interactive sessions.
- The interaction flow must not be hard-wired in the TUI; the ZCode app-server must be able to carry it too.

### Background / long-running tool

#### Todo122: Subagent Selection Failure Reason

A selection failure is still blocked by the same resolveSubagentSelection; only the error output is added.
The six public selectionIssue values enter the existing context.reason, with the raw selectionIssue log
field kept. The concrete reason uses a short bilingual (Chinese/English) message, so a readable reason is
not lost when the background keeps only the message; the stable reason marker and original selection
identity stay with the message, and no dedicated protocol is added. Only when a valid selection exists is
its identity projected to context.providerId/modelId; it does not claim that the original selection before
the failure was executed. The foreground executor, background error notification, V4/UI hint and copy reuse
the existing path. Input schema, permission, scheduling, inheritance/override priority and failure
conditions are unchanged; no account query, no selection write, no Key, Header, full config or session
body. Tests cover the real error projection, tool result and foreground/background runners.

For example a background subagent or background Bash. Focus on:

- Before creating the child execution, an explicit Subagent of a Todo99-managed Worker reuses, through an
  injected port, the public effective selection of the same-process applied Registry snapshot; a resolution
  failure blocks and must not fall back to the parent model. The original profile is not written back. An
  internally fixed override resolves before the profile, an implicit inheritance keeps using the parent
  execution Model; the Factory only validates exactly and no longer matches accounts. Ordinary, nested and
  workflow/script child Runtimes must pass the same port; the standalone CLI does not hook in yet. No Tool
  schema, permission, event or persistence field is added, and desktop continuous / mobile replayable are
  unchanged. Verification must include the real child Runtime taking the model and the request, and a
  helper unit test does not replace the whole chain.

- The Markdown contract follows the later ruling of Todo97: the official fields are `model` /
  `thoughtLevel`, and the unreleased intermediate `modelSelection` is neither read nor reverse-migrated.
  Internals and protocol keep using the structured ModelSelection, which must not be confused with the
  Markdown fields.
- Old published Provider values are converted only in the initialization migration stage of the user data
  directory; the official reader no longer performs old-identity conversion; out-of-scope files such as
  project and plugin are not rewritten automatically. An old identity must not be revived through a
  ModelFactory alias. Todo99 resolves only the migrated official selection and does not reimplement the
  migration.

- task id, status, progress, completion/error, cancel/resume, session event store and user-visible
  notification.
- `SendMessage` resuming a terminal local agent does not pass through the `Agent` tool executor; that path
  keeps publishing only `SubagentSpawned(background=true, resumed=true)`. V4 must, in the same projection
  transaction, use this fact to restore the subagent row and create a cancellable background work of the
  same `agentId`; when reusing the row it must keep the display anchor `parentToolCallId` of the original
  `Agent` tool call, must not overwrite it with this `SendMessage` call id, and must not emit a second
  started event for the same state transition.
- The `childSessionId` of a background Agent is the stable linking field for drilling from the parent
  session into the full child session: Agent launch output / runtime task snapshot ->
  `BackgroundTaskStarted/Updated/Completed` -> ZCode Protocol V4 `backgroundWorks` must preserve it segment
  by segment; the UI must not be required to guess it again from tool result text, the subagent row or
  `workId`. When old events really lack the field, degrade only to a non-drillable ordinary status item.
- The child session's own `Write` / `Edit` file summary must keep using the child's `checkpoint_created`
  artifact and terminal `model_complete.fileChanges` as the fact source, projected to the child turn header.
  `querySource=subagent` may open up only this workspace summary and must not use it to project child usage,
  the input box or other editable-session capabilities as main-session semantics; the right-hand read-only
  detail may independently open preview/apply rewind.
- When revocation is still needed after the child runtime is released, the checkpoint association and the
  workspace-only rewind state each reuse the existing `session_entry` persistence; the `SessionResumed` of a
  cold resume creates a new raw event epoch, but the V4 transport sequence must stay monotonic so an old
  detached child's high-water mark does not swallow the new revoke event.
- Child tool lifecycle produced inside a subagent / background task takes the child session's persisted
  events as the fact source; the `source: "subagent"` events mirrored to the parent runtime serve only
  compatible consumers, runtime diagnostics and telemetry, and are not tool facts of the parent session. The
  ZCode Protocol V4 ProductProjection must recognize this source before row materialization, and
  foreground/background alike must never generate a `ToolCallRow`, plan or file summary of the parent
  conversation; the full tool history is materialized only in `conversation/<childSessionId>`. The parent
  conversation keeps projecting Agent/Task rows, the subagent manifest, background work and blocking
  interactions with a subagent origin. This boundary applies to both desktop `desktop-continuous` and mobile
  `web-remote-replayable`; filtering only in the renderer would leave dirty rows in snapshot/replay.
- The third launch entry of a dwf run is the model tool `ResumeWorkflowRun` (after CreateWorkflow's submit
  path and the v4 `resumeWorkflowRun` command, 2026-08-29). It returns the same `backgrounded` shape as
  CreateWorkflow (`{status:"backgrounded", backgroundTaskId ≡ runId}`), and the executor's automatic
  tracking triggers by output shape, not tool name; per-tool lifecycle dispatch recognizes the name through
  `isDynamicWorkflowRunDispatchToolName` (CreateWorkflow ∪ ResumeWorkflowRun), and registry registration
  keeps the existing merge semantics to preserve the `parentToolCallId` of the original CreateWorkflow tool
  row (so the detail-page join does not break across resume).
- When re-arming a dwf run, `registerRuntimeBackgroundTask` must reset the **terminal settlement surface**
  (notified / error / completedAt / exitCode / resultText / pid) of the existing entry while keeping the
  **identity surface** (agentId / agentType / parentToolCallId / turnId / description / startedAt);
  `outputFile` is intentionally kept (dwf never writes it, the existing fallback is only reserved for
  artifact externalization). Root cause: for same-process cancel terminal -> resume without restart, a
  leftover `notified:true` makes `claimRuntimeBackgroundTaskNotification` refuse, swallowing the terminal
  model notification of the resumed run; the v4 command path and the tool path share the bug.
- Do not use a tool-call count as a hard stop; close through cancel, timeout, provider retry cap, token/
  context limit and user action.

### Session-state tool

For example Todo. Focus on:

- When creating future execution (e.g. `CronCreate`), the persisted model must read the session-stable
  model, never the current Turn's temporary execution model. A turn-scoped overlay such as Highspeed or an
  off-peak model serves only the current Turn; even if the tool runs while the overlay is in effect, it must
  save the session model from before the overlay was installed, so a future task is not unrecoverable after
  the temporary provider is cleaned up.
- A temporary model must not reversely change the visibility of future-task tools: a Highspeed user Turn
  still allows `CronCreate`; an actual Automation Turn takes `automationId` as the final execution boundary,
  must ignore an accelerated `modelSelection` and `modelExecution` wrongly passed in the same turn, and hides
  the Automation write tools by the existing rules.
- session store, event reducer, resume, compact summary, TUI/ZCode app-server projection.
- Declare session-only side effects and workspace/system side effects separately.
- `readOnly` is for check-type tools that do not change session/workspace/system/network state. A tool that
  writes session state should declare `sideEffectScope: "session"` and set permission by whether it is
  allowed in plan mode; do not mark a session mutation read-only just to skip approval.
- `allowedInPlanMode` may only explicitly allow control-type tools with `sideEffectScope: "session"`,
  `destructive: false`, `needsApproval: false`; it cannot allow workspace/system/network side effects nor
  override global/project deny/ask rules. A typical use is a child runtime writing to its coordinator's
  session-local response queue.
- A session-state tool used to complete a long-running target/goal must put into its model-visible
  description or prompt that "a plan, todo, checklist, phase completion, budget exhaustion or stopping work
  is not completion evidence", and require the model to audit completion against real artifacts, command
  output, tests, PR state or user confirmation.
- If the result of a session-state tool needs two-phase confirmation, such as the goal completion verifier,
  prefer making the verifier a runtime gate with a configurable switch and no new persistent state; define
  the model continuation hint on verifier failure, the stable status event, the UI/ZCode app-server state
  projection and test coverage. The existing long-running goal is still projected to old clients through the
  compatibility event `target_changed` and ZCode app-server `_meta.zcode.target`; the only model-visible
  goal tool now is `GoalRead`, and model-visible state-mutating tools such as `GoalCreate` / `GoalUpdate` /
  `Target*` must not be added or restored.

### Discovery-backed instruction tool

For example Skill. Focus on:

- Discovery roots, upward traversal boundary, same-name priority and compatible directory order must be
  written in the concrete spec; a handler should not guess paths ad hoc.
- When discovery returns only metadata, prove that the body is still read on demand through the
  adapter/port by tool call, with cancellation and trace still propagated.
- Same-name, no permission, missing frontmatter, too large or unreadable skills must enter diagnostics or a
  stable error path and must not silently change the model-visible capability.

## Minimum Test Matrix

Every tool change selects coverage by risk, at least:

- contracts: schema success/failure, defaults, old-field removal, JSON Schema projection.
- core: ToolEntry contract completeness, registry projection, the system prompt not mirroring tools, input
  normalization, permission, scheduler, executor, handler success/failure/cancel/timeout.
- adapters: I/O port behavior, provider mapping, provider error normalization, cross-platform
  path/exec/network.
- runtime integration: model tool call -> executor -> tool result -> message history -> next request.
- events/persistence: session event, store, resume, compact, rewind, usage summary.
- TUI/ZCode app-server/debug: user-visible state, approval, result display, usage, trace.
- regression: typecheck and lint of related packages, and targeted tests that prove the chain.

If a change touches a shared contract, runtime, executor, session event or model adapter, running a single
handler test is not enough; run at least the typecheck of the corresponding package and the related
integration tests.

## Pre-Commit Checks

### Subagent Computer Use Boundary (2026-08-18)

The subagent restriction of official CUA is not a prompt constraint but a two-layer tool boundary of the
provider-visible surface and the producer execution backstop. Implementation details and stable errors:
[`docs/cua/2026-08-18-subagent-computer-use-unavailable-spec.md`](../../../../../../docs/cua/2026-08-18-subagent-computer-use-unavailable-spec.md).

- Core must use the authority result of `computeOfficialCuaServerNames`, not server/tool string matching.
- A wildcard child filters the borrowed MCP snapshot; an explicit CUA server/tool/selector/Skill fails
  before the model request.
- SkillPort discover/load both filter the official `computer-use` and keep a same-named third-party Skill.
- The CUA producer must check the namespaced `runtime_scope` before the kill-switch, Broker and handler.
- Main Agent canonical/alias, permission group, protected frame and the visibility of other MCP are
  unchanged.

- The spec is updated and says whether the old behavior is kept, migrated or deleted.
- Unrelated dirty changes are not mixed into the same commit.
- No direct I/O bypasses an adapter/port.
- The system prompt does not redeclare tools; the provider-visible tool description / model request tools /
  adapter projection are consistent.
- permission, sideEffectScope, concurrentSafe, destructive and requiresUserInteraction do not contradict
  each other.
- outputSchema, runtimeOutputSchema, resultBudget, artifact and UI projection are consistent.
- session event, message history and resume/compact/replay do not lose information the model needs next turn.
- Tests cover the success path and key failure paths; cross-platform behavior that cannot be verified is
  stated in remaining risks.

## Official CUA Provider Spelling Alias

The model-visible tool name of official CUA allows only the canonical server segment
`mcp__computer-use__*`. When the model occasionally rewrites the hyphen as an underscore, a one-way runtime
alias `mcp__computer_use__*` may be added to the `ToolEntry` only if all of these hold:

- the descriptor comes from the official `zcode-cua` server that passed Host authority validation;
- the server name exactly equals the official canonical name; provenance must not be inferred from the tool
  name;
- the alias does not enter `ToolRegistry.toContracts()`, the provider request, system prompt, manifest or
  persisted events;
- after an alias hit the executor must first restore `entry.metadata.name` before entering permission, hook,
  scheduler, event, history and MCP dispatch;
- an alias that conflicts with any registered canonical tool or other alias must be rejected, never silently
  overwritten.

Do not extend this compatibility to global hyphen/underscore normalization. A third-party server, even with
the same display name, cannot get the official CUA alias, not-ready retry or other trusted-origin behavior.

## Todo103: Off-Peak Tool Consolidation

The Host's current View/rollout controls OffPeakPort injection through policy or creation parameters, and
the Host generates the complete ModelSelection for the tool default selection. The CLI keeps the
anti-recursion marker/denylist of the off-peak turn, and completion, rejection, queuing and throwing all
restore the previous activeOffPeakTaskId; it keeps passing sharedContextRefs and the current modelExecution
and does not restore the old turnRuntimeModel/overlay/model-restore interfaces. Full chain: repo root
`docs/off-peak-task/tech-design.md` §4.7.

## Todo104: Model Media Capability Field Unification

The Model data contract is unified as inputFormat/outputFormat and supportsText/Image/Video/Audio/Pdf. Read
PDF capability reading, current-turn tool capability projection, media filtering, compact and Adapter
request projection all consume this shared contract; Read input/output, permission, IO port, the independent
PDF/image capability gates and result budget are unchanged. The renaming does not modify the actual SDK
body, tool schema or persisted tool messages; desktop continuous and mobile replayable keep their delivery
chain. Verification includes strict protocol candidate validation, the Read PDF executor, media requests and
cold-resume/compact cases; completion cannot be judged merely from the settings page display.

### Mid-Turn Message Source Presentation (2026-09-11)

The source presentation of SendMessage / RespondToCoordinator follows `../loop/turn-steering.md`: update the
coordinator recognition hint, keep history-prefix compatibility and the existing reply/continue-work
contract. Parameters, permission, execution target, background batch and visibility boundaries are not
extended; a child does not get SendMessage, and the reply target of a parent peer comes from the bound
agent-id. Verified: tool description, real parent/child Runtime requests, cold resume and the BG25/O18/O19
fixtures.

### 2026-09-18 ToolSearch E2E Completion

Only tests and docs are extended: real entry -> search execution -> final HTTP body -> first request after
compact/fork/restart; including the off request to verify degradation and recovery. Product schema,
permission, SQLite and App protocol are unchanged. Acceptance scenarios: the TS sub-scenarios of the root
conversation-session coverage matrix.

### 2026-09-18 ToolSearch E2E Formal Admission

This and the previous 8 specs (29 items) were promoted after user confirmation; the case-local fixture
becomes the actual source of model responses, and the original request stage, cancellation barrier and
product assertions are unchanged. Only tests and docs change; no production interface is added and no
database or protocol modified. The formal path and run evidence are in the root coverage matrix; Docker
admission is recorded separately.

## CreateWorkflow Amend-Resume Without Re-Confirmation Within a Session (2026-09-13)

```text
User approves CreateWorkflow / hub direct launch -> runId
  -> PermissionService.grantWorkflowLineage(runId, resume_from?)      (in-memory only, session lifetime)
Model CreateWorkflow{resume_from}
  -> checkAlwaysAsk: blocking branch -> session rule -> lineage hit allow -> otherwise ask
User Cancel (initiator user) -> revokeWorkflowLineage(runId) revokes the whole lineage
```

Only the permission decision, two seeding points and one revocation change. ResumeWorkflowRun / resume re-arm
do not seed. Decision record: root `docs/dynamic-workflow/launch.md`, addendum 2026-09-13.

## GetWorkflowRun Situation Cross-Section (2026-09-17)

```text
dwf_event / dwf_node / dwf_actor
  -> bootstrap roster (phases / roster / health, derived at read time)
  -> DynamicWorkflowRunDetail{phases?, subagents, health, logTail[].at?}
  -> core handler: Date.now() once -> generatedAt; field-by-field copy -> summary (deterministic assembly)
  -> runtimeOutputSchema (strict, phases <= 32 / subagents <= 64 + subagentsTruncated)
  -> formatModelContent (pure function (output) => text, block order in docs/dynamic-workflow/launch.md)
  -> createToolResultDisplay -> get_workflow_run card (contracts + packages/shared both strict)
```

The output has `summary`, `generatedAt`, `phases?`, `subagents`, `subagentsTruncated?`, `health`, and
`logTail[]` has an optional `at`; input, permission, predicate, resultBudget and artifact strategy are
unaffected. `generatedAt` is necessary because `ToolEntry.formatModelContent` receives only `output`: every
"how long ago" on the model surface is computed against one reading that crosses the boundary with the output,
which keeps the formatter testable and ages comparable. The members and enums of the two display schemas (contracts and `packages/shared`) must stay in sync: the v4
envelope carries display with `.optional().catch(undefined)` (since 2026-09-21; an unreadable payload is
dropped and the frame is delivered, `docs/v4-refactor/10-protocol-spec.md` section 4.4.5), but clients older
than that fix reject the whole frame, so **look at the mirror before adding a field**. Decisions and block
order: `docs/dynamic-workflow/launch.md`, "`GetWorkflowRun`" and "Their cards".

## Workflow Draft Directory Writes Need No Confirmation (2026-09-18)

```text
executor (permission-flow / permission-input-recheck)
  -> PermissionContext{workingDirectory}
  -> checkPermission: disallowed -> project deny/ask -> plan -> project allow
     -> WebFetch preapproval -> **draft preapproval** (Edit / Write, isWorkflowDraftPath)
     -> allowedTools -> mode default
```

An Edit / Write whose resolved `file_path` is inside `<cwd>/.zcode/workflow-drafts/` is allowed, with ruleId
`tool.workflowDraft.preapproved`; the decision is in `permission/workflow-draft-path.ts`, pure path comparison.
ApplyPatch has the same `edit` permission name but its input is `patch_text`, so it is not included. The
position equals the WebFetch preapproval: it cannot override project deny/ask nor plan; it does not apply
when the context has no `workingDirectory`. The first permission judgement and the Hook-rewrite re-judgement
both use the cwd in the existing execution context, keeping the Guarded snapshot semantics. Decision record:
`docs/dynamic-workflow/launch.md` "Script files" -> "Editing a draft needs no approval".

## Script File Source and Working Copy (2026-09-18)

```text
contracts/tools/{create,amend,save}-workflow.ts, eval-workflow-snippet.ts
  -> entry.validateInput (source constraint on model input: exactly one for Create/Save/Eval, at most one for Amend)
  -> entry.resolveInput (the only disk read: read the path file / write the working copy of saved)
  -> PreToolUse hook + project permission rules -> permission event payload -> prepareApproval
  -> handler (an inline source writes the draft before reading the compile result) -> scriptPath of port.submit / port.amend
  -> model-facing response (file-line prefix of diagnostics + the "go edit that file" NOTE)
```

Each of the four tools has a file source, exactly one given (`AmendWorkflow`: at most one; giving neither
inherits the predecessor's script, next section): `CreateWorkflow.path` (plus a top-level `args` that goes in
and out only with it), `AmendWorkflow.path`, `SaveWorkflow.script_path` (not `path`, which is already where
this tool writes back its resolution), `EvalWorkflowSnippet.path`. The source constraint lives in
`validateInput`, not the schema, because after normalization `script` and a source field both present is a
legal execution state. The back-filled `script_line_offset` and `saved.draft` do not enter the model's JSON
schema (same posture as `AmendWorkflow.predecessor`).

Inline and saved sources each write a working copy to `<cwd>/.zcode/workflow-drafts/`
(`handlers/workflow-drafts.ts`, best effort, no path on failure); a `path` source writes none. The absolute
path enters `run-launched` with the `scriptPath` of `submit` / `amend`, and the model surface shows the
workspace-relative form (`handlers/workflow-script-path.ts`). Diagnostics `{path}:L{line}:C{col}` use the
**file line** (plus `script_line_offset`), while the `diagnostics` array in the output and the display payload
use body lines. The `path` submission of `AmendWorkflow` compares bytes before any window through the port's
optional `getScript`; unchanged and `max_concurrency` / `subagent_model` not changed together is
`workflow_script_unchanged` (error code 24). UI/V4 projection, events and output shape are unaffected.
Decision record: `docs/dynamic-workflow/launch.md` "Script files".

**An inline draft is recorded as a file the model wrote**: after the handler of `CreateWorkflow` /
`AmendWorkflow` writes the inline draft, `handlers/workflow-draft-read-state.ts` gets mtime / size through
`fileSystemPort.stat`, records into `context.readFileState` a full view of the same shape as `Write`, and
persists it to tool part metadata through `recordReadFileStateMetadata` (`PersistedReadFileStateTool` has
`CreateWorkflow` / `AmendWorkflow`; `read-file-state-hydrator.ts` restores it on resume). So the single `Edit`
the NOTE asks for need not first `Read` the script the model just wrote. Only the bytes written in this call
are recorded: a saved copy, a new draft of an inherited predecessor script (`predecessor.script_inherited`),
a hub direct launch and a GUI settings amend are **not**. The stale check stays (an advanced mtime gives
`STALE_FILE`); a failed stat records nothing.

## AmendWorkflow May Omit the Script (2026-09-18)

```text
Model AmendWorkflow{run_id, max_concurrency?, subagent_model?, name?} (neither `script` nor `path`)
  -> resolveInput: port.getTask (predecessor facts + scriptPath) + port.getScript (journal script_text)
  -> back-fill script, predecessor.script_inherited = true (predecessor is overwritten unconditionally, model forgery is void)
  -> the predecessor's script file still holds these bytes -> back-fill path (the new run keeps recording it); otherwise path absent
  -> PreToolUse / permission rules / prepareApproval (compiles the back-filled script, the confirm dialog draws the graph) / handler
  -> handler: path absent writes a new draft from the inline script
  -> port.amend{scriptText, scriptPath} (the port always receives the script, inheritance happens only at the tool layer)
```

The three script routes are `path` / `script` / neither (`validateInput` rejects only "both given";
normalization in `handlers/amend-workflow-source.ts`, whole-input normalization in
`handlers/amend-workflow-resolve.ts`). `script` is optional in both the model-facing and runtime schemas;
`predecessor` has `script_inherited?: true`. The port has an optional read-only `getScript(runId)` that does
not enter the `getTask` snapshot (the snapshot is polled by the background tracker, and the script is the
largest string on the port). Failures come before the confirm dialog: no archived predecessor script, no host
port, or a port lacking `getScript` -> `workflow_amend_script_unavailable` (error code 26, resolveInput,
before hook); an inherited script that does not compile under the current facade -> the first diagnostic
sentence says the script is inherited, and diagnostics and NOTE use file coordinates per "Script File Source".
The GUI `配置` ("Configure", runtime `amendWorkflowRunSettings`) uses the same rule and code (`resolveKeptScriptFile`).
Output shape, display kind, permission decision (owner rule), events and v4 protocol are unaffected; the UI
adds one line `脚本不变` ("script unchanged") on the lineage row (the chat card reads the model's original input where
`script` and `path` are **both** absent, since a `path` amend also carries no `script` yet is a changed
script; the confirm dialog reads the back-filled flag). Decision: `docs/dynamic-workflow/launch.md` "Keeping
the predecessor's script".

## AmendWorkflow Changing Only Concurrency Takes Effect In Place (2026-09-19)

```text
Model AmendWorkflow{run_id, max_concurrency} (no script / path / subagent_model / name)
  -> resolveInput: port.getTask (predecessor facts + status) + resolveAmendMaxConcurrency (tri-state -> number or null)
     -> "nothing changed except concurrency" and the run is still alive => in-place retune: no getScript, no script inheritance
     -> same value => unchanged (structured failure, before hook and confirm dialog, naming the current ceiling)
  -> PreToolUse / permission rules (owner rule unchanged; this path opens no confirm dialog: there is no script to show)
  -> prepareApproval: no compile, no ask, the gate lets it through
  -> handler: port.retuneConcurrency({ runId, maxConcurrency })
     -> ok        => response names the run id and the new ceiling; not added to the background tracker (the run is already in it)
     -> unchanged => structured failure
     -> not_live (settled / not owned by this process / pending but the engine not yet built)
        => this session's own run falls back to a real amend (then getScript + compile; a missing script / compile
           failure is reported by amend's own rejection); a run failing the owner predicate is rejected: settled is
           workflow_run_settled (28), never held is workflow_run_not_retunable (29) - this path never popped a
           window, so "nothing was approved" must not be stretched into "start another run"
```

The `AmendWorkflow` schema is unchanged; in-place routing is a judgement on the input shape. The port has
`retuneConcurrency({ runId, maxConcurrency: number | null })` (`interfaces/dynamic-workflow-run.port.ts`),
answering `{ok:true, maxConcurrency, previous, ceiling} | {ok:false, reason:"not_live"|"unchanged", current?}`:
`null` means this machine's ceiling and the port answers with the number **actually in effect** (clamped into
`[1, ceiling]`); `ceiling` lets the caller say "ceiling lifted", `previous` is the left side of the event log
and settings turn `{from,to}`, `current` lets `unchanged` name the current ceiling. The GUI's
`amendWorkflowRunSettings` shares the same tri-state parsing and routing. "Alive" is decided by the run
service: it must hold the run's live entry and the control plane must be bound to the engine; a pending run
whose engine is not yet built answers `not_live` immediately (no buffering), which is why the popover says
`就地生效` ("takes effect in place") only on `running`. An old host whose port lacks `retuneConcurrency` falls back to a
real amend. Falling back **re-reads the run** (the `predecessor` in hand still says "running") and asks a
single predicate - the contract's `isAmendWorkflowOwnedPredecessor`, the same function as the permission
service's owner rule. `workflow_retune_unchanged` (27), `workflow_run_settled` (28) and
`workflow_run_not_retunable` (29) are this route's own rejections (`AMEND_WORKFLOW_ERROR_CODE` in
`handlers/amend-workflow-source.ts`); none touches the run. Same-value is closed first in resolveInput when the
ceiling is readable; otherwise the port answers.

Engine and journal: `setMaxConcurrency(n)` writes caps, `updateRunCaps` and the `run-caps-changed` event in
one synchronous step and pumps the scheduler once more when the ceiling is raised; `dwf_run.caps_max_concurrency`
now has a second writer, and resume reads this row, so a retuned ceiling survives a restart. No migration.
Each run has a driver-side seat gate: when the ceiling is lowered, excess subagents park at **the model request
of the next turn step** (existing `model_request_queued` -> `waiting(slot)`); model requests issued inside
tools never park.

Events and v4: `run-caps-changed` is a new open-string `eventType` (the reducer's default branch only raises
the watermark, so old clients are compatible). The shared reducer moves `concurrency.limit` and
`concurrencyCeiling` by the same rule as `run-started`, and the CLI adds `concurrencyCeiling` when minting the
payload.

UI/V4: the event log has one line `并发上限 8 → 2` ("concurrency limit 8 -> 2"); the concurrency chip is unchanged (it is
`min(cap, limit)`). `amend.predecessorRunId` of the settings turn is optional, absent meaning "in place"; that
turn draws one line and no run card. Recorded skew: on an old desktop the field is required and that line
fails to parse and is dropped. The `配置` ("Configure") popover says
`立即应用到当前运行，不会新起一次运行。` ("Applied immediately to the current run; no new run is started.")
only while the run is `running` and only concurrency changes; `pending` keeps the original wording because its engine may not yet be built.

Output: `{ok:true, response, diagnostics: [], retuned:{runId,maxConcurrency,previous,ceiling}}` - no
`status:"backgrounded"`, no `backgroundTaskId`, no display payload. `retuned` is an explicit discriminating
block and stays in-process: the protocol's `toolOutputSchema` carries only text / display / truncated, so
**only the response sentence gets through v4**; the desktop tool row draws by it and the input shape, and the
two ceilings each have a verbatim test. No protocol field is added on purpose: the three display schemas of
`create_workflow` are `.strict()` frozen field sets (one more key makes the old end drop the whole tool
result), and a new display kind would make a version-locked mobile bundle fail to parse.

Main tests: `dynamic-workflow/tests/engine/engine-retune-concurrency.test.ts`,
`bootstrap/tests/workflow-seat-gate.test.ts`, `bootstrap/tests/dynamic-workflow-run-service.test.ts`,
`core/tests/amend-workflow-permission.test.ts`, `packages/ui/test/workflowRunSettingsPopover.test.ts`.
Decision: `docs/dynamic-workflow/concurrency.md` "Retuning a live run" and `docs/dynamic-workflow/launch.md`
"Changing only the parallelism of a live run".

## Approval Dialog Full Access (Todo158, Implementation Contract)

A V4 ordinary main-task approval may declare fullAccess: the same resolveInteraction first obtains the broker
answer right, atomically saves the task permission and the permission of the accepted-but-not-executed queue,
and only then allows the current tool. Runtime, Composer and queue each keep Plan; project ruleset/default,
other tasks, user Q&A and standalone workflow confirmation are unchanged. Full commit, failure recovery,
compatibility and the PA158 regression list: root
`docs/working-memory/provider-refactor/steps/todo-158-permission-dialog-full-access-and-queued-mode.md`. A
subagent request shown through the parent task does not mean the parent Runtime owns the child Runtime; do not
offer this option until the full capability is implemented.

### Todo158 Failure Closing and Recovery Fix (CR-01 / CR-02)

```text
Each fullAccess attempt -> broker creates this attempt's failure notification
  success -> registry produces V4 answer -> allow the original tool
  failure -> clean up this attempt's wait and notify waiting legacy answer/timeout -> close by the original semantics
  retry   -> create an independent new wait; while a commit is still in progress it cannot allow early
Task recovery -> read the optional receipt marker -> validate success and the same session before restoring the marker
  invalid/unknown extension field -> clear the old marker, record a diagnostic and continue recovery; authorization retry still validates strictly
```

The Broker owns the answer race and the Runtime owns permission and recovery; protocol, queue transaction and
the desktop continuous/mobile replayable boundary are unchanged. Regression covers legacy resolve/reject
arriving before and after the failure, commit/projection failure, retry, cancel, and production Runtime
recovery of valid/invalid/future receipts.

## Completion Notification durationMs Uses Lineage Active Duration (2026-09-21)

```text
dwf_event (run-started + the last event of each generation)
  -> adapters listRunLifeSpans (host read surface, single SQL, no payload decoding)
  -> bootstrap runLineageActiveMs (sum hop by hop along resumedFrom, bounded + cycle-safe)
  -> snapshotOf terminal branch -> DynamicWorkflowRunSnapshot.activeDurationMs
  -> core workflowNotificationDurationMs: max(this generation completedAt - startedAt, activeDurationMs)
  -> workflowNotification.durationMs -> completion card `时间` ("time") cell
```

Only the **sourcing** of `durationMs` changes: schema, field name, bounds and the three-state carrying rule
are unchanged, and old payloads and ports without `activeDurationMs` (in-memory journal, test doubles) use this
generation's duration. Reason: resume and amend each reopen an in-process clock while the tokens on the same
card cover the whole lineage. Criterion and floor: root `docs/dynamic-workflow/transcript-and-notifications.md`
"How long it took". `listRunLifeSpans` is not in the engine's `JournalStorePort` (the engine does not read
durations); like the `listRuns` family it is wired by capability probing and probed **independently** of the
four members of `supportsRunIntrospection`, so lacking it only makes the duration fall back to this generation
and does not affect `GetWorkflowRun`.

## Shortened Workflow Authoring Tool Descriptions and Skill Gate (2026-09-21)

```text
Model CreateWorkflow{script|path} / AmendWorkflow{path|script} / SaveWorkflow / EvalWorkflowSnippet
  -> validateInput (unchanged)
  -> resolveInput: skill gate (handlers/workflow-skill-gate.ts)
       context.hasLoadedSkill("dynamic-workflows")
         = the runtime scans the provider-visible history (agent/loaded-skills.ts): true only if a Skill call completed successfully
       no  -> ToolHandlerFailure{errorCode 428} (before hook and confirm dialog; text points to the Skill tool and the tool to retry)
       yes / probe absent (session has no skillPort) -> the original normalization
  exceptions: CreateWorkflow with only `saved`; AmendWorkflow with neither `path` nor `script`
```

The provider-visible descriptions of the four authoring tools are a few hundred tokens each
(`*-description.ts`; they were about 19k tokens in total), and the contract-level field `.describe()` is one
sentence. The facade declaration (`FACADE_DTS`, about 4.4k tokens), writing rules, phase and naming rules,
Amend's cache and tri-state fields, Save's file format and argument declaration, and the snippet facade's scope
live in `packages/bundled-skills/skills/dynamic-workflows/SKILL.md` section 16 "Tool reference", where the
facade is embedded verbatim in a `<!-- facade-dts:start/end -->` marker block that
`bootstrap/tests/dynamic-workflow-skill.test.ts` pins equal to `FACADE_DTS` and keeps the file within the Skill
tool's `MAX_SKILL_BYTES` (the full example of the former section 11 moved to examples.md section 5). The
descriptions keep only what decides "whether to call": CreateWorkflow's named routing and three sources,
AmendWorkflow's fix/extend/change-mid-run/settings-only, SaveWorkflow's never-save-proactively, and the shared
rule "load the `dynamic-workflows` skill first, otherwise rejected".

`ToolInputResolutionContext.hasLoadedSkill?` (core/tool/types.ts) flows through `ToolExecutorOptions` /
`ToolExecutorDeps` to the resolution context of call-runner; runtime-tools.ts injects the probe only when
`deps.skillPort` is present and answers with `messageHistory.borrowReadOnlyRuntimeEntries()`. The criterion
takes history, not a session flag: after compaction replaces history with a summary the skill body is no
longer in the model context and the gate closes again (like Edit requiring Read and compact clearing
readFileState); resume / rewind rebuilding history rebuilds the answer. `DYNAMIC_WORKFLOW_SKILL_NAME` lives in
contracts (shared by core and bootstrap). Output shape, permission decision, events, v4 protocol and UI are
unaffected. Main tests: `core/tests/workflow-skill-gate.test.ts`, `core/tests/loaded-skills.test.ts`,
`core/tests/workflow-routing-hints.test.ts`. Decision:
`docs/dynamic-workflow/authoring.md` "The authoring surface" -> "The skill gate" and
`docs/dynamic-workflow/launch.md` "When the model may call it", "What the model is told".

## Workflow Facade Pipeline Primitives channel / future (2026-09-22)

```text
Model CreateWorkflow / AmendWorkflow / SaveWorkflow / EvalWorkflowSnippet{script}
  -> compile: FACADE_DTS has a stream section (facade/dts-stream.ts: Channel<T> / channel() / future())
       the snippet facade includes it too; the SKILL.md section 16.2 marker block is re-embedded, the tripwire pins equality
  -> analysis: channel / future have no site (same as log); `send` is in HEAP_MUTATORS (producer->consumer data edge);
       `future` is in the callback registry (once + entered, the async body is a strand); collectSitePhases(core) produces a site -> phase-name table
  -> lowering: channel<T>(n) -> __host.channel(n); future(f) -> __host.future(f)
  -> compiled artifact CompiledDynamicWorkflowScript.sitePhases -> runWorkflowScript -> EngineConfig.sitePhases
       the engine mints instances with lexical priority and dynamic fallback (execution-engine.md "Identity: sites, ordinals, phases")
  -> sandbox: the cell's second-stage bootstrap (dynamic-workflow-runtime/src/child-cell-streams.ts) implements queues and future;
       stall detection: after each response, setImmediate runs __checkStalled - no in-flight request and not complete ->
       error-complete (ChannelDeadlock naming the channel / ScriptStalled), the run settles errored instead of hanging
```

Tool schema, permission, events, v4 protocol and UI are unaffected; the change is the script language the four
authoring tools accept (facade) and the sandbox failure form. Decision: `docs/dynamic-workflow/authoring.md`
"Streams: `channel` and `future`"; analyzer side `packages/dynamic-workflow/docs/analysis.md` "Phases" and
"Heap writes". Tests: `dynamic-workflow/tests/streams.test.ts`, `dynamic-workflow-runtime/tests/streams.test.ts`.

## CUA App Identity on the node_repl Tool Card (2026-09-17)

After Computer Use moved into `node_repl`, the display of `mcp__node_repl__js` carries the target App identity,
otherwise the tool card shows only a generic icon:

- The CUA branch of `createToolResultDisplay` dispatches by `readCuaToolName` (requires the tool name to
  contain `computer_use`) and does **not** hold for `mcp__node_repl__js`; do not widen that regex to reuse
  `kind: "cua"`.
- The identity is the optional `app: { appKey, displayName? }` of the `node_repl_images` display. Its `images`
  is optional (a pure-action cell has no screenshot but still projects the identity). The kind name is kept
  (renaming would make persisted rows be stripped by the strict schema).
- The fact comes only from the host: the CUA bridge of node-repl-host reads the producer `_meta` from the
  broker response into `NodeReplRunResult.cuaApp`, and `toMcpRunResult` lands it in
  `_meta["zcode/nodeReplCuaApp"]`. Producer keys sent through the sandbox-writable channel
  (`nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult`) must be deleted, as for
  `ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY`.
- Three strict schemas must have the same set: `toolResultDisplayPayloadSchema` (contracts),
  `toolCallDisplaySchema` (shared), and the allow-list of `toProtocolToolCallDisplay` (`node_repl_images` is
  already on it).
- Display contract: `docs/cua/cua-tool-app-identity-summary.md` "Identity source in the node_repl era".

## On-Demand Registration of the Dynamic Workflow Tool Surface (onDemand)

The rollout mode `onDemand` no longer collapses into `alwaysOn`: the ten workflow tools (and the CreateWorkflow
line in the Agent / Task descriptions) are deferred until the session first really needs them; the `/workflow`
catalog entry, the skill, the automation page tab and the Resume entry exist in both modes. Decision and
acceptance: repo root `docs/dynamic-workflow/launch.md` "On demand: activation" (DWG-09 to DWG-13). Chain:

- **Protocol**: `dynamicWorkflowMode` goes on the same row as `dynamicWorkflowEnabled` - shared
  `workspace/updateDynamicWorkflowPolicy`, `session/create`, `session/resume` (strict) and the v4
  `createSession` payload (additive). The Host's (`zcodeAgentService`) `resolveDynamicWorkflowGate` returns the
  mode instead of a boolean, and the three creation paths send it from the same source via
  `resolveDynamicWorkflowSessionFlags`; an old CLI that knows only the boolean goes through the existing compat
  omit-and-retry and behaves as alwaysOn.
- **Protocol server**: `appRuntimePreferences.dynamicWorkflowMode` coexists with the boolean; `createRecord`
  writes two explicit booleans `runtimeConfig.dynamicWorkflowEnabled` / `dynamicWorkflowToolsOnDemand` through
  `resolveDynamicWorkflowRuntimeGate` (dynamic-workflow-policy.ts) (this call's parameter -> workspace
  conclusion -> absent means alwaysOn).
- **core**: the activation state belongs to the runtime (`dynamicWorkflowToolsActivated`, born true when not
  onDemand); the two registration entries share `resolveRuntimeDynamicWorkflowToolsIncluded(runtime)`, which
  reads `enabled ∧ (¬onDemand ∨ activated)`. `activateDynamicWorkflowTools` in
  `runtime/methods/dynamic-workflow-activation.ts` flips the state -> `refreshBranchAwareBuiltInTools`
  re-registers and clears cachedTools -> writes a `runtime/dynamic_workflow_activation` entry (contracts add
  `SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION`; if the first-turn activation precedes persistence,
  `ensureSessionPersisted` backfills). Triggers: the builtin prompt resolver of bootstrap `create-app.ts`
  expanding `/workflow` (`resolveZCodeBuiltinPromptCommandInvocation` brings back the command name),
  `trackResumedDynamicWorkflowRun` (GUI Resume), both paths of `amendWorkflowRunSettings` (configure),
  `startSavedWorkflowRun` (direct start), and `restoreDynamicWorkflowActivationOnResume` in `resume.ts` (entry
  present, or the persisted history has a `/workflow` user message / a call to one of the ten tools -
  `isDynamicWorkflowToolName` exported from tool/handlers). Add only, never subtract: neither compaction nor a
  server flip reclaims it.
- **Child session**: `subagent.ts` folds the parent session's current activation state into the child config
  (not activated -> child on-demand with no entry; activated -> child registers eagerly);
  `script-workflow-child-runtime.ts` explicitly writes `dynamicWorkflowToolsOnDemand: false` for actors.
- Output shape, permission decision, events, v4 projection and UI are unaffected. Main tests:
  `core/tests/dynamic-workflow-activation.test.ts`, `bootstrap/tests/dynamic-workflow-policy.test.ts`,
  `bootstrap/tests/dynamic-workflow-on-demand.test.ts`,
  `packages/services/test/zcodeAgentService.dynamicWorkflowPolicy.test.ts`.

## Adjusting Subagent Model and Concurrency in the Confirm Dialog (2026-09-22)

```text
resolveInput of CreateWorkflow / AmendWorkflow (when the port is present)
  -> back-fill input adjustable_settings{subagent_model: whether a model catalog exists, concurrency_ceiling?} (unconditional overwrite, model forgery is void)
  -> PreToolUse / permission rules / prepareApproval / PermissionRequested event payload (the confirm dialog reads this block from the input)
User changes values in the confirm dialog, then picks Allow / Always allow this session
  -> v4 resolveInteraction.answer{optionId, content{subagent_model?: string|null, max_concurrency?: number|null}}
  -> bootstrap interaction-broker: reads content only for the allow answer of the two tools, validates by the contract schema, drops extra keys
  -> PermissionBrokerResult.inputAdjustments
  -> core permission-flow: after authorization (including session-wide no-confirm) and before the handler calls entry.applyInputAdjustments
     (the model is re-resolved through the catalog, the ceiling is clamped into [1, ceiling], null deletes the key; failure is a tool failure, nothing starts)
  -> ToolExecutionContext.inputAdjustments (the values in effect) -> the handler first says `用户在确认窗调整了设置` ("the user adjusted settings in the confirm dialog") in the response
```

`adjustable_settings` goes through the **input channel**, not the `create_workflow` display: the display's field
set is frozen, and one more key would make a client that parses it strictly (chat card, legacy v3 lookup by
kind) drop the whole block with the graph; the input channel has no schema in any version. The model-facing
JSON schema does not list it (same posture as `predecessor` / `script_line_offset` / `saved.draft`), and the
runtime strict schema accepts it as optional. An old agent does not back-fill -> a new client draws the plain
text condition line as before; an old client does not recognize it -> ignores it.

Contract: `PermissionBrokerResult.inputAdjustments?` (contracts/interfaces/permission.port.ts),
`WorkflowSettingsAdjustmentSchema` and `WorkflowAdjustableSettingsSchema` (contracts/tools/workflow-settings.ts,
extended by the runtime schemas of both tools); the bootstrap-side answer reading is in
`zcode-protocol/workflow-settings-answer.ts`; core: `ToolEntry.applyInputAdjustments?`,
`ToolExecutionContext.inputAdjustments?`, the executor's apply step in
`tool/executor/permission-input-adjustments.ts`, shared by both tools through
`handlers/workflow-settings-adjustment.ts`. Deny, Refine, a PermissionRequest hook winning, legacy v3, and
TUI / headless auto-allow carry no adjustment. Tool output shape, display kind, events, journal and v4
protocol schema are untouched (`answer.content` was already `record<string, unknown>`). Decision and copy:
repo root `docs/dynamic-workflow/launch.md` "Adjusting the settings in the window" and
`docs/dynamic-workflow/presentation.md` "The confirmation window".

## Standalone CLI `--workflow-mode` (2026-09-23)

TUI and headless (`--prompt`, `--target`) get no rollout mode from a Host; the process argument
`--workflow-mode disabled|onDemand|alwaysOn` decides the registration surface of the ten workflow tools,
**default `disabled`**. Decision and acceptance: repo root `docs/dynamic-workflow/launch.md` "The standalone
CLI: `--workflow-mode`" (DWG-14 to DWG-17); argument contract in `commands.md`. Chain:

- **CLI entry** (`cli/src/workflow-mode.ts`): `run.ts` parses and validates the value and scope
  (`app-server`/`agent-server` and subcommands that create no session error out);
  `resolveWorkflowModeRuntimeConfig` folds the mode into two explicit booleans `dynamicWorkflowEnabled` /
  `dynamicWorkflowToolsOnDemand`, which `prompt-command.ts` and `tui-prompt-handler.ts` write into each app's
  `runtimeConfig`.
- **bootstrap / core unchanged**: all consequences of the two fields reuse the existing protocol-server
  implementation - the registration gate `resolveRuntimeDynamicWorkflowToolsIncluded`, the `Agent`/`Task`
  description line, removal of the `dynamic-workflows` skill, the builtin resolver not expanding `/workflow`,
  and onDemand activation (`/dwf resume` activates through `trackResumedDynamicWorkflowRun`). The core
  "absent means on" polarity is unchanged; the standalone CLI just stops leaving the fields absent.
- **Command surface**: the command center's `workflowMode` dependency returns a local hint for `/workflow` and
  `/dwf resume` under `disabled`; `listSlashCommandSuggestions` / `formatSlashCommandHelp` drop `workflow` by
  the same mode; headless `-p "/workflow ..."` errors out with exit 1 before creating the app.
- Tool schema, permission, execution, events and v4 projection are unaffected. Tests:
  `cli/tests/workflow-mode-option.test.ts`, `cli/tests/headless-workflow-option.test.ts`; workflow cases in
  `cli/tests/headless-workflow.test.ts` use an explicit `--workflow-mode alwaysOn`.
- It supersedes the boolean `--enable-workflow` of the concurrent staging (headless only, default on in TUI):
  that argument is removed, and passing it is an unknown argument.

## ReplyToChannel (2026-09-23)

The tool sends a native mention with the mention refId already confirmed in the session bound to the current
task, including a client-continued history target; it accepts no group ID, app ID or bare user ID. 2026-10-08:
adds mentionName (name, optional candidateRef), with the Host querying the real identity in the currently
authorized session. Chain: input schema / model tool schema / description -> current execution input ->
existing reply port / protocol -> Host query and recheck -> delivery idempotency -> strict
sent/failed/unknown/invalidated or needs_clarification result.

- Names are queried by containment: a unique candidate or a unique full-name match is sent directly; other
  duplicate names, no result, or insufficient permission are not sent.
- Multi-word names are kept; an enumeration comma (`、`), comma or newline clearly separates several people; a
  name must not be split merely by spaces. The Host queries all names, and `needs_clarification.unresolved`
  returns all unresolved items (at most 50); the model asks only about these items and must not claim it sent.
- A normal final reply does not auto-recognize @ text; the model uses the name query only when the user
  explicitly asks.
- Existing permission, cancel, trace, tool result persistence and cross-end projection are kept; candidate
  output is bounded; concrete contract in the root Bot spec's mention-by-name chapter.
- input schema -> executing canonical input identity -> explicit reply port -> authenticated Host -> task
  channel binding / trusted mention resolution -> Bot delivery owner -> typed result. `botGroupSource` only
  expresses the source of a single input and is not a precondition for the call; the Host's unique binding
  decides the group/topic, and the CLI does not select a history message to act as the current authorization.
- Tool trace, cancel, existing permission policy and result budget are kept; it is a network side effect,
  non-read-only, non-destructive. A normal final reply is still sent automatically by the Bot; use it only when
  the user explicitly asks to send/mention, and a normal text cannot be used to recover mention identity.
  Workspace and local/remote identity verification are in the Host, group authorization and delivery
  idempotency in the Bot; no accepted queue is added.

## Script Names a Model for Each Subagent (2026-09-26)

A persona can name which model a subagent runs on: `agent(name, { model: "GLM-5.3-Flash" })`, or first declare
a `ModelRef` with the facade's `model("...")` and pick one at run time (routing). Decision and copy: repo root
`docs/dynamic-workflow/authoring.md` "Choosing a model per subagent", `docs/dynamic-workflow/launch.md`
"Models the script names"; priority in `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`
"Subagent sessions". Chain:

```text
Script agent(..., { model }) / model("x")
  -> compile: 9010 (analysis/actor-models.ts) requires the type of model to be ModelRef / string literal / literal union,
     collects AnalyzeResult.modelReferences; lowering erases model("x") to "x"
  -> resolveInput (CreateWorkflow / AmendWorkflow): handlers/workflow-script-models.ts resolves each name against ModelCatalogPort
     -> input `model_bindings` (name verbatim -> canonical string; AmendWorkflow for the same name keeps the binding of the predecessor snapshot)
  -> prepareApproval: a name without a binding does not open the window; the handler reports 9011 (file line), taking the does-not-compile route
  -> the confirm dialog does not list names (the script's choice is the author model's decision), only changes the start of the model sentence to `子代理默认运行在` ("subagents run by default on");
     the answer content has no model_bindings, and the user cannot change the name bindings in the window
  -> port.submit / amend({ modelBindings: Record<name, ModelSelection> })
  -> run-launched.modelBindings (zero SQL, riding with subagentModel) -> entry / snapshot / detail / GetWorkflowRun <script_models>
  -> create the subagent session: resolveActorPersonaModel(persona.model, bindings) -> actorSelection of workflowActorModelPolicy
     (persona model > run subagentModel > resume pin > parent session model) -> dwf_actor.resolved_model
  -> the actor-created progress payload derives `model`; on a repeated birth fact in ask's node-dispatched the engine carries `actorPersonaModel`
     (the name), the host derives `actorModel` (canonical string) - cold replay from the same source
  -> shared reduction: WorkflowRunActor.model (both birth paths use the same workflowActorEntry, dropped whole beyond 256)
  -> UI: the subagent row in the run detail spine ends with the model name, the tooltip carries the canonical string (WorkflowRunPhaseList / WorkflowRunSpineParts)
```

- Contract: `WorkflowModelBindingsSchema` (contracts/tools/workflow-settings.ts, accepted by the runtime schemas
  of both tools, not listed in the model-facing JSON schema), `DynamicWorkflowRunSubmitRequest/AmendRequest.modelBindings`,
  `DynamicWorkflowRunSnapshot/Detail.modelBindings`, `GetWorkflowRunOutput.modelBindings`. The engine records
  only the name (`PersonaSpec.model`) and never interprets it; the cache identity comparison does not include
  `model` (`personaIdentity` in engine/persona.ts).
- The other two launchers: hub direct launch (`runtime/methods/dynamic-workflow-run-start.ts`, unresolvable is
  `compile_failed`) and GUI `配置` ("Configure") (`dynamic-workflow-run-settings.ts`, keeps the snapshot's bindings,
  unresolvable is `model_unavailable`) share the same module.
- Compatibility: the input channel has no schema, so an old client ignores `model_bindings`; the actor in
  `workflowRuns` gains an optional `model`, a non-strict object, and an old client drops the key. A script
  with `model:` on an old CLI gets TypeScript's own error (the old facade has no such member).

## Typed Holes and `FillWorkflowHole` (2026-09-28)

A script can leave a **typed hole**: ``await hole<Plan>("决定分组", `…${survey.slowest}…`)`` ("decide grouping"). At run
time this branch parks, and the main agent writes a piece of code in the session to fill it (the same call plus
an `async () => {...}` as third argument); that code compiles and runs in the lexical scope **where the hole
sits**. Decision and copy: repo root `docs/dynamic-workflow/authoring.md` "Holes: `hole<T>()`",
`docs/dynamic-workflow/launch.md` "The `FillWorkflowHole` tool",
`docs/dynamic-workflow/transcript-and-notifications.md` (the `hole` notification),
`docs/dynamic-workflow/presentation.md` "Holes on the timeline"; analysis rules in
`packages/dynamic-workflow/docs/analysis.md` "Sites" (Hole sites); engine side in
`packages/dynamic-workflow/docs/execution-engine.md` "Holes". Chain:

```text
Script await hole<T>(name, prompt?)
  -> compile: the site id is keyed on the hole **name** `hole#<8 hex digits>` (FNV-1a, analysis/hole-id.ts; independent of
     nesting depth, two names colliding on the hash report 9012); sites minted inside a hole body get **one** prefix layer
     `<that hole id>/...` (the outer counter cannot see inside the body, a hole left inside a body uses its own name key
     and the nesting is recorded on `fill` of the site table), so filling **changes no existing site id**, and ids do not
     grow with chain depth (reason for the fix: ids used to concatenate layer by layer `hole#1/hole#1/...` and exceeded the
     protocol's 64-character bound after eight or nine steps); 9012 (analysis/hole-sites.ts): explicit type argument, a
     unique literal name (same namespace as phase markers, <= 128), must be awaited, not in an array-method callback, the
     body is an inline function literal and does not reference bindings declared after the hole; the hole itself is a
     phase (id = site id, name = hole name)
  -> lowering: `__host.hole("hole#21b40fca", name, prompt, __src => eval(__src)[, async () => {...}])`;
     `LoweredWorkflow.holeBodies[siteId]` = the lowered text `(async () => {...})` of that hole body in the effective script
  -> cell (runtime child-source): with a body it is called directly, not over the wire; without a body it first checks `__fills`, then sends
     request{type:"hole"} and parks this branch (sibling branches keep running, stall detection does not trigger); the answer {code} is remembered
     and **evaluated directly** at the hole, yielding a closure that is then called - the evaluator is rebuilt on every arrival, so a hole in a loop / helper gets this round's bindings
  -> engine: hole(siteId, name, prompt) mints an ordinal (no node row), stamps the birth phase, records hole-reached, parks by site;
     fillHole{siteId, code, script{text,hash}, askSpecs, sitePhases, phaseNames, holes?}: in one synchronous step swaps the
     spec table / phase table (superset), journal.updateRunScript (script_text and script_hash written together), records hole-filled,
     remembers code, releases all parks of that site; not_waiting / settled are both no-ops
  -> notification: core runtime/methods/dynamic-workflow-run-progress.ts emits a kind:"hole" from hole-reached
     (siteId / ordinal / name / type / prompt / draftPath / line / before / after / reachedAt), the body being a
     `<workflow-hole>` block + the next step (read the draft, write statements only, FillWorkflowHole)
  -> model FillWorkflowHole{run_id, hole_id, script | path}
     handler (core handlers/fill-workflow-hole.ts): skill gate -> exactly one of two -> an inline body first writes the **fill file**
     `<cwd>/.zcode/workflow-drafts/<slug>.<hole-slug>.dwf.ts` (mints -2 / -3; a path submission mints none) ->
     `fill_unchanged` (path bytes equal to the last rejected attempt) -> approval by the same predicate as "a run of this session needs no window"
     (hole.owned_by_this_session is back-filled by the tool, the model cannot claim it) -> port.fillHole
  -> run service (bootstrap dynamic-workflow-run-fill.ts): read the script in the row -> locate the hole via the site table ->
     spliceHoleBody (body as the last argument) -> compileOnce (diagnostics attributed by location: inside the body -> fill file line,
     outside -> draft line) -> checkSiteStability (all old ids present, all new ids prefixed, else fill_ids_unstable, a host fault)
     -> engine fillHole -> the draft is **rewritten in place** to the effective script (scriptPath unchanged; the only exception to "a draft is never overwritten")
  -> tool output = CreateWorkflowOutput (display is the graph of the effective script; the card takes the latest display of this run)
  -> progress payloads: hole-reached (host adds type / reachedAt), hole-filled (phaseNames + aligned holes index table)
     -> shared reduction workflowRuns[].holes / phaseHoles -> UI: hole station (dashed lamp, type badge), waiting (warning ring),
     the head line after filling + hover region, three states of the hole notification row, FillWorkflowHole tool row (the CreateWorkflow renderer picks wording by tool name)
```

- Contract: `contracts/tools/fill-workflow-hole.ts` (`FILL_WORKFLOW_HOLE_TOOL_NAME`, input schema, output reusing
  `CreateWorkflowOutput`), the port's `fillHole?` and `FillWorkflowHoleResult` (`run_not_found` /
  `hole_not_waiting` / `compile_failed` / `fill_ids_unstable`, diagnostics carry `inFill`), the snapshot and
  `GetWorkflowRunOutput.holes?` (<= 32, absent when none, same rule as `pendingQuestions`),
  `workflowNotification` gains `kind:"hole"`, the display gains `holes?` and `fill?` on phases / steps - the
  mirrors in contracts and packages/shared must stay in sync (see the lesson in the GetWorkflowRun entry
  above).
- Engine: `WorkflowHostApi.hole`, events `hole-reached` / `hole-filled`, `run-launched.holes?`,
  `JournalStorePort.updateRunScript` (the SQLite and in-memory implementations are bound by the same journal
  contract, zero SQL migration: both columns already exist). A hole does not write a node row: resume replays
  the effective script, and an already filled hole runs its body directly in the cell without sending a
  request; a run stopped while waiting re-reaches and asks again on resume.
- Permission: the same rule as AmendWorkflow's "a run of this session needs no window"; a run of another
  session or a run the user stopped opens a window, which draws the fill's draft line (new sites in full ink,
  the neighbours on both sides in 40% ghost) and lists the `world.run` commands newly added in the body; a
  body that does not compile opens no window.
- Compatibility: an old client drops the keys `workflowRuns[].holes` / `phaseHoles`; display uses the catch
  fallback of the v4 envelope (earlier clients reject the whole frame, same as the GetWorkflowRun entry). A
  script with `hole()` on an old CLI gets TypeScript's own error.
- Tests: dynamic-workflow `tests/hole-sites.test.ts`, `tests/lowering/holes.ts`, `tests/engine/engine-holes.test.ts`;
  runtime `tests/holes.test.ts`; handler, progress, reduction and timeline-model cases in contracts / core /
  bootstrap / shared / ui. The desktop e2e case is written but not run.

## Skill Tool Raises the Body Cap for `dynamic-workflows` (2026-09-30)

When `Skill` loads `dynamic-workflows` the cap is 200 000 bytes (`WORKFLOW_SKILL_MAX_BYTES`); other skills stay
at 100 000 (`MAX_SKILL_BYTES`), both in `core/src/tool/handlers/skill.ts`. Reason: from 2026-09-22 this skill
sat pinned at 100 000, and every new feature had to first delete existing guidance. Decision and cost: repo
root `docs/dynamic-workflow/authoring.md` "The skill".

- The criterion is the skill name in the request, the same name the skill gate (`workflow-skill-gate.ts` /
  `agent/loaded-skills.ts`) recognizes; a same-named user or project skill shadows the built-in one and also
  gets this cap.
- The cap is chosen per skill in the handler and handed to the adapter for truncation through
  `SkillLoadRequest.maxBytes`; the contract and adapter are unchanged.
- The tool-level `maxOutputBytes` / `resultBudget` are static: take the larger of the two plus the wrapper
  allowance `SKILL_RESULT_WRAPPER_BYTES` (the `<skill_content>` tag and the Base directory line), otherwise a
  body right at the cap would be cut again from the tail by the result budget.
- Tests: core `tests/skill-tool.test.ts`; the byte assertion in bootstrap `tests/dynamic-workflow-skill.test.ts`
  reads the new constant.

## Tool Settlement When Execution Fallback Has No Target (2026-10-09)

When an execution-scoped model such as Highspeed fails after the stream already accepted a complete read-only
tool, tool settlement and the availability of a fallback target are two independent decisions, closed
uniformly along the existing coordinator -> executor -> session store chain:

```text
complete tool_call -> during-stream executor -> provider/network failure
  -> coordinator settlement (completed = real result; safe cancel = cancellation; unknown = synthetic interrupted)
  -> executor persists the terminal ToolPart + live provider history commits the paired call/result
  -> target available: switch model and continue; if a tool result was committed, reset the output-token continuation budget
  -> target unavailable: end with the original provider error, request no model, publish no more tool_abandoned
```

Root cause of the old behavior: the fallback helper returned when no target resolved and the caller skipped
the generic recovery, so only `abandon()` ran (a finished result was lost, the durable part stayed
pending/running, and cold resume fabricated a different interrupted result). Now the single settlement owner
persists before deciding whether to continue the model request. Regression covers completed/running tool
states, exactly one model request without a target, original error propagation, live/cold history
consistency, and the budget reset when a new anchor is established through tool fallback after three output
continuations.

### 2026-10-09 Bot Collaboration Context

The trusted Host's botGroupSource.botIdentity and per-message mentionedBot run through the persisted input and
the model context. The model handles only its own division of work; with no @ and irrelevant it may produce no
tools and no visible reply; a native mention pointing at someone else is blocked from triggering by the Host,
and later history is background only. The shared protocol reuses the strict botGroupInputSourceSchema; no tool
or execution queue is added.

2026-10-09 bot identity regression: Host native source -> botGroupSource persistence -> conversation-quotes
model projection -> ReplyToChannel. A trusted mention gains `isCurrentBot`, derived by comparing
botIdentity.openId, to distinguish same-named bots' division of work; other targets' IDs are not exposed, and
no tool schema, send authorization or CLI admission changes.

Identity positioning addendum: conversation-quotes maps the raw ordered text/mention nodes one by one to the
model-specific material, keeping the difference between same-name typed text and a native mention, without
changing the persisted body or the authorization boundary of send refs.

## LSP Tool and Post-Edit Diagnostics (2026-10-17)

Contract: [19-lsp.md](19-lsp.md). Chain points:

- **Contracts**: `contracts/src/lsp` (strict schema of manifest `lspServers`, `ResolvedLspServer`, preference
  sidecar schema, `FileMutatedEvent`), `interfaces/language-server.port.ts`, `tools/lsp.ts`.
- **Plugin loading**: `adapters/src/plugins` parses `.lsp.json` and manifest `lspServers` and produces
  `PluginLoadOutcome.lspServers`; a single invalid server disables only itself.
- **Adapter**: `adapters/src/lsp` owns process, JSON-RPC framing, capabilities, restart and idle reclaim;
  `acquire` never waits for initialization.
- **Core**: `LspDocumentSync` is the single owner of open documents, versions and diagnostics; Edit/Write only
  publish `FileMutatedEvent` and never call LSP directly. The `LSP` tool is registered only when an available
  server exists (the two registration entries share the gate), and Explore sees it in sync.
- **Context**: new diagnostics after an edit are attached to the next model request through the existing
  `diagnostics` system-reminder source, waiting at most `LSP_EDIT_DIAGNOSTICS_WAIT_MS`, with a timeout clearly
  marked pending.
- **Protocol/UI**: `lsp/preferences/get|set`, `lsp/status`; preferences live in the fork sidecar
  `fork_lsp_preferences.json` and are not written to `setting.json`.

## Incognito `automationTools` gate (specs/incognito-session.md)

- Tools affected: `CronCreate`, `CronList`, `CronUpdate`, `CronDelete`, `OffPeakCreate`, `OffPeakList` and the
  eleven `DYNAMIC_WORKFLOW_TOOL_NAMES` tools (including `ListModels`). Schemas, permissions and execution are
  unchanged; only registration and the Agent/Task workflow guidance follow the gate.
- Registration flow: `runtime-tools.ts` (`includeAutomation`, `includeOffPeak`) and
  `resolveRuntimeDynamicWorkflowToolsIncluded` (`tool-allowlist.ts`) both read
  `resolveRuntimeAutomationToolsIncluded(config)`. The branch-refresh entry point
  (`embedded-search-branch.ts`) uses the same dynamic-workflow helper; it omits
  `includeAutomation`/`includeOffPeak`, so those tools are never added back on refresh.
- Description flow: `registerBuiltInTools` derives `dynamicWorkflowEnabled` for the Agent and Task descriptions
  from `includeDynamicWorkflow`, so the workflow instruction disappears with the tools.
- Inheritance: the gate reads the frozen `config.incognito`; Task-tool children and workflow children receive
  it through the same config paths as the other incognito toggles.
- Test: `core/tests/incognito-prompt-toggles.test.ts` ("automationTools runtime gate").

## Nested AGENTS.md reminders (specs/nested-agents-md.md)

- **Trigger:** after a successful `Read`, `Edit`, `Write`, `ApplyPatch`, `Glob`, `Grep` or `Bash` call (see the
  trigger table in the spec). Discovery walks from the touched path up to, not including, the workspace root
  and never reads outside it.
- **Delivery:** the found files are appended to the same tool result as one `<system-reminder>` block. The
  marker lines come first, so the history parser reads only them and never the AGENTS.md body.
- **Budget:** a per-session context budget (64 KiB) is reserved atomically with the per-file key. A file that
  does not fit is skipped and can be delivered by a later call.
- **Settlement:** reservations are cleared in `settleToolResults`, after the streamed results are committed to
  history. Clearing earlier would let the same file be delivered twice.
- **Dedupe:** a file counts as delivered only when a visible, full `Read` result or a visible reminder marker
  carries it. A `file_unchanged` stub does not count.
- **Known limitation (v1):** a relative `Read` is keyed against the cwd at history-read time, so a later `cd`
  can re-deliver the same file once. See the spec.
- Code: `core/src/context/nested-instructions/`, `core/src/runtime/methods/tool-result-settlement.ts`,
  `core/src/runtime/helpers/nested-instructions-context.ts`.
- Tests: `core/tests/nested-instructions-*.test.ts`, `core/tests/system-reminder-source.test.ts`.

2026-10-09 provider boundary of subagent models: the resolution of `subagent_model` and script `model` names
(core `model-reference.ts`) no longer lets a bare `modelId` land on an entry outside the session provider - a
bare name is looked up only under the current provider, and if it exists only elsewhere it is an
`other_provider` business failure listing the full names; across providers there is only the full-name
spelling, and the skill, the field descriptions of both tools and `docs/dynamic-workflow/launch.md`
"`subagent_model`" all now say: never move a subagent on your own to a model of another provider the user did
not name. Cause: the main agent picked a "lightweight" model itself following the skill example and sent the
subagents to another bill. When the catalog has no `current` entry the old "take the only one, several means
ambiguous" is kept. A full name can still cross providers, so permission adds one more check: the last step of
`AmendWorkflow`'s resolveInput (after the binding table is settled) computes
`predecessor.introduces_providers` - the providers this run will use (normalized `subagent_model` and
`model_bindings`) minus the session model and the providers used on the predecessor's `run-launched`; it is
present only when non-empty; the contract predicate `isAmendWorkflowOwnedPredecessor` sees it and no longer
gives this session's run a no-confirm pass, so the permission service asks as usual (`tool.alwaysAsk`), and a
Deny leaves the predecessor untouched. Switching models within the same provider and inheriting the
predecessor's choice still need no confirmation; the in-place concurrency-only retune and the `not_live`
fallback introduce no model and are unaffected. CreateWorkflow always opens a window and is unchanged. The only
schema addition is this back-fill key (not listed in the model-facing JSON schema; a call carrying
`predecessor` is still rejected in validation as before); events and UI are unchanged, the desktop reads only
`status` / `name` from the predecessor block, and old clients are unaffected by the new key.

## Plugin Usage Attribution

The MCP pluginId of a ToolEntry is captured at execution admission and passed along the tool success/failure
events, V4 tool.lifecycle and the existing agent_step. Skill's original fields stay compatible; ordinary MCP
and unknown attribution are left empty, not parsed from the name and not duplicated onto execution events. Only
optional metadata is added; tool execution, permission, storage and continuous/replayable delivery are
unchanged.

## UI Plugin Background First Creation

After a successful MCP UI tool result is committed through the existing V4 projection, the local desktop host
is notified with `v4/plugin-ui/tool-result`, independent of a conversation subscription or tool card mounting.
It reuses the validated display.ui and projection input; failure, cancel, MCP isError and historical hydration
do not trigger creation. Tool execution, permission, raw result and persistence are unchanged; mobile
replayable does not consume the creation side effect. Tests cover a live result without a subscription,
repeated events, history recovery, background page creation and reuse on return. Host execution/retention
rules: root `docs/plugin-ui-background-execution.md`.

### Document Plugin Multi-Window View Fix (2026-10-16)

The MCP app-only report_view gains an optional viewId and release_view releases the specified window; the
model's get_view takes an optional viewId and, when omitted with several reporting windows, returns the
ambiguity and a list. The state is solely owned by DocumentOwner; a page does not decide other windows' views;
an old client omitting viewId still uses the legacy slot. show_in_viewer keeps its dedicated surface routing
and a clearer tool description. Import stays an app-only workspace side effect; serial admission, 10-minute
inactivity expiry and partial-file sweeping belong to the importer, and completed copies are not cleaned.
Covered: multi-window regression from schema to the real MCP/AppBridge.
