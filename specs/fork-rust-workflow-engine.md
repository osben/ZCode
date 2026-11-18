# Dynamic workflow engine in Rust (F5 design)

Status: design only, no code (2026-11-17). Decision D1 (updated 2026-11-17): workflow runs are not run by the Node helper. Rust ports the workflow engine and runs each actor as its own Rust child session. The helper keeps only stateless compile and format work (see "What stays on the helper").

Related: `specs/fork-rust-node-helper.md` (rules, F2, F5 row, D1), `specs/fork-rust-agent-parity.md` ("Out of scope"), `specs/fork-agent-runtime-selection.md` (one runtime per process), `docs/dynamic-workflow/launch.md`, `docs/dynamic-workflow/concurrency.md`, `docs/dynamic-workflow/transcript-and-notifications.md`, `docs/dynamic-workflow/presentation.md`, `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`, `apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md`.

Paths are relative to the repository root. Node sources are under `apps/zcode-cli/packages/` unless noted. Line numbers were read on `origin/fork` 16e3aceed.

## Problem and scope

Dynamic workflows let the model (or the user) start a script that fans out work to subagent "actors", each a full agent session, and collects results. Node runs all of it. In Rust mode (`ZCODE_FORK_AGENT_RUNTIME=rust`) the ten gated tools and the run controls answer as refused, the rollout policy answers `enabled: false` (`packages/rust-cli/crates/protocol-zcode/src/server.rs:496`), and `v4/conversation/workflowRuns` answers an empty list.

This spec covers the port of execution (F5) to `zcode-rs`. It also covers the parts of saved workflows and run history (F2) that F5 changes. Saved-workflow files and the journal history reads stay where F1+F2 put them, unless section 4 shows they must move.

In scope:

- the ten gated tools (section 2.2) and the run controls `startSavedWorkflow`, `resumeWorkflowRun`, `amendWorkflowRunSettings`, and `cancelBackgroundWork` for a run;
- the engine core, the driver for actors, world reads and artifact publish;
- the journal (`dwf_*` rows) and the `workflowRuns` projection and deltas;
- the rollout gate (`workspace/updateDynamicWorkflowPolicy`).

Out of scope: legacy `Workflow` (`/expert`) tool, `EvalWorkflowSnippet` execution beyond its stateless form, and the Node-only TUI and CLI surfaces.

## Product rules

Rules 1 to 7 of `specs/fork-rust-node-helper.md` still hold. The workflow-specific rules are:

- **W1. Rust owns every run and every actor session.** A run, its engine state, its actors' sessions and their turns are written by `zcode-rs`. The helper never creates, opens, resumes or writes a run or a conversation. This keeps rule 2 of the helper spec intact.
- **W2. Node-format rows.** Rust writes the existing upstream rows (`dwf_run`, `dwf_actor`, `dwf_node`, `dwf_event`, and `session_task_link` role `workflow_actor`) in the exact format Node writes them. Desktop and Node readers see the same data. Section 5 gives the reasons.
- **W3. The script runs as Node does.** The user script is JavaScript evaluated in a `vm` cell inside a Node child process (section 3.1). Rust does not embed a second JavaScript engine. Replay depends on the exact promise ordering of the cell, so a different engine could change which call gets which ordinal.
- **W4. Gate off until the last PR.** Until PR W9 the tools are not registered and the policy answers `enabled: false`. Each intermediate PR keeps the same answer.
- **W5. Failure is explicit.** A run that cannot start (no helper command for compile, no `node` for the child, a journal error) fails the tool call or the run with a stable error. It never half-starts. The Node rule "durability is a prerequisite for a run" (`dynamic-workflow-run-service.ts` invariant 3) applies: no journal, no run.

## 1. Why the split is where it is

Four facts from the Node source fix the seam.

1. **Compile needs TypeScript.** `dynamic-workflow/src/` imports `typescript` in 43 files, mostly `analysis/` (analysis is 14,539 lines of TypeScript). The compile step produces the site table, phases, schema, lowered body, `scriptHash`, model bindings and the `create_workflow` display graph. The run service compiles once (`dynamic-workflow-run-service.ts` invariant 2). Rust cannot compile a TypeScript script without a JavaScript toolchain. So compile stays in Node, behind a stateless helper request.
2. **Script execution is a vm cell.** The lowered body runs in a `vm.createContext` realm inside a child process (`dynamic-workflow-runtime/src/child-source.ts`, `harness.ts`). Its determinism (no clock, no random, a fixed stall rule, FIFO channels) is part of the replay contract. Keep the cell in JavaScript and it stays exactly the same code.
3. **The engine is deterministic and small enough to port.** `dynamic-workflow/src/engine/` is 6,636 lines of TypeScript. The docs say it "performs no I/O, reads no clock, and uses no random numbers" (`engine.ts` header). That property makes a Rust port testable with the same journal goldens.
4. **Actors are conversations.** Each actor is an `AgentRuntime` with a session row (`dwf/<runId>/<site>@<ordinal>` in `session_task_link`, `dynamic-workflow-run-launch.ts:598`). Under W1 they become Rust sessions.

The resulting split (decision D1, option "Rust engine core"):

| Piece                                                                                                                            | Language after the port                  | Owner                           | Source                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Compile, analysis, lowering, schema, display graph, `scriptHash`                                                                 | JavaScript, in the helper                | helper (stateless)              | `dynamic-workflow/src/{compiler,analysis,lowering,schema,facade}` (about 17,300 lines)                                  |
| Sandbox cell and child process                                                                                                   | JavaScript, spawned by Rust              | child process, owned by the run | `dynamic-workflow-runtime/src` (1,648 lines)                                                                            |
| Boundary A host (NDJSON, sites, ordinals, holes, stall reports)                                                                  | Rust                                     | run                             | replaces `harness.ts` host side                                                                                         |
| Engine core (ordinals, FNV-1a input hash, per-actor FIFO and hold rule, cap, settle order, settlement, events)                   | Rust                                     | run                             | `dynamic-workflow/src/engine/` (6,636 lines)                                                                            |
| Boundary B driver (actor sessions, turns, submit/repair/nudge, escalation, permissions, governor, world reads, artifact publish) | Rust                                     | session actor                   | `bootstrap/src/app/workflow-*.ts`, `dynamic-workflow-run-*.ts` (about 14,400 lines together, including the run service) |
| Journal `dwf_*`                                                                                                                  | Rust writes, Node codecs as the contract | session store                   | `adapters/.../repositories/dwf-journal*.ts` (about 1,400 lines)                                                         |
| `workflowRuns` reducer and diff                                                                                                  | Rust, byte-identical                     | session projection              | `packages/shared/src/zcode-protocol-v4/workflow-runs-*.ts`                                                              |
| Tools, window, owner exemption, child denylist                                                                                   | Rust                                     | session                         | `core/src/tool/handlers/*workflow*.ts` (about 6,150 lines)                                                              |

Two alternatives, for the record (open question Q1):

