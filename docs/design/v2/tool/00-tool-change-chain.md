# Tool Change Chain

## Subagent Context Config Refresh

Settings/disk writes → Host native watcher → per-file read and shared pure parsing → memory snapshot → session initialization / same RPC from parent turn → definitions → listing / Agent / SendMessage / plugin-reference. Config read failure marks the snapshot with built-in fallback; RPC disconnection/cancellation still ends the parent turn, preserving input without provider requests. Old complete snapshots are used during background updates; running children do not refresh, and terminal resume uses parent-turn definitions while preserving identity history. Host diagnostics record file updates; CLI does not re-parse. Dedicated broadcast removed, no expansion of plugin hot updates, independent CLI/remote sources, or continuous/replayable semantics. See `docs/subagent-runtime-refresh.md` for details.

SHR09/SHR10 only supplement tests: real Settings single-field save → next parent turn spawn/terminal resume → provider and existing model change persistence; running SendMessage only delivers, does not refresh children. Timing control stays on the test side, adding no production markers, test RPC, or test state branches.

SHR10 Desktop, SHR11-SHR15 continue to supplement tests only: real Host/CLI stdio test agents are responsible for read failures and PID/session observations; provider fixtures handle retries and cross-turn windows. Core validates Guide/Stop through existing loaders, model ports, and cancellation signals; child raw model-io is exported per subagent source and tool history verified per request. Production source code, protocols, and dependencies unchanged; compare all production source code and dependency file checksums before completion.

The child cache issue discovered by SHR15 has been fixed: system output merged into two blocks — CLI prefix and body — each retaining one marker, leaving room for breakpoints at the end of conversations. Main CLI prefix no longer marked separately; body and TTL unchanged. Complete history, continuous trajectory, and cache breakpoint regressions have been verified, see `docs/subagent-runtime-refresh.md`.

SHR08 cache regression: Core tool message's `cacheControl` → Adapter tool-result part `providerOptions` → AI SDK merges tool messages → Anthropic's corresponding `tool_result.cache_control`. Markers follow the original result block, avoiding SDK discarding subsequent message providerOptions during merge; tool schema, body, and state contracts unchanged.

2026-09-15 Bash slow-command resource telemetry: sampled by PGID every 15 seconds after execution adapter spawn, reported immediately to Host/main via independent `process/toolExecResource` when the root exits or stops; frontend and background share the same sampler, maximum 20 times, Windows only captures end context. Tool schema, permissions, output, timeouts, V4, and continuous/replayable projections unchanged. Tests cover PRT-010/011/012, execution adapter exit classification, and Bash consistency. See `docs/monitoring/process-resource-telemetry.md`.

2026-09-15 review fix: Bash completion resource notification adds optional random `completionToken`; CLI generates on single-command-resource owner, services/Host forwards as-is, main deduplicates via bounded recent set then projects to ARMS whitelist. The same completion fact is reported only once across connections and window Hosts; different command metrics are still reported separately. Identifiers contain no command, path, or session/task information, do not enter ARMS, logs, or any V4 lines; old CLI missing fields retains original event behavior. Tool output, permissions, and execution cadence unchanged.

## Todo151: Plan Independent State

Enter/ExitPlanMode's Port, return Schema, handler, permission validation, rejection/feedback, existing reminders, and config projections all use independent `planEnabled`. Runtime permissions do not change due to Plan entry/approval; yolo cannot bypass planning restrictions or plan approval. Drafts are updated only through synchronous updates associated with the current tool change, not continuously overwritten by general snapshots. Historical tool results remain readable, model prompt bodies unchanged, no new visible entry/exit events added. Save and compatibility plan see `docs/plan-mode-independent-state.md`; Queue fidelity fix belongs to the same commit chain.

2026-09-08 Bash shutdown: adapter close serves as the existing asynchronous kill-tree cleanup, independent Node regression covers post-exit descendant cleanup. Normal root exit, tool events, and continuous/replayable boundaries unchanged, see `docs/bash-background-parity.md`.

