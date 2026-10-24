# Tool Change Chain

## Subagent Context Config Refresh

Settings/disk writes -> Host native watcher -> per-file read and shared pure parsing -> memory snapshot ->
session initialization / same RPC from the parent turn -> definitions -> listing / Agent / SendMessage /
plugin-reference. A config read failure marks the snapshot with the built-in fallback; RPC
disconnection/cancellation still ends the parent turn, preserving input without provider requests. Old
complete snapshots are used during background updates; running children do not refresh, and terminal resume
uses the parent-turn definitions while preserving identity history. Host diagnostics record file updates; the
CLI does not re-parse. The dedicated broadcast is removed; plugin hot updates, independent CLI/remote sources
and continuous/replayable semantics are not expanded. Details: `docs/subagent-runtime-refresh.md`.

Test coverage (SHR08-SHR15) adds tests only, no production code, protocol or dependency change: real Settings
single-field save -> next parent turn spawn/terminal resume -> provider and existing model change persistence;
running SendMessage only delivers and does not refresh children; real Host/CLI stdio test agents cover read
failures and PID/session observation; provider fixtures handle retries and cross-turn windows; Core validates
Guide/Stop through existing loaders, model ports and cancellation signals; child raw model-io is exported per
subagent source and tool history verified per request. Timing control stays on the test side with no
production markers, test RPC or test state branches.

Child cache fix (SHR15): system output is merged into two blocks, CLI prefix and body, each keeping one
marker, leaving room for breakpoints at the end of the conversation. The main CLI prefix is no longer marked
separately; body and TTL are unchanged. Complete history, continuous trajectory and cache breakpoint
regressions are verified (see `docs/subagent-runtime-refresh.md`).

SHR08 cache path: Core tool message `cacheControl` -> Adapter tool-result part `providerOptions` -> AI SDK
merges tool messages -> Anthropic `tool_result.cache_control`. Markers follow the original result block so the
SDK cannot discard the later message's providerOptions during the merge; tool schema, body and state
contracts are unchanged.

## Bash resource telemetry (2026-09-15)

Slow-command resource telemetry: sampled by PGID every 15 seconds after the execution adapter spawn, reported
immediately to Host/main via the independent `process/toolExecResource` when the root exits or stops; frontend
and background share the same sampler, at most 20 samples, and Windows captures only the end context. Tool
schema, permissions, output, timeouts, V4 and continuous/replayable projections are unchanged. Tests cover
PRT-010/011/012, execution adapter exit classification and Bash consistency. See
`docs/monitoring/process-resource-telemetry.md`.

Bash completion resource notifications carry an optional random `completionToken`: the CLI generates it on
the single-command-resource owner, services/Host forward it as is, and main deduplicates through a bounded
recent set before projecting to the ARMS whitelist. The same completion fact is reported once across
connections and window Hosts; different commands' metrics are still reported separately. Identifiers contain
no command, path, or session/task information, do not enter ARMS, logs or any V4 lines; an old CLI missing the
field keeps the original event behavior. Tool output, permissions and execution cadence are unchanged.

## Todo151: Plan Independent State

Enter/ExitPlanMode's Port, return Schema, handler, permission validation, rejection/feedback, existing
reminders and config projections all use the independent `planEnabled`. Runtime permissions do not change
because of Plan entry/approval; yolo cannot bypass planning restrictions or plan approval. Drafts update only
through synchronous updates tied to the current tool change and are not continuously overwritten by general
snapshots. Historical tool results stay readable, model prompt bodies are unchanged, and no new visible
entry/exit events are added. Save and compatibility plan: `docs/plan-mode-independent-state.md`; the Queue
fidelity fix belongs to the same commit chain.

## Bash behavior

- Shutdown: adapter close is the existing asynchronous kill-tree cleanup; an independent Node regression
  covers post-exit descendant cleanup. Normal root exit, tool events and continuous/replayable boundaries are
  unchanged (`docs/bash-background-parity.md`).
- Progress scheduling: one shared interval per Node process / internal polling cycle; tasks independently
  subscribe and tail-read; released when the last subscriber exits. The per-task 5 GiB watchdog stays;
  protocol/display unchanged; tests cover sharing, handoff, concurrent reads and late results; Desktop BG14
  re-verified.