- **Q1-A (recommended, chosen by the user's decision):** Rust engine core and driver, as the table shows. The only JavaScript left in the run is the sandbox cell and the compile helper.
- **Q1-B:** keep the engine core in JavaScript inside the child process, with the journal written through the child. Rust would own only the driver, the tools and the projection. This ships sooner but puts a second writer of `dwf_*` in a non-Rust process, which weakens W1 and the single-writer argument of section 5.

## 2. Inventory of the Node engine

### 2.1 Modules and sizes

Counts are `wc -l` of the listed files on 16e3aceed. "Total" rows are sums.

| Area                     | Files                                                                                                                                        | Lines                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine core              | `dynamic-workflow/src/engine/*.ts`                                                                                                           | 6,636                                                                                                                                          | `engine.ts` 728 (class and lifecycle), `types.ts` 1,154, `scheduler.ts` 573, `imported-cache.ts` 301, `engine-resume.ts`, `engine-settlement.ts`, `engine-holes.ts`, `engine-artifacts.ts`, `engine-world.ts`, `replay-order.ts`, `hash.ts`                                                                     |
| Analysis and compile     | `dynamic-workflow/src/analysis/*.ts`, `compiler/compile.ts`                                                                                  | 14,539                                                                                                                                         | keeps the `typescript` dependency; produces sites, phases, causality, display                                                                                                                                                                                                                                   |
| Lowering, schema, facade | `dynamic-workflow/src/{lowering,schema,facade}/*.ts`                                                                                         | 2,741                                                                                                                                          | lowering of the script body, JSON schema for typed asks, the `dwf` facade types                                                                                                                                                                                                                                 |
| Sandbox                  | `dynamic-workflow-runtime/src/*.ts`                                                                                                          | 1,648                                                                                                                                          | `harness.ts` 644 (host), `child-source.ts` 516 (cell), `child-cell-streams.ts`, `child-entry-file.ts`, `protocol.ts`                                                                                                                                                                                            |
| Host service and launch  | `bootstrap/src/app/dynamic-workflow-run-*.ts`                                                                                                | 6,835                                                                                                                                          | `dynamic-workflow-run-service.ts` 777, `-launch.ts` 678, `-submit.ts` 668, `-observation.ts` 732, `-fill.ts` 344, `-holes.ts` 309, `-introspection.ts` 350, `-journal.ts`, `-artifact-*.ts`, `-retune.ts`, `-replay.ts`, `-roster-*.ts`                                                                         |
| Driver and world         | `bootstrap/src/app/workflow-*.ts`, `script-workflow-*.ts` (outside the `dynamic-workflow-run-*` files above)                                 | about 7,600 (estimate: the 17,290 lines of `bootstrap/src/app/{dynamic-workflow,workflow,script-workflow}*.ts` minus the 6,835 run-file lines) | `workflow-driver.ts` 701, `workflow-driver-*.ts` 2,886 in total, `workflow-world-read.ts` 773, `workflow-artifact-publish.ts` 571, `workflow-concurrency-governor.ts` 513, `workflow-git-world-read.ts` 458, `workflow-facade.ts` 367, `dynamic-workflow-import.ts` 657, `dynamic-workflow-quota-resume.ts` 283 |
| Tools                    | `core/src/tool/handlers/{create,amend,fill,save,list-saved,eval,resolve,resume,list-workflow-runs,get-workflow-run}*.ts`                     | 6,152                                                                                                                                          | model-facing text and input schemas included                                                                                                                                                                                                                                                                    |
| Runtime methods          | `core/src/runtime/methods/dynamic-workflow-run-*.ts`, `background-stop-dynamic-workflow.ts`                                                  | 2,459 (for the `dynamic-workflow-run-*` and background files)                                                                                  | start, settings, progress, hole notice, track                                                                                                                                                                                                                                                                   |
| Contracts                | `contracts/src/interfaces/dynamic-workflow-run.port.ts` 1,288; `contracts/src/tools/*workflow*.ts`; `contracts/src/events/session.events.ts` | about 3,000                                                                                                                                    | port shape, tool inputs, the event payloads                                                                                                                                                                                                                                                                     |
| Journal                  | `adapters/src/storage/session-store/repositories/dwf-journal*.ts`                                                                            | 490 + 455 + 369 + (artifact files)                                                                                                             | Node codecs and the SQL                                                                                                                                                                                                                                                                                         |
| Migration                | `adapters/src/storage/session-store/migrations.ts:831-944`                                                                                   |                                                                                                                                                | `0019_dwf_journal` (four tables), mirrored in `packages/rust-cli/crates/node-store/src/repo/migrations/0019_dwf_journal.sql`                                                                                                                                                                                    |
| Shared state and reducer | `packages/shared/src/zcode-protocol-v4/workflow-runs-*.ts` (repo root)                                                                       |                                                                                                                                                | `workflow-runs-reducer.ts:119` `reduceWorkflowRunsState`, `workflow-runs-delta.ts:146` `diffWorkflowRunsState`, plus about 20 helper files                                                                                                                                                                      |
| Projection               | `bootstrap/src/zcode-protocol-v4/product-projection.ts:5462-5483`                                                                            |                                                                                                                                                | `onDynamicWorkflowRunProgress`                                                                                                                                                                                                                                                                                  |

The Rust port estimate is in section 9. It is an estimate, not a measurement.

### 2.2 The gated tools and the Host methods they reach

`core/src/tool/handlers/index.ts:173-184` defines the set `DYNAMIC_WORKFLOW_TOOL_NAMES`. It has ten entries, and the comment above it still says "Eleven" (stale). `isDynamicWorkflowToolName` (`index.ts:187`) reads the same set for cold-restore activation.

| Tool                      | Gate                     | Permission                                                              | Host method reached                            | Notes                                                        |
| ------------------------- | ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `CreateWorkflow`          | `includeDynamicWorkflow` | `alwaysAsk`, `allowAlways: "session"` (`create-workflow.ts:470,482`)    | `port.submit` (`create-workflow.ts` handler)   | inline, `saved` or `path` source; compiles, shows the window |
| `AmendWorkflow`           | same                     | `alwaysAsk`, `allowAlways: "session"` (`amend-workflow.ts:386-387`)     | `port.amend` / `retuneConcurrency`             | owner exemption for this session's own predecessor (below)   |
| `FillWorkflowHole`        | same                     | `alwaysAsk`, `allowAlways: "session"` (`fill-workflow-hole.ts:342-343`) | `fillHole`                                     | owner exemption for `hole.owned_by_this_session`             |
| `SaveWorkflow`            | same                     | `alwaysAsk`, `allowAlways: false` (`save-workflow.ts:289,292`)          | saved-workflow files (F2 `workflows/save`)     | writes a file, no run                                        |
| `ListSavedWorkflows`      | same                     | none                                                                    | saved-workflow files (F2 `workflows/list`)     | read only                                                    |
| `EvalWorkflowSnippet`     | same                     | none                                                                    | compile only (`eval-workflow-snippet.ts`)      | synchronous, transient                                       |
| `ListWorkflowRuns`        | same                     | none                                                                    | run port `listRuns`                            | read only, main session only                                 |
| `GetWorkflowRun`          | same                     | none                                                                    | run port `getRun`, `GetWorkflowRun` formatting | read only, main session only                                 |
| `ResumeWorkflowRun`       | same                     | alwaysAsk outside yolo (comment `index.ts:146-148`)                     | run service `resume`                           | structurally denied to children                              |
| `ResolveWorkflowQuestion` | same                     | none                                                                    | run port `resolveQuestion`                     | main session only, denied to actors                          |

Adjacent, not in the ten:

- `ListModels` is registered when `includeDynamicWorkflow` is on or a session-control surface is present (`index.ts:329-337`). It is not in the set, because its answers serve `subagent_model` and `CreateSession`, not the run (comment `index.ts:329-332`).
- Actor-only tools `submit_result` (typed ask answer) and `escalate` (`index.ts:120-128`). They are registered in actors only.

Gate resolution. `resolveRuntimeDynamicWorkflowToolsIncluded` (`core/src/runtime/helpers/tool-allowlist.ts:107-120`) is `dynamicWorkflowEnabled !== false && dynamicWorkflowToolsActivated && automationTools included`. `dynamicWorkflowEnabled` and the on-demand mode come from `bootstrap/src/zcode-protocol/dynamic-workflow-policy.ts` (`updateDynamicWorkflowPolicy`, `resolveDynamicWorkflowRuntimeGate`). A record created before a flag change keeps its tools. The Host sends `dynamicWorkflow.mode` through `/client/configs`.

Child denylist. `tool-allowlist.ts:31-64` (`WORKFLOW_CHILD_DISALLOWED_TOOLS`) removes from every workflow child: `CreateWorkflow`, `AmendWorkflow`, `SaveWorkflow`, `ResumeWorkflowRun`, `ResolveWorkflowQuestion`, `FillWorkflowHole`. `tool-allowlist.ts:67` (`RUN_INTROSPECTION_TOOLS`) removes `ListWorkflowRuns` and `GetWorkflowRun` from child runtimes, since a child holds no run port. The bootstrap `ACTOR_DISALLOWED_TOOLS` duplicates the first list on purpose (`tool-allowlist.ts:52-56`). Actors also lose `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` (`launch.md` "Questions", "Permissions inside a run").

Owner exemption. `core/src/permission/service.ts:462-483` (`isOwnedWorkflowAmend`) skips the always-ask branch when the input says the predecessor or hole is owned by this session: `isAmendWorkflowOwnedPredecessor` (`contracts/src/tools/amend-workflow.ts:159`, which also refuses a new provider) and `isFillWorkflowHoleOwnedRun` (`contracts/src/tools/fill-workflow-hole.ts:96`). `CreateWorkflow` has no exemption, so it always asks. `launch.md` "Amending this session's runs" gives the user-facing rule.

### 2.3 Run control entry points

| Entry                                            | Where                                                                                                                                                              | Path                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| GUI start from the hub                           | v4 `startSavedWorkflow` → `create-app.ts:1715` → `startSavedWorkflowRun` (`interaction-background.ts` ~282)                                                        | `launchDynamicWorkflowRun` (`dynamic-workflow-run-launch.ts:171`)                            |
| GUI or model resume                              | v4 `resumeWorkflowRun` (`interaction-background.ts:263`) → `create-app.ts:1691` → run service `resume`                                                             | `dynamic-workflow-run-service.ts`                                                            |
| GUI configure                                    | v4 `amendWorkflowRunSettings` → `create-app.ts:1732` → runtime `amendWorkflowRunSettings` (`core/src/runtime/methods/dynamic-workflow-run-settings.ts`, 395 lines) | in-place retune or amendment, then a settings turn (`dynamic-workflow-run-settings-turn.ts`) |
| Cancel (GUI, `TaskStop`, `cancelBackgroundWork`) | `interaction-background.ts:200` → `core/src/runtime/methods/background-stop-dynamic-workflow.ts`                                                                   | one path for all three; strict for `TaskStop` only (header of that file)                     |
| Quota auto-resume                                | `bootstrap/src/app/dynamic-workflow-quota-resume.ts` (283 lines)                                                                                                   | timer at `resetAt + 1 min` on the parent App                                                 |

Rust today: `crates/protocol-zcode/src/worktree.rs:537-541` lists these four commands in `REQUIRES_RECORD` (a prepared session refuses them, as Node does). Nothing in Rust implements them. `crates/protocol-zcode/src/fork/background_work.rs` implements `cancelBackgroundWork` for kernel tasks (subagents and background commands) only. A run needs a new background kind.

### 2.4 Storage

Four upstream tables, created by `0019_dwf_journal` (`migrations.ts:831-944`). `migrations.ts:833` lists `dwf_artifact` in `touchedTables`, but no DDL creates it. Artifacts are `dwf_node` rows with `kind = 'artifact'` and `dwf_event` rows. The name is a stale entry in a list, and the migration must not change (AGENTS.md "Shared Databases").

| Table       | Key                          | What it holds                                                                                                                                                                                                                                                                           |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dwf_run`   | `id` text                    | run metadata: `parent_session_id`, `cwd`, `name`, `script_text`, `script_hash`, `args_json`, `tool_call_id`, `resumed_from`, `caps_max_concurrency`, `spent_tokens`, `status` (physical `pending`, `running`, `completed`, `failed`, `cancelled`), `result_json`, `failure_json`, times |
| `dwf_actor` | `(run_id, site_id, ordinal)` | `name`, `persona_json`, `resolved_model`, `session_id` (plain text, no FK)                                                                                                                                                                                                              |
| `dwf_node`  | `(run_id, site_id, ordinal)` | `kind` (`ask`, `world-read`, `world-run`, `report`, `artifact`), actor coordinates, `actor_seq`, `input_hash`, `input_json`, `status`, `result_json`, `error_json`, `stats_json`, `message_boundary`, `artifact_id`                                                                     |
| `dwf_event` | `(run_id, sequence)`         | `type`, `payload_json` (the `RunEvent`, verbatim), time; expression index on `artifactId`                                                                                                                                                                                               |

Logical status mapping (`execution-engine.md` "Physical and logical status"): `completed` → `completed`; `errored` → `failed` with a `WorkflowErrorJson`; `stopped {reason}` → `cancelled` with the envelope `{stopReason, error?}`. Decoding is total. The event log is not mapped: old `run-settled` payloads keep their words.

Session side. The actors' transcripts are ordinary `session` rows with a parent. Their task link is `session_task_link` with role `workflow_actor` and `path = dwf/<runId>/<site>@<ordinal>`, `root_workflow_run_id` NULL (the column references the legacy `workflow_run` table, `dynamic-workflow-run-launch.ts:580-600`). The session title is `workflow subagent <ref>` (`:576`).

Progress is memory-only. `bootstrap/src/zcode-protocol-v4/transcript-hydration.ts` lists `DynamicWorkflowRunProgress` in `MEMORY_ONLY_EVENT_TYPES` (line 717). The authority is the `dwf_event` journal, not `session_entry`.

Cascade. `packages/rust-cli/crates/node-store/src/session_tree.rs:195,294` and `session_deletion.rs:216-231` already delete `dwf_run` rows and their children when a parent session is deleted. Rust needs no new deletion rule.

### 2.5 Events and the wire

`RunEvent` kinds (`execution-engine.md` "Events"): `run-started`, `run-launched`, `actor-created`, `node-queued`, `node-dispatched`, `node-repairing`, `node-nudged`, `node-waiting`, `node-executing`, `concurrency-changed`, `run-caps-changed`, `node-settled`, `node-progress`, `usage-updated`, `log`, `import-cache-closed`, `phase-entered`, `report`, `artifact-published`, `artifact-failed`, `hole-reached`, `hole-filled`, `escalation-raised`, `escalation-resolved`, `run-stalled`, `run-settled`. A `compaction` kind exists and is never emitted.

Every event is appended to `dwf_event` first, then handed to `driver.emit`. The run service turns it into a session event `DynamicWorkflowRunProgress` (`contracts/src/events/session.events.ts:161`, payload `:1131`: `runId`, `toolCallId?`, `sequence`, `eventType`, `payload`, `actorSessionId?`, `launchInputId?`). The payload is not persisted in the transcript (section 2.4).

The desktop reads `workflowRuns`, a snapshot key, and two deltas, `workflowRun.updated` and `workflowRun.removed`. The reducer is `reduceWorkflowRunsState` (`workflow-runs-reducer.ts:119`), applied in `onDynamicWorkflowRunProgress` (`product-projection.ts:5462-5483`), and the delta is `diffWorkflowRunsState` (`workflow-runs-delta.ts:146`). The contract is `applyAll(prior, diff(prior, next))` byte-identical to `next`, checked by a property test. Delta ops do not bump the conversation revision (`projection-state.ts` ~264). The gateway reads the snapshot in `v4-gateway.ts:2014`. The TUI mirrors the same reducer (`launch.md` "The inline card").

Notifications. Each `escalation-raised` and each `hole-reached` yields one notification. Each `run-stalled` segment yields one notification. The terminal notification comes from the background tracker's settlement (`core/src/tool/executor/background-tasks.ts`). The payload `workflowNotification` is defined in `packages/shared/src/zcode-protocol-v4/rows.ts` and the model-facing text is a `<task-notification>` block (`transcript-and-notifications.md` "Notifications"). The reminder for an idle main agent is `dynamic-workflow-blocked-reminder.ts`.

### 2.6 Permissions inside a run

A subagent asks as the parent session, with an `origin` of kind `subagent` and description `<name> (<siteId>@<ordinal>)` (`launch.md` "What a subagent's ask looks like"). Full access is never offered. A Guarded dangerous command gets a single-use ask. Other asks offer "Always allow in this session", which covers only the subagent that asked, because each subagent has its own session (session-scoped rules, F3b(a)). A project-level "always allow" covers every later subagent. Denial reaches the subagent as an ordinary tool result. The subagent keeps its seat while waiting, and a permission wait does not count toward the stall notice.

The mode is fixed when the run is created: `subagentPermissionMode` on `run-launched` (`execution-engine.md` "Events"). Resume reads it back.

### 2.7 Engine behaviour that must reproduce exactly

These are the parts a port can get wrong while still passing happy-path tests. Each has a journal-level test in the Node suite (`dynamic-workflow/src/testing/journal-contract-*.ts`, `dynamic-workflow/tests`).

- **Identity.** A facade call's `siteId` plus the next ordinal for that site (arrival counter). An instance is `site × ordinal`. An actor is creation site × ordinal.
- **Input hash.** FNV-1a over canonical JSON. Ask: the instructions only. World read: `{op, args}`. Report: the item only. A mismatch on replay fails the run with `InputHashMismatch`.
- **Replay.** A `completed` or `failed` node row settles from the journal (`node-settled {cached: true}`) with no driver call. A `running` row is redriven.
- **Settle order.** Replay reproduces the order in which instances first settled, from `node-settled`, `artifact-published` and `artifact-failed` events (`execution-engine.md` "Replaying the settle order"). Without it, ordinals drift on resume.
- **Per-actor FIFO and hold rule.** Asks to one actor queue in script order with `actorSeq`. Replayed asks are held in recorded order before live asks.
- **Cap.** `caps.maxConcurrency` bounds live asks across actors. `setMaxConcurrency` retunes in place and writes `run-caps-changed`.
- **Usage.** `spentTokens` is the lineage total; a new run starts from `inheritedTokens`.
- **Settlement.** First wins. `complete` aborts in-flight asks (`Cancelled: Run completed; in-flight subagent tasks were abandoned.`). `fail` rejects them. `stop` takes reasons `user`, `model`, `superseded`, `provider`, `interrupted`. Every path ends in `updateRunStatus`, then `run-settled`, then dispose.
- **Repair and nudge.** A typed `submit_result` that fails validation is repaired in the same turn. A turn that ends without submitting gets one fresh turn with the nudge prompt. The repair budget is finite, then `cancelAsk`.
- **Model failures.** Classified by `resolveWorkflowModelFailurePolicy` (`adapters/src/model/workflow-model-failure-policy.ts`). Permanent errors stop the run as `stopped(provider)`. `context_exceeded` fails only that ask. Others redrive after backoff (2 s doubling to 60 s, jittered, `Retry-After` honoured). The script never sees the transient failure.
- **Governor.** Process-level, one bucket per `providerId/modelId`, shared by all runs and the main agent. Admission per model-request attempt; backoff sleep holds no slot. AIMD controller (`ConcurrencyController`, `dynamic-workflow/src/engine/concurrency.ts:72`; `concurrency.md`).
- **Stall.** The cell reports stalled channels; the driver keeps a run-level stall clock that any successful request resets.
- **Cell rules.** `Math.random`, `Date`-style clocks and similar are banned inside the cell (`child-source.ts` header). The host must not reorder NDJSON lines. A malformed line is `stopped(interrupted)`.

## 3. State owners and event order

Owners used in every diagram:

- **session actor** (Rust, `crates/session`): the parent conversation, its turn queue, its permission chain, its session-scoped grants, and the live run registry. Lifetime bounds the live run (section 3.7).
- **run service** (Rust, new module in `crates/agents` or a new `crates/workflow` crate, see section 5): launch, amend, resume, cancel, settings, the run map. One per session actor.
- **engine** (Rust): ordinals, scheduler, settlement, events. No I/O of its own except through the journal port.
- **sandbox child** (Node process, JavaScript cell): runs the lowered script. Owns no state that outlives a request.
- **helper** (Node, stateless): compile, analysis, display, format. Owns no run.
- **actor child session** (Rust session of kind `Subagent`): one per actor, with its own message history.
- **governor** (Rust, process-level): admits model requests per `provider/model` bucket.
- **journal** (`dwf_*` via the session store): the authority for every run fact.

### 3.1 Launch from a tool call (CreateWorkflow)

```
Model        session actor            helper (Node)       run service/engine (Rust)   sandbox child     journal
  │ tool_use CreateWorkflow{script}
  │──────────►│ schema, validateInput
  │           │ resolveInput (saved/path read: F2 files)
  │           │── compile ─────────►│ compile, analysis,
  │           │                     │ lower, schema, display
  │           │◄── {sites, phases, entrySource, scriptHash,
  │           │     modelBindings, display, diagnostics}
  │           │ diagnostics? ─► tool error, no window
  │           │ permission: alwaysAsk ─► user (window)
  │           │ allow(+adjustments) ─►
  │           │ write draft file (inline) ─► (file)
  │           │ launch(run) ──────────────►│ createRun (run row,
  │           │                            │ scriptText, hash, args, caps)  ──► dwf_run
  │           │                            │ append run-started, run-launched ──► dwf_event
  │           │                            │ write <cwd>/.zcode/workflow-runs/<runId>.mjs (entrySource)
  │           │                            │ spawn execPath (ELECTRON_RUN_AS_NODE=1) ──►│ vm cell starts
  │           │                            │◄── create-actor / request ask ───────────────│
  │           │                            │ putActor, actor session ─► session row + session_task_link ──► dwf_actor
  │ ◄── tool result "backgrounded, file path" (run id, draft path)
  │           │ run-launched turn (control-only, origin workflowLaunch)
```

Notes. The order is the one `launch.md` "From call to run" fixes: everything after step 3 sees one script. The tool result returns when the run is registered, not when it finishes. The engine writes the row before the child starts, so a crash after spawn leaves a `running` row that section 3.6 reconciles.

### 3.2 An actor step (ask)

```
Child cell          harness (Rust Boundary A)    engine (Rust)           driver (Rust)              actor session (Rust)
  │ await ask(site, actor, instr)
  │── request ask ──►│ map local#N → ActorId
  │                  │──► askRequested ─►│ ordinal, inputHash,
  │                  │                    │ FIFO/cap admission,
  │                  │                    │ node row running ──► dwf_node
  │                  │                    │ node-queued ──► dwf_event
  │                  │                    │──► startAsk ──────────►│ governor.acquire (per attempt)
  │                  │                    │                        │── executeTurn(instructions) ──►│ model turn, tools,
  │                  │                    │                        │                                │ permissions (origin subagent)
  │                  │                    │                        │◄── submit_result(value) ───────│
  │                  │                    │◄── askSubmitAttempted ─│ validate: ok → accept
  │                  │                    │ node-settled ok ──► dwf_node, dwf_event
  │◄── response(value)│◄──────────────────│
  │ resolves
```

Repair: a rejected submit answers `{accept:false, violations}` in the same turn; the turn continues. Nudge: a turn that ends with no submit starts one more turn on the same actor session with the nudge prompt. Escalation: `escalate` parks a deferred in the driver, emits `escalation-raised`, and the main agent answers through `resolveWorkflowQuestion`. The tool result is the answer text, and the actor continues in place.

### 3.3 A hole fill

```
Child cell                    engine             run service / tool (Rust)   parent session (user/main agent)
  │ hole(site, name, prompt)  (no body)
  │── request hole ──►│ hole-reached ──► dwf_event, hole notification
  │                   │ parked                   │
  │                   │                          │ FillWorkflowHole{hole, script}
  │                   │                          │ compile (helper) ──► diagnostics → error
  │                   │                          │ permission: alwaysAsk; owner exemption if hole.owned_by_this_session
  │                   │                          │ write draft (fill file), splice effective script
  │                   │◄── fillHole(siteId, code) ──│ hole-filled {scriptPath?} ──► dwf_event
  │◄── response {code}│ release branch
  │ branch continues in the cell (siblings ran meanwhile)
```

The cell evaluates the fill at the site (`execution-engine.md` "Holes are evaluated in the cell"). Rust does not evaluate script code. A later run of the same script reaches the site again and reads the fill from the cell's fill table, which is the same mechanism Node uses.

### 3.4 Amend and in-place retune

```
Tool / settings command      run service (Rust)                       journal
  AmendWorkflow{run_id, script?, caps?, model?}
     │ predecessor: owned? (contracts predicate, permission exemption)
     │ compile new script (helper) ; preflight: import closure from predecessor rows
     │ stop predecessor: stop("superseded", successorId) ─► run-settled ──► dwf_run.status cancelled
     │ create successor run with inheritedTokens, resumedFrom = predecessor
     │ import cache: predecessor ask/world rows with results ─► successor
     │ first workspace write in successor ─► import-cache-closed ──► dwf_event
     │ start successor (3.1 steps after createRun)

  Retune (max_concurrency only, live run)
     │ setMaxConcurrency(n): resolve default if null; floor to int ≥1
     │ write caps ─► dwf_run.caps_max_concurrency; run-caps-changed ──► dwf_event
     │ no successor, no stop
```

Settings from the GUI (`amendWorkflowRunSettings`) uses the same two routes, decided by what changed (`launch.md` "Changing a run's settings from the GUI"). A settings turn is written to the parent as a control-only turn.

### 3.5 Cancel

```
Source (GUI cancelBackgroundWork | TaskStop | Stop button)
   │
   ▼
run service.cancel(runId, initiator)        one path (background-stop-dynamic-workflow.ts)
   │ abort controller of the run: reason = initiator
   ▼
harness observes signal
   │ reason "model" → engine.stop("model")    (TaskStop, strict)
   │ reason "user"  → engine.stop("user")
   │ reason "interrupted" → engine.stop("interrupted", Interrupted failure)  (owner App closed)
   ▼
engine: in-flight asks abort (cancelled node rows), then finishRun:
   updateRunStatus(cancelled, {stopReason}) ─► run-settled ─► dwf_run
   ▼
background tracker: terminal notification (workflowNotification kind terminal)
   ▼
projection: workflowRun.updated / removed deltas
```

Actor pending asks are cancelled with the run (`launch.md`: "Stopping the run cancels its pending asks with it"). Cancel of a run that already settled is a no-op for a lenient caller and `not_running` for strict.

### 3.6 Resume after a restart

```
Process start (desktop or CLI): Rust session open for session S
   │ orphan reconciliation at open (only when no live run for S exists in this process):
   │   dwf_run rows of S with status running ──► updateRunStatus(stopped, interrupted)  ──► dwf_run
   │   (same rule as dynamic-workflow-run-service.ts invariant 4)
   │
User or model: ResumeWorkflowRun{runId}   (or quota timer)
   │ gate (engine/resume): not_found | already_running | not_resumable (completed, errored)
   │                       | script_missing | script_mismatch | compile_failed (helper compile)
   │ read script_text, args, caps (retuned value wins), subagentModel, permission mode from run-launched
   │ engine constructed with the run row (resume branch: counts from rows, budgets from record)
   │ replay: settle-order gate from node-settled events; cached settles from rows
   │ running rows are redriven as new asks (actor sessions reused, message history kept)
   │ run-started (clears stale failure) ─► dwf_event
   │ sandbox child re-spawned with the same entry file (same scriptHash)
   ▼
run continues; workflowRuns snapshot rebuilt by replaying dwf_event (cold replay, reportItems limit 64)
```

Quota auto-resume: a run stopped as `stopped(provider)` with `kind: quota` and `resetAt` arms a timer at `resetAt + 1 min`. The timer rereads the row when it fires. Cold start rescans the session's recent rows. Rust places the timer in the session actor, not in a separate process.

### 3.7 Lifetime of a live run

Node keeps the App resident while a run is live (`execution-engine.md` "Engine ownership": a launch registers its settlement as residency-blocking work). Rust equivalent: the session actor holds a `LiveRunGuard` per live run and is not evicted while one exists. Close of the session stops every live run as `interrupted` and waits for its settlement. This needs a check of the session eviction path in `crates/session` (PR W6).

## 4. What stays on the helper, and why

| Piece                                                                                                  | Stays on helper                          | Why                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compile` (script to sites, phases, `entrySource`, `scriptHash`, model bindings, display, diagnostics) | yes, stateless `helper/workflow/compile` | TypeScript; no conversation; deterministic                                                                                                                      |
| `analysis` for the window graph and `GetWorkflowRun` text formatting                                   | yes, stateless `helper/workflow/format`  | pure functions of journal rows; large model-facing text (`get-workflow-run-format*.ts`, `workflow-observation-display.ts`). Port later if the helper is retired |
| `EvalWorkflowSnippet`                                                                                  | yes, stateless                           | synchronous, transient, no run                                                                                                                                  |
| `SaveWorkflow`, `ListSavedWorkflows`, saved-workflow files                                             | yes, F1+F2 `workflows/*`                 | file I/O already forwarded; no conversation                                                                                                                     |
| `dwf_*` history reads for the desktop (`v4/conversation/workflowRuns`, F2)                             | yes, as today                            | read-only journal consumer; rows are Node-format (section 5)                                                                                                    |
| Engine core, driver, actor sessions, governor, permission prompts, notifications                       | no, Rust                                 | W1, D1                                                                                                                                                          |
| Sandbox cell and its child process                                                                     | a Node process spawned and owned by Rust | W3; the cell is the script's runtime, not an owner                                                                                                              |

Why the helper is not the spawner of the child (open question Q4). Rust owns the run's abort, its lifetime and its settlement. A helper-spawned child would make the helper a second owner of the run and would add a relay for every host call.

### 4.1 As built (W4): helper wire and the NDJSON boundary

Status: built in PR W4 (branch `feat/rust-workflow-sandbox-host`). Gate off: nothing calls these from a turn.

Helper methods (added to `FORK_RUST_HELPER_METHODS`, so `helper/initialize` advertises them; protocol version stays 2 because the additions are advertised, not assumed. Rust forwards them only when both its allowlist and the advertised list name them):

- `helper/workflow/compile` `{scriptText, runId, args?, resumedFrom?}` returns either
  - `{ok: true, scriptHash, compiled, entrySource}`, where `compiled` is `compileProgram` (`bootstrap/src/app/dynamic-workflow-run-compile.ts`) without `lowered` (`askSpecs`, `actorSubmitProfiles`, `sitePhases`, `phases`, `holes`, `holeBodies`, `scriptHash`), and `entrySource` is `renderChildEntry({lowered, args, run: {id, resumedFrom?}}, {runId})`; or
  - `{ok: false, diagnostics, message?}` with `diagnostics` as `CompileDiagnostic[]` (`code, line, column, message`). `message` is set when the compile threw after the diagnostics pass (schema or world-run wiring errors).
  - `scriptHash` is the SHA-256 of the author's text, as Node computes it. Rust never hashes or lowers.
- `helper/workflow/format` `{kind: "analysis", scriptText}` returns `{analysis}`, the JSON of `analyzeWorkflowScript` (window graph, causality, declared artifacts, model references). Other `kind` values are rejected with -32602; the journal-row text formats (`GetWorkflowRun`) come with W7.
- Invalid params are -32602 on both. Neither method reads or writes storage, a session, or the journal.

Rust side (`protocol-zcode/src/fork/workflow_*.rs`):

- The compile client calls `NodeHelper::forward`, so the usual lifecycle, timeout and `nodeHelperUnavailable` answers apply. Both methods are added to `FORWARDED_METHODS`.
- The entry writer writes `<cwd>/.zcode/workflow-runs/<runId>.mjs` with `*` in a `.gitignore` written once. A write failure falls back to `<tmp>/zcode-workflow-runs/`, with a warning. The file name sanitises `runId` as `childEntryFileName` does.
- The child is spawned as `execPath --max-old-space-size=256 <entry>` with `ELECTRON_RUN_AS_NODE=1` added to the helper command's `env`. `execPath` and `env` come from the same `ZCODE_FORK_NODE_HELPER_COMMAND` the helper uses (Q9). The entry file is self-contained, so the bundle path in `args` is not used. Spawning goes through an injected launcher, so `protocol-zcode` spawns nothing itself.

NDJSON boundary (Boundary A, transport only in W4). The message shapes are those of `dynamic-workflow-runtime/src/protocol.ts`.

- Child to host: `create-actor` (no answer; the host records `localId` before any later message is handled), `request` (`ask`, `world-read`, `publish-artifact`, `hole`; answered by a `response` with the same `id`, in any order), `event` (`log`, `report`, `declare-artifact`, `phase-entered`; no answer, handled in line order), `complete` (ends the run's stream).
- Host to child: `{kind: "response", id, ok, value?, error?}`, one line each.
- Lines are handled in arrival order. A line that does not parse, an unknown `kind` or `type` (a `response` from the child included), a request naming a handle the child never created, a reused request `id` or `localId`, and an engine refusal of an actor all end the run as `stopped(interrupted)`. The cause gives the line's position, never its content.
- EOF before `complete` ends the run as `stopped(interrupted)`; the cause is the bounded tail of the child's stderr.
- The host does not interpret asks, world reads, reports or artifacts. W5 to W6 supply the handler for those.

Memory (Q8), measured in W4 on macOS arm64 with Node v26.12.0 and the unmodified `renderChildEntry` output, run as `node --max-old-space-size=256 <entry>` with one ask in flight and no reply: RSS about 56 MB (56,080 KB), steady over 5 s. This is a plain Node process, not the packaged Electron helper, so the packaged child is expected to be larger; it is still one child per live run, and the same child runs under Node today. Not measured: the packaged build, and several concurrent runs.

## 5. Mapping to existing Rust machinery, and what is new

| Need                                | Existing in Rust                                                                                                                                                                                                  | New                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Child session for an actor          | `crates/agents/src/spawn.rs`, `child.rs` (`ChildSink`, `with_origin`), `routes.rs`, `live.rs` (subagent table), `runs.rs` (running runs), session kind `Subagent` with `parent` (`kernel-api/src/store.rs:21-33`) | a persistent actor loop: one session, many turns, driven by the engine. `spawn.rs` runs a child to its end, which is not the same. New: `ActorRuntime` in `crates/agents` (or the new workflow crate) |
| Origin of an actor's permission ask | `ChildSink::with_origin` (`crates/agents/src/child.rs`)                                                                                                                                                           | description `<name> (<site>@<ordinal>)` and the kind `subagent` shape check                                                                                                                           |
| Session-scoped "always allow"       | session actor set (F3b(a), built)                                                                                                                                                                                 | `allowAlways: "session"` on the four tools, `allowAlways: false` on `SaveWorkflow`                                                                                                                    |
| Permission owner exemption          | none                                                                                                                                                                                                              | `isOwnedWorkflowAmend` logic (`service.ts:462-483`) ported with the same predicates                                                                                                                   |
| Submit, repair, nudge, escalate     | `respond.rs` (RespondToCoordinator, F-round parity), `crates/agents/src/messaging.rs`                                                                                                                             | typed `submit_result` validation and budgets (driver), `escalate` (new tool)                                                                                                                          |
| Notices to the parent               | background notices and `shell_notices.rs` (`<task-notification>`), `live.rs` notice mailbox                                                                                                                       | `workflowNotification` payload on the notice, kinds terminal, escalation, hole, stall, reminder                                                                                                       |
| Session input ledger                | `crates/session` `session_input` ledger (`project_rust-session-input-ledger`)                                                                                                                                     | control-only turns `workflow_launch` and `workflowSettingsAmend` admitted through it                                                                                                                  |
| Background task registry            | kernel task table and `fork/background_work.rs` (subagents, commands)                                                                                                                                             | new kind for a run: `cancelBackgroundWork` on a run routes to the run service's `cancel`                                                                                                              |
| Journal writes                      | `crates/node-store` (`repo/`, session tree, deletion)                                                                                                                                                             | `dwf_*` repository with Node codecs and goldens                                                                                                                                                       |
| Projection of `workflowRuns`        | `crates/protocol-zcode` projection (`workflowRuns: []` today, `methods.rs:36`)                                                                                                                                    | reducer and diff port (byte identical), cold replay from `dwf_event`                                                                                                                                  |
| Model admission                     | model crate requests (no process-level governor)                                                                                                                                                                  | process-level governor per `provider/model`, acquire/release per attempt, AIMD controller                                                                                                             |
| Run settings turn                   | session turns                                                                                                                                                                                                     | control-only turn writer                                                                                                                                                                              |
| Sandbox child                       | none                                                                                                                                                                                                              | Rust process spawn with the helper's `execPath` and `ELECTRON_RUN_AS_NODE=1`, NDJSON host (Boundary A)                                                                                                |
| Rollout gate                        | `server.rs:496` answers `enabled: false`                                                                                                                                                                          | record reads `dynamicWorkflowEnabled` and mode; tools registered only when on                                                                                                                         |

### 5.1 Storage: Rust writes Node's `dwf_*` tables in Node's format

Rust writes the upstream tables `dwf_run`, `dwf_actor`, `dwf_node`, `dwf_event`, and the upstream `session_task_link` row with role `workflow_actor`. This is allowed under AGENTS.md "Shared Databases" for these reasons:

1. **No migration change.** `0019_dwf_journal` is already mirrored by `packages/rust-cli/crates/node-store/src/repo/migrations/0019_dwf_journal.sql` and listed at `migrations.rs:55`. Its checksum must stay equal to Node's. PR W2 adds a test that pins the checksum against `migrations.ts:831-944`.
2. **No new column is needed by this design.** Every value the engine persists fits an existing column: `resolved_model`, `message_boundary`, `session_id`, `stats_json`, `caps_max_concurrency`, `spent_tokens`, the failure envelope and the event payload. If PR W2 finds a column that is required, the design changes: it becomes a `fork_` table, not an edit to `0019`.
3. **Same codecs, same values.** Rust writes the physical status and envelope exactly as section 2.4 describes, and the `dwf_event` payload as JSON with the same field names. Readers decode by the same rules, so a row written by Rust is a row Node reads, and the reverse.
4. **Single writer per run.** Only the run's owning runtime writes a run's rows (W1). Node and Rust never write the same run. The runtime is fixed per process (`fork-agent-runtime-selection.md` rule 1), and a run left `running` by a process that is gone is reconciled before anyone writes it (section 3.6).
5. **No fork table in the design.** No `fork_` table is needed for workflows. Any Rust-only state (for example a session-grant set) lives in memory, as Node's does, so it dies with the session like Node's.

Evidence to produce in PR W2 (cross-runtime goldens, both directions):

- Rust writes a run covering every event kind of section 2.5, and Node's `createDwfJournalStore` plus `runJournalStoreContract` read it back (fork Vitest, a fixture written by the Rust test).
- Node writes the same run through its own store, and Rust's reader returns the same `RunRecord`, actors, nodes and events.

### 5.2 Other storage rules

- Session ids for actors: Rust mints its own `sess_…` ids. `dwf_actor.session_id` is plain text, so any id is valid. The desktop reads it through the projection.
- The entry file `<cwd>/.zcode/workflow-runs/<runId>.mjs` and its `.gitignore` are written by Rust, with the Node fallback to `os.tmpdir()` when `cwd` is not writable (`dynamic-workflow-runtime/src/child-entry-file.ts`).
- Draft and fill files use the existing F2 file layout (`launch.md` "The drafts directory").

## 6. Failure modes

| Failure                                | Behaviour                                                                                                                      | Stable code / event                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Helper command absent (CLI, TUI, `-p`) | tools stay unregistered (W4, same as F1–F4 rule 1)                                                                             | none; `proto.forkRustAgent.nodeHelperUnavailable` only for helper-forwarded calls |
| Helper compile unavailable at launch   | the tool call fails; no run row is written                                                                                     | `proto.forkRustAgent.nodeHelperUnavailable`                                       |
| `node` for the child cannot start      | the run is not started; row not written, or written and settled `failed` with `Interrupted` if the row exists                  | run error                                                                         |
| Child crashes mid-run                  | `stopped(interrupted)` with the last stderr as cause (`harness.ts` table)                                                      | `run-settled`                                                                     |
| Journal write fails                    | the run fails closed: no run starts, a running run stops `interrupted`                                                         | run error                                                                         |
| Session evicted while live             | prevented by `LiveRunGuard` (3.7); on forced close, `stopped(interrupted)`                                                     | `run-settled`                                                                     |
| Runtime switch with a live run         | restart is the only switch; the old process's runs become orphans and reconcile on open (3.6). Both runtimes never own one run | `interrupted`                                                                     |
| Two desktop instances on one database  | unsupported, as in Node (`execution-engine.md`, "the unsupported two-instance case")                                           | none                                                                              |

## 7. Acceptance scenarios

Each scenario runs on the Rust runtime in the desktop E2E box and, where the scenario is a parity check, on Node too. A scenario is "done" when its E2E passes on Rust and its journal goldens pass.

1. **Launch from a tool call.** The model calls `CreateWorkflow` with an inline script. The window shows the same graph as Node (golden display from the helper). Allow starts a run; the tool returns the run id and draft path. Test: the E2E `conversation-session-dynamic-workflow-gray-always-on-confirm`, `-compile`, `-save-window`.
2. **Always allow in this session.** A second `CreateWorkflow` in the same session does not prompt; a second session does. Test: `-user-choice`, `-cross-session`.
3. **Actor asks and results.** Actors run, typed answers validate, a rejected submit is repaired in place, a silent turn is nudged. Test: `-run`, `-transcript`, `-run-pane-details`.
4. **Escalation.** An actor escalates; the main agent answers through `ResolveWorkflowQuestion`; the actor continues; a notification appears once. Test: `-questions`, `-notify`.
5. **Hole fill.** A run reaches a hole, the model calls `FillWorkflowHole` (no prompt for its own run), the branch continues. Test: `conversation-session-dynamic-workflow-holes`.
6. **Artifacts.** `artifact.file` and `artifact.markdown` produce user-facing artifacts with the same tiles. Test: `-artifacts`.
7. **Stop.** Stop from the GUI, from `TaskStop`, and from the card cancels the run and its asks; the card shows the stopped state with the right reason. Test: `-stop`.
8. **Restart and resume.** Kill the desktop mid-run; the run is `stopped(interrupted)` on the next open; `ResumeWorkflowRun` replays the settled work from the journal and redrives the rest. Test: `-restart`, `-resume`.
9. **Amend and retune.** Amend a run (superseded, import cache, `import-cache-closed` once), and retune `max_concurrency` on a live run without a new run id. Test: `-amend`, `-overflow`.
10. **Quota.** A run stopped by a quota reset resumes after `resetAt + 1 min`, once. Test: the Node unit test `bootstrap/tests/dynamic-workflow-quota-resume.test.ts` is ported as a Rust unit test; no E2E covers it today, and a scripted-provider E2E is added in PR W6b.
11. **Permissions in a run.** Subagent asks show the origin line; "Always allow" covers only that subagent; Guarded commands offer single-use; YOLO runs do not ask. Test: `-run-permissions`.
12. **Gate.** Disabled: no tools, no hub entry. On demand: tools appear after activation. Test: `-disabled`, `-on-demand`, `-english-dark`.
13. **Hub launch.** Start a saved workflow from the hub; the launch turn is a run card; provenance block shows. Test: `automations/workflows/automations-workflows-hub.test.ts` "direct launch" group, which is F5 (the helper spec says it fails until F5).
14. **Helper unavailable.** Missing compile helper: the tool call fails with the stable code; plain chat is unaffected.
15. **Node parity of goldens.** Rust and Node produce byte-identical `workflowRuns` snapshots and deltas for the same event stream.

### 7.1 E2E inventory (Node specs to reuse)

All 25 specs in `packages/desktop/test/e2e/conversation-session/workflows/` (`*.test.ts`), plus the workflows hub spec. The `manual-review/pending/*.test.mjs` files are not run and are excluded.

| Group                | Specs (suffix after `conversation-session-dynamic-workflow-`)                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate                 | `gray-disabled`, `gray-on-demand`, `gray-always-on`, `gray-always-on-english-dark`                                                                                   |
| Start and confirm    | `gray-always-on-confirm`, `gray-always-on-compile`, `gray-always-on-save-window`, `gray-always-on-user-choice`, `gray-always-on-lookup`, `gray-always-on-snippet`    |
| Observe              | `gray-always-on-transcript`, `gray-always-on-run`, `gray-always-on-run-pane-details`, `gray-always-on-artifacts`, `gray-always-on-notify`, `gray-always-on-overflow` |
| Questions and holes  | `gray-always-on-questions`, `holes` (the spec name is `conversation-session-dynamic-workflow-holes`)                                                                 |
| Control              | `gray-always-on-stop`, `gray-always-on-resume`, `gray-always-on-restart`, `gray-always-on-amend`, `gray-always-on-cross-session`                                     |
| Permissions and save | `gray-always-on-run-permissions`, `gray-always-on-save-from-chat`                                                                                                    |
| Hub                  | `automations/workflows/automations-workflows-hub.test.ts` (groups: saved workflows hub and global hub are F2; direct launch is F5)                                   |

Shared helpers: `packages/desktop/test/e2e/helpers/dynamic-workflow-gray.ts` and `dynamic-workflow-config-mock-server.ts` (the gate and the config server). The Node-side tests `packages/desktop/test/dynamicWorkflowConfigMockServer.test.ts` and `bootstrap/tests/workflow-driver.helpers.ts` show the scripted provider shape.

Classification to do in PR W9 (before the gate flips): each spec is marked "reusable as is" (UI and fake provider only), "reusable with a Rust fixture" (depends on a Node-only trace or journal inspection), or "Node-only" (none expected). The replay traps in the memory notes apply: `reference_desktop-e2e-replay-traps.md` (a pending directory forces capture mode, and the typecheck clobbers `out/host`), `reference_e2e-linux-container-runner.md` (log subdirectories for names with slashes must exist before the run), and the Rust E2E gate notes in `project_wave2-merges-2026-11-12.md`.

## 8. Tests

- **Rust unit tests**, per PR, red first: engine determinism (ordinals, FNV hash, FIFO and hold, settle order, cap changes), replay against recorded journals, settlement paths, permission owner exemption, session grants, child denylist, gate resolution, reducer and diff against the Node fixtures.
- **Journal goldens** (PR W2): Rust-written rows read by Node's `runJournalStoreContract` and Node-written rows read by Rust, in both directions.
- **Reducer goldens** (PR W3): the property test `applyAll(prior, diff(prior, next)) == next` on Rust, plus a fixture set produced by the Node reducer.
- **Fake sandbox tests** (PR W4): the NDJSON host against a scripted child that emits `create-actor`, `request`, `event` and `complete` lines, including a malformed line and an early exit.
- **Fork Vitest** (`scripts/fork-test-files.json`): the helper's `helper/workflow/compile` and `format` return the Node results for the same script (golden display graph).
- **Scripted provider**: the bootstrap fake provider (`bootstrap/tests/helpers/fake-provider-server.ts`) drives actor turns deterministically. Replay traps for the Rust side: the scripted turns must be keyed by actor session, not by global arrival order, because actor ids differ between runtimes.

## 9. PR slicing

Each PR is independently mergeable and keeps the gate off (W4) until PR W9. Sizes are estimates in lines of Rust including tests, not measurements. The TypeScript measures are in section 2.1.

| PR  | Scope                                                                                                                                                                                                                                                                                                          | Size (estimate)    | Gate |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---- |
| W1  | Gate plumbing: record reads `dynamicWorkflowEnabled` and mode (`resolveDynamicWorkflowRuntimeGate` rules); policy answer stays `false` until W9; tool set defined but not registered                                                                                                                           | 300                | off  |
| W2  | `dwf_*` repository in `node-store` with Node codecs; checksum pin for `0019`; cross-runtime goldens both ways; `session_task_link` role writer                                                                                                                                                                 | 1,500              | off  |
| W3  | Reducer and diff port (`workflow-runs-reducer.ts`, `workflow-runs-delta.ts` and the helpers they need) with the property test; cold replay from `dwf_event`; projection hook for `workflowRuns` and the two deltas, returning the empty snapshot as today when no run exists                                   | 1,200              | off  |
| W4  | Helper: `helper/workflow/compile` and `helper/workflow/format` (stateless, JS); Rust: compile client, sandbox spawn (`execPath`, `ELECTRON_RUN_AS_NODE=1`), entry file writer, NDJSON host (Boundary A) with a fake child for tests                                                                            | 1,800 Rust, 400 JS | off  |
| W5a | Engine core, no I/O: identity, hash, scheduler, FIFO and hold, cap and retune, usage, events, settlement; resume replay gate; journal port used through W2                                                                                                                                                     | 4,000              | off  |
| W5b | Engine resume and amend: import cache (`imported-cache.ts`, `dynamic-workflow-import.ts` preflight), `import-cache-closed`, `superseded`                                                                                                                                                                       | 2,000              | off  |
| W5c | Engine holes, artifacts and reports (spec 9.6): `engine-holes.ts`, `engine-artifacts.ts` and `-primary.ts`, `engine-report.ts`, the artifact spec validator and the report tally on resume; `hole-reached`, `hole-filled`, `report`, `artifact-published`, `artifact-failed`                                   | 2,400              | off  |
| W6a | Driver for actors: `ActorRuntime` child session, per-ask turns, `submit_result` validation budgets, repair and nudge, `escalate`, permission origin for subagents, session grants                                                                                                                              | 3,000              | off  |
| W6b | Driver for the rest: governor (process-level, admission per attempt), model failure policy, world reads, artifact publish, stall clock, quota timer, `LiveRunGuard` and session residency                                                                                                                      | 3,000              | off  |
| W7  | The tools: `CreateWorkflow`, `AmendWorkflow`, `FillWorkflowHole`, `SaveWorkflow`, `ListSavedWorkflows`, `EvalWorkflowSnippet`, `ListWorkflowRuns`, `GetWorkflowRun`, `ResumeWorkflowRun`, `ResolveWorkflowQuestion`; window display from helper; owner exemption; child denylist; registration behind the gate | 2,500              | off  |
| W8  | Cancel for runs in the background registry; `cancelBackgroundWork` routing; terminal, escalation, hole and stall notifications with `workflowNotification`; reminder; orphan reconciliation at session open; settings turn writer                                                                              | 1,800              | off  |
| W9  | Hub start (`startSavedWorkflow`), `amendWorkflowRunSettings`, launch turn and provenance; policy answer driven by the gate; E2E classification and enabling (section 7.1); parent doc updates                                                                                                                  | 800 Rust, E2E      | on   |

Total: about 22,000 lines of Rust including tests and about 400 of JavaScript, estimated. Versus Node: the engine core is 6,636 TypeScript lines, the bootstrap workflow and run files about 17,290 (these include some non-engine code), and the tools 6,152. A Rust port of this size usually runs about 1.2 to 1.5 times the TypeScript for the same behaviour, so the estimate is in the expected range; it should be re-checked after W5a.

Order and dependencies: W1 and W2 can run in parallel. W3 needs W2. W4 is independent of W2 and W3. W5a needs W2. W5b needs W5a. W6a needs W5a and W4. W6b needs W6a. W7 needs W6a and W3. W8 needs W7. W9 needs everything.

Each PR updates the F5 row and D1 in `specs/fork-rust-node-helper.md` and the "Out of scope" section of `specs/fork-rust-agent-parity.md` with its status.

### 9.1 As built (W2)

- Code: `packages/rust-cli/crates/node-store/src/repo/dwf/` (`mod.rs` repository, `codecs.rs` Node's physical and logical status codecs, `dwf_tests.rs`, `golden_tests.rs`). The module is `#[allow(dead_code)]` until W5a calls it; nothing is wired, the gate stays off.
- Surface: runs (create, settle, usage, caps, script, non-terminal by parent), actors and nodes (full-row upserts), events (per-run sequence in one statement), and the `session_task_link` `workflow_actor` writer. Reads: the run, actor, node, event lists Node's engine uses. The artifact, introspection and paged reads of `dwf-journal-*.ts` are not ported yet.
- Goldens: `fixtures/dwf/scenario.json` is the shared input (27 event kinds, every status decoding path, a non-terminal run, a workflow actor link). `node-written.sqlite` and `node-expected.json` come from Node: `scripts/rust-cli/dwf-journal-goldens.ts`, run with `pnpm exec tsx`. `rust-written.sqlite` comes from the ignored test `regenerate_rust_written_golden`. Direction 1 is `golden_tests::rust_reads_what_node_wrote`; direction 2 is `apps/zcode-cli/packages/adapters/tests/dwf-rust-goldens.test.ts` (fork Vitest). Timestamps are not compared.
- Pin: `dwf_tests::the_0019_checksum_is_pinned_to_the_upstream_ledger` pins `1c8da556…` (`fork-upstream-migrations.json`); the Node golden checks the ledger value. No migration or DDL changed.

### 9.2 As built (W1)

Gate plumbing only. Nothing runs, nothing is registered, and the policy answer stays `enabled: false` (W4).

- Pure rules: `crates/kernel-api/src/dynamic_workflow.rs`. `DynamicWorkflowMode` (wire values `disabled`, `onDemand`, `alwaysOn`), `DynamicWorkflowPreferences` (the Host's workspace fact), and `resolve_gate`, which follows Node's `resolveDynamicWorkflowRuntimeGate` (`bootstrap/src/zcode-protocol/dynamic-workflow-policy.ts`): the create parameters win, then the cached preference, then closed. A mode is read only when enabled, and it defaults to `alwaysOn`. `onDemand` is the only mode that defers tools. The Node rules are the test table (`dynamic_workflow_tests.rs`).
- Workspace fact: `workspace/updateDynamicWorkflowPolicy` caches `enabled` and `mode` in `Preferences` (`server.rs`). A disabled update clears the mode, as Node does. The reply is still `enabled: false`.
- Record fact: `createSession` reads `dynamicWorkflowEnabled` and `dynamicWorkflowMode` (the fields the Host already sends; the inbound schema accepts them). The direct route records the resolved gate for the new session in `Server::dynamic_workflow_gates`. The record is memory-only and is rebuilt at every create or resume, as Node does: Node writes `runtimeConfig` at createRecord and reads the process preference on cold recovery (`v4-bridge.ts`, `dynamic-workflow-policy.ts`). Nothing reads the gate yet; W7 registers the tools from it.
- Tool names: the ten Node names (section 2.2) are constants in `tool_names.rs` with `DYNAMIC_WORKFLOW_TOOLS`. They are not in any registration list and have no `Tool` implementation. Contracts and implementations are W7.
- Not in W1: the activation route (`preparedSessionId`), the submission reservation, and the worktree activation do not record a gate yet. W7 must read it there before it registers tools. Legacy `session/create` and `session/resume` do not read the fields either.

### 9.3 As built (W5a)

W5a is built in two parts. Part 1 (PR 529, branch `feat/rust-workflow-engine-core`) is the lifecycle and the journal port. Part 2 (PR 531, branch `feat/rust-workflow-engine-scheduler`) is identity, scheduler, replay and usage, and is described after part 1.

#### Part 1: lifecycle and journal port

Status: part 1 is built; gate off, nothing calls it.

Code: `packages/rust-cli/crates/workflow` (package `rust-cli-workflow`).

- `canon.rs`: `canonicalJson` (keys sorted by UTF-16 code units, JS number form via `base::js::json::js_double`) and `fnv1a` (over UTF-16 code units, low byte then high byte). Golden: `fixtures/hash-goldens.json` (28 cases from Node's `hash.ts`, generated by `scripts/rust-cli/workflow-engine-goldens.ts`).
- `error.rs`: the error codes the lifecycle reaches (`DriverError`, `Cancelled`, `ScriptHashMismatch`, `Interrupted`, `ProviderStop`); `toJSON` key order `code`, `message`, `violations`, `finalText`, `mismatch`, `providerStop`, each optional part written only when set. `mismatch` is typed (`expected`, `got`) and set by `with_mismatch`; `ScriptHashMismatch` carries it as Node's `hashMismatch`/resume error does. `violations` and `providerStop` stay JSON values until their owners port the types; `providerStop` is set by `with_provider_stop`.
- `event.rs`: the lifecycle subset of `RunEvent` (`run-started`, `run-launched`, `run-caps-changed`, `usage-updated`, `log`, `run-settled`). `payload_json` is the `JSON.stringify` text, key order included.
- `model.rs`: `RunStatus`, `StopReason`, `Caps`, `Settlement`, `RunRow`, `StoredEvent`. Caps and tokens are `f64`, as JavaScript numbers.
- `journal.rs`: `JournalPort` (run and event methods), a blanket `&mut T` impl, and `MemoryJournal` (the run and event subset of `InMemoryJournalStore`).
- `journal_dwf.rs`: `DwfJournal`, the port over the W2 repository. `rust-cli-node-store` exports `dwf`, `open_session_database`, `StartupError` and `MIGRATION_LOCK_WAIT` for it (re-export lines in `lib.rs`; `dwf` has a boundary comment there). Non-integer caps or tokens are an error, because `dwf_run` stores integers. The accepted range is `[-2^63, 2^63)`, half-open at the top, because `i64::MAX as f64` rounds up to `2^63`.
- `engine.rs`: `WorkflowEngine` lifecycle. Create or resume (`ScriptHashMismatch` before any write); `run-started`, then `run-launched` on create only, then `usage-updated` when the spent tokens are above 0; `log`; `record_usage`; `set_max_concurrency` (floor, minimum 1, no-op when settled or unchanged); `complete`, `stop`, `fail` (first settlement wins; order: journal status, `run-settled`, dispose).
- Failed journal writes (pinned by `engine_tests.rs` with a journal that fails one chosen write once). Node has the same ordering, so the outcome is Node's:
  - Settlement latches before the journal writes: `complete`, `stop` and `fail` set the latch and the settlement value together (`begin_settlement`), then the cancelled `node-settled` events and `finish_run` write. Each settlement step runs even when an earlier write fails, so every in-flight ask still settles; the first error is returned. A failed status write leaves the engine settled, appends no `run-settled`, calls no dispose, and a retry returns `Ok(())` as a no-op. The row keeps its previous status.
  - `record_usage` adds to the spent total before `update_run_usage`. A failed write leaves the total ahead of the row; the next usage write persists the full total.
  - `set_max_concurrency` replaces the caps before `update_run_caps`. A failed write leaves the engine on the new value and the row on the old one. A retry with the same value returns `Ok(false)`, so the row stays stale until the value changes again. This matches Node (`this.caps = caps`, then `updateRunCaps`).
- Goldens: `scripts/rust-cli/workflow-lifecycle-goldens.ts` runs Node's `WorkflowEngine` on `InMemoryJournalStore` for six scenarios (complete with retunes, user stop with inherited usage, errored, interrupted, superseded, resume across three lifetimes including a script-hash mismatch). It writes `fixtures/lifecycle-goldens.json` with the inputs, the step results, the run row after each lifetime, the constructor error, the dispose count, and every event's sequence and payload text. `lifecycle_golden_tests.rs` replays the same inputs on `MemoryJournal` and on `DwfJournal` over an in-memory session database, and compares all of it. Payloads are compared as text, not as values.

Tests: the part 1 counts are in the part 2 test paragraph below (the totals there cover both parts).

Remaining as of part 1 (all four are built in part 2, below; the list is kept as written):

1. Identity: `nextOrdinal` (per-site ordinals, phase counters, `sitePhases` and `currentPhase`, instance birth-phase table) and `stampBirthPhase` (`engine-phase-stamp.ts`, 83 lines).
2. Scheduler: `scheduler.ts` (573), `scheduler-types.ts` (138), `scheduler-submit.ts` (124). Actors and `createActor` (duplicate-name check), `admitAsk` (ordinal, input hash, the miss path with `node-queued`, the `running` row at admission), per-actor FIFO by `actorSeq`, `pumpActor` against the cap, `node-dispatched`, `node-settled` (ok, failed, cancelled), `abortInFlight` at settlement, and submit/turn callbacks (repair, nudge, cancel).
3. Replay: `replay-order.ts` (258, the settle-order gate and hold rule), `engine-resume.ts` (44, restore of counters and recorded ask counts), and the node and actor rows on the port (`put_node`, `get_node`, `put_actor`, `get_actor`, `list_nodes`), which the adapter does not expose yet.
4. Usage from asks: `askStats` with `noteStats`, and the node backfill after settlement.

Not in the W5a row, and needing an owner (owned by W5c, section 9.6): `engine-holes.ts` (226), `engine-artifacts.ts` and `-primary.ts` (527 and 45), `engine-report.ts` (206). `engine-world.ts` (233) and `imported-cache*` belong to W5b. `concurrency.ts` (345, the governor) belongs to W6b.

Deviations and facts found while porting:

- serde_json's default float parser is not correctly rounded: `123456789012345680000` parsed one ulp off and printed differently. The workspace `serde_json` declaration enables `float_roundtrip` (no new crates), and members take it with `.workspace = true`, so every crate parses JSON numbers the same way. The NDJSON host (W4) was outside that graph at first; part 2 enables the feature in `rust-cli-protocol-zcode` too.
- W2's `append_event` writes the payload with serde's `to_string`, not `JSON.stringify`. The two agree on integers, strings and nested objects, but not on exponent-form numbers such as a cap of `1e21`. The adapter re-stringifies on read, so the engine goldens pass, but the raw `payload_json` bytes are not guaranteed to match Node. Fix in W2 by writing `base::js::json::stringify`; not changed here.
- Lone surrogates cannot cross into Rust (serde rejects them, `String` cannot hold them). Node's canonical form of a lone surrogate (`\ud800`) is therefore not reproduced. No golden case uses one.
- The resume `run-started` carries the config's caps, not the stored row's (Node does the same). Reproduced by the golden.
- `ScriptHashMismatch` carries the structured `mismatch` `{expected, got}`, as Node's error does. The lifecycle goldens record the whole constructor error (`toJSON`), so the mismatch is golden-covered.
- `complete(undefined)` in Node leaves `result` absent; Rust takes a `Value`, so it stores `null`. Not reachable from the scenarios; model the absent case when the run service passes one.

Size re-check (`wc -l`): the built Rust is 1,473 lines including tests (canon 117, engine 324, error 108, event 170, journal 160, journal_dwf 188, model 159, lib 16, lifecycle tests 231). The goldens are 583 + 144 lines of JSON and 370 lines of TypeScript generators. The remaining in-scope Node code is about 1,470 TypeScript lines (scheduler, scheduler-types and scheduler-submit 835, replay-order 258, engine-resume 44, engine-phase-stamp 83, the ask and identity paths of `engine.ts` about 250). At the spec's 1.2 to 1.5 ratio that is about 1,800 to 2,200 Rust lines, so W5a's in-scope total comes to about 3,300 to 3,700 Rust lines including tests. That is below the 4,000 estimate. If holes, artifacts and reports are added to W5a (about 960 TypeScript lines, roughly 1,200 Rust), the total reaches about 4,500 to 5,000. Recommendation: give holes, artifacts and reports their own row before W6a.

#### Part 2: identity, scheduler, replay and usage

Status: built on `feat/rust-workflow-engine-scheduler`, on top of part 1. Gate off; nothing calls it. The four remaining items of part 1 (identity, scheduler, replay, usage) are done. The deviations below are the ones that matter for W5b and W6a.

Code, `packages/rust-cli/crates/workflow`:

- `identity.rs`: `nextOrdinal` (per-site counters, `sitePhases` over the current marker), `enterPhase` counts (a separate table), and the birth-phase stamp of the creation events (`engine-phase-stamp.ts`). Node stamps the event at `record`, so the stamp reads the table at emit time as Node does.
- `scheduler.rs`: admission (recorded row or pending miss), per-actor FIFO by `actorSeq`, the replay hold rule, `pumpActor` against the cap, dispatch, `node-queued` and `node-dispatched`, `node-settled` (ok, failed, cancelled), `abortInFlight` in insertion order, and `noteStats` with the backfill of a settled row. `scheduler_submit.rs`: submit repair and validation budgets (`REPAIR_ATTEMPTS` 3), turn nudge and `ResultNotSubmitted`, and the one-time JSON parse of a string submit.
- `replay.rs`: the settle-order gate (hold, pump, batch flush, open), and the cached settlement (`node-settled cached: true` with the repeated facts). `resume.rs`: the settle order from the first `node-settled` per instance, and the recorded ask count per actor.
- `persona.rs`: `normalizePersona` with `budget.webSearch`, in Node's key order.
- `engine.rs`: `create_actor` (duplicate name fails the run), `ask` (tickets), `enter_phase`, `ask_stats`, `set_max_concurrency` (pumps on a raise), `complete`, `stop`, `fail`, `drain`, `take_outcomes`. Journal port: `put_actor`, `get_actor`, `list_actors`, `put_node`, `get_node`, `list_nodes` on `MemoryJournal` and `DwfJournal`.

Node's promises are modelled, not hidden. An ask returns a ticket, and its settlement (resolved, rejected, or abandoned) is an `AskOutcome` in the order the promise would have settled. Work that Node does after an `await` or `queueMicrotask` is a `Job` in a FIFO queue, and the host calls `drain()` after each synchronous slice. A first dispatch of an actor takes two jobs (`SessionReady`, then `Dispatch`), a later one takes one, which matches the two promise hops of `ensureSession`. The hop count is what keeps cross-actor dispatch order equal to Node's; it is pinned by the goldens, not argued from first principles.

Fixes found on the way:

- Review of PR 531: the settlement latch and value are set together, and each settlement step runs after an earlier write fails (part 1 failed-write bullets). Pinned by `engine_tests::a_failed_cancel_write_during_settlement_still_settles_every_ask`.
- Full-row node upserts keep `artifact_id`, `input` and `message_boundary`: the adapter reads the stored row first. Pinned by `journal_dwf::tests::a_full_row_upsert_keeps_the_columns_the_port_does_not_carry`.
- Resume refuses a run with world rows until W5b (`engine_tests::resume_refuses_settled_world_rows_instead_of_holding_the_gate`). Node claims world rows on replay; this port would hold their order slots forever.
- JavaScript whitespace: `describeCause`, `enterPhase` and `instructionsHead` use `rust_cli_base::js::string::trim` (U+FEFF stripped, U+0085 kept). Bounds count UTF-16 units.

- W2 (part 1 item): `dwf` writes now use `JSON.stringify` text. `append_event`, the JSON columns (`encode_json`, `encode_result_json`) and the cancelled failure envelope used serde's `to_string`. Test `the_stored_payload_text_is_javascript_json_text` (1e21 stores as `1e+21`).
- W4 NDJSON host: the spec said `float_roundtrip` was workspace-wide. It was not in the protocol crate's graph, so `123456789012345680000` parsed one ulp off there. `rust-cli-protocol-zcode` now enables `float_roundtrip` on serde_json (feature only, no new crate). Test `a_number_in_a_child_line_is_the_nearest_double`.

Goldens: `scripts/rust-cli/workflow-scheduler-goldens.ts` (a second generator beside the lifecycle one, run on Node's real `WorkflowEngine` with a recording driver) writes `fixtures/scheduler-goldens.json`. Six scenarios: `fifo-retune-repair-resume` (two lifetimes; the resumed one calls asks in a different order from the first lifetime, so the gate has to reorder the cached settlements), `complete-with-asks-in-flight`, `fail-rejects-in-flight`, `stop-user-cancels-asks`, `duplicate-actor-name`, `replay-hash-mismatch`. `scheduler_golden_tests.rs` replays each on `MemoryJournal` and on `DwfJournal` and compares, per lifetime, the step results, the constructor error, and the run, node and actor rows; and for the whole run, the ask outcomes in settlement order, the driver calls in call order, and every event's sequence and exact payload text.

Tests (Linux box, after the PR 531 review round): `cargo test -p rust-cli-workflow` 36 pass (part 2 adds the scheduler goldens on each journal, the settlement, UTF-16 and JS-trim regressions, the world-row refusal, the corrupt-event message and the `journal_dwf` carry-through). `rust-cli-node-store` lib 313 pass, 1 ignored. `rust-cli-protocol-zcode` lib 800 pass. `cargo clippy --workspace --all-targets -- -D warnings` clean. `cargo fmt --all -- --check` clean. The Node goldens regenerate byte-identical (`scripts/rust-cli/workflow-scheduler-goldens.ts`). The root-run CLI integration suites were not run.

Deviations and gaps (open, with the owner):

- Node's `createActorSession` is async. The Rust driver port is synchronous (`create_actor_session` returns the id). The job model keeps the order of a real async driver; the W6a driver must complete the session as a job, not inline. A failed session is modelled (`DriverError`, "Failed to create the subagent session") but not exercised by a golden.
- Journal reads are not filtered: `list_nodes` returns every row (Node reads work rows without results and the artifact rows separately), and `list_events` returns every event and the settle gate filters by type in process (Node filters in the store). Resume reads everything. Fine for the goldens; a long run needs the filters (`kinds`, `withResult`, `types`) before W9. `countNodes` and `sumResultBytes` (the report tally) are not ported; they belong to the report row.
- Not ported, by row: the import cache and `import-cache-closed` (W5b: `tryImportedSettle`, `reconcile`, `carried`, `sourceSessionId` are absent, so the goldens have no import path); holes, artifacts and reports (own row); `askProgress`, `askWaiting`, `askExecuting`, `askMutating`, `concurrencyChanged`, `runStalled`, `stopRun` with `enrichProviderStopPhase` (W6a and W6b; their event kinds are not in `RunEvent` yet); escalation (W6a); the governor (W6b).
- `complete(undefined)` is still stored as `null` (the item from part 1, unchanged).
- Instructions heads: Node's `slice(0, 240)` counts UTF-16 units and can cut a surrogate pair in two, which leaves a lone surrogate. Rust drops the pair, so the head is 239 units when the pair straddles 240. A Rust `String` cannot hold the lone surrogate Node keeps, so the bytes differ in that case. `describeCause` (300 units) has the same deviation. Pinned by `engine_tests::instructions_head_cuts_by_utf16_units` and `describe_cause_bounds_by_utf16_units`. No Node golden covers a straddling pair yet.
- Row comparison in the goldens is canonical JSON (key order not compared); events are compared byte for byte, as the spec requires.
- The generator and the goldens were built on the worktree's Node sources. Those differ from the shared checkout in `index.ts`, `persona.ts` and `types.ts` (the persona budget). The engine files the scheduler uses are identical in both. The lifecycle fixture from part 1 was not regenerated and still matches.

### 9.4 As built (W3)

Spec-first design, then the code. The gate stays off and nothing calls the port.

- Code: `packages/rust-cli/crates/node-store/src/workflow_runs/`. `mod.rs` holds the reducer dispatch, `eviction.rs` the slot admission and groups, `caps.rs` the unlisted counters and buckets, `delta.rs` the diff and apply, `js.rs` the JS-compatible string and number helpers, `replay.rs` the cold replay from `dwf_event`, `projection.rs` the snapshot hook, and `tests.rs`. The module is `#[allow(dead_code)]` until the engine core (W5a) calls it.
- State is an ordered JSON map (`serde_json`, `preserve_order` is already workspace-wide), not typed structs. Node grows entries with `{...run, key: v}`, so the key order of actor and node entries follows arrival order. Typed structs would change that order and break byte-identity. `canonicalWorkflowRun` runs at the same points as in Node, on the run's top level only.
- Goldens: the generator is `packages/shared/src/zcode-protocol-v4/workflow-runs-goldens.ts` (it records Node's `reduceWorkflowRunsState` and `diffWorkflowRunsState`); `scripts/rust-cli/workflow-runs-goldens.ts` writes `packages/rust-cli/crates/node-store/fixtures/workflow-runs/goldens.json`. It lives in the shared package so the drift guard can typecheck. Two scenario sets: default limits, and small injected limits that exercise eviction, unlisted buckets and truncation. The Vitest drift guard regenerates and compares; it is registered in `scripts/fork-test-files.json`.
- Property: `applyAll(prior, diff(prior, next))` serializes byte-identical to `next` for every golden step and for a seeded pseudo-random stream. No new dependency (`proptest` is not in the lock).
- Cold replay: `replay.rs` reads `dwf_event` through W2's `list_events`, mints the envelope fields that `toProgressPayload` derives (`actorSessionId`, `resumedFrom`, `subagentModel`, the persona `model` and `actorModel` through `modelBindings`, `concurrencyCeiling`, `resumable`, `reachedAt`), and applies the `boundDynamicWorkflowRunEventPayload` bounds. Not ported: `holeTypeOf`, which needs the compiled script and so lands with the helper (W4). A replayed `hole-reached` therefore has no `type`.
- Runtime switch: nothing reads the replay yet. The snapshot hook returns `{"runs": []}` when no run exists, the same answer Rust gives today.
- Surrogates: the reducer's own cuts (`slice(0, limit - 1) + "…"`, bounded text fields) round down to a code point boundary, as `truncateSurrogateSafe` does in the contracts bounding. Node can keep a lone surrogate there, and `JSON.stringify` writes it as an escape that Rust cannot hold. This is a deliberate deviation; the golden set avoids the case and a unit test pins the rounding.
- Size and checks: 4,289 lines of Rust in `workflow_runs/` (3,665 excluding `tests.rs`), 14 `workflow_runs` unit tests, 326 passed in the `rust-cli-node-store` lib suite (1 ignored). `clippy --workspace --all-targets -- -D warnings` is clean.

### 9.5 W5b: engine resume and amend (design)

Status: design written before the code (2026-11-17). Gate off; nothing calls it.

Scope of this PR (W5b part 1, branch `feat/rust-workflow-engine-resume`):

- **World path.** `engine-world.ts`: `readWorld` (world-read and world-run) with replay through the settle-order gate, live execution through a driver ticket, and the cached settlement `node-settled {cached: true}`. The W5a refusal of resume with world rows goes away. World reads are not subject to actor FIFO or the cap (Node: "harness I/O").
- **Import cache consumption.** `imported-cache.ts` (`ImportedActorState`, `ImportedWorldQueue`, `matchImportedActor`, `importedAskRecord`) and `imported-cache-types.ts`. The scheduler's `tryImportedSettle` runs at the admission point of a fresh ask (after the miss, before `admitLive`). Recorded asks are reconciled before their release. `cachedAskFacts` carries `sourceSessionId`, read at decision time. `ensureSession` passes the divergence seed to the driver.
- **Closure.** `closeImportCache` with causes `world-run` (before a live world run is dispatched) and `mutating-tool` (`askMutating`, a driver observation). `import-cache-closed` is emitted only for an amended run. Resume rebuilds the closure state from events (`recoverImportClosure`, `engine-world.ts`).
- **Preflight and builder.** `bootstrap/src/app/dynamic-workflow-import.ts` is ported as a pure function over the journal port. The transcript message count it needs (`countSource`) is an injected function, so the Rust side can plug its session store in later. `preflightAmendImport`, `buildImportedCache` and `rebuildImportedCacheForResume` share it.
- **Superseded.** The engine already settles `stopped(superseded, supersededBy)` (W5a lifecycle goldens). The orchestration (stop the predecessor, build the cache, create the successor with `inheritedTokens` and `resumedFrom`) belongs to the run service (W7/W9) and is not part of this row.

Driver-owned fields. `messageBoundary` on an ask row and the transcript count are written by the driver (`workflow-driver-transcript.ts`), not by the engine. The Rust engine exposes `set_message_boundary` as the write point for the host, so goldens can simulate the driver.

Deviations expected: Node's `buildImportedCache` is async only for the transcript count; the Rust port is synchronous with an injected count. Logs of the builder are not ported (no logger port); the reasons are returned as values.

Out of this row: holes, artifacts, reports, the governor, and the transcript store adapter that answers the count.

#### As built (W5b part 1)

Status: built on `feat/rust-workflow-engine-resume` (on top of W5a part 2, PR 531). Gate off; nothing calls the port.

Code, `packages/rust-cli/crates/workflow`:

- `engine_world.rs` (world path): `world_read` (ticket; a completed or failed row replays through the gate with no driver call; a running row runs again; the import queue answers while the cache is open; a live world run closes the cache first), `world_read_settled` (the host's completion, with `world_read_driver_error` for a non-workflow failure), `ask_mutating` (the driver observation), `set_message_boundary` (the driver's write of an ask boundary), `close_import_cache`, `recover_import_closure`, `bound_world_read_input` (Node `boundWorldReadInput`, UTF-16 previews).
- `imported_cache.rs`: the table types, `ImportedActorState` (take, take-if-pure, reconcile, carried, seed, divergence), `ImportedWorldQueue`, `match_imported_actor`, `imported_ask_record`, and the table as JSON (for the goldens).
- `import_build.rs`: `preflight_amend_import`, `build_imported_cache`, `rebuild_imported_cache_for_resume` (the pure builder over the port; the transcript count is injected).
- `scheduler.rs`: `try_imported_settle` at the miss point of admission (after the take decision, before `admit_live`), reconciliation of recorded rows before their release, `sourceSessionId` on the cached facts (read at decision time), `carried` as the prior-transcript flag, and the divergence seed passed to `create_actor_session`.
- `resume.rs`: the W5a world refusal is removed; world rows claim settle-order slots like asks; closure state is rebuilt from events for an amended run.
- `model.rs`, `journal_dwf.rs`: `NodeRow` carries `input` and `messageBoundary`. The DWF write keeps a stored value when the row leaves it out (a settlement upsert never resets them).
- `event.rs`: `node-queued` and `node-dispatched` without an actor (world), `import-cache-closed` (`cause`, optional `actorName`), and `sourceSessionId` on cached facts.
- `engine.rs`: `EngineConfig.imported_cache`; the driver port gains `create_actor_session(…, seed)` and `start_world_read`.

Goldens: `scripts/rust-cli/workflow-import-goldens.ts` runs Node's real `WorkflowEngine` and the real builder (`bootstrap/src/app/dynamic-workflow-import.ts`) over twelve scenarios, each a sequence of runs on one journal: world-row settle order across two lifetimes, a failed world read replayed as failed, a world-row hash mismatch on resume, a world run without a cache (no closure event), prefix hit then a seeded miss, an in-flight continuation, persona mismatch and an anonymous actor, the world queue cursor, a world run closing the cache before a pure entry is refused, a mutating observation closing it for a pure entry that then hits, a two-lifetime resume of an amended run, and the four refusals (`not_amendable`, `missing_boundaries`, `run_not_found`). Fixture: `packages/rust-cli/crates/workflow/fixtures/import-goldens.json`. `import_golden_tests.rs` replays it on `MemoryJournal` and on `DwfJournal`, and compares the build results, step results, constructor errors, run, node and actor rows (row order is not significant), dispose counts, settlements in settlement order, driver calls (session seeds included) and every event's sequence and payload text.

Deviations and facts found while porting:

- Node's `buildImportedCache` is async only for the transcript count. The Rust builder is synchronous and takes the count as a function (`None` from it is an unreadable source, as Node treats it). Node's logger is not ported; the degraded cases are returned as values.
- The generator answers one bootstrap module, `dynamic-workflow-run-observation.ts` (it only supplies `TERMINAL_RUN_STATUSES`, and its own import graph needs `@zcode/*` runtime packages tsx cannot resolve outside the app build), with the same three statuses. The builder itself is Node's file, unmodified.
- Ordinals are one-based per site (`refToString` of the first node of a site is `@1`). Node's submit settles only at the end of the turn, so the scenarios end the turn after each submit.
- A live world read is a ticket finished by `world_read_settled`, the Rust form of Node's `executeWorldRead(...).then`. The driver receives the instance in `start_world_read`.
- `set_message_boundary` is the write point the driver uses (Node writes `messageBoundary` from `workflow-driver-transcript.ts`). The engine never computes it.
- Row order: Node's and Rust's `listNodes` / `listActors` order is not compared (rows are sorted canonically on both sides). Events are compared byte for byte in journal order.
- The W5a refusal test (`resume_refuses_settled_world_rows_instead_of_holding_the_gate`) is removed. Its behaviour is now golden-covered by `resume-world-rows-settle-in-recorded-order` and `world-read-failure-replays-as-failed`.
- Node takes the import queue for a `running` world row too (engine-world.ts reads the queue after the recorded-row block, although its comment says the journal takes precedence). After an interrupted lifetime, a resumed read at a running ordinal can settle from the queue's first entry with a stale result, and overwrite the running row. Golden `amend-world-running-row-versus-the-import-queue` records it. The port matches Node. Whether to diverge is an owner decision (review round of PR 534).
- The goldens were generated before the Rust side was written. The first Rust run failed on row order only, which the harness then normalised. Red was not observed per Rust test; the golden mismatch was the first failing signal.

Not in this row, with the owner:

- The transcript store adapter that answers `countSource` (the production driver, W6a). The builder is ready for it.
- The run service's amend orchestration: stop the predecessor with `superseded` and the successor id, build the cache, create the successor with `inheritedTokens` and `resumedFrom`, and the resume rebuild call (W7/W9). The engine already settles `superseded` (W5a lifecycle goldens).
- The production driver's calls into `ask_mutating` (on a subagent's mutating tool), `set_message_boundary` (after each exchange) and the session seed (W6a).
- Holes, artifacts, reports, `countNodes` / `sumResultBytes`, and the governor (W6b and their own row).

### 9.6 As built (W5c): holes, artifacts and reports

Status: built on `feat/rust-workflow-engine-holes`, stacked on W5b part 1 (#534). Gate off; nothing calls the port. Owner of the rows that section 9.3 left unowned ("Not in the W5a row").

Scope: Node `engine/engine-holes.ts` (226), `engine-artifacts.ts` (527), `engine-artifacts-primary.ts` (45), `engine-report.ts` (206), and `artifact-spec.ts` (176, the declaration path needs it). The events `hole-reached`, `hole-filled`, `report`, `artifact-published` and `artifact-failed`; the replay gate for artifact rows; the resume restore of artifact ids and of the report tally (`countNodes` and `sumResultBytes` are read as a restore over the run's rows). Not in scope: the driver's store call and the fill orchestration of the run service (W6a, W6b, W7), and the tools.

Code, `packages/rust-cli/crates/workflow/src`:

- `engine_holes.rs`: `HoleRegistry` (parked branches and this lifetime's fills, both in Node's Map order), `hole`, `fill_hole`, `open_holes`, `filled_holes`, the rejection on settlement.
- `engine_artifacts.rs`: content publish (`publish_artifact`), its settlement (`artifact_publish_settled`), preset declaration (`declare_artifact`), admission, the primary flag, `restore_artifacts`.
- `engine_report.rs`: `report`, the three report limits, `restore_report_tally`.
- `artifact_spec.rs`: the spec validator. Lengths are UTF-16 units and the messages use JavaScript `String()` and `describe` forms.
- Existing files, additive only: `event.rs` (five variants), `error.rs` (twelve codes), `model.rs` (`NodeRow.artifact_id`, carried through `journal_dwf.rs`), `journal.rs` and `journal_dwf.rs` (`update_run_script`), `replay.rs` (`Release::Held`), `resume.rs` (artifact rows in the gate, artifact events in the settle order, the restores), `engine.rs` (fields, the two driver methods with defaults, the rejection on abort, the release arm), `identity.rs` (`replace_site_phases` and the `hole-reached` birth phase). Each `NodeRow` literal gets `artifact_id: None`.

Driver port: `has_artifact_store()` (default `false`, so a publish fails with `ArtifactStoreUnavailable`) and `start_artifact_publish(instance, request)`. The host answers with `artifact_publish_settled` and then `drain`. The answer is never delivered inline.

Promises: a hole and a publish are tickets in the outcome queue (as asks are). A parked hole is released by `fill_hole` in parked order and rejected by settlement in site order, then parked order, as Node's `rejectAll`.

Clock: the host passes `now` to `hole` and `fill_hole`, the value Node's `EngineConfig.now` would return. The engine reads no clock.

Golden: `scripts/rust-cli/workflow-holes-goldens.ts` runs Node's real engine on five scenarios: `reports-and-presets-resume`, `report-undeclared-and-redeclared`, `declare-redeclared-and-invalid`, `publish-settle-order-and-replay`, `holes-fill-and-stop`. It writes `fixtures/holes-goldens.json`. `holes_golden_tests.rs` replays each on `MemoryJournal` and on `DwfJournal`, and compares the outcomes in settlement order, the driver publish requests, the run, node and actor rows, the open and filled holes per lifetime, and every event's exact payload text.

Deviations and facts found while porting:

- A report item is a `serde_json::Value`, so the JavaScript-only refusals (a cycle, a bigint, `undefined`) cannot reach the engine. The compile-time check and Node's guard stay on the script side.
- `null` as the `opts` argument: Node reads `args[2].primary` and throws a `TypeError` synchronously. The port treats `null` as no options. The facade validates `opts`, so this is not reachable from a script.
- The artifact id is now a `NodeRow` field. The DWF upsert keeps the stored id only when the row has none.
- `artifacts` is a `BTreeMap`, not an insertion-ordered map. Only the declared-id list and the primary lookup iterate it. The list is sorted as Node sorts it, and at most one id is primary, so the order cannot change an outcome.
- A recorded failure that is not a `WorkflowError` JSON is reported as `DriverError` (Node would throw inside `fromJSON`). Rows the engine writes are always readable.
- `ArtifactSourceMissing`, `ArtifactPathOutsideWorkspace` and `ArtifactTooLarge` are in `ErrorCode` so the host's errors round-trip. The engine never creates them.
- A replayed publish computes its settlement from the recorded row when the hold is made, where Node computes it inside the release closure. The row cannot change in between, so the two agree.

Tests (Linux box): `cargo test -p rust-cli-workflow` 42 pass, 0 fail (40 earlier, 2 new: the holes goldens on each journal). `cargo clippy --workspace --all-targets -- -D warnings` clean. `cargo fmt --all -- --check` clean.

Mutation check (each mutation made the goldens fail on both journals, then was reverted): dropping the hole rejection on settlement; letting failed artifact rows stop claiming a gate slot on resume; dropping the birth phase of `hole-reached`.

Red first, honestly: the harness was written before the engine methods. The first build was red (missing trait methods and the test journal's method). The first runtime red was a harness bug (the scenario inputs sit under `input` in the fixture). After that the parity checks passed on the first run.

Not covered yet (open, with the owner):

- The per-item, item-count and run-byte report caps and the artifact version cap have no golden, and no Rust unit test. Node's tests cover them (`journal-contract-*`, `dynamic-workflow/tests`).
- The fill's ask spec table is always empty in the goldens, so a fill that adds ask sites is not pinned yet (W7 with the run service).
- Driver: the store call and the publish's settlement come from the W6b driver. The hole-fill orchestration (compile, permission, draft write) is the run service (W7/W8).
- The notifications and the snapshot projection of open holes are W8.

### 9.7 W6a: the actor driver (design, then as built)

Status: part 1 built on `feat/rust-workflow-actor-driver`, stacked on W5c (#535, which is on #534). Gate off; nothing calls it. Part 2 (the runtime that runs turns) is open, listed below.

Design. Owners, one per kind of state:

- **engine** (Rust, `crates/workflow`): the single writer of the journal and of every ask, node and settlement. It stays synchronous and reads no clock.
- **driver owner** (Rust, one task per run, the run service's side of the port): holds the per-session driver state (current instance, typed flag, submit profile, the pending submit verdict, the escalation book). It is the only caller of the engine. Actor turns never call the engine directly.
- **actor turn** (async, one per ask attempt): runs a turn on the actor's child session. It sends messages to the driver owner and waits for a oneshot reply. A `submit_result` or `escalate` tool call blocks on its reply, which becomes the tool result.
- **actor child session** (Rust session of kind `Subagent` with a parent): its transcript, tools, and permission ask. Its id is `sess_dwf-<san(runId)>-<san(site@ordinal)>`, minted by `mint_actor_session_id` in node-store, the same function the replay envelope uses (one implementation, per Node's `mintActorSessionId`).
- **session task link** (`workflow_actor` role, W2 writer): links the child to the run by `dwf/<runId>/<site@ordinal>`.

Event order for one typed ask (the W6a target; the ticket and oneshot rules are as in section 3.2):

```
actor turn            driver owner (engine + journal)            engine
  │ submit_result(v) ─SubmitAttempted{instance,v,reply}─►│ submit_route: no ask → reject; untyped → reject
  │                                                      │ Engine route: engine.submit_attempted ──────►│ validate
  │                                                      │◄─ verdict (accept | reject+violations) ──────│ settle or repair
  │◄── reply (oneshot) = tool result ────────────────────│
  │ turn ends without submit ─TurnEnded{instance,text}──►│ engine.turn_ended ─────────────────────────►│ nudge or settle
  │                                                      │ Nudge: fresh turn, NUDGE_PROMPT, boundary 0
  │ escalate(q) ─Escalate{session,req,reply}──────────►│ book.escalate: refuse, or park + write escalation-raised
  │  (blocks)                                            │ … main agent answers: book.answer → escalation-resolved
  │◄── reply (oneshot) = answer as the tool result ─────│
```

Rules that follow from the owners:

- A submit with no ask in flight, or on an untyped ask, is refused at the port. The engine is not told, because an untyped ask would never settle its deferred (Node's submit bridge).
- Session creation completes as a job, not inline (section 9.3, deviation 1).
- The escalation book, not the engine, owns parked questions. The raise is written before the question counts as parked. A failed raise write revokes the park and returns the error. A failed resolved write is a warning, and the answer is still delivered (Node's asymmetry, `workflow-driver-escalation.ts`).
- `askedAt` is read once by the driver and shared between the event and the parked record. The engine and the book read no clock.

As built (part 1: the rules, with goldens; no turn runtime):

- `crates/workflow/src/driver_rules.rs`: `NUDGE_PROMPT`, `TYPED_TOOL_EPILOGUE`, `schema_epilogue` with `json_pretty` (a JavaScript-faithful `JSON.stringify(v, null, 2)`: two spaces, `[]` and `{}` for empty containers, insertion order, JavaScript number form), `question_id_fragments`, `normalize_escalation_context` (JavaScript `trim`), `effective_actor_name`, `subagent_label`, `reject_with`, `submit_route` (the port's refusals, with `NO_ACTIVE_ASK_MESSAGE` and `UNTYPED_ASK_MESSAGE`), `profile_fit` (generic, mono with canonical compare, untyped with the `DriverError` text), the recorded permission mode (`subagent_permission_mode_of` with `plan` as `build`, `parse_subagent_permission_mode`, `actor_permission_policy` defaulting to YOLO), `actor_interaction_description` (`<name ?? "subagent"> (<site>@<ordinal>)`), `actor_session_title`, `actor_task_link_path`, and `WORKFLOW_ACTOR_LINK_ROLE`.
- `crates/workflow/src/escalation.rs`: the `EscalationBook`. Per session: the active-ask flag, the per-ask budget (`MAX_ESCALATIONS_PER_ASK` 3, reset by `start_ask`), and the parked ids in raise order. Per run: the id registry and the sequence. `escalate` refuses with `no_active_ask` or `budget_exhausted` (ordinary results, nothing parked, no event). `answer` retires the id and writes `escalation-resolved`. `end_ask` and `start_ask` withdraw the parked questions. `mint_question_id` tries the fragments in order and fails when none is free.
- `RunEvent::EscalationRaised` and `RunEvent::EscalationResolved` (additive; `event.rs`), with Node's key order: `type, qid, actor, actorName?, question, context?, askedAt` and `type, qid, answer`.
- node-store: `mint_actor_session_id` and `sanitize_id_segment` are re-exported from the replay module (`crates/node-store/src/lib.rs`). The sanitiser now maps UTF-16 code units, as Node's `replace` does. Before this, an astral character in a run id gave one underscore instead of two, so the replay's session id differed from the id the driver would mint. Fixed in `workflow_runs/replay.rs`; pinned by `workflow_runs::tests::an_astral_character_in_a_run_id_maps_to_two_underscores_as_node_does`.

Goldens and tests:

- `scripts/rust-cli/workflow-driver-goldens.ts` calls Node's own `workflow-driver-helpers.ts` and `workflow-actor-permission.ts` and writes `crates/workflow/fixtures/driver-goldens.json`. The generator needs `TSX_TSCONFIG_PATH=scripts/rust-cli/tsconfig.workflow-goldens.json`. That map points `@zcode/contracts` at `scripts/rust-cli/stubs/contracts.ts` and `@zcode/dynamic-workflow` at `scripts/rust-cli/stubs/dynamic-workflow.ts`. Both stubs copy the real source (`createSessionId` returns `sess_${id}`; `CoreErrorType.TurnCancelled` is `turn_cancelled`; the dynamic-workflow stub re-exports the two symbols the helpers use from Node's own files, because the package index needs the generated compiler libs).
- `driver_golden_tests.rs` replays the fixture: 55 session ids (11 run ids by 5 actors, including an emoji and underscores), 11 fragment lists, the constants, 6 schema epilogues (absent, null, string, nested with `1e21` and `123456789012345680000`, array), the context and name normalisers, labels, `rejectWith`, and the permission rules and descriptions.
- Unit tests in `driver_rules.rs`, `escalation_tests.rs`: the budget and refusals, withdrawal on a new ask and on `end_ask`, the raise and resolved write failures, Node key order in the payloads, and the fragment fallback.
- Red first, as recorded: `cargo test -p rust-cli-workflow --lib` failed to compile (`file not found for module driver_rules`) before the module existed. `rust-cli-node-store --lib astral_character` failed on `sess_dwf-dwfrun-_x-x.y-z_10` against Node's `__x`. The escalation tests failed to compile (`file not found for module escalation`) before the book existed.
- Results on the Linux box: `cargo test -p rust-cli-workflow --lib` 62 pass; `cargo test -p rust-cli-node-store --lib` 328 pass, 1 ignored; `cargo clippy --workspace --all-targets -- -D warnings` exit 0; `cargo fmt --all -- --check` exit 0.

Deviations and what is not golden-covered:

- The escalation book is tested against the behaviour its Node source states, not against goldens from a running Node driver, because Node's escalation port needs an AgentRuntime. The payload key order is pinned to the Node object literals. The fragment fallback and `mint_question_id` are from source, not from a Node call (the function is not exported).
- Node's permission mode type is `CollaborationMode`, which TypeScript cannot pass as an unknown string. A Rust `&str` can, so an unknown mode reads as absent (`None`, then YOLO).
- `json_pretty` reads every JSON number as a double, as `JSON.parse` does in Node. A schema integer above 2^53 therefore prints the same way Node prints it.
- The untyped-ask and no-active-ask texts are copied from `workflow-driver-submit-bridge.ts` and checked by a Rust test against the literal; there is no golden for them.
- Not verified: how Node hides `workflow_actor` sessions from the sessions index. The index projection (`bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts`) has no reference to the role. The actor session carries `parentSessionId` (`dynamic-workflow-run-launch.ts`, `persistActorSession`), so the parent is the likely filter. Part 2 must check the adapter query before it writes the link.

Remaining (W6a part 2, owner: W6a; not in this part):

1. The `ActorRuntime`: create the child session as a job through `crates/agents` (session kind `Subagent`, parent, title, task-link writer, persona model and tool policy). The existing `spawn.rs` runs a child to its end, so the runtime needs a turn-by-turn entry point on the same session.
2. The per-ask turn loop on that session, the `submit_result` and `escalate` tools modelled on `respond.rs` (the blocking tool with a oneshot), the typed epilogue (`schema_epilogue` or `TYPED_TOOL_EPILOGUE`), the mono submit profile, and the nudge turn with `NUDGE_PROMPT`.
3. The permission origin: `ChildSink::with_origin` with `actor_interaction_description`; "always allow" as the session-scoped grant (F3b(a)).
4. `set_message_boundary` from the transcript, `ask_mutating` from tool activity, the `countSource` adapter for the import builder (W5b), and the per-ask tool counts for `statsFromTurn`.
5. Wiring the escalation book into the driver owner's messages and the engine journal (the book is written, the engine is not yet called from a session).
6. Port the driver tests that apply to W6a: `bootstrap/tests/workflow-driver.test.ts` (1,344 lines), `workflow-driver-submit-profile.test.ts`, and the escalation cases. Concurrency and the seat gate are W6b.

### 9.8 W6a part 2: the driver owner (design, then as built)

Status: part 2a built on `feat/rust-workflow-actor-runtime`, stacked on W6a part 1 (#536). Gate off; nothing calls it. The turn side (part 2b) is open.

**The index question (answered).** Node hides `workflow_actor` child sessions from the sessions index by their parent, not by their role. Evidence:

- The actor session is created with `parentSessionId` (`dynamic-workflow-run-launch.ts` `createActorSession`, and `persistActorSession`). Its `task_type` is `workflow_child`, the runtime's `taskType`.
- The index lists roots only: `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts`, `listSessions`, `if (input.roots) clauses.push("parent_id is null")`.
- The sidebar child scope covers only `selection_side_chat` (`CHILD_SESSION_TASK_TYPES`, same file). Subagents are reached from the parent conversation, not from the list.
- `sessions-index-projection.ts` and the shared `sessions-index.ts` schema have no reference to the role. The projection shows only what the store returns.
- Rust mirrors the filter: `packages/rust-cli/crates/node-store/src/repo/sessions.rs:315`, `(parent_id is null or task_type = 'fork')`.

So the rule is: a `workflow_actor` child has a parent, and the parent filter hides it. The link row is not part of the listing. The Rust actor session therefore needs `parent_id` set to the run's parent session, and must not be a fork. Its `task_type` in Rust is the subagent kind's value (`subagent_child`) rather than Node's `workflow_child`; this is a recorded deviation (section 9.8 "Deviations"). The owned-tree deletion and the usage counts key on `workflow_child`, so this has to be settled before the session is written in the real runtime.

Owners (part 2 additions):

- **driver owner** (`crates/workflow/src/driver_owner.rs`, `ActorDriverOwner`): the single owner of the engine, the escalation book, and the active-ask table. Every message from a turn is handled inside `handle_*`, one at a time. After each engine call it runs `pump`, which applies the engine's queued starts and failures.
- **actor port** (`ActorPort`, the engine's `WorkflowDriver`): owns the session map and the per-session submit profile. It queues starts, failures and verdicts. It never calls the book. It calls the turn side through `ActorSessions`.
- **turn side** (`ActorSessions`, implemented later by the async runtime on the child session): creates the session and link row, starts and cancels turns, and rejects withdrawn parked questions. No engine access.

Event order (part 2; the submit and turn-end paths of 9.7 are unchanged):

```
turn side           ActorDriverOwner (owner)                  ActorPort (driver)        engine
  │ start (engine.ask)  ─────────────────────────────────────────────────────────────►│ start_ask(session)
  │                                                    │◄─ queued start ──────────────│
  │                    pump: book.start_ask (withdraw parked), profile_fit,            │
  │                          Fits / FallBack → active; Fail → engine.ask_failed        │
  │ submit_result(v) ─SubmitResult{session,v}─────────►│ submit_route: refused text, or engine.submit_attempted
  │                                                    │───────────────────────────────►│ respond_to_submit → verdict slot
  │◄── reply: refusal text, or verdict ───────────────│◄───────────────────────────────│
  │                    reconcile: ask no longer live → book.end_ask, reject parked       │
  │ escalate(q) ─────────────────────────────────────►│ book.escalate (write via engine.record, raise before park)
```

Rules that follow:

- A message is handled only by the owner. The turn side waits for the reply, and nothing in the port blocks.
- `pump` runs before and after each message, and loops until the queues are empty. A start is applied before any message from its turn can be handled, because the turn starts after the start is queued.
- The active-ask table is derived from the engine: an ask that is no longer live is ended in the book, and its parked questions are rejected. Accept, budget exhaustion and cancel all end the ask this way, so no path has to remember to end it.
- A world read in a turn-driven ask is not supported in this part (W6b); the port fails such an ask with a `DriverError`, as a fault rather than a panic.

Node driver tests applied in part 2: the port refusals (`workflow-driver-submit-bridge.ts`), the profile fit, the escalation budget and withdrawal, and the nudge and repair verdicts through the engine. The turn-loop tests (`workflow-driver.test.ts`) need the real child session and stay in the remaining list.

As built (part 2a: the owner and the port, synchronous, no turn runtime):

- `crates/workflow/src/driver_owner.rs`: `ActorDriverOwner<J, S>` (the engine, the escalation book, the active-ask table) and `ActorPort<S>` (the engine's `WorkflowDriver`). `ActorSessions` is the turn-side trait; `ActorSessionRequest` carries Node's title (`workflow subagent <site>@<ordinal>`), the parent, and the link path (`dwf/<run>/<site>@<ordinal>`).
- Owner entry points: `create_actor`, `ask`, `drain`, `complete`, `submit_result` (refusals from `submit_route`, else `engine.submit_attempted` and the verdict slot), `turn_ended` (Nudge, a settlement, or a repair, from the engine), `escalate` and `answer` (the book, writing through `engine.record`), `set_message_boundary` and `ask_mutating` (the engine's existing methods, on the session's active ask), `set_actor_profile` (the caller's ask-to-actor analysis).
- `pump` applies the port's queued starts (book start, withdrawn questions rejected, turn start), failures (`ask_failed`), and then `reconcile`, which ends every active ask the engine no longer has live (accept, budget exhaustion, cancel, complete). `reconcile` also runs when the queues are empty, because `complete` queues nothing.
- A profile fit that fails (untyped profile on a typed ask) fails the ask with `DriverError` before any turn starts. A mono miss falls back to generic and the turn starts.
- Tests: `crates/workflow/src/driver_owner_tests.rs`, 15 cases (session title, parent and link path; the two port refusals with the engine writing nothing; accept, invalid submit, nudge; mono fallback and untyped failure; escalation refusal without an ask, park, answer, budget, withdrawal on accept, cancel on complete; boundary write; mutating observation on an idle session).
- Red first, as recorded: `cargo test -p rust-cli-workflow --lib driver_owner` failed to compile (`file not found for module driver_owner`) before the module existed. Then 12 of 13 ran red on the tests' own assumptions (a session exists only after the first dispatch, so `session_of` before a drain is `None`). The test was fixed to drain first. The `complete` case then failed because `pump` returned before `reconcile` on an empty queue; the fix is in `pump`. Both are in the commit.
- Box, 2026-11-17: `cargo test -p rust-cli-workflow --lib` 79 pass (after the owner tests); `cargo fmt --all -- --check` exit 0; `cargo clippy --workspace --all-targets -- -D warnings` exit 0.

Deviations (part 2a):

- Actor session `task_type`: Node writes `workflow_child` (the runtime's `taskType`). The Rust turn side will write the subagent kind's task type; `workflow_child` is the owned-tree and usage key in Node (`session-store` `OWNED_CHILD_TASK_TYPES`, `session_tree.rs`), so the turn side must either use it or add the Rust equivalent to those lists. Not settled in this part; the owner does not write sessions.
- Seeds (`ActorSessionSeed`) are passed through the trait signature but not used. Diverged actors are part 2b.
- World reads fail the ask with `DriverError` as a fault (W6b).
- The owner is synchronous and single-threaded by construction; the async turn side must send messages to it, not call it from inside a turn.

Review fixes to part 2a (verdicts against the code and Node):

- Queue drain (fixed): `pump` applies every queued start and failure and returns the first error after the rest. Before, the first `ask_failed` error dropped the remaining failures and those instances hung. Test: `two_asks_that_fail_in_one_drain_both_get_their_outcome` (the error branch itself needs a failing journal; not covered).
- Turn-side errors (fixed): `ActorSessions::start_turn`, `cancel_turn` and `reject_parked` return `Result`. A refused start fails the ask as `DriverError` with the send error's text, the withdrawn questions are released, and nothing is left active (Node `askFailed(toWorkflowError(error))`, `workflow-driver.ts` `onTurnRejected`). A cancel or reject error the engine cannot receive is kept and returned by the next owner call. Test: `a_turn_that_cannot_start_fails_the_ask_with_the_send_error_and_starts_nothing`.
- Exhausted repair budget (fixed): the submit is answered `SubmitReply::Cancelled("The ask was cancelled by the engine.")`, Node's text for a pending submit rejected by `cancelAsk` (`workflow-driver.ts` `cancelAsk`). Before, it was `NO_ACTIVE_ASK_MESSAGE`. Test: `an_exhausted_repair_budget_answers_the_submit_as_the_engine_cancelled_it_and_fails_the_ask`.
- Port state (fixed): `emitted` is removed (the journal is the record; the Host fan-out is W7, so `emit` keeps nothing and says why). `session_of_instance` is removed when the ask ends, fails or is cancelled. Verdicts are removed on the error path, on cancel and on end. The actor maps grow per actor in the run and are not pruned (bounded by the run's actors).
- Turn end (fixed, tests added): `turn_ended` returns `TurnEndReply::{Verdict, AskEnded, NoAsk}` in place of an `Option`. Tests: nudge then `ResultNotSubmitted` with cancel (`a_turn_that_ends_without_a_submit_is_nudged_once_then_fails_with_result_not_submitted`), a rejected submit followed by a nudge, an untyped turn end that settles, and no ask in flight.
- Unknown session (fixed, not testable through the owner): `start_ask` for a session the port does not know fails the ask with `Unknown subagent session: <id>`, Node's text (`workflow-driver.ts` `startAsk`). The engine only starts sessions it created, so no public call reaches it.
- Import cache (fixed): the mutating-tool test runs with an imported cache, so the observable is one `import-cache-closed` event for an active ask, none for a repeat or an idle session. Before, a fresh run wrote nothing whatever the routing.
- Test hygiene (fixed): the instance comes from the recorder, the recorded turn and message are asserted, the cancelled instance is asserted, the vacuous assertion is now `actor == "site@1"`, and the idle-session call is last in the mutating test.

Review round 2 (ocr, on 58cd5fced):

- Settled submit or turn end with a turn-side error (fixed): a reply-answering call returns the engine's reply whether or not the pump fails while it settles. Turn-side errors are logged (`settle_quietly`), not returned, so a retry never sees a settled ask as no ask. Engine errors still return, since no reply exists. Tests: `a_repair_exhausted_by_a_refused_cancel_still_answers_the_submit_and_fails_the_ask`, `an_accept_with_a_refused_withdrawal_still_returns_the_accept_and_releases_the_rest`, `a_turn_end_that_settles_with_a_refused_cancel_still_returns_ask_ended`.
- Stale start (fixed): `apply_start` starts no turn for an ask the engine no longer has live. Every owner call now pumps even when the engine call failed (`after_engine`), so a queued start is never left for a later call. Test: `a_start_queued_for_an_ask_that_is_no_longer_live_starts_no_turn` (through the test-only `queue_start_for_test`).
- Liveness keyed by instance (fixed): the settled-versus-live check on a reply is `engine.is_live_ask(instance)`, not by session.
- Invariant messages (fixed): they name the requirement (`submit_route` admits a submit only with an active ask; `scheduler_submit` answers every submit and turn end on a live typed ask).
- Redundant reconcile (fixed): submit and turn end no longer reconcile; `pump` reconciles on every exit path.
- Cancel and reject failure tests (fixed): the recorder has one-shot failure flags for `cancel_turn` and `reject_parked`. Tests: the refused cancel on `complete` is returned and the rest of the queue still applies (`a_refused_cancel_on_complete_is_returned_and_the_rest_of_the_queue_still_applies`); a refused withdrawal on accept is skipped and the other question is still released.

Red record for round 2: `cargo test -p rust-cli-workflow --lib driver_owner` failed to compile before the change (`no method named queue_start_for_test`). The behaviour tests were not run against the round-1 code separately, so the behaviour part of the red record is not observed.

Review round 3 (ocr, on 63e0a578e):

- Engine error with a pump error (fixed): a reply call that fails in the engine logs the pump error before it returns the engine's error (`reply_after`, `log_settle_error`). Before, the pump error was dropped.
- Log wording and module doc (fixed): the message names no source, since a pump error may be a turn-side error or an engine journal write in `ask_failed`. The module doc says which calls return pump errors and which log them.
- Mixed behaviour (fixed): `set_message_boundary` and `ask_mutating` return every pump error, before and after the engine write, as non-reply calls. Before, the pre-call pump was logged and the post-call one returned.
- Stale start (fixed, logged): the guard logs a `debug` line with the instance key and the session when it drops a start.
- Stale-start test (fixed): it rebuilds the race (admit the ask, its turn runs, `complete` settles it, then a start is queued and applied). It is red without the guard (two turns instead of one; checked by disabling the guard for one run and restoring it).
- Refused reject (parity decision, documented): Node's `withdrawSessionEscalations` retires the registry entry, then rejects the deferred, and a promise rejection cannot fail there. The Rust book also retires the question before the reject, so a refused reject drops the question in both. The error is logged or returned by the pump, not retried. Comments at the withdrawal sites and on the refused-reject test say so.

Remaining (W6a part 2b, the turn side; not in this part):

1. An `ActorSessions` implementation over the agents crate: a child session of kind `Subagent` with the parent, the title, and the `workflow_actor` link row (`insert_workflow_actor_link` in node-store), created at dispatch. Decide the task type first (Deviations above).
2. The turn loop: `start_turn` runs a turn on the child; `submit_result` and `escalate` tools modelled on `respond.rs` (blocking on a oneshot, the result is the reply); `turn_ended` → Nudge → a fresh turn with `NUDGE_PROMPT`; the typed epilogue (`schema_epilogue` / `TYPED_TOOL_EPILOGUE`) and mono profile in the instructions.
3. Permission origin (`ChildSink::with_origin`, `actor_interaction_description`) and session-scoped "always allow" grants.
4. `ask_mutating` from tool activity and `set_message_boundary` from the transcript (the owner methods exist; the callers do not).
5. The `countSource` adapter for the import builder (W5b) and the per-ask tool counts for `statsFromTurn`.
6. Port the turn-loop cases of `bootstrap/tests/workflow-driver.test.ts` and `workflow-driver-submit-profile.test.ts` that need a session; these need the real child session from item 1.

### 9.8b W6a part 2b: the turn side (design, then as built)

Status: part 2b (session side) built on `feat/rust-workflow-actor-runtime`, stacked on part 2a (f4f710534). The turn side (2c) is open.

Decision (coordinator, 2026-11-17): the actor session's `task_type` is Node's `workflow_child`, not the Rust subagent kind's `subagent_child`. Reason: the DB is shared with upstream, and `workflow_child` is the key for owned-tree deletion (`OWNED_CHILD_TASK_TYPES`) and the tree walk (`SESSION_TREE_CHILD_TASK_TYPES`). The actor keeps `parent_id` set and is never a fork.

Checked on the Rust side, the owned-child paths already include `workflow_child`:

- `crates/node-store/src/session_deletion.rs` `OWNED_CHILD_TASK_TYPES`: `selection_side_chat`, `workflow_child`, `subagent_child`, `nested_workflow_child`. Forks are excluded.
- `crates/node-store/src/session_tree.rs` `SESSION_TREE_CHILD_TASK_TYPES`: the same four. The counts split `workflow_child` and `nested_workflow_child` into `workflow_sessions`.
- Before this part, `load.rs` read `workflow_child` as `SessionKind::Interactive`. That is wrong for a child with a parent, so this part maps it to `Subagent`. Node-written `workflow_child` rows change kind on read. Nothing in the sessions list shows them (`parent_id is null or task_type = 'fork'`).

Owners (part 2b additions):

- **session store** (node-store, the only writer of `session` rows): `create_workflow_actor_session` writes the row with `task_type = 'workflow_child'`, `parent_id`, and the run's directory. It goes through the same `repo::sessions::create` as every session.
- **actor session adapter** (`crates/workflow/src/actor_sessions.rs`, `NodeActorSessions`, the `ActorSessions` impl): for `create_session`, it mints the session id with `mint_actor_session_id` (the replay envelope's function), writes the session row, then the `workflow_actor` link. It is synchronous and runs on the driver owner's thread. It owns no state of its own beyond the connection.
- **turn side** (later, in `crates/agents`): runs the turns on the session. It is not in this part.

Event order for session creation (one owner, one write path):

```
engine (dispatch)   driver owner / port        NodeActorSessions                 node-store
  create_actor_session ─► create_session(req) ─► mint id, create_workflow_actor_session ─► session row (workflow_child)
                                                 insert_workflow_actor_link ───────────────► session_task_link (workflow_actor)
                       ◄── session id ───────────┘
```

Deviations recorded in this part:

- Link id: Node uses `tasklink_<randomUUID()>`. This adapter uses `tasklink_<session id>`, which is unique because `child_session_id` is unique in the table. The id is not random, so a re-created session keeps the same link id (the upsert path moves only status and time).
- `persona` is recorded by the owner's request and not written to the session row here; the turn side writes the frozen persona.

As built: see the end of this section.

As built (part 2b, the session side; the turn loop is not in this part):

- `crates/node-store/src/repo/dwf/mod.rs`: `WorkflowActorSession` and `create_workflow_actor_session`, the writer of the `workflow_child` row under the run's parent (through `repo::sessions::create`, not a parallel insert). Exported as `rust_cli_node_store::dwf`.
- `crates/node-store/src/load.rs`: `workflow_child` and `nested_workflow_child` read as `SessionKind::Subagent` (were `Interactive`). Node-written rows change kind on read; the sessions list is still filtered by `parent_id is null or task_type = 'fork'`.
- Owned-child paths, checked and tested: `session_deletion::OWNED_CHILD_TASK_TYPES` and `session_tree::SESSION_TREE_CHILD_TASK_TYPES` already include `workflow_child` (no code change). Test `a_workflow_child_is_an_owned_member_of_its_parent_tree` (node-store) asserts the owned tree of the parent contains the actor session.
- `crates/workflow/src/actor_sessions.rs`: `NodeActorSessions<T: ActorTurns>`, the `ActorSessions` impl. `create_session` mints the id with `mint_actor_session_id`, writes the row, then the `workflow_actor` link (`tasklink_<session id>`, path from the request). A request with no parent session is refused and writes nothing. The turn calls are delegated to `ActorTurns`, the injected turn side.
- Tests (workflow): `actor_sessions_tests.rs`, 4 cases (row and link written; id equals the replay function's id; no-parent refusal; delegation). Tests (node-store): 2 in `repo/dwf/workflow_actor_tests.rs`.
- Red first, as recorded: node-store `cargo test -p rust-cli-node-store --lib workflow_actor` failed to compile (`WorkflowActorSession` and `create_workflow_actor_session` not in scope). Workflow `cargo test -p rust-cli-workflow --lib actor_sessions` failed to compile (`file not found for module actor_sessions`). After the module existed, one case failed on an expectation of mine: the sanitiser escapes `_` to `__` (Node's rule), so the prefix is `sess_dwf-run__1-`. The test was corrected; the code was right.
- Box, 2026-11-17: node-store `cargo test -p rust-cli-node-store --lib` 330 pass, 1 ignored (was 328 pass); workflow `cargo test -p rust-cli-workflow --lib` 85 pass.

Deviations (part 2b):

- The link id is `tasklink_<session id>`, not Node's `tasklink_<randomUUID()>`. `child_session_id` is unique, so it cannot collide, and a re-created session keeps its link id.
- `trace_id` of the actor session is the parent session id. Node's trace is not verified here; the Rust subagent path uses the root agent id.
- The persona is not written to the session row here; the turn side writes the frozen persona.

Remaining (part 2c, the turn side):

1. An `ActorTurns` implementation over `crates/agents`: each ask runs as a turn on the child session (turn-by-turn entry on the existing subagent machinery; `spawn.rs` runs to completion today).
2. The `submit_result` and `escalate` tools, modelled on `respond.rs`: `escalate` blocks on a oneshot and its answer is the tool result; `submit_result` sends `submit_result` to the owner and returns the verdict as the tool result.
3. The nudge turn with `NUDGE_PROMPT`, the typed epilogue (`schema_epilogue`, `TYPED_TOOL_EPILOGUE`) and the mono profile in the instructions, and the repair budget path in the turn loop.
4. Permission origin (`ChildSink::with_origin`, `actor_interaction_description`) and session-scoped "always allow".
5. Callers for `ask_mutating` (tool activity) and `set_message_boundary` (the transcript). The owner methods exist.
   5b. The `countSource` adapter for the import builder (W5b) and the per-ask tool counts for `statsFromTurn`.
6. Port the session-dependent cases of `bootstrap/tests/workflow-driver.test.ts` and `workflow-driver-submit-profile.test.ts`.

### 9.8c W6a part 2c: the turn loop (design, split)

Status: started on `feat/rust-workflow-turn-loop`, stacked on fork (9bb28da37 = #537 merged). Gate off.

Why it is split. The turn loop touches four crates (`workflow` owner, `agents` turn runner, `protocol-zcode` for the tool surface, `node-store` for the transcript reads), and each needs its own review. The split:

- **2c-1 (this part): the answer path and the mailbox.** The owner's `answer` writes the journal but does not deliver the answer to the blocked escalate call, so the actor would wait forever. Node resolves the deferred (`workflow-driver-escalation.ts` `respondToParkedEscalation`: `deferred.resolve(answer)`). 2c-1 adds `ActorSessions::deliver_answer` and calls it from `answer` (with the session from the book; a delivery error is logged, the journal write already happened, since Node delivers the answer even when the journal write fails). It also adds `ActorMailbox`, a std `mpsc` request channel (submit, turn end, escalate, answer; each with a reply sender), and `serve`, which drains it on the owner's thread. Turns send requests and block on their own reply channel. Nothing async is added.
- **2c-2: ActorTurns over crates/agents.** A turn-by-turn entry on the existing subagent machinery (`spawn.rs` runs to completion today). `start_turn` runs one ask's turn on the child session; `cancel_turn` aborts it; `reject_parked` and `deliver_answer` wake the blocked tool. The transcript and the session task link come from node-store (2b).
- **2c-3: the tools and the prompt.** `submit_result` and `escalate` tool definitions modelled on `respond.rs` (the blocking tool with a reply channel), `NUDGE_PROMPT` for a nudged turn, the typed epilogue and the mono profile in the instructions (`driver_rules`), and the repair path in the turn loop.
- **2c-4: the callers and the ports.** `ask_mutating` from tool activity and `set_message_boundary` from the transcript; the permission origin (`ChildSink::with_origin`, `actor_interaction_description`) and session-scoped grants; the `countSource` adapter for the import builder (W5b) and per-ask tool counts for `statsFromTurn`; the Node driver tests that need a session (`workflow-driver.test.ts`, `workflow-driver-submit-profile.test.ts`).

Design of 2c-1 (owners and event order):

```
turn (blocked)            ActorMailbox (std mpsc)           owner thread (ActorDriverOwner)        turn side (ActorSessions)
  escalate(q) ─Escalate{session,req,reply}─►│ serve: owner.escalate ─► Parked{qid} ─► reply
  │ blocks on its own receiver              │
  │                                          │ main agent: answer(qid,text)  ─► owner.answer ─► book.answer (journal write)
  │                                          │                                    └─► deliver_answer(session,qid,text) ─► wakes the blocked turn
  │ submit_result ─Submit{session,payload,reply}─► serve: owner.submit_result ─► SubmitReply ─► reply
```

Owners: the owner thread is the only caller of the engine and the book. The mailbox is a plain queue; it holds no state beyond the channel. The turn side owns its blocked receivers.

Deviations recorded for 2c-1:

- `answer` delivers only when the book held the question. A question withdrawn earlier gets no delivery (Node: `respondToParkedEscalation` returns false, `run_not_in_flight`).
- The mailbox is synchronous. A turn that is not on a thread that can block must not call `serve`'s caller; the agents side (2c-2) runs turns on their own threads or tasks.

Tests for 2c-1 (written first; red recorded in the commit message and the report):

- the recorder's `deliver_answer` is called with the session, qid and answer when an answer is accepted, and not when it is refused (driver_owner_tests);
- a withdrawn question is not delivered;
- the mailbox round trip: a submit through the mailbox gets its `SubmitReply`; an escalate gets `Parked`; an answer sent through the mailbox is delivered to the recorder.

As built (2c-1): `ActorSessions::deliver_answer` (and `ActorTurns`) resolves the blocked escalate with the answer; `ActorDriverOwner::answer` delivers to the question's session when the book accepted it (the journal write does not gate delivery, as in Node). `crates/workflow/src/actor_mailbox.rs`: `ActorMailbox` (owner side, `serve_next`) and `ActorHandle` (turn side: `submit`, `turn_ended`, `escalate`, `answer`), std mpsc, errors as text. Tests: `driver_owner_tests` (two delivery cases), `actor_mailbox_tests` (four). Red: the module and the trait method were missing at first, so the run failed to compile; the delivery behaviour was not run red separately. Box: workflow lib 102 pass; fmt and clippy clean.

Review of 2c-1 (ocr on bb65c05f9), verdicts:

- Delegation test (fixed): the stub records the call; the test asserts session, qid and answer are forwarded unchanged.
- Mailbox shutdown and panic (fixed): the mailbox keeps no sender. `ActorMailbox::new` returns the receiver and one handle, and handles are cloned from it. When every handle drops, `serve_next` returns `MailboxError::Closed`. A panic in the owner drops the request's reply sender, so the turn gets `NoAnswer`. The panic path is not driven by a test; the drop is tested by taking a request and dropping it.
- Send versus receive failure (fixed): `NotDelivered` (the send failed; safe to retry) and `NoAnswer` (the owner took the request and stopped; it may already be applied) are distinct variants with distinct text.
- Error type (fixed): the reply carries `anyhow::Result`, and `MailboxError::Owner` keeps the chain. The text-only design is removed.
- `ActorRequest` (fixed): `pub(crate)`.
- Refused delivery (fixed; parity decision). Node's `respondToParkedEscalation` calls `deferred.resolve(answer)`, which cannot fail. Rust's turn can be gone, so a refused delivery is possible. The Rust answer therefore carries `AnswerOutcome.delivery_warning`, and the question is retired either way. This is a Rust addition with no Node counterpart.
- Refused delivery test (fixed): `fail_next_deliver` on the recorder; the test checks the warning, the empty delivery list, and that a retry returns `None`.
- Structured log fields (fixed): `session`, `qid` and `error` are tracing fields.
- Dead Some/None guard (fixed): the session is looked up first. The book answers exactly the questions it parks, so a missing session returns `None` before any write. A book that refuses after the lookup is an error, not a silent drop.
- Owner error through the mailbox (fixed): a journal that refuses appends, switched on after the ask runs, makes `escalate` fail inside the owner. The turn gets `MailboxError::Owner` with `journal refused the append` in its chain.

Box, after the fixes: workflow lib 106 pass; fmt --check and clippy --workspace -D warnings exit 0.

### 9.8d W6a part 2c-2: the turn loop over the agents crate (split)

Status: started on `feat/rust-workflow-actor-turns`, stacked on fork (61a044f6d = #538 merged). Gate off.

Why it is split. The agents-side turn needs a `LiveAgent` for an actor child (agent type, definition, selection, workspace, the parent `RunInfo`), a tool registry, and the permission origin. The nudge and failure loop does not need any of that. So 2c-2 is split:

- **2c-2a (this part): the turn loop over an injected `TurnRunner`.** `TurnRunner` runs one model turn on a child session and returns its final text (or an error). `MailboxTurns` implements `ActorTurns` on top of it. `start_turn` runs the ask on its own thread: a turn, then `turn_ended` through the mailbox. A `Nudge` verdict starts a fresh turn with `NUDGE_PROMPT`. A settled ask (`AskEnded`, `NoAsk`) or an owner that is gone ends the loop. A turn error is sent to the owner as `turn_failed`, so the ask fails with `DriverError` (Node's `askFailed(toWorkflowError(error))`). A cancelled ask runs no `turn_ended` (Node: `onTurnRejected` returns early on `state.cancelled`). The mailbox gains `TurnFailed`, and the owner gains `turn_failed`, which the engine's `ask_failed` writes. `reject_parked` and `deliver_answer` return an error until the escalate tool exists (2c-3), because no question can be parked before then.
- **2c-2b: the `TurnRunner` over `crates/agents`.** A turn runs `resume` (a new user message on the child) and `drive` on the child session (`spawn.rs`), with a `LiveAgent` built for the actor, and the turn's final text taken from the transcript. It needs the `LiveAgent` constructor for actor children, the workspace and selection, and the permission origin (`ChildSink::with_origin`). It is the first PR that touches `crates/agents`, and its tests need the agents test support.
- **2c-3: the tools and the prompt.** `submit_result` and `escalate` as tools (modelled on `respond.rs`, `escalate` blocking on a reply), the typed epilogue and the mono profile in the instructions (`driver_rules`), `reject_parked` and `deliver_answer` wired to the blocked escalate.
- **2c-4: the callers and the ports.** As in 9.8c: `ask_mutating` and `set_message_boundary` from tool activity and the transcript, the grants, `countSource` and stats, and the Node driver tests that need a session.

Owners and event order for 2c-2a (each turn runs on its own thread; the owner is served by the mailbox):

```
owner thread                        ask thread (MailboxTurns, one per ask)         TurnRunner
  ask → start_ask → start_turn ─────► spawn ─────────────────────────────────────►  run_turn(prompt)
  serve_next ◄──── TurnEnded ◄──────── turn_ended(text) (blocks)  ◄─── text ───────────┘
  reply Nudge ───────────────────────► prompt = NUDGE_PROMPT → run_turn again
  ...
  reply AskEnded ─────────────────────► return (thread ends)
  TurnFailed ◄─────────────────────── turn_failed(msg) (on a turn error, not cancelled)
  cancel_turn(instance) ───────────── sets the ask's flag; run_turn returns; no turn_ended
```

Deviations recorded for 2c-2a:

- The cancel flag is observed between turns and after the runner returns. A runner that never returns cannot be stopped by the flag; the agents side (2c-2b) must abort the model call.
- One thread per ask. The owner never waits on a thread; the thread waits on the owner's reply through the mailbox.

Tests for 2c-2a (written first; red recorded in the commit message and the report): a nudge followed by `AskEnded` runs two turns, the second with `NUDGE_PROMPT`, and fails the ask with `ResultNotSubmitted`; a refused turn fails the ask with the runner's text; a cancelled turn sends no `turn_ended` (the join completes, which proves no request was sent and waited on).

As built (2c-2a): `crates/workflow/src/actor_turns.rs`: `TurnRunner` (one model turn; `Send + Sync`), `MailboxTurns` (the `ActorTurns` implementation: one thread per ask, a per-instance cancel flag), and `run_ask` (the turn, then `turn_ended`; `Nudge` starts a turn with `NUDGE_PROMPT`; any other verdict ends the thread; a turn error is reported with `turn_failed` unless the ask was cancelled; a cancelled turn reports nothing). `ActorRequest::TurnFailed` and `ActorHandle::turn_failed` carry the failure; `ActorDriverOwner::turn_failed` calls the engine's `ask_failed` with `DriverError`. `reject_parked` and `deliver_answer` return an error until 2c-3. Tests: `actor_turns_tests.rs`, three cases (nudge then settlement with the nudge prompt; a refused turn fails the ask with its text; a cancelled turn sends no turn end). Red: the module was missing, so the first run failed to compile; the first real run hung in the cancel case because the test had not drained the owner, so the turn never started (a test error, fixed by adding `drain`). Box: workflow lib 109 pass; fmt and clippy clean. `crates/agents` is not touched by this part.

### 9.8e W6a part 2c-2b: the agents-side TurnRunner (design, split)

Status: decided (option C). 2c-2b-1 is on `feat/rust-workflow-agent-turn-runner` (PR #540). Gate off.

**What the runner must do.** One model turn of an actor's ask on the child session: `run_turn(session, prompt, cancel)` returns the turn's final text, or an error text. The existing machinery is `spawn::resume` (appends a user message to a stored child and commits a turn) and `spawn::drive` (runs the model loop until the run ends, returning `Finished { ending, report, error }`).

**Two things the code shows that the design must respect.**

1. A child agent needs a full `LiveAgent` (`crates/agents/src/live.rs`, about 25 fields). Several are fork or background specific: `owner`, `tool_use`, `execution_worktree`, `off_peak_execution`, `background`, `asks`, `delivered`, `fork_prefix`, `stopped_by_user`. An actor child is none of those. A constructor for an actor (`LiveAgent::for_actor`) must set each field to Node's actor value, and the reason for each non-default value must be written down.
2. `Ending` and `Report` are `pub(crate)` in `agents`. A bridge in another crate cannot name them, so the bridge has to call a function that is inside `agents`.

**Decision (coordinator, 2026-11-17): option C. The bridge lives in `crates/runtime`.** Reasons: `runtime` already depends on `agents`, `session`, `tools` and `node-store`, and it is the composition root that wires sessions. No crate depends on `workflow` yet, so `runtime -> workflow` creates no cycle. `protocol-zcode` does not depend on `agents`, so option B would add two edges. A new crate would add a workspace member and a lock entry for code that needs runtime context anyway. The only new edge is `rust-cli-runtime -> rust-cli-workflow`; its `Cargo.lock` entry is hand-edited.

Rules for the agents side (decided with the coordinator): add `pub` entry points in `agents` (a turn-by-turn entry and `LiveAgent::for_actor`). Keep `Ending` and `Report` `pub(crate)`, unless the bridge needs them; prefer a small `pub` result type. No helper lands without a caller in the same commit and a test that calls it, so clippy stays clean.

**The turn result, from Node (`workflow-driver.ts`, `runTurn` and `onTurnResolved`).** A resolved `executeTurn` gives `result.response`, the turn's final text, which is the value `askTurnEnded` reports. A rejected turn goes to `onTurnRejected`: a cancelled turn (`state.cancelled`, or an abort error, `isTurnCancelled`) is silent; any other error is `askFailed(toWorkflowError(error))`. In Rust, `spawn::drive` produces `Finished`: `Ending::Completed` carries `report.text` (the final text), `Ending::Failed` carries the error, and `Ending::Killed` and the other killed endings are the stopped case. The mapping is `ActorTurnEnd::{Text, Failed, Stopped}`.

**Proposed sub-split of 2c-2b (after the decision):**

- **2c-2b-1: `agents` public entry for an actor turn.** `pub` function that takes the ids, the selection and the workspace, and returns `Result<String, String>` (the final text, or the failure text). Result mapping: `Ending::Completed` and no error gives the report text. `Failed` or an error gives the failure text. `Killed`, `KilledParked` and `KilledByUser` give a "stopped" error, which the loop reads as cancelled when its flag is set. The mapping is checked against Node's `executeTurn` result before it is written; I have not read that path yet.
- **2c-2b-2: `LiveAgent::for_actor`.** The constructor, with one line per field recording its actor value. Tests use the agents test support.
- **2c-2b-3: the bridge in `crates/runtime`** (option C) implementing `TurnRunner`, with a scripted-runner test: one turn ends with text, one turn fails, one turn is cancelled. Adds the `rust-cli-runtime -> rust-cli-workflow` edge.
- **2c-2b-4: permission origin and session-scoped grants** (`ChildSink::with_origin`, `actor_interaction_description`, "always allow" for the session). Node: `workflow-actor-permission.ts`.

**What is not done here.** Nothing is compiled or tested in this part. The Node result path and the permission origin are not read yet; both are listed as open in the sub-split.

As built (2c-2b-1): `crates/agents/src/actor_turn.rs` (`pub mod`): `ActorTurnEnd::{Text, Failed, Stopped}` and `actor_turn_end(killed, failure, text)`, the mapping from a finished run's parts (killed is stopped whatever else it carries; a failure takes precedence over the text). Tests: four cases in the same module, red first (the first run failed to compile on the missing names). Box: fmt and clippy --workspace clean; agents lib 262 pass. The entry point that runs a turn and returns `ActorTurnEnd` (2c-2b-2 with `LiveAgent::for_actor`) is not in this part, so this function has no caller in the workspace yet; it is `pub` and tested, and it is the function the entry point will call.

As built (2c-2b-2): `crates/agents/src/actor_turn.rs` now has `ActorRun` (the child, the parent, the description, the persona prompt, the workspace, the selection and the mode), `LiveAgent::for_actor` (the Agent tool's entry with the actor's values; the definition is built here with `AgentSource::BuiltIn`, recorded as a deviation), and `Agents::run_actor_turn(run, prompt, cancel) -> ActorTurnEnd`. The entry makes the live entry on the first call, starts a run (`begin_run`), runs `spawn::resume` and `spawn::drive` (the cancel token is the drive's cancel), and returns `actor_turn_end`, which now has its caller. It does not use `Live::restart`, because that claims routes for notifications, which an actor run must not do. Tests (`actor_turn_entry_tests.rs`, three): a turn runs on its child and returns the final text; a second turn resumes the same child (two model turns, two user prompts in its transcript); a turn cancelled before it runs is `Stopped` (the gated runner is never notified, so only the cancel ends it). Red: the first run failed to compile on the missing names. Box: agents lib 265 pass; fmt and clippy --workspace clean. Open: concurrent turns of one actor are not checked here (the workflow FIFO guarantees they do not overlap). Stall-clock interaction with these entries is not checked (W6b).

Review fixes to 2c-2b-2 (ocr on 56376f308): the first-use check, the insert and the run start are one lock section (`Live::begin_actor_run`), and a running entry refuses a new run as `Failed` without disturbing it (the concurrency test was red before this change: the second call ran). `ActorRun` moves into `for_actor` (no clones). The killed check uses `Ending::status() == BackgroundStatus::Killed`. Tests added: the workflow's child row keeps its title and creation time across the first turn; a missing child row fails and creates nothing; the second model request carries the first turn's prompt and reply; the request carries the persona in the system blocks, the selection, the mode and `QuerySource::Subagent("workflow_actor")`; a cancelled turn leaves exactly one prompt and no reply in the transcript (Rust behaviour; Node parity of the prompt ordering on abort is not verified). Box: agents lib 270 pass; fmt and clippy clean.

As built (2c-2b-3): `crates/runtime/src/actor_turns.rs` (`pub mod`): `ActorAgents` (the agents boundary; `rust_cli_agents::Agents` implements it), `ActorRunBase` (the parent, the workspace, the selection, the mode and the persona prompt), and `AgentTurnRunner<A>`, the `TurnRunner` that blocks the ask thread on the runtime's `Handle` while the turn runs and carries the ask's cancel flag into the turn's `CancellationToken` (polled every millisecond). `run_turn` asserts that the ask thread is not inside a runtime. The Cargo edges: `rust-cli-runtime -> rust-cli-workflow` and `-> anyhow` (both in `Cargo.lock`, hand-edited; `cargo metadata --locked` passes), and the runtime's tokio gains `rt` and `time` (features, no lock change). Tests (`actor_turns_tests.rs`, four): a scripted actor turn runs through the real workflow owner, mailbox and turn loop, and settles after the nudge; a refused turn fails the ask with its text; a cancelled turn is stopped through the bridge and reports nothing; the debug assertion refuses a call from inside a runtime. The end-to-end test scripts the agents boundary (`ActorAgents`), not the model: the real entry is covered by the agents crate's tests. Red: the first run failed to compile on the missing module. Deviations: one persona per runner (the workflow passes no persona per turn; a per-actor persona is the next step), and the runner is not wired into the composition root (the gate stays off). Box: runtime lib 141 pass, agents lib 276 pass, workflow lib 110 pass; fmt and clippy --workspace clean; `cargo metadata --locked` passes.

As built (2c-2b-4), permission origin and session grants: `ActorRun` carries `interaction_description`, the origin of the actor's asks (`<persona name ?? "subagent"> (<site>@<ordinal>)`, Node's `workflowActorInteractionDescription`), not the session title. The owner keeps each session's description and passes it with every turn (`ActorSessions::start_turn` and `TurnRunner::run_turn` take it). `ActorRun.interactions: Option<Arc<dyn Interactions>>` is the parent's broker; `actor_asks(background_prompts, interactions)` gives the actor an asks channel only when the parent offers background prompts, the gate the Agent tool uses. The bridge's `actor_permission_mode(recorded)` composes Node's `parse_subagent_permission_mode` and `actor_permission_policy` (absent is YOLO) with the shared `PermissionMode::from_node_name`, so there is no second table. Tests: the mode mapping over build, edit, yolo, guarded, auto, plan (not recordable), bogus and absent; the entry's origin is the description; a run carries the description and the parent's interactions; the owner passes the description per persona. Deviations: the runtime tests were written with the change in one edit, so their red run was not recorded separately (the agents red compile was). Not covered: an always-allow staying in the actor's child session, which the existing session-allow tests cover only indirectly; and `actor_permission_mode` has no production caller until the runner is wired into the composition root. Box: agents lib 278 pass, runtime lib 143 pass, workflow lib 112 pass; fmt clean; clippy `--workspace --all-targets --locked -D warnings` clean.

### 9.8f W6a part 2c-3: the tools and the prompt (split)

Status: started on `feat/rust-workflow-actor-tools`, stacked on fork (c4dbc1abf = #544 merged). Gate off.

Why it is split. The rule text already exists in `driver_rules` (`NUDGE_PROMPT`, `TYPED_TOOL_EPILOGUE`, `schema_epilogue`, `submit_route`, `profile_fit`). What is missing is the tool surface and the wiring, and each needs its own review: the tools are in `crates/agents` (the child's toolset) and the blocking calls cross the mailbox. `crates/agents` does not depend on `crates/workflow`, so the blocking tools need a port defined on the agents side and implemented in `runtime`. Split:

- **2c-3a (this part): the actor tool surface.** `WORKFLOW_ACTOR_DISALLOWED_TOOLS` in `agents::actor_turn` is Node's `workflowActorToolPolicy` list (seven names, pinned by a test). `LiveAgent::for_actor` sets it on the definition, which the child's toolset enforces (`toolset.rs` deny list). Also the low ocr fix on the #544 review: `SubagentPermissionMode` and its name table are generated from one macro, with `ALL` in the same expansion. Node's header comment names `ReadSessionContext` among the excluded reads, but its exclusion list does not; the Rust list follows the list.
- **2c-3b: `submit_result` and `escalate` as tools.** Each is a `Tool` in `agents`, modelled on `respond.rs`: `submit_result` takes the typed payload and blocks on a reply; `escalate` blocks until the question is answered or rejected. The blocking calls go through a port defined in `agents` (a trait with the submit and escalate calls) and implemented in `runtime` over `ActorHandle` (the same bridge as `AgentTurnRunner`, one boundary crossing per call). The typed epilogue is appended to the typed ask's prompt. Wires `ActorTurns::reject_parked` and `deliver_answer` to the blocked escalate, which replaces their current errors. Decision to make before coding: whether the epilogue is appended to the turn prompt or put in the child's system prompt (Node puts it in the typed ask's text; the golden test pins `TYPED_TOOL_EPILOGUE` as the text).
- **2c-3c: the repair path.** Built, with no new port method. Node `ensureSubmitProfileFits` sets the session's profile to generic and re-registers the generic `submit_result` (and invalidates the tool cache). Rust needs no re-registration call: the owner's `FallBackToGeneric` arm sets the in-memory profile to generic, and every later turn's `TurnInput` carries `submit_schema: None`, so the runtime's `ActorRun` and the entry's port refresh give the child the generic declaration on that turn. The child's tool list is built from the port each run, so no cache needs invalidating. Node logs `dynamic_workflow.submit_profile.mismatch` as a warning and journals nothing; the Rust arm logs the same event, and journals nothing either. The profile is in memory only, so a restarted run finds the mismatch again and falls back again. Tests: the runtime test `a_mono_session_that_misses_its_ask_falls_back_to_the_generic_declaration_on_every_turn` (both turns, nudge included, declare no schema; the ask is composed for generic). The owner-side fallback is covered by `driver_owner_tests`.

- **2c-4a (built, part): the message boundary.** Node `journalAskMessageBoundary` writes the child's message count on the settled ask's node, after settlement, because the settled record replaces the row. The owner keeps each session's last settled instance (`settled`) until its next ask starts, and `set_message_boundary` writes to the active ask or to that settled one (test: `a_boundary_written_after_the_ask_settles_reaches_the_settled_ask_node`, which failed before the change). The mailbox has a `MessageBoundary` request. The workflow's turn loop sends it after a non-nudge verdict, through a defaulted `TurnRunner::message_boundary`. The runtime bridge reads the count through `ActorAgents::message_count` (`Agents::child_message_count`, the stored message count). Tests: the agents count, the workflow loop with a counting runner, and the runtime end to end. Not built in this part: `ask_mutating` has no caller yet. Its trigger is Node's `onMutating` on the child's first workspace write, which needs a hook in the child's tool execution (not scoped). The permission origin and session grants are not in this part either. **2c-4c (built): the ask stats.** Node `reportTurnObservations` reports `statsFromTurn` before each turn's end. The child counts its started tool calls in the started stream (`ChildSink::emit` on `ToolStarted`, as Node counts `ToolCallStarted`), and its committed responses (`requests`). `world_tool_calls` leaves out the protocol tools (Node `isWorldTouchingToolCall`: a `session` or `userInteraction` scope). The counts sum over the ask's turns; tokens and turns are the turn's own, and a failed usage read takes Node's defaults, 0 tokens and 1 turn. The owner's `ask_stats` writes them through the engine. Tests: the counts from the stream and the protocol set (agents `child_tests`); the workflow loop with cumulative counts and the failed-read defaults; the runtime mapping end to end. Not in this part: Node's `usage.totalTokens` is the turn's total, while the child's `tokens` here is its last response's usage, the figure the existing report uses. The two may differ for a multi-request turn; that needs checking against Node before the count is trusted. `countSource`: the Rust import builder takes the count as an injected function, but no production caller of `build_imported_cache` exists yet (only the golden tests), so there is nothing to inject into until the amend import is wired.

Tests (2c-3a, written first; red recorded as a compile failure of `live_actor_tests` before the constant existed): an actor's definition carries exactly Node's seven denied names, and `for_actor` puts them on the definition. The mode test iterates `SubagentPermissionMode::ALL`, so a missing variant cannot pass.

As built (2c-3b part 1, the workflow side): `driver_rules::quality_epilogue` (Node `qualityEpilogue`, pinned to Node's text inline; the golden fixture is generated by a Node script and is not regenerated here) and `driver_rules::ask_input`, which composes an ask's input as Node does: instructions, then the quality epilogue, then for a typed ask the tool epilogue of a mono session or the schema epilogue otherwise. Its boundary is the instructions' length in UTF-16 units (`encode_utf16().count()`), since a byte length would differ for non-ASCII text. The owner composes after the profile fit and applies the repair: `FallBackToGeneric` sets the actor's profile to generic before composing, as Node's `ensureSubmitProfileFits` does. `ActorSessions::start_turn` and `TurnRunner::run_turn` carry the input and the boundary; the nudged turn passes 0, as Node's `runTurn(NUDGE_PROMPT, 0)` does. The runtime bridge takes the boundary and does not yet persist it. Tests: the Node text of the quality epilogue (with and without `evidence`/`confidence`, and top-level properties only), the three input shapes, the UTF-16 boundary (`"é🙂 go"` is 6 units, 9 bytes), the owner's composed typed input and boundary, the mono fallback and the fitting mono (tool epilogue, boundary 6 for "second"), and the nudge's boundary of 0. Red: the new functions and the new signatures did not compile. Box: workflow lib 123 pass, runtime lib 144 pass; fmt and clippy clean.

As built (2c-3b part 2a, the submit tool): `agents::submit` is the `submit_result` tool (Node `submit-result.ts`). An accepted result returns Node's text and `stop_turn`, which ends the turn; a rejected one is an error whose text is Node's header and one `path: expected X, got Y` line per violation. The child gets the tool only when its actor entry carries a port (`LiveAgent::actor_port`, set from `ActorRun::port` on each turn, by `submit::tools_for` in `spawn::child_tools`). `agents::actor_turn::ActorPort` is the port (async `submit`); `runtime` implements it as `MailboxPort`, which sends the result through the turn's `ActorHandle` on the blocking pool and maps the owner's `SubmitReply`. `AgentTurnRunner::new` takes the mailbox handle. Tests: the tool's name, the accepted and rejected text, the missing-result input error, a refused port, the gate on a port; and two end-to-end runtime tests through the owner (accept settles the ask with the result; a reject keeps it live and the nudged turn fails it with `ResultNotSubmitted`). Deviations: the declaration is always generic, so a mono session's typed declaration with its schema is not built; the mono epilogue therefore names a schema the declaration does not show. Box: agents lib 288 pass, runtime lib 146 pass; fmt and clippy clean.

Review fixes to 2a (ocr on 55ea40a2a, head b55cddbed): (1) `Live::finish_actor_turn` finishes the entry and clears its submit port in one lock section, so a turn's end cannot clear a port a later turn has already installed; `run_actor_turn` uses it on both paths. (2) `Live::restart` clears the port: a resume is never a workflow turn. (3) The submit declaration is strict, as Node's `SubmitResultInputSchema` is: `additionalProperties: false`, and a call with any key other than `result` is refused at the tool with `InvalidInput` naming the key, before the port sees it. Tests: `the_next_turns_port_survives_the_previous_turns_end`, `a_restart_offers_no_submit_port`, `a_call_with_an_unknown_key_is_refused_before_the_port_as_node_strict_schema_refuses_it`, `the_declaration_refuses_unknown_keys_as_node_strict_schema_does`.

As built (2c-3b part 2b, the escalate tool): `agents::escalate` is the `escalate` tool (Node `escalate.ts`). Its text is the outcome's message: the answer when answered, the refusal when refused (a refusal is an ordinary result, not an error); only a failed port fails the call. `ActorPort::escalate` carries the question and context. Its answer is `ActorEscalation::Answered { qid, answer }` or `Refused { reason, message }`. The child gets the tool with `submit_result` when it has a port. Parity with Node's `escalate.ts` (as `submit_result`): the input is strict (`additionalProperties: false`, an unknown key is refused before the port), `question` is non-empty (Node `min(1)`), the cancel text is Node's `cancellation.userVisibleMessage`, and a background actor's `tools` allowlist does not drop the tool. Node's `escalateToolEntry` values: the result budget (`MAX_ESCALATE_MODEL_BYTES`, 16,000) and `shouldDefer: true`.

The parked store (`workflow::parked_answers`) follows the rule that a turn blocked in escalate has not ended. A wait registers under the store's lock before its first check. A session's cancel (`discard_session`) withdraws each question its turn waits on, with `the ask was cancelled`, unless an answer is already there, which the waiter takes. The slots nobody waits for are dropped. Every state change wakes all waiters. The runtime's blocked escalate also checks the turn's cancel token (`wait_until`) as a backstop for a cancel that arrives before its wait registers. Tests: the two interleavings (a waiter withdrawn by a discard; an answer put before a discard), and the backstop.

The answer path (workflow): `ParkedAnswers` (`workflow::parked_answers`) is a keyed store with a condvar. A delivery that comes before its wait is kept, so an answer served before the turn waits is not lost. The mailbox's handle carries it (`ActorHandle::parked`). `MailboxTurns::deliver_answer` delivers the answer to the question's slot, and `reject_parked` withdraws it, so its waiter fails instead of hanging. The owner fills in the actor and persona name of each escalation from the session (`identity_of_session`), whatever the caller put in the request. `ActorDriverOwner::parked_questions` lists a session's parked questions.

The runtime adapter (`MailboxPort::escalate`) sends the question on the blocking pool, then waits on the parked store for the answer. Its request is stamped by the runtime clock, carried on `ActorRunBase::clock`.

Tests: the store's four cases (answer before wait; wait then answer; withdrawal with its reason; per-question slots); the turn side's answer and withdrawal through `MailboxTurns`; the tool's answer, refusal, context, required question and failed port; and an end-to-end runtime test (a scripted turn escalates, the owner parks it, the owner answers the parked question, and the turn receives the answer). The identity override is pinned by a journal test: the caller sends another actor and persona, and the `escalation-raised` event holds the session's. The store's slots are tagged with their session, and `cancel_turn` drops that session's slots, which nobody waited for, while other sessions keep theirs (test: a cancelled session's answer is dropped, another's is kept). Limit: the store has no hook for a session closing, because the actor port has no close call. A withdrawal that the owner sends after the cancel is not dropped, since the cancel ran first. Box: workflow lib 131, agents lib 293, runtime lib 147 pass; fmt and clippy clean.

As built (2c-3b part 2c-1, the mono declaration): the turn's input is one `workflow::actor_turns::TurnInput` (text, epilogue boundary, and the mono session's submit schema, or None for a generic one). `TurnRunner::run_turn`, `ActorSessions::start_turn`, and the queued start take it. The owner sets the schema from the session's profile, only for a typed ask. A nudged turn keeps the schema. The bridge puts it in the turn's `ActorRun::port` (a `SubmitPort`, which holds the port and the schema together, so a schema cannot exist without a port), and `LiveAgent::actor_port` carries that per turn, refreshed like the asks and the port. The submit tool declares it as Node's `{description: "The structured result for this ask.", ...resultSchema}` under `result`: the schema's own keys come after the description, so a description in the schema wins, and `result` is required, with `additionalProperties` false. A generic session's declaration is unchanged. A nudge keeps the schema; only its text and boundary change. Tests: the mono and generic declarations (agents); a mono turn carries its schema and a generic one carries none (owner); a mono session's schema reaches both turns of its ask through the bridge (runtime). Deviation: Node adds `strict: true` for the Anthropic adapter. That needs the provider adapter, and it is not built here. Box: workflow lib 132, agents lib 294, runtime lib 148 pass; fmt and clippy clean.

As built (2c-3b part 2c-2, the epilogue boundary on the user message): `kernel_api::message::UserMessage::epilogue_start` (UTF-16 units; serde default, omitted when None). node-store writes it into the message row's `metadata.epilogueStart`, in the same object as `inputIntent`, as Node's `message-persistence.ts` does (`epilogueStart !== undefined`): `Some(0)` is stored, and `None` stores nothing. `spawn::resume` takes the boundary; the actor's turn passes `ActorRun::epilogue_start`, and the bridge passes `Some(turn.epilogue_start)`. The other resume callers pass None. Tests: the store round trip (a boundary of 5, a zero boundary, none, and a boundary beside the intent), and an entry test that the turn's user message carries its boundary. Box: node-store lib 335, agents lib 295, runtime lib 148 pass; fmt and clippy clean. Red: the store test was written before the write, but its red run was not captured (the change was made in one pass).

Follow-ups (not built):

- `strict: true` on the mono `submit_result` declaration. Node sets it so the Anthropic adapter enforces the schema natively. It needs the provider adapter to honour the flag, so the declaration does not carry it yet.
- Session close. The actor port has no session-close call, so the parked-answer store cannot drop a session's unwaited slots when the session closes, only when its turn is cancelled. A withdrawal the owner sends after the cancel is not dropped.

## 10. Open questions

Each has a recommendation. The user decides. Until decided, the recommendation is the default.

Decided 2026-11-17 by the user: Q1 = Q1-A (engine core in Rust), Q2 = (a) `SessionKind::Subagent` plus the `session_task_link` `workflow_actor` row, Q7 = the admission hook lands in W6b with its own focused review. Q3–Q6 and Q8–Q10 follow their recommendations.

**Q1. Engine core in Rust, or in the child?** Recommendation: Rust (Q1-A), as the decision says. Reason: W1 and the single-writer argument. Cost of Q1-A: about 6,600 TypeScript lines to port with replay goldens, roughly 4,000 Rust lines (W5a and W5b). Cost of Q1-B: a second writer of `dwf_*` in a non-Rust process and a split in ownership that W1 forbids.

**Q2. Actor session kind.** Options: (a) `SessionKind::Subagent` with a parent, plus a `session_task_link` row with role `workflow_actor` in Node's format; (b) a new kind `Workflow`. Recommendation: (a). It reuses the subagent machinery and the existing session kinds, and the link row keeps Node's sidebar and index rules. Not verified yet: how Node hides these rows in the sessions index. PR W6a must check `bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts` and the adapters' session queries before choosing.

**Q3. Persist progress events?** Node keeps `DynamicWorkflowRunProgress` memory-only (`transcript-hydration.ts:717`) and rebuilds `workflowRuns` from `dwf_event`. Recommendation: the same in Rust. Rust does not write progress to `session_entry`. Cold restore replays `dwf_event`. This keeps the transcript free of a second record of each event.

**Q4. Who spawns the sandbox child?** Recommendation: Rust. Reason: the run's abort, lifetime and settlement are Rust's (section 4). The helper only compiles and renders the entry file.

**Q5. Runtime switch with a live run.** Recommendation: the runtime is fixed per process, so a switch is a restart. A run left `running` by the previous process is reconciled to `stopped(interrupted)` when a session opens, and is resumable. No run is ever owned by two runtimes. This matches Node's orphan rule (`dynamic-workflow-run-service.ts` invariant 4).

**Q6. Read-only tools and formatting.** `ListWorkflowRuns` and `GetWorkflowRun` format model-facing text from journal rows. Options: (a) Rust formats (port of about 650 lines); (b) helper formats (stateless call). Recommendation: (b) for W7, port to Rust later if the helper is retired. It keeps the text identical to Node's without a second implementation.

**Q7. Governor scope.** The Node governor is process-level and shared with the main agent. Rust's model requests have no such admission today. Recommendation: add the admission hook in the model crate in W6b, one bucket per `provider/model`, and keep Node's AIMD constants. The hook is used by the main agent too, as in Node, so it lands behind the gate but touches a shared path. Needs a separate review.

**Q8. Memory budget.** Each live run adds one Node child process (about 256 MB heap cap, `harness.ts` `--max-old-space-size=256`). The helper's idle RSS is already over budget (`fork-rust-node-helper.md` "Memory"). Recommendation: measure the child RSS on the packaged build in PR W4 and record it, before W9 turns the gate on. Accept it as a known cost if it is in line with Node's, which runs the same child.

**Q9. The sandbox on single-executable builds.** Node runs the cell through the CLI's own binary (`__zcode-dwf-child`, `dynamic-workflow-run-launch.ts:486-493`). `zcode-rs` is a separate binary, so Rust needs a Node runtime in the helper command. Recommendation: Rust spawns the helper command's `execPath`. Where there is no helper command, the tools stay unregistered (W4). Single-executable builds of `zcode-rs` are out of scope for this spec.

**Q10. Gate source in Rust.** The policy answer (`server.rs:496`) is fixed at `false` today. Recommendation: the Host's `dynamicWorkflow` config remains the only source, read through the same `updateDynamicWorkflowPolicy` call, and the record copies it as Node does. No new `setting.json` key (helper rule 5).

## 11. Edits made to other specs with this decision

- `specs/fork-rust-node-helper.md`: D1 records the 2026-11-17 decision; the F5 row and the F2 row's "until F5" point here; the "F3b, elicitation and F5" F5 paragraph and the "Shared storage" bullet are updated; "Delivery" points to section 9 here. The "Result budget" bullet and the elicitation paragraph are not touched.
- `specs/fork-rust-agent-parity.md`: the "Out of scope" bullet for dynamic workflows points here.