2026-09-08 Bash progress scheduling: shared interval per Node process/internal polling cycle, tasks independently subscribed and tail-read; released when the last subscriber exits. Retains per-task 5 GiB watchdog; protocol/display unchanged; tests cover sharing, handoff, concurrent reads, and late results, Desktop BG14 re-verified.

2026-09-08 Desktop: Bash terminal state passes bounded headers, truncation flags, and retained file paths through strict `bash_output` display; the UI shows partial output prompts and file entries, the runtime hides line counts/byte counts. Provider content and TUI unchanged, acceptance see `docs/bash-background-parity.md`.

## Bash Direct File Output

2026-09-07 completion: Bash large output cancellation 64 MiB file truncation, the model receives a header summary and full output path. Bounded tail-read produces 5/100 line previews and estimated line counts, entered into CLI's V4 tool line projection via optional `outputPreview` contract; terminal/background cleanup previews, does not reuse `progress` field exclusive to replayable. Tests cover complete files and progress events. 2026-09-08 retained Desktop rendering and BG14 verification per user's final requirements; TUI unchanged.

See `docs/bash-background-parity.md` for the specific contract of normal Bash output and lifecycle. Output file flags selected by host platform, not by shell dialect.

```text
Bash schema / permission / handler
  -> Execution adapter: prepare commands, async open once
  -> spawn(stdin, fd, fd) -> close parent fd
  -> child process writes directly to canonical output
  -> frontend bounded tail progress / terminal state bounded head result
  -> Background registry / TaskOutput / single completion notification
  -> existing runtime queue / V4 projection
```

Frontend and background use the same file, same process; checks the 5 GiB soft threshold every 5 seconds, settlement when the root process exits. Background descendants may continue writing after the terminal state, so the terminal state can no longer be described as file stability. The general argv/Hook pipe and hard-truncation contracts remain unchanged. Bash no longer emits per-chunk stdout/stderr events, reusing progress/result protocols; desktop continuous and web remote replayable delivery boundaries unchanged.

## Tool History Declaration Order

The order of tool declarations for the same assistant may differ from the initial write order during pre-execution. Existing ToolPart writes carry a runtime-generated optional `declarationIndex`. Fallback and stream-loss recovery continue to create new parts, using the same callID and declaration sequence; model history hydration selects the last newly created part for each callID within the same assistant, then restores calls/results declaration order when the sequence is complete. When the sequence is missing, the original order of the selected record is retained. Original parts, UI, and file read state restoration perform no call merging or declaration sorting. Model stream callbacks, tool scheduling, and write timing remain unchanged.

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

`PdfDocumentPort` is provided by the host; Core only forwards the existing port, does not create a second PDF adapter, and does not depend on old model connection ports. The merge `bd4dc05bcb` of 2026-09-02 omitted the adjacent PDF port injection when handling the deletion of `modelConnectionPort` conflicts, causing tool schemas to still expose `pages`, but page-read returned a missing config, and full-read skipped the page check.

Restoring the wiring must preserve both the page-read success results and the native read's page protection; permissions, timeouts, cancellation, tool schemas, and error classification are unchanged. Main tasks and subtasks share this executor assembly boundary; desktop, Web/mobile remote control all use the host's existing CLI Runtime, without changing the continuous/replayable delivery chain. Cross-platform paths and PDF external commands are still handled by existing adapters.

`runtime-read-pdf.test.ts` validates main tasks and subtasks through complete Runtime tool loops: page-read injects adapters, the next model request receives images arranged by page order; no `pages` and exceeding 10 pages returns a tool error, without reading PDF binaries. Tests cannot simply construct ToolExecutor directly, otherwise the missing dependency during Runtime assembly will not be discovered.

## Topic History Attachment On-Demand Read (Local / stdio / WebSocket access verification in progress)

Reuses `ReadSessionContext`'s `topic` strategy, passing already-archived `messageId` and resource indices through optional attachment selectors. Model input does not include botId, chatId, workspace, authorization version, or download URLs. The current session must be consistent with the tool context; input sources and authorization versions are parsed from the current task's trusted inbound records.