- Desktop display: the Bash terminal state passes bounded headers, truncation flags and retained file paths
  through the strict `bash_output` display; the UI shows partial-output prompts and file entries, and the
  runtime hides line counts/byte counts. Provider content and TUI unchanged
  (`docs/bash-background-parity.md`).

### Bash direct file output

Bash large-output cancellation truncates at 64 MiB of file output; the model receives a header summary and the
full output path. A bounded tail-read produces 5/100-line previews and estimated line counts, entering the
CLI's V4 tool line projection through the optional `outputPreview` contract; terminal/background cleanup
previews and does not reuse the `progress` field reserved for replayable. Tests cover complete files and
progress events. Desktop rendering and BG14 verification stay; TUI unchanged.

See `docs/bash-background-parity.md` for the specific contract of normal Bash output and lifecycle. Output file
flags are chosen by host platform, not by shell dialect.

```text
Bash schema / permission / handler
  -> Execution adapter: prepare commands, async open once
  -> spawn(stdin, fd, fd) -> close parent fd
  -> child process writes directly to canonical output
  -> frontend bounded tail progress / terminal state bounded head result
  -> Background registry / TaskOutput / single completion notification
  -> existing runtime queue / V4 projection
```

Frontend and background use the same file and process; the 5 GiB soft threshold is checked every 5 seconds and
settled when the root process exits. Background descendants may keep writing after the terminal state, so the
terminal state can no longer be described as file stability. The general argv/Hook pipe and hard-truncation
contracts are unchanged. Bash no longer emits per-chunk stdout/stderr events and reuses the progress/result
protocols; desktop continuous and web remote replayable delivery boundaries are unchanged.

## Tool History Declaration Order

The order of tool declarations for the same assistant may differ from the initial write order because of
pre-execution. Existing ToolPart writes carry a runtime-generated optional `declarationIndex`. Fallback and
stream-loss recovery keep creating new parts with the same callID and declaration sequence; model history
hydration selects the last newly created part for each callID within the same assistant, then restores the
calls/results declaration order when the sequence is complete. When the sequence is missing, the original
order of the selected records is kept. Original parts, UI and file read state restoration perform no call
merging or declaration sorting. Model stream callbacks, tool scheduling and write timing are unchanged.

See [Tool History Order Repair Proposal](./tool-history-order-repair-proposal.md) for detailed contracts.

```text
Declare Bash(0) -> Read(1) -> original write Read(1), Bash(0)
                       -> hydration calls/results Bash(0), Read(1)
```

## Read PDF Runtime Dependency Injection

```text
Host creates/injects PdfDocumentPort
  -> AgentRuntimeDeps (main task and subtasks)
  -> createRuntimeToolExecutor
  -> ToolExecutionContext.pdfDocumentPort
  -> Read(pages): renderPages -> image processing -> ordered page images in next model request
  -> Read(no pages): getPageCount -> rejects full read when exceeding 10 pages
```

`PdfDocumentPort` is provided by the host; Core only forwards the existing port, does not create a second PDF
adapter and does not depend on the old model connection ports. The 2026-09-02 merge `bd4dc05bcb` dropped the
adjacent PDF port injection while resolving the `modelConnectionPort` deletion conflict, so tool schemas still
exposed `pages` while page-read returned a missing config and full-read skipped the page check.

The wiring must preserve both the page-read success results and the native read's page protection;
permissions, timeouts, cancellation, tool schemas and error classification are unchanged. Main tasks and
subtasks share this executor assembly boundary; desktop and Web/mobile remote control all use the host's
existing CLI Runtime, without changing the continuous/replayable delivery chain. Cross-platform paths and PDF
external commands are still handled by existing adapters.

`runtime-read-pdf.test.ts` validates main tasks and subtasks through complete Runtime tool loops: page-read
injects adapters and the next model request receives images in page order; without `pages` and exceeding 10
pages returns a tool error without reading PDF binaries. Tests must not construct ToolExecutor directly,
otherwise a dependency missing at Runtime assembly goes unnoticed.

## Topic History Attachment On-Demand Read (Local / stdio / WebSocket access verification in progress)