The tool selector is `attachment: { inputId?, messageId, index? }`; text history indices with inputId can only parse corresponding snapshots received by that task. When old calls omit these, the latest trusted input is used. Model-filled inputId is for selection only, providing no authorization.

The attachment selector is only allowed for `strategy=topic`. Real model validation found the current task ID outside the model context; when the topic strategy omits sessionId or passes `current`, the tool context resolves the current task. Other strategies still require explicit sessionId, not allowing cross-topic reads. The trusted source preferentially reads `conversationInputIntent`, compatible with old `inputIntent`; when the canonical field exists but is invalid, old fields cannot be used to restore permissions. Only normal user input can provide the source; when the queued authorization version is missing, refuse attachment reads explicitly. The Host returns the registered reference along with name/MIME/byte count; the Agent validates the actual byte count and writes session binary artifacts.

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

App/Agent methods and bidirectional parameters use the runtime schema from `packages/shared/src/zcode-protocol/index.ts`; old Host/standalone CLI capability gaps must fail explicitly, without falling back to arbitrary URL downloads. Host connection boundaries inject workspaceIdentity and remoteSessionId, not accepting model overrides; remote runtime requests must return through existing connections to the Host holding bot credentials, not build separate runtimes or read local credentials remotely.

stdio's controlled process tests reproduce: when CLI warms up then binds a logical session, the reverse resource request permanently captures the first wireClient parameters, losing remoteSessionId. Each read begins by routing from the same CLI's current trusted entry, downloading, uploading, and final authorization checks all share this snapshot, without re-selecting workspaces or runtimes in async steps.

Attachment bytes reuse existing chunked upload and validation, not placed in a single reverse response. The Agent reads full resources from its session's artifacts, reuses binary artifact writing and session lifecycle cleanup, and file extensions must be safely normalized. Cancellation propagates to download/transit/write; failures do not provide partial paths. Downloads cannot approve permissions, change strategies, or create input queues. Read-only tool permissions still check the current task/source boundaries; traces, result budgets, events, and V4 projections follow the tool execution chain.

Tests sequentially cover tool schemas, trusted source parsing, Host reverse requests, remote routing, chunk failures and cancellation, runtime artifact landing, real model answering based on internal file values, and original topic delivery. Host download unit tests or native API downloads succeeding does not mean this end-to-end tool chain is complete.

### Real Lookup Connection Close (2026-09-08)

13:57 real call had the correct history attachment selected, but the Host immediately closed the protocol and terminated the CLI. The new attachment port places the Core TraceContext into the strict protocol trace as-is, carrying sessionId, turnId, attributes, and other non-protocol fields. Cross-end reverse reads and cancellation must reuse `protocolTraceFromTraceContext` mapping, passing only traceId, spanId, and parentId; task/input identity continues to be placed in strict request parameters. Tests must validate complete read/cancellation frames using actual zcodeProtocolMessageSchema, not merely assert that requestClient was called.

When cancellation and disconnection occur simultaneously, requestClient may throw errors synchronously before returning the Promise. Cancellation notifications are best-effort; uncaught exceptions must not be thrown from AbortSignal listeners; the original read still fails as if cancelled or disconnected, without re-execution or reconnection.

## CronDelete Deletion Semantics

CronDelete's deletion scope must be limited to the current workspace, and the deletion result must reflect the actual number of database rows affected.

```text
CronDelete(id)
  -> CLI AutomationPort
  -> automation/delete protocol
  -> Service.delete(id, current workspace)
  -> Repo.delete(id, workspace key)
  -> { deleted: true | false }
  -> Tool result
```

Deleting a non-existent ID, already-deleted ID, or an ID not belonging to the current workspace must not return success. The caller needs to receive an explicit not-found result, preventing the model from repeatedly retrying the same delete request after a CronList.

## Remote Workspace Cron Tool Strategy