Reuses the `topic` strategy of `ReadSessionContext`, passing already-archived `messageId` and resource indices
through optional attachment selectors. Model input does not include botId, chatId, workspace, authorization
version or download URLs. The current session must match the tool context; input sources and authorization
versions are parsed from the current task's trusted inbound records.

The tool selector is `attachment: { inputId?, messageId, index? }`; text history indices with inputId can only
parse the corresponding snapshots received by that task. When old calls omit them, the latest trusted input is
used. A model-filled inputId is for selection only and provides no authorization.

The attachment selector is allowed only for `strategy=topic`. When the topic strategy omits sessionId or passes
`current`, the tool context resolves the current task (the current task ID is outside the model context). Other
strategies still require an explicit sessionId and do not allow cross-topic reads. The trusted source
preferentially reads `conversationInputIntent`, compatible with the old `inputIntent`; when the canonical field
exists but is invalid, the old field cannot restore permissions. Only normal user input can provide the source;
when the queued authorization version is missing, attachment reads are refused explicitly. The Host returns the
registered reference with name/MIME/byte count; the Agent validates the actual byte count and writes session
binary artifacts.

```text
ReadSessionContext(topic, attachment reference)
  -> current session + trusted admitted input source
  -> dependency-injected TopicResourcePort
  -> strict Agent/Host reverse request
  -> Host readTopicResource (archive + group/topic/version checks)
  -> existing chunked attachment upload into requesting CLI
  -> CLI session artifact -> binary artifact with target-local path
  -> bounded tool result (name/type/size/reference/path)
```

App/Agent methods and bidirectional parameters use the runtime schema from
`packages/shared/src/zcode-protocol/index.ts`; old Host/standalone CLI capability gaps must fail explicitly
without falling back to arbitrary URL downloads. Host connection boundaries inject workspaceIdentity and
remoteSessionId and do not accept model overrides; remote runtime requests must return through existing
connections to the Host holding bot credentials, not build separate runtimes or read local credentials
remotely.

Routing: each read begins by routing from the same CLI's current trusted entry (when the CLI warms up and then
binds a logical session, a reverse resource request must not permanently capture the first wireClient
parameters and lose remoteSessionId); download, upload and final authorization checks share this snapshot and
do not re-select workspaces or runtimes in async steps.

Attachment bytes reuse existing chunked upload and validation and are not placed in a single reverse response.
The Agent reads full resources from its session artifacts, reuses binary artifact writing and session lifecycle
cleanup, and file extensions must be safely normalized. Cancellation propagates to download/transit/write;
failures provide no partial path. Downloads cannot approve permissions, change strategies or create input
queues. Read-only tool permissions still check the current task/source boundaries; traces, result budgets,
events and V4 projections follow the tool execution chain.

Tests sequentially cover tool schemas, trusted source parsing, Host reverse requests, remote routing, chunk
failures and cancellation, runtime artifact landing, a real model answering from internal file values, and
original topic delivery. Host download unit tests or native API downloads succeeding does not mean this
end-to-end tool chain is complete.

### Real lookup connection close (2026-09-08)

The attachment port must map the Core TraceContext to the strict protocol trace through
`protocolTraceFromTraceContext`, passing only traceId, spanId and parentId (not sessionId, turnId, attributes
and other non-protocol fields; the Host closed the protocol and terminated the CLI when it received the
unmapped context). Task/input identity stays in strict request parameters. Tests must validate complete
read/cancellation frames with the actual `zcodeProtocolMessageSchema`, not merely assert `requestClient` was
called.

When cancellation and disconnection occur simultaneously, requestClient may throw synchronously before
returning the Promise. Cancellation notifications are best-effort; uncaught exceptions must not be thrown from
AbortSignal listeners; the original read still fails as cancelled or disconnected, without re-execution or
reconnection.

## CronDelete Deletion Semantics

CronDelete's scope is limited to the current workspace, and the result must reflect the actual number of
database rows affected.

```text
CronDelete(id)
  -> CLI AutomationPort
  -> automation/delete protocol
  -> Service.delete(id, current workspace)
  -> Repo.delete(id, workspace key)
  -> { deleted: true | false }
  -> Tool result
```

Deleting a non-existent ID, an already-deleted ID, or an ID not belonging to the current workspace must not
return success. The caller must get an explicit not-found result so the model does not repeat the same delete
after a CronList.