SSH, WSL, Docker, and Server workspaces use `remote:*` workspace identity. These sessions add CronCreate, CronList, CronUpdate, and CronDelete to the session-level denylist at creation or recovery, preventing remote Agents from exposing scheduling capabilities that remote scheduling boundaries cannot reliably bear. Local workspaces do not inherit this restriction.

## Todo103: Off-Peak Tools and Standard Execution Boundaries

```text
Host local capabilities (service assembly + workspace type, no networking) -> Off-Peak policy/creation parameters -> App OffPeakPort -> tool registration
OffPeakCreate actual call -> Host grayscale/package/model validation -> createTask/queue ticket
idle turn attribution -> turn denylist + activeOffPeakTaskId -> reject recursive Create
Current modelExecution + sharedContextRefs -> Core admission -> cleanup turn attribution on completion
```

3.12.2 removes grayscale reading during the registration phase, retaining local support boundaries, call admission, and bound requests; CLI cold recovery/creation uses the current async App factory assembly, without restoring old workspace catalogs, temporary overlays, turnRuntimeModel, or model recovery. Idle execution still carries precise ModelSelection/requestAuth, without modifying Session persistent selections. Exit/rejection/queueing branches all clean up the current turn's activeOffPeakTaskId; allowing Cron turns to create idle-time tasks, but prohibiting merging OffPeakCreate into Cron write tool constants.

## Explicit Subagent Model Selection (Todo99)

```text
profile original Selection -> Worker public Selection Facade (same applied account/Registry snapshot)
  -> temporarily valid Selection -> child Runtime -> ModelFactory exact validation -> model request
```

Parsed through host-injected read-only ports; does not change tool parameters, results, or profile persistence. No fallback to parent model when no same model exists; tier failure does not fill defaults. Implicit inheritance and internal execution overrides are not re-interpreted. Ports forward sub Runtime/workflow; independent terminal CLI without injection retains original behavior. Full contract and validation see `docs/working-memory/provider-refactor/steps/todo-99-worker-account-selection-repair.md`.

## Idle-Turn SendMessage / Workflow Prohibition (D52)

```text
Host idle dispatch -> prompt-turn.ts / server-operations.ts turn denylist (+SendMessage,+Workflow)
  -> turn-loop.ts hides per OFF_PEAK_MUTATION_TOOL_NAMES on each model step
  -> handler send-message.ts / workflow.ts reads context.offPeakTurn -> assertNotOffPeakTurn
  -> recoverable PermissionDenied (prompt using frontend Agent) -> model switches to Agent tool (with subagentModelOverride)
```

Reason: SendMessage continuing the terminal state sub-agent and Workflow-derived script sub-sessions both rebuild models outside idle-turn `modelExecution`, falling back to the parent session's resident selection and counting toward the user's Coding Plan (ZCT-2099408932463325184). The three denylist constants must have identical values; `isOffPeakCreateRestrictedTurn`'s denylist only recognizes the OffPeakCreate sentinel. Tool schemas, permissions, and timeouts unchanged; automation turns and normal turns are unaffected. Tests: `core/tests/off-peak-tool.test.ts`, `bootstrap/tests/offpeak-prompt-turn-disallowlist.test.ts`, `bootstrap/tests/v4-native-commands.test.ts`.

#### 2026-09-08 Entry Validation Issue Discovered by Native Verification

Both topic original text lookup and history attachment selection use `conversationInputIntent` as the authoritative source. Only when this field is missing is `inputIntent` compatible; when the authoritative field exists but has no valid topic record, records from old fields on the same message must not be restored. When both fields conflict on the same message, only the authoritative record is accepted; the body and synthetic background still cannot inject source identity.

When the real model explicitly passes `sessionId: current`, the tool executor's JSON Schema validation converts the union of the regex string and literal into `oneOf`, and the minimum validator does not apply the regex, so both branches match simultaneously, erroneously rejecting the call. The current topic selector should express `current | sess_*` as a single string pattern, validated at both the executor input validation and handler runtime parsing layers; non-topic strategies still require explicit task IDs. Unit tests that call the handler directly cannot claim real tool entry points are available.