## Remote Workspace Cron Tool Strategy

SSH, WSL, Docker and Server workspaces use the `remote:*` workspace identity. These sessions add CronCreate,
CronList, CronUpdate and CronDelete to the session-level denylist at creation or recovery, so remote Agents do
not expose scheduling capabilities that remote scheduling boundaries cannot reliably bear. Local workspaces do
not inherit this restriction.

## Todo103: Off-Peak Tools and Standard Execution Boundaries

```text
Host local capabilities (service assembly + workspace type, no networking) -> Off-Peak policy/creation parameters -> App OffPeakPort -> tool registration
OffPeakCreate actual call -> Host grayscale/package/model validation -> createTask/queue ticket
idle turn attribution -> turn denylist + activeOffPeakTaskId -> reject recursive Create
Current modelExecution + sharedContextRefs -> Core admission -> cleanup turn attribution on completion
```

3.12.2 removes grayscale reading during the registration phase, keeping local support boundaries, call
admission and bound requests; CLI cold recovery/creation uses the current async App factory assembly, without
restoring old workspace catalogs, temporary overlays, turnRuntimeModel or model recovery. Idle execution still
carries a precise ModelSelection/requestAuth without modifying the Session's persistent selection. Exit,
rejection and queueing branches all clean up the current turn's activeOffPeakTaskId; Cron turns may create
idle-time tasks, but OffPeakCreate must not be merged into the Cron write-tool constants.

## Explicit Subagent Model Selection (Todo99)

```text
profile original Selection -> Worker public Selection Facade (same applied account/Registry snapshot)
  -> temporarily valid Selection -> child Runtime -> ModelFactory exact validation -> model request
```

Parsed through host-injected read-only ports; tool parameters, results and profile persistence are unchanged.
No fallback to the parent model when no same model exists; tier failure does not fill defaults. Implicit
inheritance and internal execution overrides are not re-interpreted. Ports forward to the child
Runtime/workflow; an independent terminal CLI without injection keeps the original behavior. Full contract and
validation: `docs/working-memory/provider-refactor/steps/todo-99-worker-account-selection-repair.md`.

## Idle-Turn SendMessage / Workflow Prohibition (D52)

```text
Host idle dispatch -> prompt-turn.ts / server-operations.ts turn denylist (+SendMessage,+Workflow)
  -> turn-loop.ts hides per OFF_PEAK_MUTATION_TOOL_NAMES on each model step
  -> handler send-message.ts / workflow.ts reads context.offPeakTurn -> assertNotOffPeakTurn
  -> recoverable PermissionDenied (prompt using frontend Agent) -> model switches to Agent tool (with subagentModelOverride)
```

Reason: SendMessage continuing a terminal-state sub-agent and Workflow-derived script sub-sessions both rebuild
models outside the idle turn's `modelExecution`, falling back to the parent session's resident selection and
counting toward the user's Coding Plan (ZCT-2099408932463325184). The three denylist constants must have
identical values; the denylist of `isOffPeakCreateRestrictedTurn` recognizes only the OffPeakCreate sentinel.
Tool schemas, permissions and timeouts are unchanged; automation turns and normal turns are unaffected. Tests:
`core/tests/off-peak-tool.test.ts`, `bootstrap/tests/offpeak-prompt-turn-disallowlist.test.ts`,
`bootstrap/tests/v4-native-commands.test.ts`.

#### Entry validation issue found by native verification (2026-09-08)

Both topic original-text lookup and history attachment selection use `conversationInputIntent` as the
authoritative source. `inputIntent` is compatible only when this field is missing; when the authoritative field
exists but has no valid topic record, records from the old field on the same message must not be restored.
When both fields conflict on the same message, only the authoritative record is accepted; the body and
synthetic background still cannot inject source identity.

When a real model explicitly passes `sessionId: current`, the tool executor's JSON Schema validation turns the
union of the regex string and literal into `oneOf`, and the minimal validator does not apply the regex, so both
branches match at once and the call is wrongly rejected. The current topic selector must express
`current | sess_*` as a single string pattern, validated both in the executor input validation and in the
handler runtime parsing; non-topic strategies still require explicit task IDs. Unit tests calling the handler
directly cannot claim that real tool entry points are available.
